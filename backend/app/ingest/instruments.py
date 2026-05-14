"""Bootstrap the instrument universe.

Two stages, both idempotent:

1. SEC EDGAR `company_tickers.json` — ~13k US filers with CIK + name.
   Single API call, runs in ~1 second.

2. Local watchlists — non-SEC tickers (ETFs, futures, crypto) that the
   correlation engine and other panels rely on. We type-tag these so
   the universe table reflects the full set the terminal can touch.

Per-symbol fundamentals/sector/industry enrichment is deferred to
`prices.py` / `fundamentals.py` (lazy, on-demand).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

import httpx

from ..config import settings
from ..data.watchlist import DEFAULT_EQUITIES_WATCHLIST, load_watchlist
from ..db import engine

log = logging.getLogger(__name__)

EDGAR_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"


def _classify_symbol(symbol: str) -> str:
    """Best-effort static classification from the symbol shape."""
    s = symbol.upper()
    if s.endswith("=F"):       return "future"
    if s.endswith("-USD"):     return "crypto"
    if s.startswith("^"):      return "index"
    if "." in s and len(s) <= 12:  # e.g., DX-Y.NYB
        return "index"
    return "equity"  # default; refined later via yfinance.info


def _upsert_instrument(c, *, symbol: str, cik: str | None, name: str, type_: str, source: str) -> None:
    c.execute(
        """
        INSERT INTO instruments (symbol, cik, name, type, source, last_seen_at)
        VALUES (?, ?, ?, ?, ?, now())
        ON CONFLICT (symbol) DO UPDATE SET
            cik          = COALESCE(EXCLUDED.cik, instruments.cik),
            name         = COALESCE(EXCLUDED.name, instruments.name),
            type         = COALESCE(EXCLUDED.type, instruments.type),
            source       = COALESCE(EXCLUDED.source, instruments.source),
            last_seen_at = now()
        """,
        [symbol, cik, name, type_, source],
    )


def bootstrap_universe() -> dict:
    """Run the full universe ingest. Returns counts + timing.

    Bootstrapping is intended to run once on startup or via the manual
    refresh button; subsequent calls are cheap upserts.
    """
    run_id = engine.etl_start("universe", target="bootstrap")
    started = datetime.utcnow()
    edgar_rows = 0
    local_rows = 0
    error: str | None = None

    try:
        # Stage 1: EDGAR universe (US public companies)
        try:
            with httpx.Client(
                timeout=30.0,
                headers={"User-Agent": settings.sec_user_agent, "Accept": "application/json"},
                follow_redirects=True,
            ) as client:
                r = client.get(EDGAR_TICKERS_URL)
                r.raise_for_status()
                payload = r.json()
        except Exception as e:
            log.warning("EDGAR universe fetch failed: %s", e)
            payload = {}

        with engine.conn() as c:
            for v in (payload.values() if isinstance(payload, dict) else []):
                ticker = (v.get("ticker") or "").upper()
                cik = v.get("cik_str")
                title = v.get("title") or ""
                if not ticker or cik is None:
                    continue
                _upsert_instrument(
                    c,
                    symbol=ticker,
                    cik=f"{int(cik):010d}",
                    name=title,
                    type_="equity",
                    source="edgar",
                )
                edgar_rows += 1

            # Stage 2: local watchlists — ETFs, futures, crypto, indexes
            correlations_watchlist = load_watchlist()
            for entry in correlations_watchlist:
                _upsert_instrument(
                    c,
                    symbol=entry.ticker,
                    cik=None,
                    name=entry.label,
                    type_=_classify_symbol(entry.ticker),
                    source="watchlist",
                )
                local_rows += 1

            for ticker in DEFAULT_EQUITIES_WATCHLIST:
                _upsert_instrument(
                    c,
                    symbol=ticker.upper(),
                    cik=None,
                    name="",
                    type_="equity",
                    source="watchlist",
                )
                local_rows += 1

        engine.etl_finish(
            run_id,
            status="ok",
            rows_in=edgar_rows + local_rows,
            rows_out=edgar_rows + local_rows,
            note=f"edgar={edgar_rows} local={local_rows}",
        )
    except Exception as e:
        log.exception("bootstrap_universe failed")
        error = str(e)
        engine.etl_finish(run_id, status="error", note=error)

    elapsed = (datetime.utcnow() - started).total_seconds()
    return {
        "edgar_rows":   edgar_rows,
        "local_rows":   local_rows,
        "total":        edgar_rows + local_rows,
        "elapsed_s":    round(elapsed, 2),
        "error":        error,
        "run_id":       run_id,
    }
