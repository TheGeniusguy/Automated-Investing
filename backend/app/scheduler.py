"""Background scheduler — nightly data refresh + daily briefing pre-bake.

A single module-level APScheduler `BackgroundScheduler`. Jobs run in a daemon
thread pool; the scheduler is started ONLY from the FastAPI startup hook, never
at import time (so importing `app.scheduler` / `app.main` and the pytest suite
do not spin up threads).

Both `start()` and the job bodies are wrapped so they never raise — a failed
scheduler must never take down the API.
"""
from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.background import BackgroundScheduler

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None
_started = False


# ---------- Job bodies ----------

def _job_fred_refresh() -> None:
    """Nightly: refresh every FRED-catalog series into macro_series_history."""
    try:
        from .data import fred_catalog, macro_data

        series_ids = [s.id for s in fred_catalog.all_series()]
        data = macro_data.fetch_all(days=90, series=series_ids)
        non_empty = sum(1 for pts in data.values() if pts)
        log.info(
            "scheduler: FRED refresh complete — %d/%d series returned data",
            non_empty, len(series_ids),
        )
    except Exception as e:
        log.warning("scheduler: FRED refresh failed: %s", e)


def _job_price_ingest() -> None:
    """Nightly: backfill OHLCV for the bounded watchlist+holdings universe into
    prices_daily (writes an etl_runs row per symbol via backfill_symbol)."""
    try:
        from .ingest import prices as ingest_prices

        result = ingest_prices.backfill_universe(days=400)
        log.info(
            "scheduler: price ingest complete — %d symbols, %d rows",
            len(result.get("symbols", [])), result.get("total_rows", 0),
        )
    except Exception as e:
        log.warning("scheduler: price ingest failed: %s", e)


def _job_daily_briefing() -> None:
    """07:00: pre-bake today's daily briefing so the panel serves it instantly.

    `daily_briefing.stream_daily_briefing()` is the compute-AND-cache path
    (it persists to the `daily_briefings` table on completion). We drive the
    async generator to exhaustion. If keys are missing the underlying function
    degrades on its own — we don't special-case it.
    """
    try:
        from .briefing import daily_briefing as daily_briefing_mod

        async def _drive() -> None:
            async for _event, _data in daily_briefing_mod.stream_daily_briefing():
                pass

        asyncio.run(_drive())
        log.info("scheduler: daily briefing pre-bake complete")
    except Exception as e:
        log.warning("scheduler: daily briefing pre-bake failed: %s", e)


# ---------- Lifecycle ----------

def start() -> None:
    """Start the scheduler and register jobs. Idempotent; never raises."""
    global _scheduler, _started
    if _started:
        return
    try:
        _scheduler = BackgroundScheduler()
        _scheduler.add_job(
            _job_fred_refresh,
            trigger="cron",
            hour=2,
            minute=30,
            id="fred_nightly_refresh",
            name="Nightly FRED refresh",
            replace_existing=True,
        )
        _scheduler.add_job(
            _job_price_ingest,
            trigger="cron",
            hour=3,
            minute=30,
            id="price_nightly_ingest",
            name="Nightly price ingest",
            replace_existing=True,
        )
        _scheduler.add_job(
            _job_daily_briefing,
            trigger="cron",
            hour=7,
            minute=0,
            id="daily_briefing_prebake",
            name="Daily briefing pre-bake",
            replace_existing=True,
        )
        _scheduler.start()
        _started = True
        log.info("scheduler: started with %d jobs", len(_scheduler.get_jobs()))
    except Exception as e:
        log.warning("scheduler: failed to start: %s", e)


def shutdown() -> None:
    """Stop the scheduler. Idempotent; never raises."""
    global _scheduler, _started
    try:
        if _scheduler is not None:
            _scheduler.shutdown(wait=False)
    except Exception as e:
        log.warning("scheduler: shutdown failed: %s", e)
    finally:
        _scheduler = None
        _started = False


def job_status() -> list[dict]:
    """Report registered jobs. Never raises."""
    try:
        if _scheduler is None:
            return []
        out: list[dict] = []
        for job in _scheduler.get_jobs():
            nrt = getattr(job, "next_run_time", None)
            out.append({
                "id":            job.id,
                "name":          job.name,
                "next_run_time": nrt.isoformat() if nrt else None,
                "trigger":       str(job.trigger),
            })
        return out
    except Exception as e:
        log.warning("scheduler: job_status failed: %s", e)
        return []
