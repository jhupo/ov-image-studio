from __future__ import annotations

from urllib.parse import urlparse

import requests
from flask import Blueprint, jsonify, request

from .config import (
    DEFAULT_IMAGE_API_URL,
    DELAYED_QUEUE_KEY,
    MAX_CONCURRENT_GLOBAL,
    MAX_CONCURRENT_PER_KEY,
    MAX_CONCURRENT_PER_PROFILE,
    MAX_CONCURRENT_PER_USER,
    QUEUE_KEY,
    TERMINAL_STATES,
    WORKER_COUNT,
    WORKER_ID,
)
from .db import check_db, check_redis, redis_client
from .queue import promote_delayed_tasks, queue_task, remove_task_from_queues
from .tasks import (
    create_task,
    delete_task_payload,
    delete_task_result,
    fetch_task,
    list_tasks,
    load_task_payload,
    public_task,
    update_task,
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
            },
        }
    ), status


@api.route("/tasks", methods=["GET", "POST", "OPTIONS"])
def tasks_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        requester_id = request.args.get("requesterId")
        status = request.args.get("status")
        if status and status not in VALID_TASK_STATUSES:
            return error_response("BAD_REQUEST", "Invalid task status", 400)
        try:
            limit = parse_int_arg("limit", 200) or 200
            before = parse_int_arg("before")
        except ValueError as exc:
            return error_response("BAD_REQUEST", str(exc), 400)
        items = [public_task(task) for task in list_tasks(requester_id, status=status, limit=limit, before=before)]
        next_before = items[-1]["createdAt"] if len(items) == max(1, min(limit, 500)) else None
        return jsonify({"code": 0, "message": "success", "data": {"items": items, "nextBefore": next_before}})

    payload = request.get_json(silent=True) or {}
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
    return jsonify({"code": 0, "message": "success", "data": public_task(task)})


@api.route("/tasks/<task_id>/cancel", methods=["POST", "OPTIONS"])
def cancel_task(task_id: str):
    if request.method == "OPTIONS":
        return ("", 204)
    task = fetch_task(task_id)
    if not task:
        return error_response("NOT_FOUND", "Not found", 404)
    if task["status"] in TERMINAL_STATES:
        return jsonify({"code": 0, "message": "success", "data": public_task(task)})
    remove_task_from_queues(task_id)
    delete_task_payload(task_id)
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
    queue_task(task_id)
    return jsonify({"code": 0, "message": "success", "data": public_task(fetch_task(task_id))})
