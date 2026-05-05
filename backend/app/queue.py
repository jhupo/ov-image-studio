from __future__ import annotations

from .config import DELAYED_QUEUE_KEY, QUEUE_KEY, REBUILD_QUEUE_ON_START
from .db import db_conn, redis_client
from .timeutil import now_ms


def queue_task(task_id: str, available_at: int | None = None) -> None:
    if available_at and available_at > now_ms():
        redis_client.zadd(DELAYED_QUEUE_KEY, {task_id: available_at})
    else:
        redis_client.lpush(QUEUE_KEY, task_id)


def promote_delayed_tasks(limit: int = 100) -> None:
    due = redis_client.zrangebyscore(DELAYED_QUEUE_KEY, 0, now_ms(), start=0, num=limit)
    if not due:
        return
    pipe = redis_client.pipeline()
    for task_id in due:
        pipe.zrem(DELAYED_QUEUE_KEY, task_id)
        pipe.lpush(QUEUE_KEY, task_id)
    pipe.execute()


def remove_task_from_queues(task_id: str) -> None:
    redis_client.lrem(QUEUE_KEY, 0, task_id)
    redis_client.zrem(DELAYED_QUEUE_KEY, task_id)


def queue_position(task: dict) -> int | None:
    return queue_positions(task)["global"]


def ordered_queue_ids() -> list[str]:
    queued = list(reversed(redis_client.lrange(QUEUE_KEY, 0, -1)))
    delayed = redis_client.zrange(DELAYED_QUEUE_KEY, 0, -1)
    return queued + [task_id for task_id in delayed if task_id not in queued]


def queue_positions(task: dict) -> dict[str, int | None]:
    empty = {"global": None, "user": None, "apiKey": None, "profile": None}
    if task["status"] != "queued":
        return empty

    ordered = ordered_queue_ids()
    try:
        target_index = ordered.index(task["id"])
    except ValueError:
        return empty

    rows_by_id: dict[str, dict] = {}
    if ordered:
        with db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, requester_id, api_key_fingerprint, profile_fingerprint
                    FROM image_tasks
                    WHERE id = ANY(%s)
                    """,
                    (ordered,),
                )
                rows_by_id = {row["id"]: row for row in cur.fetchall()}

    target = rows_by_id.get(task["id"], task)
    user_position = 0
    key_position = 0
    profile_position = 0
    for queued_id in ordered[: target_index + 1]:
        row = rows_by_id.get(queued_id)
        if not row:
            continue
        if target.get("requester_id") and row.get("requester_id") == target.get("requester_id"):
            user_position += 1
        if row.get("api_key_fingerprint") == target.get("api_key_fingerprint"):
            key_position += 1
        if row.get("profile_fingerprint") == target.get("profile_fingerprint"):
            profile_position += 1

    return {
        "global": target_index + 1,
        "user": user_position or None,
        "apiKey": key_position or None,
        "profile": profile_position or None,
    }


def rebuild_queue_from_db() -> None:
    if not REBUILD_QUEUE_ON_START:
        return
    redis_client.delete(QUEUE_KEY)
    redis_client.delete(DELAYED_QUEUE_KEY)
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, available_at
                FROM image_tasks
                WHERE status = 'queued'
                ORDER BY priority DESC, queued_at DESC, created_at DESC
                """
            )
            rows = cur.fetchall()
    for row in rows:
        queue_task(row["id"], row["available_at"])
