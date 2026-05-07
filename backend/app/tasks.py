from __future__ import annotations

import json
import uuid
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import MAX_RETRIES, PAYLOAD_KEY_PREFIX, PAYLOAD_TTL_SECONDS, RESULT_KEY_PREFIX, RESULT_TTL_SECONDS, TASK_EVENT_TTL_SECONDS, TASK_METADATA_TTL_SECONDS
from .db import db_conn, redis_client
from .fingerprints import api_key_fingerprint, profile_fingerprint
from .queue import queue_positions, queue_task
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


def redis_ttl_seconds(key: str) -> int | None:
    ttl = redis_client.ttl(key)
    return ttl if ttl >= 0 else None


def public_task(task: dict[str, Any], include_result: bool = False) -> dict[str, Any]:
    result = None
    if include_result and task["status"] == "succeeded":
        result = load_task_result(task["id"])
    if result is None:
        result = task.get("result_payload")
    if isinstance(result, str):
        result = json.loads(result)
    metrics = task_phase_metrics(task)
    positions = queue_positions(task)
    public_queue_position = positions["user"]
    return {
        "id": task["id"],
        "requesterId": task.get("requester_id"),
        "status": task["status"],
        "queuePosition": public_queue_position,
        "queuePositions": {"user": public_queue_position},
        "priority": task.get("priority", 0),
        "retryCount": task.get("retry_count", 0),
        "maxRetries": task.get("max_retries", 0),
        "errorCode": task.get("error_code"),
        "errorCategory": error_category(task.get("error_code"), task.get("error_message")),
        "error": task.get("error_message"),
        "createdAt": task["created_at"],
        "updatedAt": task["updated_at"],
        "queuedAt": task.get("queued_at"),
        "availableAt": task.get("available_at"),
        "startedAt": task.get("started_at"),
        "finishedAt": task.get("finished_at"),
        "canceledAt": task.get("canceled_at"),
        "leaseOwner": task.get("lease_owner"),
        "leaseExpiresAt": task.get("lease_expires_at"),
        "phase": metrics["phase"],
        "phaseStartedAt": metrics["phase_started_at"],
        "queuedMs": metrics["queued_ms"],
        "runningMs": metrics["running_ms"],
        "totalMs": metrics["total_ms"],
        "payloadTtlSeconds": redis_ttl_seconds(payload_key(task["id"])),
        "resultTtlSeconds": redis_ttl_seconds(result_key(task["id"])),
        "result": result,
    }


def error_category(error_code: str | None, error_message: str | None = None) -> str | None:
    if not error_code and not error_message:
        return None
    message = (error_message or "").lower()
    code = error_code or ""
    if code == "UPSTREAM_NO_AVAILABLE_ACCOUNTS" or "no available accounts" in message:
        return "account_unavailable"
    if code == "UPSTREAM_RATE_LIMITED":
        return "rate_limited"
    if code in {"UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK", "UPSTREAM_5XX"}:
        return "upstream_unavailable"
    if code in {"IMAGE_DOWNLOAD_TIMEOUT", "IMAGE_DOWNLOAD_FAILED"}:
        return "image_download_failed"
    if code == "PAYLOAD_EXPIRED":
        return "payload_expired"
    if code in {"UPSTREAM_EMPTY_RESULT", "UPSTREAM_BAD_RESPONSE"}:
        return "upstream_bad_response"
    if code == "USER_CANCELED":
        return "canceled"
    if code == "LEASE_EXPIRED":
        return "worker_recovered"
    return "internal_error" if code == "INTERNAL_WORKER_ERROR" else "unknown"


def task_phase_metrics(task: dict[str, Any]) -> dict[str, Any]:
    now = now_ms()
    created_at = task["created_at"]
    queued_at = task.get("queued_at") or created_at
    available_at = task.get("available_at") or queued_at
    started_at = task.get("started_at")
    finished_at = task.get("finished_at")
    status = task["status"]
    retry_count = task.get("retry_count", 0) or 0

    if status == "queued":
        phase = "retry_waiting" if retry_count > 0 and available_at > now else "queued"
        phase_started_at = available_at if phase == "retry_waiting" else queued_at
    elif status == "running":
        phase = "running"
        phase_started_at = started_at or queued_at
    elif status == "succeeded":
        phase = "succeeded"
        phase_started_at = finished_at
    elif status == "failed":
        phase = "failed"
        phase_started_at = finished_at
    elif status == "canceled":
        phase = "canceled"
        phase_started_at = task.get("canceled_at") or finished_at
    else:
        phase = status
        phase_started_at = task.get("updated_at")

    running_end = finished_at or (now if status == "running" else None)
    queued_end = started_at or (now if status == "queued" else finished_at)
    total_end = finished_at or (now if status in {"queued", "running"} else task.get("updated_at") or now)

    return {
        "phase": phase,
        "phase_started_at": phase_started_at,
        "queued_ms": max(0, queued_end - queued_at) if queued_end else None,
        "running_ms": max(0, running_end - started_at) if started_at and running_end else None,
        "total_ms": max(0, total_end - created_at) if total_end else None,
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


def append_task_event(task_id: str, event_type: str, message: str | None = None, metadata: dict[str, Any] | None = None) -> None:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO image_task_events (task_id, event_type, message, metadata, created_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (task_id, event_type, message, Jsonb(metadata) if metadata is not None else None, now_ms()),
            )
        conn.commit()


SAFE_EVENT_METADATA_KEYS = {"retryCount", "maxRetries", "delaySeconds", "errorCode", "imageCount", "stage"}


def public_task_event(event: dict[str, Any]) -> dict[str, Any]:
    metadata = event.get("metadata") or {}
    if isinstance(metadata, str):
        metadata = json.loads(metadata)
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "id": event["id"],
        "type": event["event_type"],
        "message": event.get("message"),
        "metadata": {key: metadata[key] for key in SAFE_EVENT_METADATA_KEYS if key in metadata},
        "createdAt": event["created_at"],
    }


def list_task_events(task_id: str, limit: int = 50) -> list[dict[str, Any]]:
    safe_limit = max(1, min(200, limit))
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, event_type, message, metadata, created_at
                FROM image_task_events
                WHERE task_id = %s
                ORDER BY created_at ASC, id ASC
                LIMIT %s
                """,
                (task_id, safe_limit),
            )
            return [public_task_event(row) for row in cur.fetchall()]


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
    append_task_event(task_id, "created", metadata={"requesterId": requester_id, "idempotencyKey": idempotency_key})
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


def cleanup_expired_task_metadata(now: int | None = None) -> int:
    if TASK_METADATA_TTL_SECONDS <= 0:
        return 0
    cutoff = (now if now is not None else now_ms()) - TASK_METADATA_TTL_SECONDS * 1000
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM image_tasks
                WHERE status IN ('succeeded', 'failed', 'canceled')
                  AND updated_at < %s
                RETURNING id
                """,
                (cutoff,),
            )
            deleted_ids = [row["id"] for row in cur.fetchall()]
        conn.commit()
    if deleted_ids:
        pipe = redis_client.pipeline()
        for task_id in deleted_ids:
            pipe.delete(payload_key(task_id))
            pipe.delete(result_key(task_id))
        pipe.execute()
    return len(deleted_ids)


def cleanup_expired_task_events(now: int | None = None) -> int:
    if TASK_EVENT_TTL_SECONDS <= 0:
        return 0
    cutoff = (now if now is not None else now_ms()) - TASK_EVENT_TTL_SECONDS * 1000
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM image_task_events
                WHERE created_at < %s
                """,
                (cutoff,),
            )
            deleted = cur.rowcount
        conn.commit()
    return deleted
