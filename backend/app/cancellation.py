from __future__ import annotations

import logging
import threading
from collections.abc import Callable

from .config import CANCEL_KEY_PREFIX, CANCEL_TTL_SECONDS
from .db import redis_client

logger = logging.getLogger("image_studio.cancellation")

_callbacks: dict[str, list[Callable[[], None]]] = {}
_lock = threading.RLock()


def cancel_key(task_id: str) -> str:
    return f"{CANCEL_KEY_PREFIX}:{task_id}"


def is_task_cancelled(task_id: str) -> bool:
    return bool(redis_client.exists(cancel_key(task_id)))


def signal_task_cancel(task_id: str) -> None:
    redis_client.setex(cancel_key(task_id), max(60, CANCEL_TTL_SECONDS), "1")
    with _lock:
        callbacks = list(_callbacks.get(task_id, []))
    for callback in callbacks:
        try:
            callback()
        except Exception:
            logger.exception("task cancel callback failed task_id=%s", task_id)


def clear_task_cancel_signal(task_id: str) -> None:
    redis_client.delete(cancel_key(task_id))


def register_cancel_callback(task_id: str, callback: Callable[[], None]) -> None:
    with _lock:
        _callbacks.setdefault(task_id, []).append(callback)


def unregister_cancel_callback(task_id: str, callback: Callable[[], None]) -> None:
    with _lock:
        callbacks = _callbacks.get(task_id)
        if not callbacks:
            return
        remaining = [item for item in callbacks if item is not callback]
        if remaining:
            _callbacks[task_id] = remaining
        else:
            _callbacks.pop(task_id, None)
