"""Seasonality engine (Bloomberg SEAG analog).

Given a symbol, builds a calendar-seasonality study from daily prices:

- Monthly average return + hit rate (share of years the month was positive)
  for each calendar month (Jan..Dec).
- Best / worst calendar month by average return.
- A month x year return matrix (the heatmap source).
- Day-of-week average returns (Mon..Fri).
- The current calendar month's seasonal stat (the "what usually happens now"
  read).

Live path: daily prices via app.data.macro_data.fetch_arbitrary_ticker. When
the live source returns nothing we degrade to a deterministic Geometric
Brownian Motion (GBM) walk seeded off the symbol so the panel is always fully
populated for screenshots. The seed is derived with hashlib so the same symbol
always yields the same sample series (stable screenshots).

This module never raises - it always returns a populated payload and tags it
with data_mode / as_of / source for honesty under the hood.

Formulas (all pure numpy / stdlib):
  monthly return for (year, m) = close[last trading day of month] /
                                 close[last trading day of prior month] - 1
  avg_return_pct[m]   = mean over years of monthly return for calendar month m
  hit_rate_pct[m]     = 100 * (count of positive monthly returns for m) / count
  day_of_week avg[d]  = mean of daily simple returns whose date falls on
                        weekday d, where daily return = price[t]/price[t-1] - 1
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

TRADING_DAYS = 252
SEASONALITY_TTL = 60 * 60 * 6  # 6 hours - seasonal stats move slowly
MIN_POINTS = 60  # need a couple of months of data before the live path is useful

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Sample GBM drift/vol profile (annualized). A small per-symbol tilt is layered
# on top so different tickers do not all share an identical-looking study.
SAMPLE_ANN_RETURN = 0.09
SAMPLE_ANN_VOL = 0.17


# ---------------------------------------------------------------------------
# Deterministic sample-price synthesis (GBM seeded off the symbol)
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    """Stable integer seed derived from the symbol via hashlib (md5)."""
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    """`days`+1 trading-day date strings (weekdays only) ending today."""
    out: list[str] = []
    d = date.today()
    while len(out) < days + 1:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_prices(symbol: str, days: int) -> list[dict]:
    """Deterministic GBM price path as a list of {date, value} points.

    A per-symbol drift/vol tilt (bounded) keeps each symbol's study distinct
    while staying realistic. Seeded off the symbol so output is reproducible.
    """
    n_pts = max(days, MIN_POINTS + 5)
    dates = _sample_dates(n_pts)
    rng = np.random.default_rng(_seed(symbol))

    # Per-symbol tilt in [-1, 1] from two independent hash slices.
    h = hashlib.md5(symbol.encode()).hexdigest()
    tilt_ret = (int(h[8:12], 16) / 0xFFFF - 0.5) * 2.0
    tilt_vol = (int(h[12:16], 16) / 0xFFFF - 0.5) * 2.0

    ann_ret = SAMPLE_ANN_RETURN + tilt_ret * 0.06       # ~3% .. 15%
    ann_vol = max(SAMPLE_ANN_VOL + tilt_vol * 0.07, 0.06)  # floor 6%

    mu = ann_ret / TRADING_DAYS
    sig = ann_vol / np.sqrt(TRADING_DAYS)
    rets = rng.normal(mu, sig, len(dates) - 1)
    # Gentle deterministic seasonal wave so monthly bars are not all flat noise.
    months = np.array([int(d[5:7]) for d in dates[1:]])
    seasonal = 0.0006 * np.sin((months - 1) / 12.0 * 2 * np.pi + tilt_ret)
    rets = rets + seasonal

    base = 100.0
    prices = base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))
    return [{"date": d, "value": round(float(p), 4)} for d, p in zip(dates, prices)]


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------

def _clean_points(points: list[dict]) -> list[tuple[str, float]]:
    """Sorted (date, price) pairs with usable positive values."""
    out: list[tuple[str, float]] = []
    for p in points or []:
        d = p.get("date")
        v = p.get("value")
        if d and v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv > 0:
                out.append((str(d), fv))
    out.sort(key=lambda x: x[0])
    return out


def _month_end_prices(pairs: list[tuple[str, float]]) -> list[tuple[int, int, float]]:
    """Collapse to one close per (year, month): the last trading day's price.

    Returns a list of (year, month, close) ordered chronologically.
    """
    by_ym: dict[tuple[int, int], float] = {}
    for d, price in pairs:  # pairs already sorted ascending
        y, m = int(d[0:4]), int(d[5:7])
        by_ym[(y, m)] = price  # last write wins -> last close of the month
    return [(y, m, by_ym[(y, m)]) for (y, m) in sorted(by_ym)]


def _monthly_returns(pairs: list[tuple[str, float]]) -> list[tuple[int, int, float]]:
    """Per-month simple returns as (year, month, return_fraction).

    Each month's return uses the immediately preceding month-end close in the
    series. The first month has no prior close and is dropped.
    """
    me = _month_end_prices(pairs)
    out: list[tuple[int, int, float]] = []
    for i in range(1, len(me)):
        _, _, prev_close = me[i - 1]
        y, m, close = me[i]
        if prev_close > 0:
            out.append((y, m, close / prev_close - 1.0))
    return out


def _monthly_seasonality(monthly: list[tuple[int, int, float]]) -> list[dict]:
    """Aggregate per-month returns into the Jan..Dec seasonality table."""
    buckets: dict[int, list[float]] = {m: [] for m in range(1, 13)}
    for _, m, r in monthly:
        buckets[m].append(r)
    table: list[dict] = []
    for m in range(1, 13):
        vals = buckets[m]
        if vals:
            arr = np.array(vals, dtype=float)
            avg = float(np.mean(arr))
            hit = float(np.mean(arr > 0))
            table.append({
                "month": m,
                "month_name": MONTH_NAMES[m - 1],
                "avg_return_pct": round(avg * 100, 3),
                "hit_rate_pct": round(hit * 100, 1),
                "count": int(arr.size),
            })
        else:
            table.append({
                "month": m,
                "month_name": MONTH_NAMES[m - 1],
                "avg_return_pct": None,
                "hit_rate_pct": None,
                "count": 0,
            })
    return table


def _day_of_week(pairs: list[tuple[str, float]]) -> list[dict]:
    """Average simple daily return grouped by weekday (Mon..Fri)."""
    buckets: dict[int, list[float]] = {i: [] for i in range(5)}
    for i in range(1, len(pairs)):
        prev_close = pairs[i - 1][1]
        d, close = pairs[i]
        if prev_close > 0:
            wd = date.fromisoformat(d).weekday()
            if wd < 5:
                buckets[wd].append(close / prev_close - 1.0)
    out: list[dict] = []
    for wd in range(5):
        vals = buckets[wd]
        if vals:
            arr = np.array(vals, dtype=float)
            out.append({
                "day": DOW_NAMES[wd],
                "avg_return_pct": round(float(np.mean(arr)) * 100, 4),
                "count": int(arr.size),
            })
        else:
            out.append({"day": DOW_NAMES[wd], "avg_return_pct": None, "count": 0})
    return out


def _best_worst(table: list[dict]) -> tuple[dict | None, dict | None]:
    computable = [row for row in table if row["avg_return_pct"] is not None]
    if not computable:
        return None, None
    best = max(computable, key=lambda r: r["avg_return_pct"])
    worst = min(computable, key=lambda r: r["avg_return_pct"])
    return best, worst


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def seasonality(symbol: str, years: int = 15) -> dict:
    """Build a calendar-seasonality study for `symbol`.

    Never raises - degrades to a deterministic GBM sample series and tags the
    payload with data_mode / as_of / source.
    """
    try:
        return _seasonality(symbol, years)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("seasonality failed hard, returning sample: %s", e)
        sym = (symbol or "SPY").strip().upper() or "SPY"
        yrs = years if isinstance(years, int) and years > 0 else 15
        try:
            return _build(sym, yrs, _sample_prices(sym, yrs * TRADING_DAYS),
                          data_mode="sample", source="sample")
        except Exception:
            # Last-resort empty-but-shaped payload.
            return _empty_payload(sym, yrs)


def _seasonality(symbol: str, years: int) -> dict:
    sym = (symbol or "SPY").strip().upper() or "SPY"
    yrs = years if isinstance(years, int) and years > 0 else 15
    yrs = min(yrs, 50)

    cache_key = f"seasonality:{sym}:{yrs}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    points: list[dict] = []
    try:
        points = fetch_arbitrary_ticker(sym, days=yrs * 365)
    except Exception as e:
        log.warning("seasonality fetch failed for %s: %s", sym, e)
        points = []

    pairs = _clean_points(points)
    if len(pairs) >= MIN_POINTS:
        result = _build(sym, yrs, points, data_mode="live", source="yfinance")
    else:
        result = _build(sym, yrs, _sample_prices(sym, yrs * TRADING_DAYS),
                        data_mode="sample", source="sample")

    cache.set(cache_key, result, SEASONALITY_TTL)
    return result


def _build(symbol: str, years: int, points: list[dict], *,
           data_mode: str, source: str) -> dict:
    pairs = _clean_points(points)
    monthly = _monthly_returns(pairs)

    table = _monthly_seasonality(monthly)
    matrix = [
        {"year": y, "month": m, "return_pct": round(r * 100, 3)}
        for (y, m, r) in monthly
    ]
    dow = _day_of_week(pairs)
    best, worst = _best_worst(table)

    cur_m = date.today().month
    current_month = next((row for row in table if row["month"] == cur_m), None)

    return {
        "symbol": symbol,
        "years": years,
        "monthly": table,
        "month_year_matrix": matrix,
        "day_of_week": dow,
        "best_month": best,
        "worst_month": worst,
        "current_month": current_month,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_payload(symbol: str, years: int) -> dict:
    table = _monthly_seasonality([])
    cur_m = date.today().month
    return {
        "symbol": symbol,
        "years": years,
        "monthly": table,
        "month_year_matrix": [],
        "day_of_week": _day_of_week([]),
        "best_month": None,
        "worst_month": None,
        "current_month": next((r for r in table if r["month"] == cur_m), None),
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
