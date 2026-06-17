package imagejobs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"ov-image-studio/backend/internal/apperror"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

type CreateParams struct {
	UserID            *string
	SourceMode        string
	APIMode           string
	Model             string
	Prompt            string
	Params            ImageParams
	InputAssetIDs     []string
	MaskAssetID       *string
	APIKeyFingerprint string
	APIKeyCiphertext  []byte
	APIKeyNonce       []byte
}

func (r *Repository) Create(ctx context.Context, params CreateParams) (Job, error) {
	rawParams, err := json.Marshal(params.Params)
	if err != nil {
		return Job{}, err
	}
	sourceMode := params.SourceMode
	if sourceMode == "" {
		sourceMode = "gallery"
	}
	args := []any{
		params.UserID,
		StatusQueued,
		"enqueue",
		sourceMode,
		params.APIMode,
		params.Model,
		params.Prompt,
		rawParams,
		params.MaskAssetID,
		params.APIKeyFingerprint,
		params.APIKeyCiphertext,
		params.APIKeyNonce,
	}
	for _, assetID := range params.InputAssetIDs {
		args = append(args, assetID)
	}
	row := r.db.QueryRowContext(ctx, fmt.Sprintf(`
		INSERT INTO image_jobs (
			user_id, status, stage, source_mode, api_mode, model, prompt, params,
			input_asset_ids, mask_asset_id, api_key_fingerprint, api_key_ciphertext, api_key_nonce
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, %s, $9, $10, $11, $12)
		RETURNING id::text, user_id::text, status, stage, source_mode, api_mode, model, prompt, params,
			array_to_json(input_asset_ids), mask_asset_id::text, array_to_json(result_asset_ids), actual_params, error,
			created_at, started_at, finished_at, cancelled_at, acked_at
	`, uuidArraySQL(params.InputAssetIDs, 13)), args...)
	return scanJob(row)
}

func (r *Repository) Get(ctx context.Context, id string) (Job, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, status, stage, source_mode, api_mode, model, prompt, params,
			array_to_json(input_asset_ids), mask_asset_id::text, array_to_json(result_asset_ids), actual_params, error,
			created_at, started_at, finished_at, cancelled_at, acked_at
		FROM image_jobs
		WHERE id = $1
	`, id)
	return scanJob(row)
}

func (r *Repository) MarkRunning(ctx context.Context, id string) (bool, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE image_jobs
		SET status = $2, stage = 'upstream', started_at = COALESCE(started_at, now())
		WHERE id = $1 AND status = 'queued'
	`, id, StatusRunning)
	if err != nil {
		return false, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return rowsAffected > 0, nil
}

func (r *Repository) MarkDone(ctx context.Context, id string, assetIDs []string, actual map[string]any) (bool, error) {
	rawActual, err := json.Marshal(actual)
	if err != nil {
		return false, err
	}
	args := []any{id, rawActual}
	for _, assetID := range assetIDs {
		args = append(args, assetID)
	}
	result, err := r.db.ExecContext(ctx, fmt.Sprintf(`
		UPDATE image_jobs
		SET status = 'done', stage = 'done', result_asset_ids = %s, actual_params = $2, finished_at = now(),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1 AND status = 'running'
	`, uuidArraySQL(assetIDs, 3)), args...)
	if err != nil {
		return false, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return rowsAffected > 0, nil
}

func (r *Repository) MarkError(ctx context.Context, id string, appErr *apperror.Error) error {
	rawError, err := json.Marshal(appErr)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		UPDATE image_jobs
		SET status = 'error', stage = 'error', error = $2, finished_at = now(),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1 AND status IN ('queued','running')
	`, id, rawError)
	return err
}

func (r *Repository) Cancel(ctx context.Context, id string) (bool, error) {
	result, err := r.db.ExecContext(ctx, `
		UPDATE image_jobs
		SET status = 'cancelled', stage = 'cancelled', cancelled_at = now(), finished_at = COALESCE(finished_at, now()),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1 AND status IN ('queued','running')
	`, id)
	if err != nil {
		return false, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return rowsAffected > 0, nil
}

func (r *Repository) Ack(ctx context.Context, id string) (Job, error) {
	result, err := r.db.ExecContext(ctx, `UPDATE image_jobs SET acked_at = now() WHERE id = $1 AND status = 'done'`, id)
	if err != nil {
		return Job{}, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return Job{}, err
	}
	if rowsAffected == 0 {
		if _, getErr := r.Get(ctx, id); getErr != nil {
			if getErr == sql.ErrNoRows {
				return Job{}, apperror.NotFound("任务不存在")
			}
			return Job{}, getErr
		}
		return Job{}, apperror.New(409, "job_not_done", "任务未完成，不能确认清理")
	}
	return r.Get(ctx, id)
}

func (r *Repository) RequeueUnfinished(ctx context.Context) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `
		UPDATE image_jobs
		SET status = 'queued', stage = 'enqueue'
		WHERE status IN ('queued','running')
		RETURNING id::text
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func uuidArraySQL(values []string, startIndex int) string {
	if len(values) == 0 {
		return "ARRAY[]::uuid[]"
	}
	parts := make([]string, len(values))
	for i := range values {
		parts[i] = fmt.Sprintf("$%d::uuid", startIndex+i)
	}
	return "ARRAY[" + strings.Join(parts, ",") + "]"
}

func scanJob(row interface {
	Scan(dest ...any) error
}) (Job, error) {
	var job Job
	var userID sql.NullString
	var rawParams []byte
	var rawInputAssetIDs []byte
	var maskAssetID sql.NullString
	var rawResultAssetIDs []byte
	var rawActual []byte
	var rawError []byte
	var startedAt sql.NullTime
	var finishedAt sql.NullTime
	var cancelledAt sql.NullTime
	var ackedAt sql.NullTime
	err := row.Scan(
		&job.ID,
		&userID,
		&job.Status,
		&job.Stage,
		&job.SourceMode,
		&job.APIMode,
		&job.Model,
		&job.Prompt,
		&rawParams,
		&rawInputAssetIDs,
		&maskAssetID,
		&rawResultAssetIDs,
		&rawActual,
		&rawError,
		&job.CreatedAt,
		&startedAt,
		&finishedAt,
		&cancelledAt,
		&ackedAt,
	)
	if err != nil {
		return Job{}, err
	}
	if userID.Valid {
		job.UserID = &userID.String
	}
	_ = json.Unmarshal(rawParams, &job.Params)
	_ = json.Unmarshal(rawInputAssetIDs, &job.InputAssetIDs)
	if maskAssetID.Valid {
		job.MaskAssetID = &maskAssetID.String
	}
	_ = json.Unmarshal(rawResultAssetIDs, &job.ResultAssetIDs)
	if len(rawActual) > 0 {
		_ = json.Unmarshal(rawActual, &job.ActualParams)
	}
	if len(rawError) > 0 {
		var appErr apperror.Error
		if err := json.Unmarshal(rawError, &appErr); err == nil {
			job.Error = &appErr
		}
	}
	if startedAt.Valid {
		job.StartedAt = &startedAt.Time
	}
	if finishedAt.Valid {
		job.FinishedAt = &finishedAt.Time
	}
	if cancelledAt.Valid {
		job.CancelledAt = &cancelledAt.Time
	}
	if ackedAt.Valid {
		job.AckedAt = &ackedAt.Time
	}
	return job, nil
}
