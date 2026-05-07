from __future__ import annotations

import logging
import threading

from app.queue import rebuild_queue_from_db
from app.schema import ensure_schema
from app.worker import start_workers


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("image_studio.worker_process")


def main() -> None:
    ensure_schema()
    rebuild_queue_from_db()
    start_workers()
    logger.info("worker process started")
    threading.Event().wait()


if __name__ == "__main__":
    main()
