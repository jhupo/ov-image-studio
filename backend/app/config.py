from __future__ import annotations

import os
import socket
import uuid


DEFAULT_IMAGE_API_URL = os.environ.get("DEFAULT_IMAGE_API_URL", "https://dash.classicriver.cn/v1")
POSTGRES_DSN = os.environ.get(
    "POSTGRES_DSN",
    "postgresql://postgres:postgres@127.0.0.1:5432/chaincloud_image_studio",
)
REDIS_URL = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
PORT = int(os.environ.get("IMAGE_STUDIO_PORT", "8787"))
WORKER_COUNT = int(os.environ.get("IMAGE_STUDIO_WORKER_COUNT", "20"))
MAX_RETRIES = int(os.environ.get("IMAGE_STUDIO_MAX_RETRIES", "2"))
RETRY_BASE_DELAY_SECONDS = int(os.environ.get("IMAGE_STUDIO_RETRY_BASE_DELAY_SECONDS", "20"))
LEASE_SECONDS = int(os.environ.get("IMAGE_STUDIO_LEASE_SECONDS", "90"))
LEASE_RENEW_SECONDS = max(5, min(30, LEASE_SECONDS // 3))
TASK_TIMEOUT_SECONDS = int(os.environ.get("IMAGE_STUDIO_TASK_TIMEOUT_SECONDS", "900"))
MAX_CONCURRENT_GLOBAL = int(os.environ.get("IMAGE_STUDIO_MAX_CONCURRENT", "80"))
MAX_CONCURRENT_PER_USER = int(os.environ.get("IMAGE_STUDIO_MAX_CONCURRENT_PER_USER", "20"))
MAX_CONCURRENT_PER_KEY = int(os.environ.get("IMAGE_STUDIO_MAX_CONCURRENT_PER_KEY", "20"))
MAX_CONCURRENT_PER_PROFILE = int(os.environ.get("IMAGE_STUDIO_MAX_CONCURRENT_PER_PROFILE", "20"))
QUEUE_KEY = os.environ.get("IMAGE_STUDIO_QUEUE_KEY", "chaincloud:image_tasks:queue")
DELAYED_QUEUE_KEY = os.environ.get("IMAGE_STUDIO_DELAYED_QUEUE_KEY", "chaincloud:image_tasks:delayed")
CONCURRENCY_PREFIX = os.environ.get("IMAGE_STUDIO_CONCURRENCY_PREFIX", "chaincloud:image_tasks:concurrency")
PAYLOAD_KEY_PREFIX = os.environ.get("IMAGE_STUDIO_PAYLOAD_KEY_PREFIX", "chaincloud:image_tasks:payload")
RESULT_KEY_PREFIX = os.environ.get("IMAGE_STUDIO_RESULT_KEY_PREFIX", "chaincloud:image_tasks:result")
CANCEL_KEY_PREFIX = os.environ.get("IMAGE_STUDIO_CANCEL_KEY_PREFIX", "chaincloud:image_tasks:cancel")
PAYLOAD_TTL_SECONDS = int(os.environ.get("IMAGE_STUDIO_PAYLOAD_TTL_SECONDS", "86400"))
RESULT_TTL_SECONDS = int(os.environ.get("IMAGE_STUDIO_RESULT_TTL_SECONDS", "86400"))
CANCEL_TTL_SECONDS = int(os.environ.get("IMAGE_STUDIO_CANCEL_TTL_SECONDS", "3600"))
CANCEL_POLL_INTERVAL_SECONDS = float(os.environ.get("IMAGE_STUDIO_CANCEL_POLL_INTERVAL_SECONDS", "0.5"))
TASK_METADATA_TTL_SECONDS = int(os.environ.get("IMAGE_STUDIO_TASK_METADATA_TTL_SECONDS", str(7 * 86400)))
TASK_EVENT_TTL_SECONDS = int(os.environ.get("IMAGE_STUDIO_TASK_EVENT_TTL_SECONDS", str(3 * 86400)))
CLEANUP_INTERVAL_SECONDS = int(os.environ.get("IMAGE_STUDIO_CLEANUP_INTERVAL_SECONDS", "3600"))
REBUILD_QUEUE_ON_START = os.environ.get("IMAGE_STUDIO_REBUILD_QUEUE_ON_START", "true").lower() in {"1", "true", "yes"}
UPSCALER_URL = os.environ.get("IMAGE_STUDIO_UPSCALER_URL", "").rstrip("/")
UPSCALER_TOKEN = os.environ.get("IMAGE_STUDIO_UPSCALER_TOKEN", "")
UPSCALER_POLL_INTERVAL_SECONDS = float(os.environ.get("IMAGE_STUDIO_UPSCALER_POLL_INTERVAL_SECONDS", "3"))
UPSCALER_TIMEOUT_SECONDS = int(os.environ.get("IMAGE_STUDIO_UPSCALER_TIMEOUT_SECONDS", "3600"))
UPSCALER_REQUEST_TIMEOUT_SECONDS = int(os.environ.get("IMAGE_STUDIO_UPSCALER_REQUEST_TIMEOUT_SECONDS", "60"))
UPSCALER_DELETE_REMOTE_RESULT = os.environ.get("IMAGE_STUDIO_UPSCALER_DELETE_REMOTE_RESULT", "true").lower() in {"1", "true", "yes"}

TERMINAL_STATES = {"succeeded", "failed", "canceled"}
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
