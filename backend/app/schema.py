from __future__ import annotations

from .db import db_conn


def ensure_schema() -> None:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS image_tasks (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    request_payload JSONB NOT NULL,
                    result_payload JSONB NULL,
                    requester_id TEXT NULL,
                    profile_fingerprint TEXT NOT NULL,
                    api_key_fingerprint TEXT NOT NULL,
                    idempotency_key TEXT NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    max_retries INTEGER NOT NULL DEFAULT 0,
                    error_code TEXT NULL,
                    error_message TEXT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    queued_at BIGINT NOT NULL,
                    available_at BIGINT NOT NULL,
                    started_at BIGINT NULL,
                    finished_at BIGINT NULL,
                    canceled_at BIGINT NULL,
                    lease_owner TEXT NULL,
                    lease_expires_at BIGINT NULL
                )
                """
            )
            cur.execute("ALTER TABLE image_tasks ALTER COLUMN requester_id TYPE TEXT USING requester_id::text")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS api_key_fingerprint TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 0")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS error_code TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS error_message TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS error TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS queued_at BIGINT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS available_at BIGINT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS canceled_at BIGINT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS lease_owner TEXT")
            cur.execute("ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT")
            cur.execute("UPDATE image_tasks SET api_key_fingerprint = '' WHERE api_key_fingerprint IS NULL")
            cur.execute("UPDATE image_tasks SET queued_at = created_at WHERE queued_at IS NULL")
            cur.execute("UPDATE image_tasks SET available_at = created_at WHERE available_at IS NULL")
            cur.execute("UPDATE image_tasks SET error_message = error WHERE error_message IS NULL AND error IS NOT NULL")
            cur.execute(
                """
                UPDATE image_tasks
                SET request_payload = request_payload - 'inputImageDataUrls' - 'maskDataUrl'
                WHERE request_payload ? 'inputImageDataUrls'
                   OR request_payload ? 'maskDataUrl'
                """
            )
            cur.execute(
                """
                UPDATE image_tasks
                SET request_payload = jsonb_set(request_payload, '{profile,apiKey}', '"[redacted]"'::jsonb, false)
                WHERE request_payload #>> '{profile,apiKey}' IS NOT NULL
                  AND request_payload #>> '{profile,apiKey}' <> '[redacted]'
                """
            )
            cur.execute(
                """
                UPDATE image_tasks
                SET result_payload = result_payload - 'images'
                WHERE result_payload IS NOT NULL
                  AND result_payload ? 'images'
                """
            )
            cur.execute("ALTER TABLE image_tasks ALTER COLUMN api_key_fingerprint SET NOT NULL")
            cur.execute("ALTER TABLE image_tasks ALTER COLUMN queued_at SET NOT NULL")
            cur.execute("ALTER TABLE image_tasks ALTER COLUMN available_at SET NOT NULL")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_image_tasks_status_available ON image_tasks (status, available_at, priority DESC, created_at)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_image_tasks_requester ON image_tasks (requester_id, created_at DESC)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_image_tasks_profile ON image_tasks (profile_fingerprint, status)")
            cur.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_image_tasks_idempotency
                ON image_tasks (idempotency_key)
                WHERE idempotency_key IS NOT NULL
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS image_task_events (
                    id BIGSERIAL PRIMARY KEY,
                    task_id TEXT NOT NULL REFERENCES image_tasks(id) ON DELETE CASCADE,
                    event_type TEXT NOT NULL,
                    message TEXT NULL,
                    metadata JSONB NULL,
                    created_at BIGINT NOT NULL
                )
                """
            )
            cur.execute("CREATE INDEX IF NOT EXISTS idx_image_task_events_task ON image_task_events (task_id, created_at)")
        conn.commit()
