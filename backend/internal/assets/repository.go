package assets

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

type CreateAssetParams struct {
	UserID           *string
	Kind             string
	MIME             string
	Data             []byte
	SourceJobID      *string
	SourceAgentRunID *string
	ExpiresAt        time.Time
}

func (r *Repository) Create(ctx context.Context, params CreateAssetParams) (Asset, error) {
	sum := sha256.Sum256(params.Data)
	row := r.db.QueryRowContext(ctx, `
		INSERT INTO assets (
			user_id, kind, mime, data, file_size, sha256,
			source_job_id, source_agent_run_id, expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id::text, user_id::text, kind, mime, file_size, width, height, sha256, status,
			source_job_id::text, source_agent_run_id::text, delivered_at, deleted_at, expires_at, created_at
	`, params.UserID, params.Kind, params.MIME, params.Data, int64(len(params.Data)), hex.EncodeToString(sum[:]), params.SourceJobID, params.SourceAgentRunID, params.ExpiresAt)
	return scanAsset(row)
}

func (r *Repository) Get(ctx context.Context, id string) (Asset, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id::text, user_id::text, kind, mime, file_size, width, height, sha256, status,
			source_job_id::text, source_agent_run_id::text, delivered_at, deleted_at, expires_at, created_at
		FROM assets
		WHERE id = $1
	`, id)
	return scanAsset(row)
}

func (r *Repository) GetData(ctx context.Context, id string) ([]byte, error) {
	var data []byte
	err := r.db.QueryRowContext(ctx, `
		SELECT data
		FROM assets
		WHERE id = $1 AND status = 'available' AND data IS NOT NULL
	`, id).Scan(&data)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (r *Repository) MarkDelivered(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE assets SET delivered_at = now() WHERE id = $1`, id)
	return err
}

func (r *Repository) MarkDeleted(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	placeholders := make([]string, 0, len(ids))
	args := make([]any, 0, len(ids))
	for i, id := range ids {
		placeholders = append(placeholders, fmt.Sprintf("$%d", i+1))
		args = append(args, id)
	}
	_, err := r.db.ExecContext(ctx, fmt.Sprintf(`
		UPDATE assets
		SET status = 'deleted', deleted_at = now(), data = NULL
		WHERE id IN (%s)
	`, strings.Join(placeholders, ",")), args...)
	return err
}

func (r *Repository) DeleteExpired(ctx context.Context, now time.Time, limit int) (int64, error) {
	if limit <= 0 {
		limit = 100
	}
	result, err := r.db.ExecContext(ctx, `
		UPDATE assets
		SET status = 'deleted', deleted_at = COALESCE(deleted_at, now()), data = NULL
		WHERE id IN (
			SELECT id
			FROM assets
			WHERE status = 'available' AND expires_at <= $1
			ORDER BY expires_at
			LIMIT $2
		)
	`, now, limit)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func scanAsset(row interface {
	Scan(dest ...any) error
}) (Asset, error) {
	var asset Asset
	var userID sql.NullString
	var width sql.NullInt64
	var height sql.NullInt64
	var sha sql.NullString
	var sourceJobID sql.NullString
	var sourceAgentRunID sql.NullString
	var deliveredAt sql.NullTime
	var deletedAt sql.NullTime
	err := row.Scan(
		&asset.ID,
		&userID,
		&asset.Kind,
		&asset.MIME,
		&asset.FileSize,
		&width,
		&height,
		&sha,
		&asset.Status,
		&sourceJobID,
		&sourceAgentRunID,
		&deliveredAt,
		&deletedAt,
		&asset.ExpiresAt,
		&asset.CreatedAt,
	)
	if err != nil {
		return Asset{}, err
	}
	if userID.Valid {
		asset.UserID = &userID.String
	}
	if width.Valid {
		value := int(width.Int64)
		asset.Width = &value
	}
	if height.Valid {
		value := int(height.Int64)
		asset.Height = &value
	}
	if sha.Valid {
		asset.SHA256 = sha.String
	}
	if sourceJobID.Valid {
		asset.SourceJobID = &sourceJobID.String
	}
	if sourceAgentRunID.Valid {
		asset.SourceAgentRunID = &sourceAgentRunID.String
	}
	if deliveredAt.Valid {
		asset.DeliveredAt = &deliveredAt.Time
	}
	if deletedAt.Valid {
		asset.DeletedAt = &deletedAt.Time
	}
	return asset, nil
}
