"""FX seasonality engine (Bloomberg SEAG analog for currency pairs).

Given a clean currency-pair code (e.g. "EURUSD"), builds a calendar-seasonality
study from multi-year daily FX prices:

- Monthly average return + hit rate (share of years the month was positive) for
  each calendar month (Jan..Dec), plus best / worst year for that month and the
  sample size (years observed).
- Best / worst calendar month by average return, and the single strongest
  seasonal month (highest average return paired with a decent hit rate) with a
  one-line plain-language read.
- A month x year return matrix (the heatmap source).
- Day-of-week average returns (Mon..Fri).
- The current calendar month's seasonal stat (the "what usually happens now"
  read).

This is the FX analogue of the equity `seasonality.py` module and mirrors its
output shape closely so the FX panel feels consistent with the equity one.

Pair-to-symbol mapping: yfinance quotes FX spot with the "EURUSD=X" suffix form,
the same convention used by `data/fx_analytics.py`. A clean pair code is mapped
to "<PAIR>=X" before fetching via `macro_data.fetch_arbitrary_ticker`, the
universal price-history entrypoint.

Live path: daily prices via `fetch_arbitrary_ticker`. When the live source
returns nothing we degrade to a deterministic Geometric Brownian Motion (GBM)
walk seeded off the pair so the panel is always fully populated for screenshots.
The seed is derived with hashlib so the same pair always yields the same sample
series (stable screenshots). FX gets a near-zero annual drift and a low FX-style
volatility, so the synthetic monthly bars look like a real currency, not a stock.

This module never raises - it always returns a populated payload and tags it with
data_mode / as_of / source / pair for honesty under the hood.

Formulas (all pure numpy / stdlib):
  monthly return for (year, m) = close[last trading day of month] /
                                 close[last trading day of prior month] - 1
  avg_return_pct[m]   = mean over years of monthly return for calendar month m
  hit_rate_pct[m]     = 100 * (count of positive monthly returns for m) / count
  day_of_week avg[d]  = mean of daily simple returns whose date falls on weekday
                        d, where daily return = price[t]/price[t-1] - 1
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
FX_SEASONALITY_TTL = 60 * 60 * 6  # 6 hours - seasonal stats move slowly
MIN_POINTS = 60  # need a couple of months of data before the live path is useful
DEFAULT_YEARS = 15

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Common majors offered as panel presets / used to validate clean input. Any
# other 6-letter pair a user types is still accepted and mapped to "<PAIR>=X".
COMMON_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF",
                "NZDUSD", "EURGBP", "EURJPY"]
DEFAULT_PAIR = "EURUSD"

# Sample GBM drift/vol profile (annualized) tuned for FX, not equities: a tiny
# drift and a low single-digit vol. A small per-pair tilt is layered on top so
# different pairs do not all share an identical-looking study.
SAMPLE_ANN_RETURN = 0.005   # ~0.5% annual drift baseline
SAMPLE_ANN_VOL = 0.085      # ~8.5% annualized FX vol baseline


# ---------------------------------------------------------------------------
# Pair normalization + yfinance symbol mapping
# ---------------------------------------------------------------------------

def _normalize_pair(pair: str) -> str:
    """Clean a user pair code: strip slashes / '=X', uppercase.

    Falls back to the default when nothing usable remains. Accepts any 6-letter
    pair (not just the majors) so free-text input still works.
    """
    raw = (pair or "").strip().upper().replace("/", "").replace("=X", "").replace(" ", "")
    if len(raw) == 6 and raw.isalpha():
        return raw
    return DEFAULT_PAIR


def _yf_symbol(pair: str) -> str:
    """Map a clean pair code to the yfinance FX symbol form, e.g. EURUSD=X."""
    return f"{pair}=X"


# ---------------------------------------------------------------------------
# Deterministic sample-price synthesis (GBM seeded off the pair)
# ---------------------------------------------------------------------------

def _seed(pair: str) -> int:
    """Stable integer seed derived from the pair via hashlib (md5)."""
    return int(hashlib.md5(pair.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    """`days`+1 trading-day date strings (weekdays only) ending today."""
    out: list[str] = []
    d = date.today()
    while len(out) < days + 1:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_prices(pair: str, days: int) -> list[dict]:
    """Deterministic GBM price path as a list of {date, value} points.

    A per-pair drift/vol tilt (bounded, FX-scaled) keeps each pair's study
    distinct while staying realistic. Seeded off the pair so output is
    reproducible across calls (stable screenshots).
    """
    n_pts = max(days, MIN_POINTS + 5)
    dates = _sample_dates(n_pts)
    rng = np.random.default_rng(_seed(pair))

    # Per-pair tilt in [-1, 1] from independent hash slices.
    h = hashlib.md5(pair.encode()).hexdigest()
    tilt_ret = (int(h[8:12], 16) / 0xFFFF - 0.5) * 2.0
    tilt_vol = (int(h[12:16], 16) / 0xFFFF - 0.5) * 2.0

    ann_ret = SAMPLE_ANN_RETURN + tilt_ret * 0.03        # ~ -2.5% .. +3.5%
    ann_vol = max(SAMPLE_ANN_VOL + tilt_vol * 0.03, 0.04)  # floor 4%

    mu = ann_ret / TRADING_DAYS
    sig = ann_vol / np.sqrt(TRADING_DAYS)
    rets = rng.normal(mu, sig, len(dates) - 1)
    # Gentle deterministic seasonal wave so monthly bars are not all flat noise.
    months = np.array([int(d[5:7]) for d in dates[1:]])
    seasonal = 0.0004 * np.sin((months - 1) / 12.0 * 2 * np.pi + tilt_ret)
    rets = rets + seasonal

    # Base spot scaled per-pair so JPY crosses look like ~150, majors like ~1.1.
    base = 150.0 if pair.endswith("JPY") else 1.10
    prices = base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))
    prec = 3 if pair.endswith("JPY") else 5
    return [{"date": d, "value": round(float(p), prec)} for d, p in zip(dates, prices)]


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
    """Collapse to one close per (year, month): the last trading day's price."""
    by_ym: dict[tuple[int, int], float] = {}
    for d, price in pairs:  # pairs already sorted ascending
        y, m = int(d[0:4]), int(d[5:7])
        by_ym[(y, m)] = price  # last write wins -> last close of the month
    return [(y, m, by_ym[(y, m)]) for (y, m) in sorted(by_ym)]


def _monthly_returns(pairs: list[tuple[str, float]]) -> list[tuple[int, int, float]]:
    """Per-month simple returns as (year, month, return_fraction)."""
    me = _month_end_prices(pairs)
    out: list[tuple[int, int, float]] = []
    for i in range(1, len(me)):
        _, _, prev_close = me[i - 1]
        y, m, close = me[i]
        if prev_close > 0:
            out.append((y, m, close / prev_close - 1.0))
    return out


def _monthly_seasonality(monthly: list[tuple[int, int, float]]) -> list[dict]:
    """Aggregate per-month returns into the Jan..Dec seasonality table.

    Each row carries avg return %, hit rate %, sample size (years), and the
    best / worst year for that calendar month.
    """
    buckets: dict[int, list[tuple[int, float]]] = {m: [] for m in range(1, 13)}
    for y, m, r in monthly:
        buckets[m].append((y, r))
    table: list[dict] = []
    for m in range(1, 13):
        vals = buckets[m]
        if vals:
            arr = np.array([r for _, r in vals], dtype=float)
            avg = float(np.mean(arr))
            hit = float(np.mean(arr > 0))
            best_y, best_r = max(vals, key=lambda t: t[1])
            worst_y, worst_r = min(vals, key=lambda t: t[1])
            table.append({
                "month": m,
                "month_name": MONTH_NAMES[m - 1],
                "avg_return_pct": round(avg * 100, 3),
                "hit_rate_pct": round(hit * 100, 1),
                "count": int(arr.size),
                "best_year": int(best_y),
                "best_year_pct": round(best_r * 100, 3),
                "worst_year": int(worst_y),
                "worst_year_pct": round(worst_r * 100, 3),
            })
        else:
            table.append({
                "month": m,
                "month_name": MONTH_NAMES[m - 1],
                "avg_return_pct": None,
                "hit_rate_pct": None,
                "count": 0,
                "best_year": None,
                "best_year_pct": None,
                "worst_year": None,
                "worst_year_pct": None,
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


def _strongest_month(table: list[dict]) -> dict | None:
    """Strongest seasonal month: highest avg return among months with a decent
    hit rate (>=55%). Falls back to the plain best month if none clear the bar.
    """
    computable = [r for r in table if r["avg_return_pct"] is not None]
    if not computable:
        return None
    decent = [r for r in computable if (r["hit_rate_pct"] or 0) >= 55.0]
    pool = decent if decent else computable
    return max(pool, key=lambda r: r["avg_return_pct"])


def _read_line(pair: str, strongest: dict | None, worst: dict | None) -> str:
    """One-line plain-language seasonal read."""
    if not strongest or strongest.get("avg_return_pct") is None:
        return f"{pair} shows no clear monthly seasonal pattern over the sample."
    avg = strongest["avg_return_pct"]
    hit = strongest["hit_rate_pct"]
    name = strongest["month_name"]
    direction = "strengthened" if avg >= 0 else "weakened"
    tail = ""
    if worst and worst.get("avg_return_pct") is not None and worst["month"] != strongest["month"]:
        tail = (f" Its weakest month is {worst['month_name']} "
                f"({worst['avg_return_pct']:+.2f}% avg).")
    return (f"{pair} has historically {direction} most in {name} "
            f"({avg:+.2f}% avg, positive {hit:.0f}% of years).{tail}")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def fx_seasonality(pair: str, years: int = DEFAULT_YEARS) -> dict:
    """Build a calendar-seasonality study for an FX `pair` (e.g. "EURUSD").

    Never raises - degrades to a deterministic GBM sample series and tags the
    payload with data_mode / as_of / source / pair.
    """
    try:
        return _fx_seasonality(pair, years)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("fx_seasonality failed hard, returning sample: %s", e)
        p = _normalize_pair(pair)
        yrs = years if isinstance(years, int) and years > 0 else DEFAULT_YEARS
        try:
            return _build(p, yrs, _sample_prices(p, yrs * TRADING_DAYS),
                          data_mode="sample", source="sample")
        except Exception:
            return _empty_payload(p, yrs)


def _fx_seasonality(pair: str, years: int) -> dict:
    p = _normalize_pair(pair)
    yrs = years if isinstance(years, int) and years > 0 else DEFAULT_YEARS
    yrs = min(yrs, 50)

    cache_key = f"fx_seasonality:{p}:{yrs}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    points: list[dict] = []
    try:
        points = fetch_arbitrary_ticker(_yf_symbol(p), days=yrs * 365)
    except Exception as e:
        log.warning("fx_seasonality fetch failed for %s: %s", p, e)
        points = []

    pairs = _clean_points(points)
    if len(pairs) >= MIN_POINTS:
        result = _build(p, yrs, points, data_mode="live", source="yfinance")
    else:
        result = _build(p, yrs, _sample_prices(p, yrs * TRADING_DAYS),
                        data_mode="sample", source="sample")

    cache.set(cache_key, result, FX_SEASONALITY_TTL)
    return result


def _build(pair: str, years: int, points: list[dict], *,
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
    strongest = _strongest_month(table)

    cur_m = date.today().month
    current_month = next((row for row in table if row["month"] == cur_m), None)

    # Annual drift implied by stacking the average monthly returns (coherence
    # check / headline stat for the panel).
    avgs = [r["avg_return_pct"] for r in table if r["avg_return_pct"] is not None]
    annual_avg_pct = round(float(np.sum(avgs)), 3) if avgs else None

    return {
        "pair": pair,
        "symbol": _yf_symbol(pair),
        "years": years,
        "months": table,
        "month_year_matrix": matrix,
        "day_of_week": dow,
        "best_month": best,
        "worst_month": worst,
        "strongest_month": strongest,
        "current_month": current_month,
        "annual_avg_pct": annual_avg_pct,
        "read": _read_line(pair, strongest, worst),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_payload(pair: str, years: int) -> dict:
    table = _monthly_seasonality([])
    cur_m = date.today().month
    return {
        "pair": pair,
        "symbol": _yf_symbol(pair),
        "years": years,
        "months": table,
        "month_year_matrix": [],
        "day_of_week": _day_of_week([]),
        "best_month": None,
        "worst_month": None,
        "strongest_month": None,
        "current_month": next((r for r in table if r["month"] == cur_m), None),
        "annual_avg_pct": None,
        "read": _read_line(pair, None, None),
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
