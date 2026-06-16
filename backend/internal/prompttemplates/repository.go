package prompttemplates

import (
	"context"
	"database/sql"
	"encoding/json"
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

func (r *Repository) ReplaceSource(ctx context.Context, source string, sourceURL string, templates []Template) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE prompt_templates SET active = false WHERE source = $1`, source); err != nil {
		return err
	}
	for _, template := range templates {
		tags, err := json.Marshal(template.Tags)
		if err != nil {
			return err
		}
		imageURLs, err := json.Marshal(template.ImageURLs)
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(template)
		_, err = tx.ExecContext(ctx, `
			INSERT INTO prompt_templates (
				id, source, source_external_id, title, summary, prompt, category, tags, image_urls,
				author, source_url, detail_url, featured, raycast, language, sort_order, active, raw, synced_at, updated_at
			)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,now(),now())
			ON CONFLICT (source, source_external_id) DO UPDATE SET
				id = EXCLUDED.id,
				title = EXCLUDED.title,
				summary = EXCLUDED.summary,
				prompt = EXCLUDED.prompt,
				category = EXCLUDED.category,
				tags = EXCLUDED.tags,
				image_urls = EXCLUDED.image_urls,
				author = EXCLUDED.author,
				source_url = EXCLUDED.source_url,
				detail_url = EXCLUDED.detail_url,
				featured = EXCLUDED.featured,
				raycast = EXCLUDED.raycast,
				language = EXCLUDED.language,
				sort_order = EXCLUDED.sort_order,
				active = true,
				raw = EXCLUDED.raw,
				synced_at = now(),
				updated_at = now()
		`, template.ID, source, template.SourceExternalID, template.Title, template.Summary, template.Prompt,
			template.Category, tags, imageURLs, template.Author, template.SourceURL, template.DetailURL,
			template.Featured, template.Raycast, template.Language, template.SortOrder, raw)
		if err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO prompt_template_syncs (source, source_url, item_count, last_error, synced_at)
		VALUES ($1, $2, $3, '', now())
		ON CONFLICT (source) DO UPDATE SET source_url = EXCLUDED.source_url, item_count = EXCLUDED.item_count, last_error = '', synced_at = now()
	`, source, sourceURL, len(templates)); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) MarkSyncError(ctx context.Context, source string, sourceURL string, errText string) {
	_, _ = r.db.ExecContext(ctx, `
		INSERT INTO prompt_template_syncs (source, source_url, item_count, last_error, synced_at)
		VALUES ($1, $2, 0, $3, now())
		ON CONFLICT (source) DO UPDATE SET source_url = EXCLUDED.source_url, last_error = EXCLUDED.last_error, synced_at = now()
	`, source, sourceURL, errText)
}

func (r *Repository) List(ctx context.Context, query string, category string, ids []string, page int, pageSize int) (ListResult, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 24
	}
	if pageSize > 60 {
		pageSize = 60
	}
	where, args := listWhere(query, category, ids)
	var total int
	countQuery := "SELECT count(*) FROM prompt_templates " + where
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return ListResult{}, err
	}
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, source, source_external_id, title, summary, prompt, category, tags, image_urls,
			author, source_url, detail_url, featured, raycast, language, sort_order, synced_at
		FROM prompt_templates
		`+where+`
		ORDER BY featured DESC, sort_order ASC, title ASC
		LIMIT $`+fmt.Sprint(len(args)-1)+` OFFSET $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return ListResult{}, err
	}
	defer rows.Close()
	items := make([]Template, 0, pageSize)
	for rows.Next() {
		template, err := scanTemplate(rows)
		if err != nil {
			return ListResult{}, err
		}
		items = append(items, template)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, err
	}
	categories, err := r.Categories(ctx)
	if err != nil {
		return ListResult{}, err
	}
	return ListResult{Items: items, Total: total, Page: page, PageSize: pageSize, Categories: categories}, nil
}

func (r *Repository) Categories(ctx context.Context) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT category
		FROM prompt_templates
		WHERE active = true
		GROUP BY category
		ORDER BY CASE WHEN category = '精选' THEN 0 ELSE 1 END, min(sort_order), category
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var categories []string
	for rows.Next() {
		var category string
		if err := rows.Scan(&category); err != nil {
			return nil, err
		}
		categories = append(categories, category)
	}
	return categories, rows.Err()
}

func (r *Repository) Stats(ctx context.Context) (StoreStats, error) {
	var stats StoreStats
	err := r.db.QueryRowContext(ctx, `
		SELECT
			count(*)::int,
			count(*) FILTER (WHERE jsonb_array_length(image_urls) > 0)::int
		FROM prompt_templates
		WHERE active = true
	`).Scan(&stats.ActiveItems, &stats.ItemsWithImage)
	return stats, err
}

func (r *Repository) Get(ctx context.Context, id string) (Template, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, source, source_external_id, title, summary, prompt, category, tags, image_urls,
			author, source_url, detail_url, featured, raycast, language, sort_order, synced_at
		FROM prompt_templates
		WHERE id = $1 AND active = true
	`, id)
	return scanTemplate(row)
}

func (r *Repository) Status(ctx context.Context, source string) (SyncStatus, error) {
	var status SyncStatus
	err := r.db.QueryRowContext(ctx, `
		SELECT source, source_url, item_count, last_error, synced_at
		FROM prompt_template_syncs
		WHERE source = $1
	`, source).Scan(&status.Source, &status.SourceURL, &status.ItemCount, &status.LastError, &status.SyncedAt)
	return status, err
}

func listWhere(query string, category string, ids []string) (string, []any) {
	clauses := []string{"active = true"}
	args := make([]any, 0, 2+len(ids))
	ids = cleanIDs(ids)
	if len(ids) > 0 {
		placeholders := make([]string, 0, len(ids))
		for _, id := range ids {
			args = append(args, id)
			placeholders = append(placeholders, fmt.Sprintf("$%d", len(args)))
		}
		clauses = append(clauses, "id IN ("+strings.Join(placeholders, ",")+")")
	}
	if strings.TrimSpace(category) != "" {
		args = append(args, category)
		clauses = append(clauses, fmt.Sprintf("category = $%d", len(args)))
	}
	if strings.TrimSpace(query) != "" {
		args = append(args, "%"+strings.ToLower(strings.TrimSpace(query))+"%")
		clauses = append(clauses, fmt.Sprintf(`(
			lower(title) LIKE $%d OR lower(summary) LIKE $%d OR lower(prompt) LIKE $%d OR
			lower(category) LIKE $%d OR lower(author) LIKE $%d OR lower(tags::text) LIKE $%d
		)`, len(args), len(args), len(args), len(args), len(args), len(args)))
	}
	return "WHERE " + strings.Join(clauses, " AND "), args
}

func cleanIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	cleaned := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		cleaned = append(cleaned, id)
		if len(cleaned) >= 80 {
			break
		}
	}
	return cleaned
}

func scanTemplate(row interface{ Scan(dest ...any) error }) (Template, error) {
	var template Template
	var rawTags []byte
	var rawImageURLs []byte
	var syncedAt time.Time
	err := row.Scan(
		&template.ID,
		&template.Source,
		&template.SourceExternalID,
		&template.Title,
		&template.Summary,
		&template.Prompt,
		&template.Category,
		&rawTags,
		&rawImageURLs,
		&template.Author,
		&template.SourceURL,
		&template.DetailURL,
		&template.Featured,
		&template.Raycast,
		&template.Language,
		&template.SortOrder,
		&syncedAt,
	)
	if err != nil {
		return Template{}, err
	}
	_ = json.Unmarshal(rawTags, &template.Tags)
	_ = json.Unmarshal(rawImageURLs, &template.ImageURLs)
	template.SyncedAt = syncedAt
	return template, nil
}
