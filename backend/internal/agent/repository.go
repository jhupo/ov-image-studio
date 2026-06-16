package agent

import (
	"context"
	"database/sql"
	"encoding/json"

	"ov-image-studio/backend/internal/apperror"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

type CreateParams struct {
	Model             string
	Request           map[string]any
	APIKeyFingerprint string
	APIKeyCiphertext  []byte
	APIKeyNonce       []byte
}

func (r *Repository) Create(ctx context.Context, params CreateParams) (Run, error) {
	rawRequest, err := json.Marshal(params.Request)
	if err != nil {
		return Run{}, err
	}
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO agent_response_runs (
			status, stage, model, request, api_key_fingerprint, api_key_ciphertext, api_key_nonce
		)
		VALUES ($1, 'enqueue', $2, $3, $4, $5, $6)
		RETURNING id::text, status, stage, model, response, error, created_at, started_at, finished_at
	`, StatusQueued, params.Model, rawRequest, params.APIKeyFingerprint, params.APIKeyCiphertext, params.APIKeyNonce)
	return scanRun(row)
}

func (r *Repository) Get(ctx context.Context, id string) (Run, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id::text, status, stage, model, response, error, created_at, started_at, finished_at
		FROM agent_response_runs
		WHERE id = $1
	`, id)
	return scanRun(row)
}

func (r *Repository) GetRequest(ctx context.Context, id string) (Run, map[string]any, error) {
	var rawRequest []byte
	row := r.db.QueryRowContext(ctx, `
		SELECT id::text, status, stage, model, response, error, created_at, started_at, finished_at, request
		FROM agent_response_runs
		WHERE id = $1
	`, id)
	run, err := scanRunWithRequest(row, &rawRequest)
	if err != nil {
		return Run{}, nil, err
	}
	var request map[string]any
	if err := json.Unmarshal(rawRequest, &request); err != nil {
		return Run{}, nil, err
	}
	return run, request, nil
}

func (r *Repository) MarkRunning(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE agent_response_runs
		SET status = $2, stage = 'upstream', started_at = COALESCE(started_at, now())
		WHERE id = $1 AND status IN ('queued','running')
	`, id, StatusRunning)
	return err
}

func (r *Repository) MarkDone(ctx context.Context, id string, response map[string]any) error {
	rawResponse, err := json.Marshal(response)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		UPDATE agent_response_runs
		SET status = 'done', stage = 'done', response = $2, finished_at = now(),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1
	`, id, rawResponse)
	return err
}

func (r *Repository) MarkError(ctx context.Context, id string, appErr *apperror.Error) error {
	rawError, err := json.Marshal(appErr)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
		UPDATE agent_response_runs
		SET status = 'error', stage = 'error', error = $2, finished_at = now(),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1
	`, id, rawError)
	return err
}

func (r *Repository) Cancel(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE agent_response_runs
		SET status = 'cancelled', stage = 'cancelled', cancelled_at = now(), finished_at = COALESCE(finished_at, now()),
			api_key_ciphertext = NULL, api_key_nonce = NULL
		WHERE id = $1 AND status IN ('queued','running')
	`, id)
	return err
}

func (r *Repository) RequeueUnfinished(ctx context.Context) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `
		UPDATE agent_response_runs
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

func (r *Repository) LoadAPIKey(ctx context.Context, id string) ([]byte, []byte, error) {
	var ciphertext []byte
	var nonce []byte
	err := r.db.QueryRowContext(ctx, `
		SELECT api_key_ciphertext, api_key_nonce
		FROM agent_response_runs
		WHERE id = $1
	`, id).Scan(&ciphertext, &nonce)
	return ciphertext, nonce, err
}

func scanRun(row interface {
	Scan(dest ...any) error
}) (Run, error) {
	return scanRunWithRequest(row, nil)
}

func scanRunWithRequest(row interface {
	Scan(dest ...any) error
}, rawRequest *[]byte) (Run, error) {
	var run Run
	var rawResponse []byte
	var rawError []byte
	var startedAt sql.NullTime
	var finishedAt sql.NullTime
	dest := []any{
		&run.ID,
		&run.Status,
		&run.Stage,
		&run.Model,
		&rawResponse,
		&rawError,
		&run.CreatedAt,
		&startedAt,
		&finishedAt,
	}
	if rawRequest != nil {
		dest = append(dest, rawRequest)
	}
	if err := row.Scan(dest...); err != nil {
		return Run{}, err
	}
	if len(rawResponse) > 0 {
		if err := json.Unmarshal(rawResponse, &run.Response); err != nil {
			return Run{}, err
		}
	}
	if len(rawError) > 0 {
		var appErr apperror.Error
		if err := json.Unmarshal(rawError, &appErr); err != nil {
			return Run{}, err
		}
		run.Error = &appErr
	}
	if startedAt.Valid {
		run.StartedAt = &startedAt.Time
	}
	if finishedAt.Valid {
		run.FinishedAt = &finishedAt.Time
	}
	return run, nil
}
