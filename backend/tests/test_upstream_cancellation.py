from __future__ import annotations

import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

import requests


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.upstream import TaskExecutionError, request_with_cancellation  # noqa: E402


class UpstreamCancellationTest(TestCase):
    @patch("app.upstream.TaskCancelWatcher")
    @patch("app.upstream.register_cancel_callback")
    @patch("app.upstream.unregister_cancel_callback")
    @patch("app.upstream.raise_if_cancelled")
    @patch("app.upstream.requests.Session")
    def test_request_cancellation_closes_session_and_raises_user_canceled(
        self,
        session_cls,
        raise_if_cancelled,
        unregister_cancel_callback,
        register_cancel_callback,
        watcher_cls,
    ):
        session = Mock()
        session.request.side_effect = requests.ConnectionError("connection closed")
        session_cls.return_value = session

        def watcher_enter():
            session.close()
            callback = register_cancel_callback.call_args.args[1]
            callback()

        watcher = Mock()
        watcher.__enter__ = Mock(side_effect=watcher_enter)
        watcher.__exit__ = Mock(return_value=None)
        watcher_cls.return_value = watcher

        with self.assertRaises(TaskExecutionError) as caught:
            request_with_cancellation("task-1", "POST", "http://example.test", timeout=30)

        self.assertEqual(caught.exception.code, "USER_CANCELED")
        session.close.assert_called()
        unregister_cancel_callback.assert_called_once()
        raise_if_cancelled.assert_called_once_with("task-1")
