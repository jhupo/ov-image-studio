package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func Open(ctx context.Context, databaseURL string) (*sql.DB, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(16)
	database.SetMaxIdleConns(4)
	database.SetConnMaxLifetime(30 * time.Minute)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return nil, err
	}
	return database, nil
}

func Migrate(ctx context.Context, database *sql.DB) error {
	_, err := database.ExecContext(ctx, schema)
	return err
}

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'sub2api',
  external_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, external_user_id)
);

CREATE TABLE IF NOT EXISTS api_key_cache (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
  upstream_key_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  allow_image_generation BOOLEAN NOT NULL DEFAULT true,
  raw JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(user_id, upstream_key_id)
);

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input','mask','output','partial')),
  mime TEXT NOT NULL,
  data BYTEA,
  file_path TEXT,
  file_size BIGINT NOT NULL,
  width INT,
  height INT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  source_job_id UUID,
  source_agent_run_id UUID,
  delivered_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assets ADD COLUMN IF NOT EXISTS data BYTEA;
ALTER TABLE assets ALTER COLUMN file_path DROP NOT NULL;

CREATE TABLE IF NOT EXISTS image_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  source_mode TEXT NOT NULL DEFAULT 'gallery',
  api_mode TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  params JSONB NOT NULL,
  input_asset_ids UUID[] NOT NULL DEFAULT '{}',
  mask_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  result_asset_ids UUID[] NOT NULL DEFAULT '{}',
  api_key_fingerprint TEXT,
  api_key_ciphertext BYTEA,
  api_key_nonce BYTEA,
  actual_params JSONB NOT NULL DEFAULT '{}',
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS image_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL DEFAULT '',
  asset_ids UUID[] NOT NULL DEFAULT '{}',
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  image_params JSONB NOT NULL,
  max_tool_rounds INT NOT NULL DEFAULT 15,
  web_search BOOLEAN NOT NULL DEFAULT false,
  math_formatting BOOLEAN NOT NULL DEFAULT true,
  output_asset_ids UUID[] NOT NULL DEFAULT '{}',
  api_key_fingerprint TEXT,
  api_key_ciphertext BYTEA,
  api_key_nonce BYTEA,
  response_id TEXT,
  response_output JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_response_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  model TEXT NOT NULL,
  request JSONB NOT NULL,
  api_key_fingerprint TEXT,
  api_key_ciphertext BYTEA,
  api_key_nonce BYTEA,
  response JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agent_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '社区提示词',
  tags JSONB NOT NULL DEFAULT '[]',
  image_urls JSONB NOT NULL DEFAULT '[]',
  author TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  detail_url TEXT NOT NULL DEFAULT '',
  featured BOOLEAN NOT NULL DEFAULT false,
  raycast BOOLEAN NOT NULL DEFAULT false,
  language TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  raw JSONB NOT NULL DEFAULT '{}',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source, source_external_id)
);

CREATE TABLE IF NOT EXISTS prompt_template_syncs (
  source TEXT PRIMARY KEY,
  source_url TEXT NOT NULL DEFAULT '',
  item_count INT NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_image_jobs_status_created ON image_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_expires ON assets(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created ON agent_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_response_runs_status_created ON agent_response_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_id_id ON agent_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_active_sort ON prompt_templates(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_category ON prompt_templates(category);
`
