"""Sector rotation panel — relative strength of the 11 SPDR sector ETFs.

Computes total return over multiple windows (1m / 3m / 6m / 1y) for each
sector and the SPY benchmark. Reports both absolute return and relative
return (sector minus SPY) so the panel can show who's leading vs lagging.

Uses yfinance via `macro_data.fetch_arbitrary_ticker` (no API key required).
Falls back to DuckDB prices_daily if the symbol is already ingested there.
"""
from __future__ import annotations

import logging
from typing import Optional

from . import macro_data
from ..db import engine as db_engine

log = logging.getLogger(__name__)

# 11 official SPDR Select Sector ETFs.
SECTOR_ETFS: list[dict] = [
    {"ticker": "XLK",  "name": "Technology"},
    {"ticker": "XLF",  "name": "Financials"},
    {"ticker": "XLV",  "name": "Health Care"},
    {"ticker": "XLY",  "name": "Consumer Discretionary"},
    {"ticker": "XLC",  "name": "Communication Services"},
    {"ticker": "XLI",  "name": "Industrials"},
    {"ticker": "XLP",  "name": "Consumer Staples"},
    {"ticker": "XLE",  "name": "Energy"},
    {"ticker": "XLU",  "name": "Utilities"},
    {"ticker": "XLB",  "name": "Materials"},
    {"ticker": "XLRE", "name": "Real Estate"},
]

BENCHMARK_TICKER = "SPY"

# Window in trading days (≈ 21 per month).
WINDOWS: list[dict] = [
    {"key": "1w", "label": "1W",  "days": 5},
    {"key": "1m", "label": "1M",  "days": 21},
    {"key": "3m", "label": "3M",  "days": 63},
    {"key": "6m", "label": "6M",  "days": 126},
    {"key": "ytd", "label": "YTD", "days": None},  # special-cased below
    {"key": "1y", "label": "1Y",  "days": 252},
]


def _ytd_lookback() -> int:
    """Trading days since Jan 1 of the current year (approx)."""
    from datetime import date
    today = date.today()
    jan1  = date(today.year, 1, 1)
    delta_days = (today - jan1).days
    # ≈ 5/7 trading days; minimum 1 to avoid div-by-zero.
    return max(1, int(delta_days * 5 / 7))


def _load_closes(symbol: str, lookback: int) -> list[tuple]:
    """Pull recent (date, adj_close) rows. Prefer DuckDB; fall back to yfinance."""
    rows = db_engine.fetchall(
        """
        SELECT date, adj_close
        FROM prices_daily
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        [symbol, lookback + 5],
    )
    if rows and len(rows) >= lookback:
        return list(reversed(rows))

    # Fallback: yfinance via the cached fetcher. macro_data returns SeriesPoint
    # dicts ({date, value}) for arbitrary tickers.
    try:
        points = macro_data.fetch_arbitrary_ticker(symbol, days=max(lookback * 2, 30))
        return [(p["date"], p["value"]) for p in points if p.get("value") is not None]
    except Exception as e:
        log.warning("yfinance fallback for %s failed: %s", symbol, e)
        return []


def _return_pct(closes: list[tuple], lookback: int) -> Optional[float]:
    """Compound return over the last `lookback` trading days."""
    if len(closes) < 2 or lookback < 1:
        return None
    end_close = closes[-1][1]
    # Find the closest start point lookback days back (by position in the list).
    start_idx = max(0, len(closes) - lookback - 1)
    start_close = closes[start_idx][1]
    if start_close is None or end_close is None or start_close <= 0:
        return None
    return float((end_close - start_close) / start_close * 100.0)


def dashboard() -> dict:
    """Compute rotation matrix: rows = sectors, columns = windows.

    Returns a self-contained payload the frontend can render as a heatmap +
    leadership table.
    """
    max_lookback = max((w["days"] or _ytd_lookback()) for w in WINDOWS)

    # Pull benchmark first for relative returns.
    spy_closes = _load_closes(BENCHMARK_TICKER, max_lookback)
    bench: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        days = w["days"] if w["days"] is not None else _ytd_lookback()
        bench[w["key"]] = _return_pct(spy_closes, days)

    sectors_payload: list[dict] = []
    for sec in SECTOR_ETFS:
        closes = _load_closes(sec["ticker"], max_lookback)
        last_close = closes[-1][1] if closes else None
        last_date  = closes[-1][0] if closes else None
        returns: dict[str, dict] = {}
        for w in WINDOWS:
            days = w["days"] if w["days"] is not None else _ytd_lookback()
            r_abs = _return_pct(closes, days)
            r_rel = (r_abs - bench[w["key"]]) if (r_abs is not None and bench[w["key"]] is not None) else None
            returns[w["key"]] = {"abs": r_abs, "rel": r_rel}
        sectors_payload.append({
            "ticker":     sec["ticker"],
            "name":       sec["name"],
            "last_close": float(last_close) if last_close is not None else None,
            "last_date":  str(last_date) if last_date else None,
            "returns":    returns,
        })

    return {
        "windows":   WINDOWS,
        "benchmark": {
            "ticker":  BENCHMARK_TICKER,
            "returns": bench,
        },
        "sectors":   sectors_payload,
    }
