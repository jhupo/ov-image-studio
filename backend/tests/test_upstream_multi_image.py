from __future__ import annotations

import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch

import requests


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.upstream import call_openai_task  # noqa: E402


TINY_PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def payload(n: int = 3, input_images: list[str] | None = None):
    return {
        "_taskId": "task-1",
        "profile": {
            "provider": "openai",
            "apiKey": "sk-test",
            "model": "gpt-image-2",
            "imageApiBaseUrl": "http://upstream.test/v1",
            "timeout": 30,
        },
        "params": {
            "size": "auto",
            "quality": "auto",
            "output_format": "png",
            "output_compression": None,
            "moderation": "auto",
            "n": n,
        },
        "prompt": "hello",
        "inputImageDataUrls": input_images or [],
    }


def ok_response(image: str):
    response = Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "data": [{"b64_json": image}],
        "size": "auto",
        "output_format": "png",
    }
    return response


def bad_response(message: str = "temporary upstream failure"):
    response = requests.Response()
    response.status_code = 502
    response._content = message.encode("utf-8")
    error = requests.HTTPError(message)
    error.response = response
    wrapped = Mock()
    wrapped.raise_for_status.side_effect = error
    return wrapped


class MultiImageUpstreamTest(TestCase):
    @patch("app.upstream.is_task_cancelled", return_value=False)
    @patch("app.upstream.requests.Session")
    def test_multi_image_generation_splits_into_single_requests_without_n(self, session_cls, _cancelled):
        sessions = [Mock(), Mock(), Mock()]
        for index, session in enumerate(sessions):
            session.request.return_value = ok_response(f"image-{index}")
        session_cls.side_effect = sessions

        result = call_openai_task(payload(3))

        self.assertEqual(len(result["images"]), 3)
        self.assertEqual(result["requestedCount"], 3)
        self.assertEqual(result["failedCount"], 0)
        for session in sessions:
            body = session.request.call_args.kwargs["json"]
            self.assertNotIn("n", body)

    @patch("app.upstream.is_task_cancelled", return_value=False)
    @patch("app.upstream.requests.Session")
    def test_multi_image_generation_retries_failed_single_image_and_keeps_partial_success(self, session_cls, _cancelled):
        sessions = [Mock(), Mock(), Mock(), Mock(), Mock()]
        sessions[0].request.return_value = ok_response("image-a")
        sessions[1].request.return_value = bad_response("first failure")
        sessions[2].request.return_value = ok_response("image-b")
        sessions[3].request.return_value = bad_response("second failure")
        sessions[4].request.return_value = bad_response("third failure")
        session_cls.side_effect = sessions

        result = call_openai_task(payload(3))

        self.assertEqual(len(result["images"]), 2)
        self.assertEqual(result["requestedCount"], 3)
        self.assertEqual(result["failedCount"], 1)
        self.assertEqual(result["partialErrors"][0]["errorCode"], "UPSTREAM_5XX")
        self.assertEqual(result["actualParams"]["n"], 2)

    @patch("app.upstream.is_task_cancelled", return_value=False)
    @patch("app.upstream.requests.Session")
    def test_multi_image_edit_splits_into_single_requests_without_n(self, session_cls, _cancelled):
        sessions = [Mock(), Mock()]
        for index, session in enumerate(sessions):
            session.request.return_value = ok_response(f"edited-image-{index}")
        session_cls.side_effect = sessions

        result = call_openai_task(payload(2, [TINY_PNG_DATA_URL for _ in range(4)]))

        self.assertEqual(len(result["images"]), 2)
        self.assertEqual(result["requestedCount"], 2)
        self.assertEqual(result["failedCount"], 0)
        for session in sessions:
            kwargs = session.request.call_args.kwargs
            self.assertEqual(kwargs["data"]["model"], "gpt-image-2")
            self.assertNotIn("n", kwargs["data"])
            self.assertEqual(len([item for item in kwargs["files"] if item[0] == "image[]"]), 4)
