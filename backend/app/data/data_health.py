"""Data-health observability surface.

`health()` summarizes how fresh each persistent data source is (max-timestamp
per DuckDB table), the sqlite TTL cache footprint, and the background scheduler
job state. Never raises — every probe is wrapped so a single failing source
degrades to `null`/`missing` rather than taking down the endpoint.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from ..db import engine as db_engine
from .cache import _db_path as _cache_db_path

log = logging.getLogger(__name__)

# Staleness thresholds (hours) per source. Beyond this a source is "stale".
_THRESHOLDS = {
    "macro_series_history": 36.0,
    "prices_daily":         36.0,
    "filings_archive":      72.0,
    "daily_briefings":      36.0,
    "etl_runs":             36.0,
}


def _max_ts(table: str, col: str) -> datetime | None:
    """Most-recent timestamp in `table.col`, as an aware UTC datetime or None."""
    try:
        row = db_engine.fetchone(f"SELECT max({col}) FROM {table}")
    except Exception as e:
        log.warning("data_health: max(%s) on %s failed: %s", col, table, e)
        return None
    if not row or row[0] is None:
        return None
    val = row[0]
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(val))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _source(name: str, table: str, col: str) -> dict:
    last = _max_ts(table, col)
    if last is None:
        return {"source": name, "last_updated": None, "age_hours": None, "status": "missing"}
    age = (datetime.now(timezone.utc) - last).total_seconds() / 3600.0
    threshold = _THRESHOLDS.get(table, 36.0)
    status = "fresh" if age <= threshold else "stale"
    return {
        "source":       name,
        "last_updated": last.isoformat(),
        "age_hours":    round(age, 2),
        "status":       status,
    }


def _cache_stats() -> dict:
    """Row count + file size of the sqlite TTL cache. Best-effort; null on fail."""
    rows: int | None = None
    size_bytes: int | None = None
    try:
        path = _cache_db_path()
        if path.exists():
            size_bytes = path.stat().st_size
            import sqlite3

            c = sqlite3.connect(str(path))
            try:
                r = c.execute("SELECT count(*) FROM cache").fetchone()
                rows = int(r[0]) if r else None
            finally:
                c.close()
    except Exception as e:
        log.warning("data_health: cache stats failed: %s", e)
    return {"rows": rows, "size_bytes": size_bytes}


def health() -> dict:
    """Full data-health report. Never raises."""
    sources = [
        _source("macro_series", "macro_series_history", "ingested_at"),
        _source("prices",       "prices_daily",         "ingested_at"),
        _source("filings",      "filings_archive",      "archived_at"),
        _source("briefings",    "daily_briefings",      "generated_at"),
        _source("etl_runs",     "etl_runs",             "started_at"),
    ]

    summary = {"fresh": 0, "stale": 0, "missing": 0}
    for s in sources:
        summary[s["status"]] = summary.get(s["status"], 0) + 1

    try:
        from .. import scheduler

        jobs = scheduler.job_status()
    except Exception as e:
        log.warning("data_health: scheduler status failed: %s", e)
        jobs = []

    return {
        "sources":   sources,
        "cache":     _cache_stats(),
        "scheduler": jobs,
        "summary":   summary,
    }
