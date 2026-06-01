from __future__ import annotations

import base64
import struct
import sys
import zlib
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.upscale import image_dimensions_from_data_url, upscale_result_if_needed  # noqa: E402


def png_data_url(width: int, height: int) -> str:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw_rows = b"".join(b"\x00" + b"\x00\x00\x00\x00" * width for _ in range(height))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw_rows))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def payload(size: str = "2x2"):
    return {
        "params": {
            "size": size,
            "quality": "high",
            "output_format": "png",
        }
    }


class UpscaleHelpersTest(TestCase):
    def test_reads_png_dimensions_from_data_url(self):
        self.assertEqual(image_dimensions_from_data_url(png_data_url(3, 2))[:2], (3, 2))

    @patch("app.upscale.UPSCALER_URL", "")
    def test_annotates_actual_size_when_no_upscaler_is_configured(self):
        result = upscale_result_if_needed(payload("2x2"), {"images": [png_data_url(1, 1)]})

        self.assertEqual(result["images"][0], png_data_url(1, 1))
        self.assertEqual(result["actualParams"]["size"], "1x1")
        self.assertEqual(result["actualParamsList"][0]["size"], "1x1")

    @patch("app.upscale.UPSCALER_DELETE_REMOTE_RESULT", True)
    @patch("app.upscale.UPSCALER_POLL_INTERVAL_SECONDS", 0.01)
    @patch("app.upscale.UPSCALER_URL", "http://upscaler.test")
    @patch("app.upscale.requests")
    def test_submits_mismatched_image_to_upscaler_and_uses_result(self, requests_mock):
        post_response = Mock()
        post_response.raise_for_status.return_value = None
        post_response.json.return_value = {"data": {"id": "job-1", "status": "queued"}}
        status_response = Mock()
        status_response.raise_for_status.return_value = None
        status_response.json.return_value = {"data": {"id": "job-1", "status": "succeeded"}}
        result_response = Mock()
        result_response.raise_for_status.return_value = None
        result_response.json.return_value = {"data": {"id": "job-1", "image": png_data_url(2, 2)}}
        delete_response = Mock()
        delete_response.raise_for_status.return_value = None

        requests_mock.post.return_value = post_response
        requests_mock.get.side_effect = [status_response, result_response]
        requests_mock.delete.return_value = delete_response

        events: list[str] = []
        result = upscale_result_if_needed(
            payload("2x2"),
            {"images": [png_data_url(1, 1)], "actualParams": {"quality": "high"}},
            stage_callback=lambda event_type, _message, _metadata: events.append(event_type),
        )

        self.assertEqual(image_dimensions_from_data_url(result["images"][0])[:2], (2, 2))
        self.assertEqual(result["actualParams"]["size"], "2x2")
        self.assertEqual(result["actualParamsList"][0]["size"], "2x2")
        self.assertEqual(result["upscale"]["processedCount"], 1)
        requests_mock.post.assert_called_once()
        requests_mock.delete.assert_called_once()
        self.assertEqual(events, ["upscale_request", "upscale_started", "upscale_succeeded"])
