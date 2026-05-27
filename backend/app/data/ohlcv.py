"""Centralized OHLCV loader: DuckDB-first with a live yfinance fallback.

`prices_daily` is the canonical store, but until the ingest job has populated a
symbol, readers (technical indicators, the dossier) would otherwise compute on
nothing and render blank. This loader returns a uniform OHLCV DataFrame from the
DB when rows exist, else a cached live yfinance fetch, so analytical surfaces
work even on a cold store.

It is READ-ONLY: it never writes to DuckDB. Persistence is owned by the ingest
job (`app/ingest/prices.py`) so the read path stays concurrency-safe (DuckDB is
single-writer). Empty live results are cached with a SHORT negative TTL so a
transient upstream outage is not frozen for the full window.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

import pandas as pd

from ..db import engine as db_engine
from . import cache

log = logging.getLogger(__name__)

_COLS = ["date", "open", "high", "low", "close", "adj_close", "volume"]
_TTL = 900          # 15 min for a good live fetch
_NEG_TTL = 120      # 2 min for an empty result (avoid cache poisoning)
_YF_TIMEOUT = 15    # seconds; bound the network call so a worker can't hang


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=_COLS)


def _f(v) -> float | None:
    try:
        f = float(v)
        return None if f != f else f  # NaN check
    except (TypeError, ValueError):
        return None


def _i(v) -> float | None:
    try:
        n = float(v)
        return None if n != n else n
    except (TypeError, ValueError):
        return None


def _from_records(records: list[dict]) -> pd.DataFrame:
    """Build the canonical OHLCV frame from a list of row dicts (date-ascending)."""
    if not records:
        return _empty()
    df = pd.DataFrame(records, columns=_COLS)
    df["date"] = pd.to_datetime(df["date"])
    for col in ("open", "high", "low", "close", "adj_close"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0).astype(float)
    return df


def _fetch_live(symbol: str, days: int) -> pd.DataFrame:
    """Cached live yfinance OHLCV fetch. Never raises; returns empty on failure."""
    cache_key = f"ohlcv:{symbol}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return _from_records(cached)
    try:
        import yfinance as yf

        if days <= 365 * 2:
            hist = yf.Ticker(symbol).history(
                period=f"{max(days, 30)}d", auto_adjust=False, timeout=_YF_TIMEOUT
            )
        else:
            start = (datetime.utcnow().date() - timedelta(days=days + 14)).isoformat()
            hist = yf.Ticker(symbol).history(
                start=start, auto_adjust=False, timeout=_YF_TIMEOUT
            )

        if hist is None or hist.empty:
            cache.set(cache_key, [], _NEG_TTL)
            return _empty()

        hist = hist.tail(days)
        records = [
            {
                "date": idx.strftime("%Y-%m-%d"),
                "open": _f(row.get("Open")),
                "high": _f(row.get("High")),
                "low": _f(row.get("Low")),
                "close": _f(row.get("Close")),
                "adj_close": _f(row.get("Adj Close")) or _f(row.get("Close")),
                "volume": _i(row.get("Volume")),
            }
            for idx, row in hist.iterrows()
        ]
        cache.set(cache_key, records, _TTL)
        return _from_records(records)
    except Exception as e:
        log.warning("ohlcv live fetch failed for %s: %s", symbol, e)
        return _empty()


def load_ohlcv(symbol: str, days: int) -> pd.DataFrame:
    """Return a daily OHLCV frame for ``symbol`` (columns: date, open, high, low,
    close, adj_close, volume; date-ascending).

    DuckDB `prices_daily` first; if the store has no rows for the symbol, fall
    back to a cached live yfinance fetch. Never raises.
    """
    symbol = symbol.upper().strip()
    rows = db_engine.fetchall(
        """
        SELECT date, open, high, low, close, adj_close, volume
        FROM prices_daily
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        [symbol, days],
    )
    if rows:
        df = pd.DataFrame(rows, columns=_COLS).iloc[::-1].reset_index(drop=True)
        df["date"] = pd.to_datetime(df["date"])
        for col in ("open", "high", "low", "close", "adj_close"):
            df[col] = df[col].astype(float)
        df["volume"] = df["volume"].astype(float).fillna(0.0)
        return df

    return _fetch_live(symbol, days)
