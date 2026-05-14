"""DuckDB persistence layer.

DuckDB is single-file, embedded, columnar — ideal for the analytical
queries (rolling windows, joins across symbols, fundamentals time-series)
the terminal will run. No server, no schema-migration tool needed beyond
the SQL file in this module.

Threading: DuckDB connections are single-threaded; we open a fresh connection
per call inside a context manager. Cheap on local disk, safe under FastAPI's
async + worker concurrency.
"""
from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from pathlib import Path

import duckdb

log = logging.getLogger(__name__)

_DB_PATH_LOCK = threading.Lock()
_INITIALIZED = False


def db_path() -> Path:
    # backend/data/market.duckdb
    p = Path(__file__).parent.parent.parent / "data" / "market.duckdb"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _schema_path() -> Path:
    return Path(__file__).parent / "schema.sql"


def init() -> None:
    """Apply schema. Idempotent — safe to call on every startup."""
    global _INITIALIZED
    with _DB_PATH_LOCK:
        if _INITIALIZED:
            return
        schema = _schema_path().read_text()
        with duckdb.connect(str(db_path())) as conn:
            # Statement-by-statement so a failure on one CREATE doesn't abort the rest.
            for stmt in _split_statements(schema):
                try:
                    conn.execute(stmt)
                except duckdb.Error as e:
                    log.warning("schema stmt failed (%s): %s", e, stmt[:80])
        _INITIALIZED = True
        log.info("DuckDB initialized at %s", db_path())


def _split_statements(sql: str) -> list[str]:
    """DuckDB's `execute` won't run multi-statement strings.

    SQL comments can contain semicolons that would otherwise be mistaken
    for statement terminators, so strip line-comments first, then split.
    """
    stripped_lines = []
    for line in sql.splitlines():
        # Remove inline `--` comments (but only outside of string literals;
        # our schema has none, so a naive trim is safe).
        idx = line.find("--")
        if idx != -1:
            line = line[:idx]
        stripped_lines.append(line)
    cleaned = "\n".join(stripped_lines)
    return [s.strip() for s in cleaned.split(";") if s.strip()]


@contextmanager
def conn():
    """Open a connection, ensure schema is applied, hand it to the caller."""
    init()
    c = duckdb.connect(str(db_path()))
    try:
        yield c
    finally:
        c.close()


# ---------- Convenience helpers ----------

def fetchall(sql: str, params: list | tuple | None = None) -> list[tuple]:
    with conn() as c:
        return c.execute(sql, params or []).fetchall()


def fetchone(sql: str, params: list | tuple | None = None) -> tuple | None:
    with conn() as c:
        return c.execute(sql, params or []).fetchone()


def execute(sql: str, params: list | tuple | None = None) -> int:
    """Execute a write statement, return affected row count (best-effort)."""
    with conn() as c:
        cur = c.execute(sql, params or [])
        try:
            return cur.rowcount or 0
        except AttributeError:
            return 0


# ---------- ETL run tracking ----------

def etl_start(source: str, target: str | None = None) -> int:
    with conn() as c:
        r = c.execute(
            """
            INSERT INTO etl_runs (source, status, target)
            VALUES (?, 'running', ?)
            RETURNING id
            """,
            [source, target],
        ).fetchone()
        return int(r[0])


def etl_finish(
    run_id: int,
    *,
    status: str = "ok",
    rows_in: int = 0,
    rows_out: int = 0,
    note: str | None = None,
) -> None:
    with conn() as c:
        c.execute(
            """
            UPDATE etl_runs
            SET status = ?, rows_in = ?, rows_out = ?, note = ?,
                completed_at = current_timestamp
            WHERE id = ?
            """,
            [status, rows_in, rows_out, note, run_id],
        )
