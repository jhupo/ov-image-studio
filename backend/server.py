from __future__ import annotations

import logging

from app import create_app
from app.config import PORT
from app.queue import rebuild_queue_from_db
from app.schema import ensure_schema
from app.worker import start_workers


app = create_app()
runtime_started = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def initialize_runtime() -> None:
    global runtime_started
    if runtime_started:
        return
    ensure_schema()
    rebuild_queue_from_db()
    start_workers()
    runtime_started = True


initialize_runtime()


def main() -> None:
    app.run(host="127.0.0.1", port=PORT, threaded=True)


if __name__ == "__main__":
    main()
