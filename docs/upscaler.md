# Image Upscaler Service

This service is intended to run on the CPU upscaler host, for example `192.168.2.68`.
The main image studio host keeps handling user-facing task polling. When a generated
image does not match the requested explicit size, the worker sends the image to this
service, waits for completion, fetches the processed image, then deletes the temporary
job from the upscaler.

## Start the upscaler on 192.168.2.68

Host/systemd deployment, matching the current 68 setup:

```bash
cd /opt/chaincloud-image-upscaler
python3 -m venv .venv
.venv/bin/pip install -r upscaler/requirements.txt
cp deploy/chaincloud-image-upscaler.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now chaincloud-image-upscaler
```

Health check:

```bash
curl http://127.0.0.1:8790/health
```

Docker deployment remains available when Docker Hub/base-image access is working:

```bash
docker compose -f deploy/docker-compose.upscaler.yml up -d --build
```

Default port: `8790`.

For a CPU-only box, start with one worker:

```env
UPSCALER_WORKERS=1
UPSCALER_HTTP_PORT=8790
UPSCALER_ENGINE=realesrgan
UPSCALER_COMMAND=/opt/realesrgan-ncnn-vulkan/main/realesrgan-ncnn-vulkan -i {input} -o {output} -n realesrgan-x4plus -s {scale} -t 256 -m /opt/realesrgan-ncnn-vulkan/main/models -f png
UPSCALER_JOB_TIMEOUT_SECONDS=3600
UPSCALER_JOB_TTL_SECONDS=3600
```

The current 68 host uses the official Real-ESRGAN ncnn-vulkan release with Mesa
CPU Vulkan (`llvmpipe`). It is real AI super-resolution, but it is CPU-only and slow.
Observed 68 benchmarks with `realesrgan-x4plus`, scale 4, tile 256:

```text
220x220     -> 880x880      20s,   ~2.4GB peak RSS
512x288     -> 2048x1152    58s,   ~2.8GB peak RSS
1024x576    -> 4096x2304    3m33s, ~2.9GB peak RSS
```

`UPSCALER_ENGINE=resize` is still available as a fast Pillow/Lanczos fallback for
non-production testing. To use another AI upscaler, install the command inside the
image or mount it into the container and set `UPSCALER_COMMAND`.

Example command template:

```env
UPSCALER_ENGINE=realesrgan
UPSCALER_COMMAND=/opt/realesrgan-ncnn-vulkan/main/realesrgan-ncnn-vulkan -i {input} -o {output} -n realesrgan-x4plus -s {scale} -t 256 -m /opt/realesrgan-ncnn-vulkan/main/models -f png
```

The service always performs a final exact resize to the requested target size after
the command finishes.

## Connect the 31 host worker to 68

Set these environment variables on the `chaincloud-image-studio-worker` container:

```env
DEFAULT_IMAGE_API_URL=https://dash.classicriver.cn/v1
IMAGE_STUDIO_UPSCALER_URL=http://192.168.2.68:8790
IMAGE_STUDIO_UPSCALER_POLL_INTERVAL_SECONDS=3
IMAGE_STUDIO_UPSCALER_TIMEOUT_SECONDS=3600
IMAGE_STUDIO_UPSCALER_REQUEST_TIMEOUT_SECONDS=60
IMAGE_STUDIO_UPSCALER_DELETE_REMOTE_RESULT=true
```

If `UPSCALER_TOKEN` is set on 68, set the same value as `IMAGE_STUDIO_UPSCALER_TOKEN`
on 31.
