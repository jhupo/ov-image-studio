from __future__ import annotations

import base64
from typing import Any

import requests

from .config import DEFAULT_IMAGE_API_URL, TASK_TIMEOUT_SECONDS
from .fingerprints import build_api_url, resolve_images_base_url


class TaskExecutionError(Exception):
    def __init__(self, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def data_url_to_bytes(data_url: str) -> tuple[bytes, str]:
    header, payload = data_url.split(",", 1)
    mime_type = "application/octet-stream"
    if ":" in header:
        mime_type = header.split(":", 1)[1].split(";", 1)[0] or mime_type
    if ";base64" in header:
        return base64.b64decode(payload), mime_type
    return payload.encode("utf-8"), mime_type


def normalize_base64_image(raw: str, mime_type: str) -> str:
    return raw if raw.startswith("data:") else f"data:{mime_type};base64,{raw}"


def fetch_image_url_as_data_url(url: str, fallback_mime: str) -> str:
    try:
        response = requests.get(url, timeout=120)
        response.raise_for_status()
    except requests.Timeout as exc:
        raise TaskExecutionError("IMAGE_DOWNLOAD_TIMEOUT", "Image download timed out", True) from exc
    except requests.RequestException as exc:
        raise TaskExecutionError("IMAGE_DOWNLOAD_FAILED", str(exc), True) from exc
    mime_type = response.headers.get("Content-Type", fallback_mime)
    return f"data:{mime_type};base64,{base64.b64encode(response.content).decode('ascii')}"


def pick_actual_params(source: dict[str, Any]) -> dict[str, Any]:
    actual: dict[str, Any] = {}
    for key in ("size", "quality", "output_format", "output_compression", "moderation", "n"):
        if source.get(key) is not None:
            actual[key] = source[key]
    return actual


def raise_upstream_error(exc: requests.RequestException) -> None:
    if isinstance(exc, requests.Timeout):
        raise TaskExecutionError("UPSTREAM_TIMEOUT", "Upstream request timed out", True) from exc
    response = getattr(exc, "response", None)
    if response is not None:
        status = response.status_code
        message = response.text[:1000] if response.text else str(exc)
        if status == 429:
            raise TaskExecutionError("UPSTREAM_RATE_LIMITED", message, True) from exc
        if 500 <= status < 600:
            raise TaskExecutionError("UPSTREAM_5XX", message, True) from exc
        raise TaskExecutionError("UPSTREAM_BAD_RESPONSE", message, False) from exc
    raise TaskExecutionError("UPSTREAM_NETWORK", str(exc), True) from exc


def call_openai_task(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload["profile"]
    prompt = payload["prompt"]
    params = payload["params"]
    input_images = payload.get("inputImageDataUrls") or []
    mask_data_url = payload.get("maskDataUrl")
    timeout = min(TASK_TIMEOUT_SECONDS, max(10, int(profile.get("timeout", TASK_TIMEOUT_SECONDS))))
    fallback_mime = f"image/{'jpeg' if params['output_format'] == 'jpeg' else params['output_format']}"
    headers = {
        "Authorization": f"Bearer {profile['apiKey']}",
        "Cache-Control": "no-store, no-cache, max-age=0",
        "Pragma": "no-cache",
    }

    try:
        if profile.get("apiMode") == "responses":
            body: dict[str, Any] = {
                "model": profile["model"],
                "input": (
                    [
                        {
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": prompt},
                                *[{"type": "input_image", "image_url": item} for item in input_images],
                            ],
                        }
                    ]
                    if input_images
                    else prompt
                ),
                "tools": [
                    {
                        "type": "image_generation",
                        "action": "edit" if input_images else "generate",
                        "size": params["size"],
                        "output_format": params["output_format"],
                        **({} if profile.get("codexCli") else {"quality": params["quality"]}),
                        **(
                            {"output_compression": params["output_compression"]}
                            if params["output_format"] != "png" and params.get("output_compression") is not None
                            else {}
                        ),
                        **({"input_image_mask": {"image_url": mask_data_url}} if mask_data_url else {}),
                    }
                ],
                "tool_choice": "required",
            }
            response = requests.post(
                build_api_url(DEFAULT_IMAGE_API_URL, "responses"),
                headers={**headers, "Content-Type": "application/json"},
                json=body,
                timeout=timeout,
            )
            response.raise_for_status()
            output = response.json().get("output") or []
            results = []
            for item in output:
                if item.get("type") == "image_generation_call" and isinstance(item.get("result"), str):
                    results.append(
                        {
                            "image": normalize_base64_image(item["result"], fallback_mime),
                            "actualParams": pick_actual_params(item),
                            "revisedPrompt": item.get("revised_prompt"),
                        }
                    )
            if not results:
                raise TaskExecutionError("UPSTREAM_EMPTY_RESULT", "No image data returned from responses API", False)
            return {
                "images": [item["image"] for item in results],
                "actualParams": results[0].get("actualParams") or {},
                "actualParamsList": [item.get("actualParams") or {} for item in results],
                "revisedPrompts": [item.get("revisedPrompt") for item in results],
            }

        images_base = resolve_images_base_url(profile)
        if input_images:
            files: list[tuple[str, tuple[str, bytes, str]]] = []
            for index, item in enumerate(input_images):
                content, mime_type = data_url_to_bytes(item)
                ext = mime_type.split("/")[-1] or "png"
                files.append(("image[]", (f"input-{index + 1}.{ext}", content, mime_type)))
            if mask_data_url:
                mask_content, mask_type = data_url_to_bytes(mask_data_url)
                files.append(("mask", ("mask.png", mask_content, mask_type)))
            form_data: dict[str, Any] = {
                "model": profile["model"],
                "prompt": prompt,
                "size": params["size"],
                "output_format": params["output_format"],
                "moderation": params["moderation"],
            }
            if not profile.get("codexCli"):
                form_data["quality"] = params["quality"]
            if params["output_format"] != "png" and params.get("output_compression") is not None:
                form_data["output_compression"] = str(params["output_compression"])
            if params.get("n", 1) > 1:
                form_data["n"] = str(params["n"])
            response = requests.post(
                build_api_url(images_base, "images/edits"),
                headers=headers,
                data=form_data,
                files=files,
                timeout=timeout,
            )
        else:
            body = {
                "model": profile["model"],
                "prompt": prompt,
                "size": params["size"],
                "output_format": params["output_format"],
                "moderation": params["moderation"],
                **({} if profile.get("codexCli") else {"quality": params["quality"]}),
                **(
                    {"output_compression": params["output_compression"]}
                    if params["output_format"] != "png" and params.get("output_compression") is not None
                    else {}
                ),
                **({"n": params["n"]} if params.get("n", 1) > 1 else {}),
            }
            response = requests.post(
                build_api_url(images_base, "images/generations"),
                headers={**headers, "Content-Type": "application/json"},
                json=body,
                timeout=timeout,
            )
        response.raise_for_status()
        upstream_payload = response.json()
    except requests.RequestException as exc:
        raise_upstream_error(exc)

    data = upstream_payload.get("data") or []
    if not data:
        raise TaskExecutionError("UPSTREAM_EMPTY_RESULT", "No image data returned from images API", False)
    images: list[str] = []
    revised_prompts: list[str | None] = []
    for item in data:
        if item.get("b64_json"):
            images.append(normalize_base64_image(item["b64_json"], fallback_mime))
            revised_prompts.append(item.get("revised_prompt"))
        elif item.get("url"):
            images.append(fetch_image_url_as_data_url(item["url"], fallback_mime))
            revised_prompts.append(item.get("revised_prompt"))
    if not images:
        raise TaskExecutionError("UPSTREAM_EMPTY_RESULT", "No usable image payload returned", False)
    actual_params = pick_actual_params(upstream_payload)
    return {
        "images": images,
        "actualParams": actual_params,
        "actualParamsList": [actual_params for _ in images],
        "revisedPrompts": revised_prompts,
    }
