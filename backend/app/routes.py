from __future__ import annotations

from urllib.parse import urlparse

import requests
from flask import Blueprint, jsonify, request

from .cancellation import clear_task_cancel_signal, signal_task_cancel
from .config import (
    DEFAULT_IMAGE_API_URL,
    DELAYED_QUEUE_KEY,
    CLEANUP_INTERVAL_SECONDS,
    CANCEL_POLL_INTERVAL_SECONDS,
    CANCEL_TTL_SECONDS,
    MAX_CONCURRENT_GLOBAL,
    MAX_CONCURRENT_PER_KEY,
    MAX_CONCURRENT_PER_PROFILE,
    MAX_CONCURRENT_PER_USER,
    MAX_RETRIES,
    PAYLOAD_TTL_SECONDS,
    QUEUE_KEY,
    RESULT_TTL_SECONDS,
    TASK_EVENT_TTL_SECONDS,
    TASK_METADATA_TTL_SECONDS,
    TASK_TIMEOUT_SECONDS,
    TERMINAL_STATES,
    WORKER_COUNT,
    WORKER_ID,
)
from .db import check_db, check_redis, redis_client
from .queue import promote_delayed_tasks, queue_task, remove_task_from_queues
from .tasks import (
    create_task,
    delete_task_result,
    fetch_task,
    load_task_payload,
    list_task_events,
    public_task,
    update_task,
    append_task_event,
)
from .timeutil import now_ms

api = Blueprint("api", __name__, url_prefix="/api")
VALID_TASK_STATUSES = {"queued", "running", "succeeded", "failed", "canceled"}


def error_response(code: str, message: str, status: int):
    return jsonify({"code": code, "message": message}), status


def parse_int_arg(name: str, default: int | None = None) -> int | None:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def parse_requester_id_from_request() -> str:
    return (
        request.headers.get("X-Requester-Id")
        or request.args.get("requesterId")
        or ""
    ).strip()


def ensure_task_owner(task: dict, requester_id: str):
    task_requester_id = str(task.get("requester_id") or "").strip()
    if not task_requester_id:
        return None
    if not requester_id:
        return error_response("FORBIDDEN", "Missing requester id", 403)
    if task_requester_id != requester_id:
        return error_response("NOT_FOUND", "Not found", 404)
    return None


def should_include_task_result() -> bool:
    return request.args.get("includeResult", "").strip().lower() in {"1", "true", "yes"}


def sub2api_origin() -> str:
    parsed = urlparse(DEFAULT_IMAGE_API_URL)
    if not parsed.scheme or not parsed.netloc:
        return DEFAULT_IMAGE_API_URL.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}"


def fetch_sub2api_keys(user_id: int, authorization: str) -> requests.Response:
    origin = sub2api_origin()
    headers = {"Authorization": authorization, "Accept": "application/json"}
    params = {"page": "1", "page_size": "100"}
    response = requests.get(
        f"{origin}/api/v1/keys",
        params=params,
        headers=headers,
        timeout=30,
    )
    if response.status_code == 200:
        return response
    return requests.get(
        f"{origin}/api/v1/admin/users/{user_id}/api-keys",
        params=params,
        headers=headers,
        timeout=30,
    )


@api.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return ("", 204)
    db_ok = False
    redis_ok = False
    try:
        db_ok = check_db()
        redis_ok = check_redis()
        promote_delayed_tasks()
    except Exception:
        pass
    status = 200 if db_ok and redis_ok else 503
    return jsonify(
        {
            "code": 0 if status == 200 else "UNHEALTHY",
            "message": "ok" if status == 200 else "dependency unavailable",
            "data": {
                "db": db_ok,
                "redis": redis_ok,
                "workerId": WORKER_ID,
                "workers": WORKER_COUNT,
                "queued": redis_client.llen(QUEUE_KEY) if redis_ok else None,
                "delayed": redis_client.zcard(DELAYED_QUEUE_KEY) if redis_ok else None,
                "limits": {
                    "global": MAX_CONCURRENT_GLOBAL,
                    "perUser": MAX_CONCURRENT_PER_USER,
                    "perKey": MAX_CONCURRENT_PER_KEY,
                    "perProfile": MAX_CONCURRENT_PER_PROFILE,
                },
                "config": {
                    "workerCount": WORKER_COUNT,
                    "maxRetries": MAX_RETRIES,
                    "taskTimeoutSeconds": TASK_TIMEOUT_SECONDS,
                    "payloadTtlSeconds": PAYLOAD_TTL_SECONDS,
                    "resultTtlSeconds": RESULT_TTL_SECONDS,
                    "cancelTtlSeconds": CANCEL_TTL_SECONDS,
                    "cancelPollIntervalSeconds": CANCEL_POLL_INTERVAL_SECONDS,
                    "taskMetadataTtlSeconds": TASK_METADATA_TTL_SECONDS,
                    "taskEventTtlSeconds": TASK_EVENT_TTL_SECONDS,
                    "cleanupIntervalSeconds": CLEANUP_INTERVAL_SECONDS,
                },
            },
        }
    ), status


@api.route("/tasks", methods=["GET", "POST", "OPTIONS"])
def tasks_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        return error_response("NOT_FOUND", "Not found", 404)

    payload = request.get_json(silent=True) or {}
    requester_id = str(payload.get("requesterId") or "").strip()
    if not requester_id:
        return error_response("BAD_REQUEST", "requesterId is required", 400)
    payload["requesterId"] = requester_id
    idempotency_key = request.headers.get("Idempotency-Key") or payload.get("idempotencyKey")
    if idempotency_key is not None:
        idempotency_key = str(idempotency_key).strip()
        if not idempotency_key:
            idempotency_key = None
        elif len(idempotency_key) > 200:
            return error_response("BAD_REQUEST", "Idempotency-Key is too long", 400)
    try:
        task = create_task(payload, idempotency_key)
    except ValueError as exc:
        return error_response("BAD_REQUEST", str(exc), 400)
    return jsonify({"code": 0, "message": "success", "data": public_task(task)}), 201


@api.route("/tasks/<task_id>", methods=["GET", "OPTIONS"])
def task_detail(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    task = fetch_task(task_id)
    if not task:
        return error_response("NOT_FOUND", "Not found", 404)
    owner_error = ensure_task_owner(task, parse_requester_id_from_request())
    if owner_error:
        return owner_error
    return jsonify({"code": 0, "message": "success", "data": public_task(task, include_result=should_include_task_result())})


@api.route("/tasks/<task_id>/events", methods=["GET", "OPTIONS"])
def task_events(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    task = fetch_task(task_id)
    if not task:
        return error_response("NOT_FOUND", "Not found", 404)
    owner_error = ensure_task_owner(task, parse_requester_id_from_request())
    if owner_error:
        return owner_error
    try:
        limit = parse_int_arg("limit", 50) or 50
    except ValueError as exc:
        return error_response("BAD_REQUEST", str(exc), 400)
    return jsonify({"code": 0, "message": "success", "data": list_task_events(task_id, limit)})


@api.route("/tasks/<task_id>/cancel", methods=["POST", "OPTIONS"])
def cancel_task(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    task = fetch_task(task_id)
    if not task:
        return error_response("NOT_FOUND", "Not found", 404)
    owner_error = ensure_task_owner(task, parse_requester_id_from_request())
    if owner_error:
        return owner_error
    if task["status"] in TERMINAL_STATES:
        return jsonify({"code": 0, "message": "success", "data": public_task(task)})
    signal_task_cancel(task_id)
    append_task_event(task_id, "cancel_requested")
    remove_task_from_queues(task_id)
    delete_task_result(task_id)
    update_task(
        task_id,
        status="canceled",
        error_code="USER_CANCELED",
        error_message="Task canceled by requester",
        canceled_at=now_ms(),
        finished_at=now_ms(),
        lease_owner=None,
        lease_expires_at=None,
    )
    return jsonify({"code": 0, "message": "success", "data": public_task(fetch_task(task_id))})


@api.route("/embedded/keys", methods=["GET", "OPTIONS"])
def embedded_keys():
    if request.method == "OPTIONS":
        return ("", 204)
    token = request.headers.get("Authorization", "")
    try:
        user_id = parse_int_arg("userId")
    except ValueError as exc:
        return error_response("BAD_REQUEST", str(exc), 400)
    if not user_id or user_id <= 0:
        return error_response("BAD_REQUEST", "userId is required", 400)
    if not token.startswith("Bearer "):
        return error_response("UNAUTHORIZED", "Missing bearer token", 401)

    try:
        response = fetch_sub2api_keys(user_id, token)
    except requests.RequestException as exc:
        return error_response("UPSTREAM_UNAVAILABLE", str(exc), 502)

    content_type = response.headers.get("Content-Type", "")
    if "application/json" not in content_type.lower():
        return error_response("UPSTREAM_BAD_RESPONSE", "Embedded host did not return JSON", 502)
    return jsonify(response.json()), response.status_code


@api.route("/tasks/<task_id>/retry", methods=["POST", "OPTIONS"])
def retry_task(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    task = fetch_task(task_id)
    if not task:
        return error_response("NOT_FOUND", "Not found", 404)
    owner_error = ensure_task_owner(task, parse_requester_id_from_request())
    if owner_error:
        return owner_error
    if task["status"] not in {"failed", "canceled"}:
        return error_response("BAD_REQUEST", "Only failed or canceled tasks can be retried", 400)
    if load_task_payload(task_id) is None:
        return error_response("PAYLOAD_EXPIRED", "Task input images have expired; create a new task from the client", 409)
    now = now_ms()
    update_task(
        task_id,
        status="queued",
        retry_count=0,
        error_code=None,
        error_message=None,
        result_payload=None,
        queued_at=now,
        available_at=now,
        started_at=None,
        finished_at=None,
        canceled_at=None,
        lease_owner=None,
        lease_expires_at=None,
    )
    clear_task_cancel_signal(task_id)
    queue_task(task_id)
    append_task_event(task_id, "retry_requested")
    return jsonify({"code": 0, "message": "success", "data": public_task(fetch_task(task_id))})
