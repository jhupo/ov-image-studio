from __future__ import annotations

import threading
import time
import logging

from .cancellation import clear_task_cancel_signal, is_task_cancelled
from .config import (
    CLEANUP_INTERVAL_SECONDS,
    CONCURRENCY_PREFIX,
    DELAYED_QUEUE_KEY,
    LEASE_RENEW_SECONDS,
    LEASE_SECONDS,
    MAX_CONCURRENT_GLOBAL,
    MAX_CONCURRENT_PER_KEY,
    MAX_CONCURRENT_PER_PROFILE,
    MAX_CONCURRENT_PER_USER,
    QUEUE_KEY,
    RETRY_BASE_DELAY_SECONDS,
    WORKER_COUNT,
    WORKER_ID,
)
from .db import db_conn, redis_client
from .queue import promote_delayed_tasks, queue_task
from .tasks import (
    cleanup_expired_task_metadata,
    cleanup_expired_task_events,
    fetch_task,
    load_task_payload,
    renew_task_lease,
    store_task_result,
    summarize_result_payload,
    update_task,
    delete_task_payload,
    append_task_event,
)
from .timeutil import now_ms
from .upstream import TaskExecutionError, call_openai_task
from .upscale import upscale_result_if_needed

logger = logging.getLogger("image_studio.worker")

ACQUIRE_CONCURRENCY_SCRIPT = """
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  local limit = tonumber(ARGV[i + 1])
  if limit >= 0 and current >= limit then
    return 0
  end
end
for i = 1, #KEYS do
  redis.call('INCR', KEYS[i])
  redis.call('EXPIRE', KEYS[i], ttl)
end
return 1
"""

RELEASE_CONCURRENCY_SCRIPT = """
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current <= 1 then
    redis.call('DEL', KEYS[i])
  else
    redis.call('DECR', KEYS[i])
  end
end
return 1
"""


def concurrency_keys(task: dict) -> tuple[list[str], list[int]]:
    requester = task.get("requester_id") or "anonymous"
    return (
        [
            f"{CONCURRENCY_PREFIX}:global",
            f"{CONCURRENCY_PREFIX}:user:{requester}",
            f"{CONCURRENCY_PREFIX}:key:{task['api_key_fingerprint']}",
            f"{CONCURRENCY_PREFIX}:profile:{task['profile_fingerprint']}",
        ],
        [
            MAX_CONCURRENT_GLOBAL,
            MAX_CONCURRENT_PER_USER,
            MAX_CONCURRENT_PER_KEY,
            MAX_CONCURRENT_PER_PROFILE,
        ],
    )


def acquire_concurrency(task: dict) -> bool:
    keys, limits = concurrency_keys(task)
    return bool(redis_client.eval(ACQUIRE_CONCURRENCY_SCRIPT, len(keys), *keys, LEASE_SECONDS * 3, *limits))


def saturated_concurrency_scopes(task: dict) -> list[str]:
    keys, limits = concurrency_keys(task)
    scopes = ["global", "user", "apiKey", "profile"]
    saturated: list[str] = []
    if not keys:
        return saturated
    values = redis_client.mget(keys)
    for scope, raw_value, limit in zip(scopes, values, limits):
        if limit < 0:
            continue
        try:
            current = int(raw_value or 0)
        except (TypeError, ValueError):
            current = 0
        if current >= limit:
            saturated.append(scope)
    return saturated


def release_concurrency(task: dict) -> None:
    keys, _ = concurrency_keys(task)
    redis_client.eval(RELEASE_CONCURRENCY_SCRIPT, len(keys), *keys)


def recover_expired_leases() -> None:
    now = now_ms()
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE image_tasks
                SET status = 'queued',
                    available_at = %s,
                    queued_at = %s,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    error_code = 'LEASE_EXPIRED',
                    error_message = 'Worker lease expired before completion',
                    updated_at = %s
                WHERE status = 'running'
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at < %s
                RETURNING id
                """,
                (now, now, now, now),
            )
            expired = [row["id"] for row in cur.fetchall()]
        conn.commit()
    for task_id in expired:
        logger.warning("task lease expired; requeued task_id=%s", task_id)
        queue_task(task_id)


def fallback_pick_queued_task_id() -> str | None:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id
                FROM image_tasks
                WHERE status = 'queued' AND available_at <= %s
                ORDER BY priority DESC, queued_at ASC, created_at ASC
                LIMIT 1
                """,
                (now_ms(),),
            )
            row = cur.fetchone()
            return row["id"] if row else None


def claim_task(task_id: str) -> dict | None:
    now = now_ms()
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM image_tasks WHERE id = %s FOR UPDATE SKIP LOCKED", (task_id,))
            task = cur.fetchone()
            if not task or task["status"] != "queued" or task["available_at"] > now:
                conn.rollback()
                return None
            if not acquire_concurrency(task):
                conn.rollback()
                saturated_scopes = saturated_concurrency_scopes(task)
                logger.info(
                    "task waiting for concurrency task_id=%s scopes=%s requester=%s",
                    task_id,
                    ",".join(saturated_scopes) or "unknown",
                    task.get("requester_id") or "anonymous",
                )
                append_task_event(
                    task_id,
                    "concurrency_waiting",
                    metadata={
                        "waitReason": "concurrency",
                        "saturatedScopes": saturated_scopes,
                    },
                )
                queue_task(task_id, now + 1000)
                return None
            cur.execute(
                """
                UPDATE image_tasks
                SET status = 'running',
                    started_at = COALESCE(started_at, %s),
                    lease_owner = %s,
                    lease_expires_at = %s,
                    error_code = NULL,
                    error_message = NULL,
                    updated_at = %s
                WHERE id = %s
                """,
                (now, WORKER_ID, now + LEASE_SECONDS * 1000, now, task_id),
            )
        conn.commit()
    claimed = fetch_task(task_id)
    if claimed:
        append_task_event(
            task_id,
            "claimed",
            metadata={
                "workerId": WORKER_ID,
                "retryCount": claimed.get("retry_count", 0),
                "maxRetries": claimed.get("max_retries", 0),
            },
        )
        logger.info(
            "task started task_id=%s worker_id=%s retry=%s/%s requester=%s",
            task_id,
            WORKER_ID,
            claimed.get("retry_count", 0),
            claimed.get("max_retries", 0),
            claimed.get("requester_id") or "anonymous",
        )
    return claimed


def lease_renewer(task_id: str, stop: threading.Event) -> None:
    while not stop.wait(LEASE_RENEW_SECONDS):
        renewed = renew_task_lease(task_id, WORKER_ID, now_ms() + LEASE_SECONDS * 1000)
        if not renewed:
            return


def finish_task(task: dict, status: str, result: dict | None = None, error_code: str | None = None, error_message: str | None = None) -> None:
    try:
        latest = fetch_task(task["id"])
        if latest and latest["status"] == "canceled":
            update_task(task["id"], lease_owner=None, lease_expires_at=None)
            return
        if status == "succeeded" and result is not None:
            store_task_result(task["id"], result)
        update_task(
            task["id"],
            status=status,
            result_payload=summarize_result_payload(result),
            error_code=error_code,
            error_message=error_message,
            finished_at=now_ms(),
            lease_owner=None,
            lease_expires_at=None,
        )
        if status == "succeeded":
            append_task_event(
                task["id"],
                "succeeded",
                metadata={"workerId": WORKER_ID, "imageCount": len(result.get("images") or []) if result else 0},
            )
            logger.info(
                "task succeeded task_id=%s worker_id=%s image_count=%s elapsed_ms=%s",
                task["id"],
                WORKER_ID,
                len(result.get("images") or []) if result else 0,
                now_ms() - task["created_at"],
            )
        else:
            append_task_event(
                task["id"],
                status,
                message=error_message,
                metadata={"workerId": WORKER_ID, "errorCode": error_code},
            )
            logger.error(
                "task finished with error task_id=%s worker_id=%s status=%s error_code=%s error=%s",
                task["id"],
                WORKER_ID,
                status,
                error_code,
                error_message,
            )
    finally:
        if status in {"succeeded", "failed"}:
            clear_task_cancel_signal(task["id"])
        release_concurrency(task)


def retry_or_fail_task(task: dict, error: TaskExecutionError) -> None:
    latest = fetch_task(task["id"])
    if latest and latest["status"] == "canceled":
        release_concurrency(task)
        return
    can_retry = error.retryable and task["retry_count"] < task["max_retries"]
    if not can_retry:
        finish_task(task, "failed", error_code=error.code, error_message=str(error))
        return
    retry_count = task["retry_count"] + 1
    delay = RETRY_BASE_DELAY_SECONDS * (2 ** (retry_count - 1))
    available_at = now_ms() + delay * 1000
    update_task(
        task["id"],
        status="queued",
        retry_count=retry_count,
        available_at=available_at,
        queued_at=now_ms(),
        error_code=error.code,
        error_message=str(error),
        lease_owner=None,
        lease_expires_at=None,
    )
    logger.warning(
        "task retry scheduled task_id=%s worker_id=%s retry=%s/%s delay_seconds=%s error_code=%s error=%s",
        task["id"],
        WORKER_ID,
        retry_count,
        task["max_retries"],
        delay,
        error.code,
        str(error),
    )
    append_task_event(
        task["id"],
        "retry_scheduled",
        message=str(error),
        metadata={"workerId": WORKER_ID, "retryCount": retry_count, "delaySeconds": delay, "errorCode": error.code},
    )
    release_concurrency(task)
    queue_task(task["id"], available_at)


def execute_claimed_task(task: dict) -> None:
    payload = load_task_payload(task["id"])
    if payload is None:
        finish_task(
            task,
            "failed",
            error_code="PAYLOAD_EXPIRED",
            error_message="Task payload expired before execution",
        )
        return
    stop = threading.Event()
    renewer = threading.Thread(target=lease_renewer, args=(task["id"], stop), daemon=True)
    renewer.start()
    try:
        latest = fetch_task(task["id"])
        if (latest and latest["status"] == "canceled") or is_task_cancelled(task["id"]):
            append_task_event(task["id"], "canceled", metadata={"workerId": WORKER_ID, "stage": "before_upstream"})
            release_concurrency(task)
            return
        logger.info("task requesting upstream task_id=%s worker_id=%s", task["id"], WORKER_ID)
        append_task_event(task["id"], "upstream_request", metadata={"workerId": WORKER_ID})
        payload = {**payload, "_taskId": task["id"]}
        result = call_openai_task(payload)
        result = upscale_result_if_needed(payload, result, stage_callback=lambda event_type, message, metadata: record_upscale_stage(task["id"], event_type, message, metadata))
        finish_task(task, "succeeded", result=result)
        delete_task_payload(task["id"])
    except TaskExecutionError as exc:
        retry_or_fail_task(task, exc)
    except Exception as exc:
        retry_or_fail_task(task, TaskExecutionError("INTERNAL_WORKER_ERROR", str(exc), False))
    finally:
        stop.set()


def record_upscale_stage(task_id: str, event_type: str, message: str | None, metadata: dict | None) -> None:
    metadata = metadata or {}
    update_task(
        task_id,
        result_payload={
            "phase": "upscaling",
            "phaseStartedAt": now_ms(),
            "message": message,
            "metadata": {key: metadata[key] for key in ("imageIndex", "sourceSize", "targetSize") if key in metadata},
        },
    )
    append_task_event(task_id, event_type, message=message, metadata={**metadata, "workerId": WORKER_ID})


def worker_loop() -> None:
    while True:
        try:
            promote_delayed_tasks()
            recover_expired_leases()
            popped = redis_client.brpop(QUEUE_KEY, timeout=2)
            task_id = popped[1] if popped else fallback_pick_queued_task_id()
            if not task_id:
                continue
            task = claim_task(task_id)
            if task:
                execute_claimed_task(task)
        except Exception:
            logger.exception("worker loop error worker_id=%s", WORKER_ID)
            time.sleep(1)


def cleanup_loop() -> None:
    while True:
        try:
            deleted_metadata = cleanup_expired_task_metadata()
            deleted_events = cleanup_expired_task_events()
            if deleted_metadata or deleted_events:
                logger.info("task cleanup deleted_metadata=%s deleted_events=%s", deleted_metadata, deleted_events)
        except Exception:
            logger.exception("task cleanup failed worker_id=%s", WORKER_ID)
        time.sleep(max(60, CLEANUP_INTERVAL_SECONDS))


def start_workers() -> None:
    for index in range(max(1, WORKER_COUNT)):
        worker = threading.Thread(target=worker_loop, name=f"image-worker-{index + 1}", daemon=True)
        worker.start()
    cleaner = threading.Thread(target=cleanup_loop, name="image-task-cleanup", daemon=True)
    cleaner.start()
