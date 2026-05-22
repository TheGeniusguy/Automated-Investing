"""
Sector Peer Comparison — YTD price series normalized to 100 at Jan 1.

Returns per-stock series so the frontend can overlay them on one chart.
Also returns best/worst performer labels and the sector ETF series.
"""
from __future__ import annotations

import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import yfinance as yf

from .cache import get, set as cache_set

_TTL = 1800  # 30 min — YTD data changes intraday


def _ytd_series(symbol: str) -> dict[str, Any] | None:
    """Return normalized YTD series for one symbol: [{date, value}] indexed to 100."""
    cache_key = f"peer_ytd:{symbol}:{datetime.date.today()}"
    cached = get(cache_key)
    if cached is not None:
        return cached

    try:
        year_start = datetime.date(datetime.date.today().year, 1, 1)
        hist = yf.Ticker(symbol).history(
            start=str(year_start),
            end=str(datetime.date.today() + datetime.timedelta(days=1)),
        )
        if hist is None or hist.empty or len(hist) < 2:
            return None

        closes = [(str(idx.date()), float(row["Close"])) for idx, row in hist.iterrows()]
        if not closes:
            return None

        base = closes[0][1]
        if not base or base == 0:
            return None

        points = [{"date": d, "value": round(c / base * 100, 3)} for d, c in closes]
        ytd_pct = round((closes[-1][1] / base - 1) * 100, 2)

        result = {
            "symbol": symbol,
            "points": points,
            "ytd_pct": ytd_pct,
            "last_close": round(closes[-1][1], 2),
        }
        cache_set(cache_key, result, _TTL)
        return result
    except Exception:
        return None


def sector_peer_comparison(
    sector_id: str,
    stocks: list[str],
    etf: str,
) -> dict[str, Any]:
    # Include ETF in the fetch alongside stock symbols
    all_symbols = list(dict.fromkeys([etf] + stocks))[:16]  # cap at 16

    series_list: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_ytd_series, s): s for s in all_symbols}
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                series_list.append(r)

    if not series_list:
        return {
            "sector_id": sector_id,
            "etf": etf,
            "series": [],
            "best": None,
            "worst": None,
        }

    # Sort by ytd_pct descending so legend renders best-to-worst
    series_list.sort(key=lambda s: s["ytd_pct"] if s["ytd_pct"] is not None else 0, reverse=True)

    stocks_only = [s for s in series_list if s["symbol"] != etf]
    best = stocks_only[0]["symbol"] if stocks_only else None
    worst = stocks_only[-1]["symbol"] if stocks_only else None

    return {
        "sector_id": sector_id,
        "etf": etf,
        "series": series_list,
        "best": best,
        "worst": worst,
    }
