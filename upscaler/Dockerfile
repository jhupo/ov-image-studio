FROM python:3.12-slim

WORKDIR /opt/upscaler

ENV UPSCALER_PORT=8790
ENV UPSCALER_WORK_DIR=/data/jobs
ENV UPSCALER_WORKERS=1
ENV UPSCALER_ENGINE=resize

COPY upscaler/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY upscaler/server.py ./server.py

EXPOSE 8790

CMD ["sh", "-lc", "mkdir -p ${UPSCALER_WORK_DIR}; gunicorn --bind 0.0.0.0:${UPSCALER_PORT} --workers 1 --threads 4 --timeout 7200 server:app"]
