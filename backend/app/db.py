from __future__ import annotations

from contextlib import contextmanager

import psycopg
import redis
from psycopg.rows import dict_row

from .config import POSTGRES_DSN, REDIS_URL


redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)


@contextmanager
def db_conn():
    with psycopg.connect(POSTGRES_DSN, row_factory=dict_row) as conn:
        yield conn


def check_db() -> bool:
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            return cur.fetchone() is not None


def check_redis() -> bool:
    return bool(redis_client.ping())
