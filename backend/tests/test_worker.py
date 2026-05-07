from pathlib import Path
import sys
from unittest import TestCase
from unittest.mock import patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.worker import saturated_concurrency_scopes  # noqa: E402


class WorkerConcurrencyTest(TestCase):
    @patch("app.worker.concurrency_keys")
    @patch("app.worker.redis_client")
    def test_saturated_concurrency_scopes_reports_hit_limits(self, redis_client, concurrency_keys):
        concurrency_keys.return_value = (
            ["global-key", "user-key", "api-key", "profile-key"],
            [80, 20, 20, 20],
        )
        redis_client.mget.return_value = [b"79", b"20", b"21", None]

        scopes = saturated_concurrency_scopes({"id": "task-1"})

        self.assertEqual(scopes, ["user", "apiKey"])
        redis_client.mget.assert_called_once_with(["global-key", "user-key", "api-key", "profile-key"])

    @patch("app.worker.concurrency_keys")
    @patch("app.worker.redis_client")
    def test_saturated_concurrency_scopes_ignores_unlimited_limits(self, redis_client, concurrency_keys):
        concurrency_keys.return_value = (
            ["global-key", "user-key", "api-key", "profile-key"],
            [-1, 20, -1, 20],
        )
        redis_client.mget.return_value = [b"999", b"19", b"999", b"20"]

        scopes = saturated_concurrency_scopes({"id": "task-1"})

        self.assertEqual(scopes, ["profile"])
