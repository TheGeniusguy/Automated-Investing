"""Fixed Income overview — Treasury yields by maturity + bond-ETF tracking.

Cross-asset surface. Pure functions, never-raise.

Treasury yields and curve shape are COMPOSED from the existing `yield_curve`
module (`current_curve()` gives per-maturity yield + daily delta in bps;
`shape_summary()` gives the 2s10s / 3m10y spreads and a classification) — we
do not duplicate that logic.

Bond ETFs use `macro_data.fetch_arbitrary_ticker` for price + 1m/ytd change,
and `yf.Ticker().info` for the yield proxy (`yield` /
`trailingAnnualDividendYield`), wrapped like `valuation.py::_yf_info`.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from . import cache
from . import yield_curve as yc
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

_TTL = 900  # 15 min

# Bond ETFs to track. (symbol, what it tracks)
BOND_ETFS: list[tuple[str, str]] = [
    ("SHY", "1-3Y Treasuries"),
    ("IEF", "7-10Y Treasuries"),
    ("TLT", "20Y+ Treasuries"),
    ("AGG", "US Aggregate Bond"),
    ("LQD", "Investment-Grade Corp"),
    ("HYG", "High-Yield Corp"),
    ("TIP", "TIPS (Inflation-Linked)"),
]


def _yf_info(symbol: str) -> dict:
    """Single-symbol yfinance .info with graceful fallback (mirrors valuation.py)."""
    try:
        import yfinance as yf
        return yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("fixed_income yf.info(%s) failed: %s", symbol, e)
        return {}


def _pct_change(latest: float | None, base: float | None) -> float | None:
    if latest is None or base is None or base == 0:
        return None
    return round((latest / base - 1) * 100, 2)


def _etf_row(symbol: str, tracks: str) -> dict:
    """One bond ETF: price, yield proxy, 1m/ytd change. Never raises."""
    cache_key = f"fixed_income:etf:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    row: dict = {
        "symbol": symbol,
        "tracks": tracks,
        "price": None,
        "yield_pct": None,
        "change_1m_pct": None,
        "change_ytd_pct": None,
    }
    try:
        # Pull enough history to cover YTD plus a month of margin.
        today = date.today()
        ytd_days = (today - date(today.year, 1, 1)).days + 35
        pts = fetch_arbitrary_ticker(symbol, days=max(ytd_days, 60))
        clean = [p for p in pts if p.get("value") is not None]
        if clean:
            price = clean[-1]["value"]
            row["price"] = round(price, 2)
            month_ago = clean[-23]["value"] if len(clean) >= 23 else clean[0]["value"]
            row["change_1m_pct"] = _pct_change(price, month_ago)
            # YTD anchor: first close on/after Jan 1 (clean is date-ascending).
            jan1 = f"{today.year}-01-01"
            ytd_base = next((p["value"] for p in clean if p["date"] >= jan1), clean[0]["value"])
            row["change_ytd_pct"] = _pct_change(price, ytd_base)

        info = _yf_info(symbol)
        if info:
            raw_yield = info.get("yield")
            if raw_yield is None:
                raw_yield = info.get("trailingAnnualDividendYield")
            # yfinance reports these as decimals (0.043 = 4.3%).
            if raw_yield is not None:
                row["yield_pct"] = round(float(raw_yield) * 100, 2)
            if row["price"] is None and info.get("regularMarketPrice") is not None:
                row["price"] = round(float(info["regularMarketPrice"]), 2)
    except Exception as e:
        log.warning("fixed_income _etf_row(%s) failed: %s", symbol, e)

    cache.set(cache_key, row, _TTL)
    return row


def _treasury_section() -> dict:
    """Treasury yields by maturity + curve shape, composed from yield_curve.

    Never raises — returns null-filled structure on any failure.
    """
    try:
        curve = yc.current_curve()
        shape = yc.shape_summary(curve)
        maturities = [
            {
                "maturity": p["maturity"],
                "years": p["years"],
                "yield_pct": p["yield"],
                "change_bps": p.get("delta_bps"),
            }
            for p in curve.get("points", [])
        ]
        return {
            "date": curve.get("date"),
            "maturities": maturities,
            "shape": shape,
        }
    except Exception as e:
        log.warning("fixed_income _treasury_section failed: %s", e)
        return {"date": None, "maturities": [], "shape": None}


def overview() -> dict:
    """Treasury yields + curve shape + bond-ETF table. Never raises."""
    treasuries = _treasury_section()

    etfs: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_etf_row, sym, tracks) for sym, tracks in BOND_ETFS]
        results = {}
        for fut, (sym, tracks) in zip(futures, BOND_ETFS):
            try:
                results[sym] = fut.result()
            except Exception as e:
                log.warning("fixed_income overview etf(%s) failed: %s", sym, e)
                results[sym] = {
                    "symbol": sym, "tracks": tracks, "price": None,
                    "yield_pct": None, "change_1m_pct": None, "change_ytd_pct": None,
                }
        etfs = [results[sym] for sym, _ in BOND_ETFS]

    return {
        "treasuries": treasuries,
        "bond_etfs": etfs,
    }
