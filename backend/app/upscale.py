from __future__ import annotations

import base64
import re
import struct
import time
from typing import Any, Callable

import requests

from .config import (
    UPSCALER_DELETE_REMOTE_RESULT,
    UPSCALER_POLL_INTERVAL_SECONDS,
    UPSCALER_REQUEST_TIMEOUT_SECONDS,
    UPSCALER_TIMEOUT_SECONDS,
    UPSCALER_TOKEN,
    UPSCALER_URL,
)
from .upstream import TaskExecutionError


StageCallback = Callable[[str, str | None, dict[str, Any] | None], None]

SIZE_PATTERN = re.compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$")


def parse_size(size: str | None) -> tuple[int, int] | None:
    if not size:
        return None
    match = SIZE_PATTERN.match(str(size))
    if not match:
        return None
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width, height


def data_url_to_bytes(data_url: str) -> bytes:
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    return base64.b64decode(payload)


def image_dimensions_from_bytes(data: bytes) -> tuple[int, int, str] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return width, height, "png"

    if data.startswith(b"\xff\xd8"):
        index = 2
        start_of_frame_markers = {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            while index < len(data) and data[index] == 0xFF:
                index += 1
            if index >= len(data):
                break
            marker = data[index]
            index += 1
            if marker in (0xD9, 0xDA):
                break
            if marker == 0x01 or 0xD0 <= marker <= 0xD7:
                continue
            if index + 2 > len(data):
                break
            length = struct.unpack(">H", data[index:index + 2])[0]
            if marker in start_of_frame_markers and index + 7 <= len(data):
                height, width = struct.unpack(">HH", data[index + 3:index + 7])
                return width, height, "jpeg"
            index += length

    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 30:
        fourcc = data[12:16]
        if fourcc == b"VP8X":
            width = int.from_bytes(data[24:27], "little") + 1
            height = int.from_bytes(data[27:30], "little") + 1
            return width, height, "webp"
        if fourcc == b"VP8 ":
            width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
            height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
            return width, height, "webp"
        if fourcc == b"VP8L":
            bits = int.from_bytes(data[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height, "webp"

    return None


def image_dimensions_from_data_url(data_url: str) -> tuple[int, int, str] | None:
    return image_dimensions_from_bytes(data_url_to_bytes(data_url))


def format_size(width: int, height: int) -> str:
    return f"{width}x{height}"


def merge_actual_params_size(
    result: dict[str, Any],
    per_image_sizes: list[str | None],
) -> None:
    images = result.get("images") or []
    actual_params = dict(result.get("actualParams") or {})
    actual_params_list = list(result.get("actualParamsList") or [])
    if len(actual_params_list) < len(images):
        actual_params_list.extend({} for _ in range(len(images) - len(actual_params_list)))

    for index, size in enumerate(per_image_sizes):
        if not size or index >= len(actual_params_list):
            continue
        item = dict(actual_params_list[index] or {})
        item["size"] = size
        actual_params_list[index] = item

    sizes = [size for size in per_image_sizes if size]
    if len(sizes) == len(images) and len(set(sizes)) == 1:
        actual_params["size"] = sizes[0]

    if actual_params:
        result["actualParams"] = actual_params
    if actual_params_list:
        result["actualParamsList"] = actual_params_list


def upscale_result_if_needed(payload: dict[str, Any], result: dict[str, Any], stage_callback: StageCallback | None = None) -> dict[str, Any]:
    target = parse_size((payload.get("params") or {}).get("size"))
    images = result.get("images") or []
    if not target or not images:
        return result

    target_width, target_height = target
    target_size = format_size(target_width, target_height)
    output_format = str((payload.get("params") or {}).get("output_format") or "png")
    target_quality = str((payload.get("params") or {}).get("quality") or "auto")
    updated_images: list[str] = []
    per_image_sizes: list[str | None] = []
    processed_count = 0

    for index, image in enumerate(images):
        dimensions = image_dimensions_from_data_url(image)
        if not dimensions:
            updated_images.append(image)
            per_image_sizes.append(None)
            continue

        width, height, image_format = dimensions
        source_size = format_size(width, height)
        if width == target_width and height == target_height:
            updated_images.append(image)
            per_image_sizes.append(source_size)
            continue

        if not UPSCALER_URL:
            updated_images.append(image)
            per_image_sizes.append(source_size)
            continue

        if stage_callback:
            stage_callback(
                "upscale_request",
                "Image generated; upscaling to requested size",
                {
                    "stage": "upscaling",
                    "imageIndex": index,
                    "sourceSize": source_size,
                    "targetSize": target_size,
                },
            )

        upscaled = request_upscale(
            image=image,
            target_size=target_size,
            output_format=output_format,
            target_quality=target_quality,
            source_size=source_size,
            image_format=image_format,
            image_index=index,
            stage_callback=stage_callback,
        )
        upscaled_dimensions = image_dimensions_from_data_url(upscaled) or (target_width, target_height, output_format)
        updated_images.append(upscaled)
        per_image_sizes.append(format_size(int(upscaled_dimensions[0]), int(upscaled_dimensions[1])))
        processed_count += 1

    result = {**result, "images": updated_images}
    merge_actual_params_size(result, per_image_sizes)
    if processed_count:
        result["upscale"] = {
            "processedCount": processed_count,
            "targetSize": target_size,
            "serviceUrl": UPSCALER_URL,
        }
    return result


def upscaler_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if UPSCALER_TOKEN:
        headers["Authorization"] = f"Bearer {UPSCALER_TOKEN}"
    return headers


def request_upscale(
    *,
    image: str,
    target_size: str,
    output_format: str,
    target_quality: str,
    source_size: str,
    image_format: str,
    image_index: int,
    stage_callback: StageCallback | None = None,
) -> str:
    job_id: str | None = None
    try:
        response = requests.post(
            f"{UPSCALER_URL}/api/upscale",
            headers=upscaler_headers(),
            json={
                "image": image,
                "targetSize": target_size,
                "outputFormat": output_format,
                "targetQuality": target_quality,
                "sourceSize": source_size,
                "sourceFormat": image_format,
            },
            timeout=UPSCALER_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        job = extract_data(response.json())
        if job.get("image"):
            return str(job["image"])
        job_id = str(job.get("id") or "")
        if not job_id:
            raise TaskExecutionError("UPSCALER_BAD_RESPONSE", "Upscaler did not return a job id", False)
        if stage_callback:
            stage_callback(
                "upscale_started",
                "Upscaler accepted image",
                {
                    "stage": "upscaling",
                    "imageIndex": image_index,
                    "sourceSize": source_size,
                    "targetSize": target_size,
                    "jobId": job_id,
                },
            )
        wait_for_job(job_id, image_index, source_size, target_size, stage_callback)
        return fetch_job_result(job_id)
    except TaskExecutionError:
        raise
    except requests.Timeout as exc:
        raise TaskExecutionError("UPSCALER_TIMEOUT", "Upscaler request timed out", True) from exc
    except requests.RequestException as exc:
        raise TaskExecutionError("UPSCALER_UNAVAILABLE", str(exc), True) from exc
    finally:
        if job_id and UPSCALER_DELETE_REMOTE_RESULT:
            try:
                requests.delete(
                    f"{UPSCALER_URL}/api/upscale/{job_id}",
                    headers=upscaler_headers(),
                    timeout=UPSCALER_REQUEST_TIMEOUT_SECONDS,
                )
            except requests.RequestException:
                pass


def wait_for_job(
    job_id: str,
    image_index: int,
    source_size: str,
    target_size: str,
    stage_callback: StageCallback | None = None,
) -> None:
    deadline = time.monotonic() + max(1, UPSCALER_TIMEOUT_SECONDS)
    while True:
        if time.monotonic() > deadline:
            raise TaskExecutionError("UPSCALER_TIMEOUT", "Upscaler job timed out", True)

        response = requests.get(
            f"{UPSCALER_URL}/api/upscale/{job_id}",
            headers=upscaler_headers(),
            timeout=UPSCALER_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        job = extract_data(response.json())
        status = str(job.get("status") or "")
        if status == "succeeded":
            if stage_callback:
                stage_callback(
                    "upscale_succeeded",
                    "Upscaling completed",
                    {
                        "stage": "upscaling",
                        "imageIndex": image_index,
                        "sourceSize": source_size,
                        "targetSize": target_size,
                        "jobId": job_id,
                    },
                )
            return
        if status == "failed":
            raise TaskExecutionError("UPSCALER_FAILED", str(job.get("error") or "Upscaler job failed"), False)
        time.sleep(max(0.2, UPSCALER_POLL_INTERVAL_SECONDS))


def fetch_job_result(job_id: str) -> str:
    response = requests.get(
        f"{UPSCALER_URL}/api/upscale/{job_id}/result",
        headers=upscaler_headers(),
        timeout=UPSCALER_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = extract_data(response.json())
    image = payload.get("image")
    if not isinstance(image, str) or not image:
        raise TaskExecutionError("UPSCALER_BAD_RESPONSE", "Upscaler did not return an image", False)
    return image


def extract_data(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    if isinstance(payload, dict):
        return payload
    raise TaskExecutionError("UPSCALER_BAD_RESPONSE", "Upscaler returned invalid JSON", False)
