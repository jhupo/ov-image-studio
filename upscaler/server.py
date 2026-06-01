from __future__ import annotations

import base64
import os
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from PIL import Image


PORT = int(os.environ.get("UPSCALER_PORT", "8790"))
WORK_DIR = Path(os.environ.get("UPSCALER_WORK_DIR", "/data/jobs"))
MAX_WORKERS = max(1, int(os.environ.get("UPSCALER_WORKERS", "1")))
JOB_TTL_SECONDS = int(os.environ.get("UPSCALER_JOB_TTL_SECONDS", "3600"))
JOB_TIMEOUT_SECONDS = int(os.environ.get("UPSCALER_JOB_TIMEOUT_SECONDS", "3600"))
TOKEN = os.environ.get("UPSCALER_TOKEN", "")
ENGINE = os.environ.get("UPSCALER_ENGINE", "resize").lower()
COMMAND_TEMPLATE = os.environ.get("UPSCALER_COMMAND", "")
ALLOW_RESIZE_FALLBACK = os.environ.get("UPSCALER_ALLOW_RESIZE_FALLBACK", "true").lower() in {"1", "true", "yes"}
JPEG_QUALITY = int(os.environ.get("UPSCALER_JPEG_QUALITY", "95"))
WEBP_QUALITY = int(os.environ.get("UPSCALER_WEBP_QUALITY", "95"))

SIZE_PATTERN = __import__("re").compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)\s*$")
MIME_BY_FORMAT = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "webp": "image/webp",
}

app = Flask(__name__)
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()


def ok(data: Any, status: int = 200):
    return jsonify({"code": 0, "message": "success", "data": data}), status


def error(code: str, message: str, status: int):
    return jsonify({"code": code, "message": message}), status


@app.before_request
def require_token():
    if request.method == "OPTIONS":
        return None
    if not TOKEN:
        return None
    auth = request.headers.get("Authorization", "")
    header_token = request.headers.get("X-Upscaler-Token", "")
    if auth == f"Bearer {TOKEN}" or header_token == TOKEN:
        return None
    return error("UNAUTHORIZED", "Missing or invalid upscaler token", 401)


@app.after_request
def add_headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Upscaler-Token"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return response


@app.route("/health", methods=["GET", "OPTIONS"])
def health():
    if request.method == "OPTIONS":
        return "", 204
    cleanup_expired_jobs()
    return ok({
        "status": "ok",
        "engine": ENGINE,
        "workers": MAX_WORKERS,
        "jobs": len(jobs),
        "workDir": str(WORK_DIR),
    })


@app.route("/api/upscale", methods=["POST", "OPTIONS"])
def create_job():
    if request.method == "OPTIONS":
        return "", 204
    cleanup_expired_jobs()
    payload = request.get_json(silent=True) or {}
    image = payload.get("image")
    target = parse_size(payload.get("targetSize"))
    if not isinstance(image, str) or not image.strip():
        return error("BAD_REQUEST", "image is required", 400)
    if target is None:
        return error("BAD_REQUEST", "targetSize must be WIDTHxHEIGHT", 400)

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job = {
        "id": job_id,
        "status": "queued",
        "createdAt": now_ms(),
        "updatedAt": now_ms(),
        "targetSize": f"{target[0]}x{target[1]}",
        "outputFormat": normalize_output_format(payload.get("outputFormat")),
        "targetQuality": payload.get("targetQuality"),
        "sourceSize": payload.get("sourceSize"),
        "sourceFormat": payload.get("sourceFormat"),
        "engine": ENGINE if COMMAND_TEMPLATE else "resize",
        "dir": str(job_dir),
        "error": None,
    }
    with jobs_lock:
        jobs[job_id] = job
    executor.submit(run_job, job_id, image, target)
    return ok(public_job(job), 202)


@app.route("/api/upscale/<job_id>", methods=["GET", "DELETE", "OPTIONS"])
def job_detail(job_id: str):
    if request.method == "OPTIONS":
        return "", 204
    cleanup_expired_jobs()
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return error("NOT_FOUND", "Job not found", 404)
    if request.method == "DELETE":
        delete_job(job_id)
        return ok({"id": job_id, "deleted": True})
    return ok(public_job(job))


@app.route("/api/upscale/<job_id>/result", methods=["GET", "OPTIONS"])
def job_result(job_id: str):
    if request.method == "OPTIONS":
        return "", 204
    cleanup_expired_jobs()
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return error("NOT_FOUND", "Job not found", 404)
    if job.get("status") != "succeeded":
        return error("NOT_READY", "Job is not finished", 409)
    output_path = Path(str(job.get("outputPath") or ""))
    if not output_path.exists():
        return error("RESULT_MISSING", "Result file is missing", 500)
    data = output_path.read_bytes()
    fmt = str(job.get("outputFormat") or "png")
    data_url = f"data:{MIME_BY_FORMAT.get(fmt, 'image/png')};base64,{base64.b64encode(data).decode('ascii')}"
    return ok({
        "id": job_id,
        "image": data_url,
        "width": job.get("outputWidth"),
        "height": job.get("outputHeight"),
        "format": fmt,
        "engine": job.get("engine"),
    })


def run_job(job_id: str, data_url: str, target: tuple[int, int]) -> None:
    with jobs_lock:
        job = jobs[job_id]
        job["status"] = "running"
        job["startedAt"] = now_ms()
        job["updatedAt"] = now_ms()
    job_dir = Path(str(job["dir"]))
    input_path = job_dir / "input"
    command_output_path = job_dir / "command-output.png"
    output_path = job_dir / f"output.{job['outputFormat']}"

    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        write_data_url(data_url, input_path)
        with Image.open(input_path) as source:
            source_width, source_height = source.size
        update_job(job_id, inputWidth=source_width, inputHeight=source_height)

        intermediate_path = input_path
        if COMMAND_TEMPLATE:
            try:
                run_command(input_path, command_output_path, target, source_width, source_height)
                if command_output_path.exists():
                    intermediate_path = command_output_path
                    update_job(job_id, engine=ENGINE or "command")
            except Exception:
                if not ALLOW_RESIZE_FALLBACK:
                    raise
                intermediate_path = input_path
                update_job(job_id, engine="resize-fallback")

        save_exact_target(intermediate_path, output_path, target, str(job["outputFormat"]))
        with Image.open(output_path) as output:
            output_width, output_height = output.size
        update_job(
            job_id,
            status="succeeded",
            updatedAt=now_ms(),
            finishedAt=now_ms(),
            outputPath=str(output_path),
            outputWidth=output_width,
            outputHeight=output_height,
        )
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            updatedAt=now_ms(),
            finishedAt=now_ms(),
            error=str(exc),
        )


def run_command(input_path: Path, output_path: Path, target: tuple[int, int], source_width: int, source_height: int) -> None:
    scale = choose_scale(source_width, source_height, target[0], target[1])
    command = COMMAND_TEMPLATE.format(
        input=shlex.quote(str(input_path)),
        output=shlex.quote(str(output_path)),
        scale=scale,
        width=target[0],
        height=target[1],
    )
    subprocess.run(command, shell=True, check=True, timeout=JOB_TIMEOUT_SECONDS)


def save_exact_target(input_path: Path, output_path: Path, target: tuple[int, int], output_format: str) -> None:
    with Image.open(input_path) as image:
        image.load()
        if image.size != target:
            image = image.resize(target, Image.Resampling.LANCZOS)
        if output_format in {"jpeg", "jpg"} and image.mode in {"RGBA", "LA", "P"}:
            image = image.convert("RGB")
        save_kwargs: dict[str, Any] = {}
        if output_format in {"jpeg", "jpg"}:
            save_kwargs.update({"quality": JPEG_QUALITY, "optimize": True})
            pil_format = "JPEG"
        elif output_format == "webp":
            save_kwargs.update({"quality": WEBP_QUALITY, "method": 6})
            pil_format = "WEBP"
        else:
            save_kwargs.update({"optimize": True})
            pil_format = "PNG"
        image.save(output_path, pil_format, **save_kwargs)


def write_data_url(data_url: str, output_path: Path) -> None:
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    output_path.write_bytes(base64.b64decode(payload))


def parse_size(value: Any) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    match = SIZE_PATTERN.match(value)
    if not match:
        return None
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width, height


def normalize_output_format(value: Any) -> str:
    fmt = str(value or "png").lower()
    if fmt == "jpg":
        return "jpeg"
    if fmt not in {"png", "jpeg", "webp"}:
        return "png"
    return fmt


def choose_scale(source_width: int, source_height: int, target_width: int, target_height: int) -> int:
    ratio = max(target_width / max(1, source_width), target_height / max(1, source_height))
    if ratio <= 2:
        return 2
    return 4


def update_job(job_id: str, **patch: Any) -> None:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        job.update(patch)
        job["updatedAt"] = patch.get("updatedAt", now_ms())


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key not in {"dir", "outputPath"}
    }


def cleanup_expired_jobs() -> None:
    cutoff = now_ms() - JOB_TTL_SECONDS * 1000
    expired: list[str] = []
    with jobs_lock:
        for job_id, job in jobs.items():
            if job.get("status") in {"succeeded", "failed"} and int(job.get("updatedAt") or 0) < cutoff:
                expired.append(job_id)
    for job_id in expired:
        delete_job(job_id)


def delete_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if not job:
        return
    job_dir = Path(str(job.get("dir") or ""))
    if job_dir.exists() and job_dir.is_dir():
        shutil.rmtree(job_dir, ignore_errors=True)


def now_ms() -> int:
    return int(time.time() * 1000)


def main() -> None:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=PORT, threaded=True)


if __name__ == "__main__":
    main()
