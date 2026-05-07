from __future__ import annotations

import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import create_app  # noqa: E402
from app.tasks import append_task_event, cleanup_expired_task_events, public_task, public_task_event  # noqa: E402


def task_row(**overrides):
    row = {
        "id": "task-1",
        "requester_id": "client:one",
        "status": "queued",
        "priority": 0,
        "retry_count": 0,
        "max_retries": 2,
        "error_code": None,
        "error_message": None,
        "created_at": 1000,
        "updated_at": 1000,
        "queued_at": 1000,
        "available_at": 1000,
        "started_at": None,
        "finished_at": None,
        "canceled_at": None,
        "lease_owner": None,
        "lease_expires_at": None,
        "result_payload": None,
    }
    row.update(overrides)
    return row


class TaskRoutesTest(TestCase):
    def setUp(self):
        self.app = create_app()
        self.client = self.app.test_client()

    @patch("app.routes.create_task")
    def test_create_task_requires_requester_id(self, create_task):
        response = self.client.post("/api/tasks", json={"prompt": "hello"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "BAD_REQUEST")
        create_task.assert_not_called()

    @patch("app.routes.fetch_task")
    def test_task_detail_hides_other_requesters_tasks(self, fetch_task):
        fetch_task.return_value = task_row(requester_id="client:other")

        response = self.client.get("/api/tasks/task-1?requesterId=client:one")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["code"], "NOT_FOUND")

    @patch("app.tasks.redis_ttl_seconds", return_value=60)
    @patch("app.tasks.queue_positions", return_value={"global": None, "user": None, "apiKey": None, "profile": None})
    @patch("app.routes.fetch_task")
    def test_task_detail_allows_matching_requester(self, fetch_task, _positions, _ttl):
        fetch_task.return_value = task_row(status="running")

        response = self.client.get("/api/tasks/task-1?requesterId=client:one")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["requesterId"], "client:one")

    @patch("app.routes.list_task_events")
    @patch("app.routes.fetch_task")
    def test_task_events_hides_other_requesters_tasks(self, fetch_task, list_task_events):
        fetch_task.return_value = task_row(requester_id="client:other")

        response = self.client.get("/api/tasks/task-1/events?requesterId=client:one")

        self.assertEqual(response.status_code, 404)
        list_task_events.assert_not_called()

    @patch("app.routes.list_task_events")
    @patch("app.routes.fetch_task")
    def test_task_events_allows_matching_requester(self, fetch_task, list_task_events):
        fetch_task.return_value = task_row(requester_id="client:one")
        list_task_events.return_value = [{"id": 1, "type": "created", "createdAt": 1234}]

        response = self.client.get("/api/tasks/task-1/events?requesterId=client:one")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["data"][0]["type"], "created")
        list_task_events.assert_called_once_with("task-1", 50)

    @patch("app.routes.redis_client")
    @patch("app.routes.promote_delayed_tasks")
    @patch("app.routes.check_redis", return_value=True)
    @patch("app.routes.check_db", return_value=True)
    def test_health_reports_runtime_config(self, _check_db, _check_redis, _promote, redis_client):
        redis_client.llen.return_value = 0
        redis_client.zcard.return_value = 0

        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        config = response.get_json()["data"]["config"]
        self.assertEqual(config["workerCount"], 20)
        self.assertEqual(config["taskEventTtlSeconds"], 259200)

    @patch("app.routes.queue_task")
    @patch("app.routes.clear_task_cancel_signal")
    @patch("app.routes.update_task")
    @patch("app.routes.load_task_payload")
    @patch("app.routes.fetch_task")
    def test_retry_requires_same_requester(self, fetch_task, load_task_payload, update_task, clear_signal, queue_task):
        fetch_task.return_value = task_row(status="failed", requester_id="client:other")
        load_task_payload.return_value = {"prompt": "hello"}

        response = self.client.post("/api/tasks/task-1/retry?requesterId=client:one")

        self.assertEqual(response.status_code, 404)
        update_task.assert_not_called()
        clear_signal.assert_not_called()
        queue_task.assert_not_called()


class PublicTaskTest(TestCase):
    @patch("app.tasks.redis_ttl_seconds", return_value=60)
    @patch("app.tasks.queue_positions", return_value={"global": None, "user": None, "apiKey": None, "profile": None})
    @patch("app.tasks.load_task_result")
    def test_public_task_uses_summary_unless_result_is_requested(self, load_task_result, _positions, _ttl):
        row = task_row(
            status="succeeded",
            result_payload={"imageCount": 2, "imagesStored": "redis_ttl"},
            finished_at=3000,
        )
        load_task_result.return_value = {"images": ["data:image/png;base64,a", "data:image/png;base64,b"]}

        summary = public_task(row)
        full = public_task(row, include_result=True)

        self.assertNotIn("images", summary["result"])
        self.assertEqual(summary["result"]["imageCount"], 2)
        self.assertEqual(full["result"]["images"], ["data:image/png;base64,a", "data:image/png;base64,b"])

    @patch("app.tasks.redis_ttl_seconds", return_value=60)
    @patch("app.tasks.queue_positions", return_value={"global": 8, "user": 2, "apiKey": 5, "profile": 7})
    def test_public_task_exposes_user_queue_position_only(self, _positions, _ttl):
        row = task_row(status="queued")

        payload = public_task(row)

        self.assertEqual(payload["queuePosition"], 2)
        self.assertEqual(payload["queuePositions"], {"user": 2})


class TaskEventsTest(TestCase):
    @patch("app.tasks.now_ms", return_value=1234)
    @patch("app.tasks.db_conn")
    def test_append_task_event_writes_event_row(self, db_conn, _now_ms):
        conn = db_conn.return_value.__enter__.return_value
        cursor = conn.cursor.return_value.__enter__.return_value

        append_task_event("task-1", "upstream_request", metadata={"workerId": "worker-1"})

        sql, args = cursor.execute.call_args.args
        self.assertIn("INSERT INTO image_task_events", sql)
        self.assertEqual(args[0], "task-1")
        self.assertEqual(args[1], "upstream_request")
        self.assertEqual(args[4], 1234)
        conn.commit.assert_called_once()

    def test_public_task_event_hides_internal_metadata(self):
        event = public_task_event(
            {
                "id": 1,
                "event_type": "claimed",
                "message": None,
                "metadata": {
                    "workerId": "worker-secret",
                    "requesterId": "client:one",
                    "retryCount": 1,
                    "errorCode": "UPSTREAM_TIMEOUT",
                    "waitReason": "concurrency",
                    "saturatedScopes": ["global", "apiKey"],
                },
                "created_at": 1234,
            }
        )

        self.assertEqual(
            event["metadata"],
            {"retryCount": 1, "errorCode": "UPSTREAM_TIMEOUT", "waitReason": "concurrency"},
        )

    @patch("app.tasks.TASK_EVENT_TTL_SECONDS", 10)
    @patch("app.tasks.now_ms", return_value=20_000)
    @patch("app.tasks.db_conn")
    def test_cleanup_expired_task_events_deletes_old_rows(self, db_conn, _now_ms):
        conn = db_conn.return_value.__enter__.return_value
        cursor = conn.cursor.return_value.__enter__.return_value
        cursor.rowcount = 3

        deleted = cleanup_expired_task_events()

        sql, args = cursor.execute.call_args.args
        self.assertIn("DELETE FROM image_task_events", sql)
        self.assertEqual(args[0], 10_000)
        self.assertEqual(deleted, 3)
        conn.commit.assert_called_once()
