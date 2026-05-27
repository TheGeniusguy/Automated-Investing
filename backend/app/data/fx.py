"""FX cross-rate matrix + DXY.

Cross-asset surface for major currency pairs. Pure functions, never-raise.
All rates flow through `macro_data.fetch_arbitrary_ticker` using yfinance FX
symbols (`EURUSD=X`, `USDJPY=X`, ...) and the dollar index (`DX-Y.NYB`).

1d change is latest-vs-prior close; 1m change is latest-vs-(~22 sessions ago).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

_TTL = 900  # 15 min

# Major pairs + a few crosses. (yfinance symbol, display label, quote precision)
PAIRS: list[tuple[str, str, int]] = [
    ("EURUSD=X", "EUR/USD", 4),
    ("GBPUSD=X", "GBP/USD", 4),
    ("USDJPY=X", "USD/JPY", 2),
    ("USDCHF=X", "USD/CHF", 4),
    ("USDCAD=X", "USD/CAD", 4),
    ("AUDUSD=X", "AUD/USD", 4),
    ("NZDUSD=X", "NZD/USD", 4),
    # Crosses
    ("EURGBP=X", "EUR/GBP", 4),
    ("EURJPY=X", "EUR/JPY", 2),
    ("GBPJPY=X", "GBP/JPY", 2),
]

DXY_SYMBOL = "DX-Y.NYB"


def _pct_change(latest: float | None, base: float | None) -> float | None:
    if latest is None or base is None or base == 0:
        return None
    return round((latest / base - 1) * 100, 3)


def _rate_row(symbol: str, label: str, precision: int) -> dict:
    """One pair: latest rate, 1d/1m % change. Never raises."""
    cache_key = f"fx:row:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    row: dict = {
        "symbol": symbol,
        "pair": label,
        "rate": None,
        "change_1d_pct": None,
        "change_1m_pct": None,
    }
    try:
        pts = fetch_arbitrary_ticker(symbol, days=40)
        values = [p["value"] for p in pts if p.get("value") is not None]
        if values:
            rate = values[-1]
            prior = values[-2] if len(values) >= 2 else None
            month_ago = values[-23] if len(values) >= 23 else values[0]
            row["rate"] = round(rate, precision)
            row["change_1d_pct"] = _pct_change(rate, prior)
            row["change_1m_pct"] = _pct_change(rate, month_ago)
    except Exception as e:
        log.warning("fx _rate_row(%s) failed: %s", symbol, e)

    cache.set(cache_key, row, _TTL)
    return row


def _dxy() -> dict:
    """Dollar index level + 1d/1m trend. Null fields on failure."""
    out = {
        "symbol": DXY_SYMBOL,
        "level": None,
        "change_1d_pct": None,
        "change_1m_pct": None,
        "trend": None,
    }
    cache_key = "fx:dxy"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        pts = fetch_arbitrary_ticker(DXY_SYMBOL, days=40)
        values = [p["value"] for p in pts if p.get("value") is not None]
        if values:
            level = values[-1]
            prior = values[-2] if len(values) >= 2 else None
            month_ago = values[-23] if len(values) >= 23 else values[0]
            out["level"] = round(level, 2)
            out["change_1d_pct"] = _pct_change(level, prior)
            out["change_1m_pct"] = _pct_change(level, month_ago)
            chg = out["change_1m_pct"]
            out["trend"] = (
                "strengthening" if chg is not None and chg > 0.25
                else "weakening" if chg is not None and chg < -0.25
                else "range-bound" if chg is not None
                else None
            )
        cache.set(cache_key, out, _TTL)
    except Exception as e:
        log.warning("fx _dxy failed: %s", e)
    return out


def matrix() -> dict:
    """Pair table + DXY. Never raises."""
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_rate_row, sym, label, prec) for sym, label, prec in PAIRS]
        results = {}
        for fut, (sym, label, prec) in zip(futures, PAIRS):
            try:
                results[sym] = fut.result()
            except Exception as e:
                log.warning("fx matrix row(%s) failed: %s", sym, e)
                results[sym] = {
                    "symbol": sym, "pair": label, "rate": None,
                    "change_1d_pct": None, "change_1m_pct": None,
                }
        rows = [results[sym] for sym, _, _ in PAIRS]

    return {
        "pairs": rows,
        "dxy": _dxy(),
    }


def history(pair: str, days: int = 90) -> dict:
    """Raw close-price history for one pair. Never raises."""
    sym = pair.strip().upper()
    days = max(2, min(int(days), 365 * 5))
    try:
        pts = fetch_arbitrary_ticker(sym, days=days)
        clean = [p for p in pts if p.get("value") is not None]
        return {"symbol": sym, "days": days, "points": clean}
    except Exception as e:
        log.warning("fx history(%s) failed: %s", sym, e)
        return {"symbol": sym, "days": days, "points": []}
