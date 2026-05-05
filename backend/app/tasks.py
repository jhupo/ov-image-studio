from __future__ import annotations

import json
import uuid
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import MAX_RETRIES, PAYLOAD_KEY_PREFIX, PAYLOAD_TTL_SECONDS, RESULT_KEY_PREFIX, RESULT_TTL_SECONDS
from .db import db_conn, redis_client
from .fingerprints import api_key_fingerprint, profile_fingerprint
from .queue import queue_position, queue_task
from .timeutil import now_ms


def validate_task_payload(payload: dict[str, Any]) -> str | None:
    profile = payload.get("profile")
    params = payload.get("params")
    if not isinstance(profile, dict) or not isinstance(params, dict):
        return "Missing task payload"
    if profile.get("provider") != "openai":
        return "Only OpenAI-compatible image tasks are supported"
    if not str(payload.get("prompt", "")).strip():
        return "Prompt is required"
    if not profile.get("apiKey") or not profile.get("model"):
        return "API key and model are required"
    for key in ("size", "quality", "output_format", "moderation", "n"):
        if key not in params:
            return f"Missing params.{key}"
    if params.get("output_format") not in {"png", "jpeg", "webp"}:
        return "Unsupported output format"
    if params.get("quality") not in {"auto", "low", "medium", "high"}:
        return "Unsupported quality"
    if params.get("moderation") not in {"auto", "low"}:
        return "Unsupported moderation"
    try:
        n = int(params.get("n"))
    except (TypeError, ValueError):
        return "params.n must be an integer"
    if n < 1 or n > 16:
        return "params.n must be between 1 and 16"
    if params.get("output_compression") is not None:
        try:
            compression = int(params["output_compression"])
        except (TypeError, ValueError):
            return "params.output_compression must be an integer"
        if compression < 0 or compression > 100:
            return "params.output_compression must be between 0 and 100"
    return None


def payload_key(task_id: str) -> str:
    return f"{PAYLOAD_KEY_PREFIX}:{task_id}"


def result_key(task_id: str) -> str:
    return f"{RESULT_KEY_PREFIX}:{task_id}"


def sanitize_task_payload(payload: dict[str, Any]) -> dict[str, Any]:
    clean = dict(payload)
    input_images = clean.pop("inputImageDataUrls", []) or []
    mask_data_url = clean.pop("maskDataUrl", None)
    profile = clean.get("profile")
    if isinstance(profile, dict):
        clean["profile"] = {**profile, "apiKey": "[redacted]"}
    clean["inputImageCount"] = len(input_images)
    clean["hasMask"] = bool(mask_data_url)
    return clean


def summarize_result_payload(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "imageCount": len(result.get("images") or []),
        "actualParams": result.get("actualParams") or {},
        "actualParamsList": result.get("actualParamsList") or [],
        "revisedPrompts": result.get("revisedPrompts") or [],
        "imagesStored": "redis_ttl",
    }


def store_task_payload(task_id: str, payload: dict[str, Any]) -> None:
    redis_client.setex(payload_key(task_id), PAYLOAD_TTL_SECONDS, json.dumps(payload, ensure_ascii=False))


def load_task_payload(task_id: str) -> dict[str, Any] | None:
    raw = redis_client.get(payload_key(task_id))
    return json.loads(raw) if raw else None


def delete_task_payload(task_id: str) -> None:
    redis_client.delete(payload_key(task_id))


def store_task_result(task_id: str, result: dict[str, Any]) -> None:
    redis_client.setex(result_key(task_id), RESULT_TTL_SECONDS, json.dumps(result, ensure_ascii=False))


def load_task_result(task_id: str) -> dict[str, Any] | None:
    raw = redis_client.get(result_key(task_id))
    return json.loads(raw) if raw else None


def delete_task_result(task_id: str) -> None:
    redis_client.delete(result_key(task_id))


def public_task(task: dict[str, Any]) -> dict[str, Any]:
    result = load_task_result(task["id"]) if task["status"] == "succeeded" else None
    if result is None:
        result = task.get("result_payload")
    if isinstance(result, str):
        result = json.loads(result)
    return {
        "id": task["id"],
        "requesterId": task.get("requester_id"),
        "status": task["status"],
        "queuePosition": queue_position(task),
        "priority": task.get("priority", 0),
        "retryCount": task.get("retry_count", 0),
        "maxRetries": task.get("max_retries", 0),
        "errorCode": task.get("error_code"),
        "error": task.get("error_message"),
        "createdAt": task["created_at"],
        "updatedAt": task["updated_at"],
        "queuedAt": task.get("queued_at"),
        "startedAt": task.get("started_at"),
        "finishedAt": task.get("finished_at"),
        "canceledAt": task.get("canceled_at"),
        "leaseExpiresAt": task.get("lease_expires_at"),
        "result": result,
    }


def fetch_task(task_id: str) -> dict[str, Any] | None:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM image_tasks WHERE id = %s", (task_id,))
            return cur.fetchone()


def update_task(task_id: str, **patch: Any) -> None:
    if not patch:
        return
    fields = []
    values = []
    for key, value in patch.items():
        fields.append(f"{key} = %s")
        values.append(Jsonb(value) if key.endswith("_payload") and value is not None else value)
    fields.append("updated_at = %s")
    values.append(now_ms())
    values.append(task_id)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE image_tasks SET {', '.join(fields)} WHERE id = %s", values)
        conn.commit()


def create_task(payload: dict[str, Any], idempotency_key: str | None) -> dict[str, Any]:
    error = validate_task_payload(payload)
    if error:
        raise ValueError(error)

    task_id = str(uuid.uuid4())
    now = now_ms()
    profile = payload["profile"]
    requester_id = payload.get("requesterId")
    try:
        priority = max(-100, min(100, int(payload.get("priority") or 0)))
        max_retries = int(payload.get("maxRetries") if payload.get("maxRetries") is not None else MAX_RETRIES)
    except (TypeError, ValueError) as exc:
        raise ValueError("priority and maxRetries must be integers") from exc
    row = {
        "id": task_id,
        "status": "queued",
        "request_payload": Jsonb(sanitize_task_payload(payload)),
        "result_payload": None,
        "requester_id": str(requester_id) if requester_id is not None else None,
        "profile_fingerprint": profile_fingerprint(profile),
        "api_key_fingerprint": api_key_fingerprint(profile),
        "idempotency_key": idempotency_key,
        "priority": priority,
        "retry_count": 0,
        "max_retries": max(0, max_retries),
        "error_code": None,
        "error_message": None,
        "created_at": now,
        "updated_at": now,
        "queued_at": now,
        "available_at": now,
        "started_at": None,
        "finished_at": None,
        "canceled_at": None,
        "lease_owner": None,
        "lease_expires_at": None,
    }
    store_task_payload(task_id, payload)
    with db_conn() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO image_tasks (
                        id, status, request_payload, result_payload, requester_id,
                        profile_fingerprint, api_key_fingerprint, idempotency_key,
                        priority, retry_count, max_retries, error_code, error_message,
                        created_at, updated_at, queued_at, available_at, started_at,
                        finished_at, canceled_at, lease_owner, lease_expires_at
                    ) VALUES (
                        %(id)s, %(status)s, %(request_payload)s, %(result_payload)s,
                        %(requester_id)s, %(profile_fingerprint)s, %(api_key_fingerprint)s,
                        %(idempotency_key)s, %(priority)s, %(retry_count)s, %(max_retries)s,
                        %(error_code)s, %(error_message)s, %(created_at)s, %(updated_at)s,
                        %(queued_at)s, %(available_at)s, %(started_at)s, %(finished_at)s,
                        %(canceled_at)s, %(lease_owner)s, %(lease_expires_at)s
                    )
                    """,
                    row,
                )
            conn.commit()
        except psycopg.errors.UniqueViolation:
            conn.rollback()
            delete_task_payload(task_id)
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM image_tasks WHERE idempotency_key = %s", (idempotency_key,))
                existing = cur.fetchone()
                if existing:
                    return existing
            raise
    queue_task(task_id)
    return fetch_task(task_id)  # type: ignore[return-value]


def renew_task_lease(task_id: str, lease_owner: str, lease_expires_at: int) -> bool:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE image_tasks
                SET lease_owner = %s,
                    lease_expires_at = %s,
                    updated_at = %s
                WHERE id = %s
                  AND status = 'running'
                  AND lease_owner = %s
                """,
                (lease_owner, lease_expires_at, now_ms(), task_id, lease_owner),
            )
            updated = cur.rowcount > 0
        conn.commit()
    return updated


def list_tasks(
    requester_id: str | None,
    status: str | None = None,
    limit: int = 200,
    before: int | None = None,
) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    clauses = []
    values: list[Any] = []
    if requester_id:
        clauses.append("requester_id = %s")
        values.append(requester_id)
    if status:
        clauses.append("status = %s")
        values.append(status)
    if before is not None:
        clauses.append("created_at < %s")
        values.append(before)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    values.append(limit)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM image_tasks {where} ORDER BY created_at DESC LIMIT %s",
                values,
            )
            return cur.fetchall()
