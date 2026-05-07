from __future__ import annotations

import base64
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import requests

from .cancellation import is_task_cancelled, register_cancel_callback, unregister_cancel_callback
from .config import CANCEL_POLL_INTERVAL_SECONDS, DEFAULT_IMAGE_API_URL, TASK_TIMEOUT_SECONDS
from .fingerprints import build_api_url, resolve_images_base_url


PROMPT_REWRITE_GUARD_PREFIX = "Use the following text as the complete prompt. Do not rewrite it:"


class TaskExecutionError(Exception):
    def __init__(self, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def task_id_from_payload(payload: dict[str, Any]) -> str | None:
    task_id = payload.get("_taskId")
    return str(task_id) if task_id else None


def raise_if_cancelled(task_id: str | None) -> None:
    if task_id and is_task_cancelled(task_id):
        raise TaskExecutionError("USER_CANCELED", "Task canceled by requester", False)


class TaskCancelWatcher:
    def __init__(self, task_id: str | None, on_cancel) -> None:
        self.task_id = task_id
        self.on_cancel = on_cancel
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def __enter__(self):
        if not self.task_id:
            return self
        self.thread = threading.Thread(target=self.watch, name=f"task-cancel-watch-{self.task_id}", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=1)

    def watch(self) -> None:
        while not self.stop.wait(max(0.1, CANCEL_POLL_INTERVAL_SECONDS)):
            if not self.task_id:
                return
            try:
                if is_task_cancelled(self.task_id):
                    self.on_cancel()
                    return
            except Exception:
                return


def request_with_cancellation(
    task_id: str | None,
    method: str,
    url: str,
    **kwargs: Any,
) -> requests.Response:
    raise_if_cancelled(task_id)
    session = requests.Session()
    cancelled_by_requester = False

    def close_session() -> None:
        nonlocal cancelled_by_requester
        cancelled_by_requester = True
        session.close()

    if task_id:
        register_cancel_callback(task_id, close_session)
    try:
        with TaskCancelWatcher(task_id, close_session):
            response = session.request(method, url, **kwargs)
        raise_if_cancelled(task_id)
        return response
    except requests.RequestException as exc:
        if cancelled_by_requester:
            raise TaskExecutionError("USER_CANCELED", "Task canceled by requester", False) from exc
        raise
    finally:
        if task_id:
            unregister_cancel_callback(task_id, close_session)
        session.close()


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


def fetch_image_url_as_data_url(url: str, fallback_mime: str, task_id: str | None = None) -> str:
    try:
        response = request_with_cancellation(task_id, "GET", url, timeout=120)
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


def add_prompt_guard(prompt: str) -> str:
    if prompt.startswith(PROMPT_REWRITE_GUARD_PREFIX):
        return prompt
    return f"{PROMPT_REWRITE_GUARD_PREFIX}\n{prompt}"


def is_images_api_unsupported_error(exc: BaseException) -> bool:
    if not isinstance(exc, TaskExecutionError):
        return False
    message = str(exc).lower()
    return (
        exc.code == "UPSTREAM_BAD_RESPONSE"
        and "images api is not supported for this platform" in message
    )


def with_responses_api(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        **payload,
        "profile": {
            **payload["profile"],
            "apiMode": "responses",
        },
    }


def raise_upstream_error(exc: requests.RequestException) -> None:
    if isinstance(exc, requests.Timeout):
        raise TaskExecutionError("UPSTREAM_TIMEOUT", "Upstream request timed out", True) from exc
    response = getattr(exc, "response", None)
    if response is not None:
        status = response.status_code
        message = response.text[:1000] if response.text else str(exc)
        if "no available accounts" in message.lower():
            raise TaskExecutionError("UPSTREAM_NO_AVAILABLE_ACCOUNTS", message, False) from exc
        if status == 429:
            raise TaskExecutionError("UPSTREAM_RATE_LIMITED", message, True) from exc
        if 500 <= status < 600:
            raise TaskExecutionError("UPSTREAM_5XX", message, True) from exc
        raise TaskExecutionError("UPSTREAM_BAD_RESPONSE", message, False) from exc
    raise TaskExecutionError("UPSTREAM_NETWORK", str(exc), True) from exc


def call_openai_task(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload["profile"]
    params = payload["params"]
    output_count = max(1, int(params.get("n", 1) or 1))
    raise_if_cancelled(task_id_from_payload(payload))
    try:
        if profile.get("apiMode") != "responses" and profile.get("codexCli") and output_count > 1:
            return call_openai_images_task_concurrent(payload, output_count)
        return call_openai_task_single(payload)
    except TaskExecutionError as exc:
        if profile.get("apiMode") != "responses" and is_images_api_unsupported_error(exc):
            return call_openai_task_single(with_responses_api(payload))
        raise


def call_openai_images_task_concurrent(payload: dict[str, Any], output_count: int) -> dict[str, Any]:
    single_payload = {
        **payload,
        "params": {
            **payload["params"],
            "n": 1,
            "quality": "auto",
        },
    }
    results: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    with ThreadPoolExecutor(max_workers=min(output_count, 8)) as executor:
        futures = [executor.submit(call_openai_task_single, single_payload) for _ in range(output_count)]
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except BaseException as exc:
                errors.append(exc)

    if not results:
        if errors:
            raise errors[0]
        raise TaskExecutionError("UPSTREAM_EMPTY_RESULT", "All concurrent image requests failed", True)

    images: list[str] = []
    actual_params_list: list[dict[str, Any]] = []
    revised_prompts: list[str | None] = []
    for result in results:
        result_images = result.get("images") or []
        images.extend(result_images)
        actual_params_list.extend(result.get("actualParamsList") or [result.get("actualParams") or {} for _ in result_images])
        revised_prompts.extend(result.get("revisedPrompts") or [None for _ in result_images])

    return {
        "images": images,
        "actualParams": {
            **(results[0].get("actualParams") or {}),
            "n": len(images),
        },
        "actualParamsList": actual_params_list,
        "revisedPrompts": revised_prompts,
    }


def call_openai_task_single(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload["profile"]
    prompt = payload["prompt"]
    params = payload["params"]
    input_images = payload.get("inputImageDataUrls") or []
    mask_data_url = payload.get("maskDataUrl")
    timeout = min(TASK_TIMEOUT_SECONDS, max(10, int(profile.get("timeout", TASK_TIMEOUT_SECONDS))))
    task_id = task_id_from_payload(payload)
    fallback_mime = f"image/{'jpeg' if params['output_format'] == 'jpeg' else params['output_format']}"
    headers = {
        "Authorization": f"Bearer {profile['apiKey']}",
        "Cache-Control": "no-store, no-cache, max-age=0",
        "Pragma": "no-cache",
    }

    try:
        raise_if_cancelled(task_id)
        if profile.get("apiMode") == "responses":
            protected_prompt = add_prompt_guard(prompt)
            body: dict[str, Any] = {
                "model": profile["model"],
                "input": (
                    [
                        {
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": protected_prompt},
                                *[{"type": "input_image", "image_url": item} for item in input_images],
                            ],
                        }
                    ]
                    if input_images
                    else protected_prompt
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
            response = request_with_cancellation(
                task_id,
                "POST",
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
        request_prompt = add_prompt_guard(prompt) if profile.get("codexCli") else prompt
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
                "prompt": request_prompt,
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
            response = request_with_cancellation(
                task_id,
                "POST",
                build_api_url(images_base, "images/edits"),
                headers=headers,
                data=form_data,
                files=files,
                timeout=timeout,
            )
        else:
            body = {
                "model": profile["model"],
                "prompt": request_prompt,
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
            response = request_with_cancellation(
                task_id,
                "POST",
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
            images.append(fetch_image_url_as_data_url(item["url"], fallback_mime, task_id))
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
