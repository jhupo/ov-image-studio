from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import urlparse

from .config import DEFAULT_IMAGE_API_URL


def normalize_base_url(base_url: str) -> str:
    trimmed = (base_url or "").strip()
    if not trimmed:
        return ""
    with_scheme = trimmed if "://" in trimmed else f"https://{trimmed}"
    parsed = urlparse(with_scheme)
    if not parsed.scheme or not parsed.netloc:
        return trimmed.rstrip("/")
    segments = [segment for segment in parsed.path.split("/") if segment]
    if "v1" in segments:
        segments = segments[: segments.index("v1") + 1]
    elif segments:
        segments.append("v1")
    path = f"/{'/'.join(segments)}" if segments else ""
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def build_api_url(base_url: str, api_path: str) -> str:
    normalized = normalize_base_url(base_url)
    endpoint_path = api_path.lstrip("/")
    if normalized.endswith("/v1"):
        return f"{normalized}/{endpoint_path}"
    return f"{normalized}/v1/{endpoint_path}"


def resolve_images_base_url(profile: dict[str, Any]) -> str:
    return normalize_base_url(profile.get("imageApiBaseUrl") or DEFAULT_IMAGE_API_URL)


def sha1_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def profile_fingerprint(profile: dict[str, Any]) -> str:
    raw = "\n".join(
        [
            profile.get("apiKey", ""),
            profile.get("model", ""),
            profile.get("apiMode", ""),
            resolve_images_base_url(profile),
        ]
    )
    return sha1_text(raw)


def api_key_fingerprint(profile: dict[str, Any]) -> str:
    return sha1_text(profile.get("apiKey", ""))
