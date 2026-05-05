from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent


def spawn(command: list[str]) -> subprocess.Popen:
    return subprocess.Popen(command, cwd=ROOT_DIR)


def main() -> int:
    backend = spawn([sys.executable, "backend/server.py"])
    client = spawn(["cmd", "/c", "npm", "run", "dev"] if os.name == "nt" else ["npm", "run", "dev"])

    def shutdown(*_args):
        for proc in (backend, client):
            if proc.poll() is None:
                proc.terminate()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        backend.wait()
        client.wait()
    finally:
        shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
