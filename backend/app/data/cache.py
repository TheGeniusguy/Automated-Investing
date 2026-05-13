import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..config import settings


_SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expires ON cache(expires_at);
"""


def _db_path() -> Path:
    return Path(__file__).parent.parent.parent / settings.cache_db_path


@contextmanager
def _conn():
    db = _db_path()
    db.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(db)
    try:
        c.executescript(_SCHEMA)
        yield c
        c.commit()
    finally:
        c.close()


def get(key: str) -> Any | None:
    with _conn() as c:
        row = c.execute(
            "SELECT value, expires_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    if row is None:
        return None
    value_json, expires_at = row
    if expires_at < time.time():
        return None
    return json.loads(value_json)


def get_stale(key: str) -> Any | None:
    """Return the value regardless of TTL — used as a graceful degradation fallback."""
    with _conn() as c:
        row = c.execute("SELECT value FROM cache WHERE key = ?", (key,)).fetchone()
    if row is None:
        return None
    return json.loads(row[0])


def set(key: str, value: Any, ttl_seconds: int) -> None:
    expires_at = time.time() + ttl_seconds
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
            (key, json.dumps(value), expires_at),
        )
