"""
Sector Breadth Indicators
For each stock in a sector compute:
  - is price > 50-day MA
  - is price > 200-day MA
  - is price within 2% of 52-week high  (= "at 52w high")
  - is price within 2% of 52-week low   (= "at 52w low")
  - % distance from 52-week high (negative = below high)
Aggregate into sector-level breadth stats.
"""
from __future__ import annotations

import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import yfinance as yf

from .cache import get, set as cache_set

_TTL = 3600  # 1 h


def _compute_breadth(symbol: str) -> dict[str, Any] | None:
    cache_key = f"breadth:{symbol}"
    cached = get(cache_key)
    if cached is not None:
        return cached

    try:
        hist = yf.Ticker(symbol).history(period="1y")
        if hist is None or hist.empty or len(hist) < 10:
            return None

        closes = hist["Close"].dropna().tolist()
        if not closes:
            return None

        price = closes[-1]
        high_52w = max(closes)
        low_52w = min(closes)

        # MAs — only compute if enough bars
        ma50 = (
            statistics.mean(closes[-50:]) if len(closes) >= 50 else None
        )
        ma200 = (
            statistics.mean(closes[-200:]) if len(closes) >= 200 else None
        )

        above_50ma = bool(ma50 and price > ma50)
        above_200ma = bool(ma200 and price > ma200)
        at_52w_high = bool(high_52w and price >= high_52w * 0.98)
        at_52w_low = bool(low_52w and price <= low_52w * 1.02)
        dist_from_52w_high = (
            round((price / high_52w - 1) * 100, 1) if high_52w else None
        )

        result: dict[str, Any] = {
            "symbol": symbol,
            "price": round(price, 2),
            "ma50": round(ma50, 2) if ma50 else None,
            "ma200": round(ma200, 2) if ma200 else None,
            "high_52w": round(high_52w, 2),
            "low_52w": round(low_52w, 2),
            "above_50ma": above_50ma,
            "above_200ma": above_200ma,
            "at_52w_high": at_52w_high,
            "at_52w_low": at_52w_low,
            "dist_from_52w_high_pct": dist_from_52w_high,
        }
        cache_set(cache_key, result, _TTL)
        return result
    except Exception:
        return None


def sector_breadth(sector_id: str, stocks: list[str]) -> dict[str, Any]:
    """Return breadth stats for a sector."""
    symbols = stocks[:15]  # cap at 15 to keep latency sane

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_compute_breadth, s): s for s in symbols}
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                results.append(r)

    if not results:
        return {
            "sector_id": sector_id,
            "stock_count": 0,
            "stocks": [],
            "summary": None,
        }

    n = len(results)

    above_50_count = sum(1 for r in results if r["above_50ma"])
    above_200_count = sum(1 for r in results if r["above_200ma"])
    at_high_count = sum(1 for r in results if r["at_52w_high"])
    at_low_count = sum(1 for r in results if r["at_52w_low"])

    dists = [r["dist_from_52w_high_pct"] for r in results if r["dist_from_52w_high_pct"] is not None]
    avg_dist = round(statistics.mean(dists), 1) if dists else None

    return {
        "sector_id": sector_id,
        "stock_count": n,
        "stocks": sorted(results, key=lambda r: r["dist_from_52w_high_pct"] or -999, reverse=True),
        "summary": {
            "above_50ma_count": above_50_count,
            "above_50ma_pct": round(above_50_count / n * 100),
            "above_200ma_count": above_200_count,
            "above_200ma_pct": round(above_200_count / n * 100),
            "at_52w_high_count": at_high_count,
            "at_52w_high_pct": round(at_high_count / n * 100),
            "at_52w_low_count": at_low_count,
            "at_52w_low_pct": round(at_low_count / n * 100),
            "avg_dist_from_52w_high_pct": avg_dist,
        },
    }
