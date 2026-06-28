"""Inter-commodity spreads & ratios engine (Wave F - cross-commodity desk).

Computes the classic cross-commodity relationships a macro/commodity desk
watches: the gold/silver "mint" ratio, gold/oil (barrels per ounce),
the WTI-Brent spread, gold/copper (defensive-vs-growth), the oil-to-gas
energy ratio, the soybean/corn ratio, and platinum/gold. For each it
derives the current level, the daily change, the trailing 1-2y high/low/mean,
a percentile rank, a z-score versus its own history, and the full history
series for charting.

Live path: front-month futures daily closes via
app.data.macro_data.fetch_arbitrary_ticker("GC=F", "SI=F", ...). Each leg
is guarded - if a leg is unavailable the ratio degrades to a deterministic
md5-seeded SAMPLE series (mean-reverting around a realistic level, stable
across runs for screenshots). When most legs are unavailable the whole set
falls back to SAMPLE and the payload is tagged data_mode="sample". This
module never raises - it always returns a populated payload carrying
data_mode / as_of / source for under-the-hood honesty.

NOTE: crack spreads are owned by a separate module (crack_spreads.py); this
module covers the cross-commodity RATIOS only.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

SPREADS_TTL = 60 * 30  # 30 minutes - cross-commodity ratios move slowly
HISTORY_DAYS = 500     # ~2y of trading days requested per leg
MIN_POINTS = 40        # need at least this many aligned points to trust live
MAX_HISTORY_OUT = 220  # downsample chart series to keep payloads lean


# ---------------------------------------------------------------------------
# Ratio definitions. op is "ratio" (num/den) or "spread" (num-den).
# sample_level / sample_sigma / sample_trend drive the deterministic
# md5-seeded fallback series so each ratio looks like a real, range-bound
# desk series even with no live feed. precision controls display rounding.
# ---------------------------------------------------------------------------

RATIO_SPECS: list[dict] = [
    {
        "key": "gold_silver",
        "name": "Gold / Silver",
        "num": "GC=F", "den": "SI=F", "op": "ratio",
        "unit": "ratio", "precision": 2, "headline": True,
        "sample_level": 86.0, "sample_sigma": 0.55, "sample_trend": 0.010,
        "blurb": "Ounces of silver per ounce of gold (the mint ratio). High = silver cheap vs gold / risk-off; low = silver leading / reflation.",
    },
    {
        "key": "gold_oil",
        "name": "Gold / Oil",
        "num": "GC=F", "den": "CL=F", "op": "ratio",
        "unit": "bbl/oz", "precision": 1, "headline": True,
        "sample_level": 30.5, "sample_sigma": 0.40, "sample_trend": 0.004,
        "blurb": "Barrels of WTI one ounce of gold buys. High = oil cheap or gold bid (slowdown/haven); low = energy leading.",
    },
    {
        "key": "wti_brent",
        "name": "WTI - Brent",
        "num": "CL=F", "den": "BZ=F", "op": "spread",
        "unit": "$/bbl", "precision": 2, "headline": True,
        "sample_level": -3.85, "sample_sigma": 0.18, "sample_trend": -0.004,
        "blurb": "WTI minus Brent. Persistently negative; a widening discount signals US glut / export & logistics stress.",
    },
    {
        "key": "oil_gas",
        "name": "Oil / Gas",
        "num": "CL=F", "den": "NG=F", "op": "ratio",
        "unit": "ratio", "precision": 1, "headline": True,
        "sample_level": 26.5, "sample_sigma": 0.65, "sample_trend": 0.012,
        "blurb": "Crude ($/bbl) divided by natural gas ($/MMBtu). Historically ~15-30; high = gas cheap on a BTU basis vs oil.",
    },
    {
        "key": "gold_copper",
        "name": "Gold / Copper",
        "num": "GC=F", "den": "HG=F", "op": "ratio",
        "unit": "ratio", "precision": 0, "headline": False,
        "sample_level": 525.0, "sample_sigma": 4.2, "sample_trend": 0.10,
        "blurb": "Defensive gold vs growth-cyclical copper. Rising = defensive leadership / slowdown; falling = pro-growth.",
    },
    {
        "key": "soy_corn",
        "name": "Soybeans / Corn",
        "num": "ZS=F", "den": "ZC=F", "op": "ratio",
        "unit": "ratio", "precision": 2, "headline": False,
        "sample_level": 2.62, "sample_sigma": 0.018, "sample_trend": 0.0004,
        "blurb": "Bushel-price ratio that drives US acreage decisions. High (>2.5) favors planting soybeans next season.",
    },
    {
        "key": "platinum_gold",
        "name": "Platinum / Gold",
        "num": "PL=F", "den": "GC=F", "op": "ratio",
        "unit": "ratio", "precision": 3, "headline": False,
        "sample_level": 0.415, "sample_sigma": 0.004, "sample_trend": -0.00008,
        "blurb": "Platinum priced in gold. Deeply below 1 historically; a turn up often tracks reviving industrial demand.",
    },
]


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _trading_dates(days: int) -> list[str]:
    """`days` weekday date strings ending today (most recent last)."""
    out: list[str] = []
    d = date.today()
    while len(out) < days:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_series(spec: dict, dates: list[str]) -> np.ndarray:
    """Mean-reverting series around a drifting center. Deterministic per key
    so the panel renders identically across calls (screenshot-stable)."""
    n = len(dates)
    rng = np.random.default_rng(_seed(spec["key"]))
    level = float(spec["sample_level"])
    sigma = float(spec["sample_sigma"])
    trend = float(spec["sample_trend"])
    kappa = 0.04  # pull back toward the drifting center each day
    x = np.empty(n, dtype=float)
    x[0] = level
    for i in range(1, n):
        center = level + trend * i
        shock = rng.normal(0.0, sigma)
        x[i] = x[i - 1] + kappa * (center - x[i - 1]) + shock
    return x


def _downsample(dates: list[str], values: list[float], n: int) -> list[dict]:
    """Evenly sample down to ~n points, always keeping the last point."""
    m = len(values)
    if m <= n:
        idx = range(m)
    else:
        step = (m - 1) / (n - 1)
        idx = sorted({int(round(k * step)) for k in range(n)} | {m - 1})
    return [{"date": dates[i], "value": values[i]} for i in idx]


# ---------------------------------------------------------------------------
# Live price helpers
# ---------------------------------------------------------------------------

def _fetch_closes(ticker: str) -> dict[str, float]:
    """date -> close map for a futures ticker. Never raises."""
    try:
        pts = fetch_arbitrary_ticker(ticker, days=HISTORY_DAYS) or []
        return {p["date"]: float(p["value"]) for p in pts if p.get("value") is not None}
    except Exception as e:  # belt-and-suspenders; fetch already guards
        log.warning("commodity_spreads fetch %s failed: %s", ticker, e)
        return {}


def _combine(num: dict[str, float], den: dict[str, float], op: str) -> tuple[list[str], list[float]]:
    """Align two close maps on common dates, apply op, return (dates, values)."""
    common = sorted(set(num) & set(den))
    dates: list[str] = []
    vals: list[float] = []
    for d in common:
        a, b = num[d], den[d]
        if a is None or b is None:
            continue
        if op == "ratio":
            if b == 0:
                continue
            vals.append(a / b)
        else:  # spread
            vals.append(a - b)
        dates.append(d)
    return dates, vals


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _stats(spec: dict, dates: list[str], values: list[float], data_mode: str, source: str) -> dict:
    arr = np.asarray(values, dtype=float)
    prec = int(spec["precision"])
    cur = float(arr[-1])
    prev = float(arr[-2]) if arr.size >= 2 else cur
    mean = float(np.mean(arr))
    std = float(np.std(arr, ddof=1)) if arr.size >= 2 else 0.0
    hi = float(np.max(arr))
    lo = float(np.min(arr))
    z = (cur - mean) / std if std > 0 else 0.0
    pct = float(np.mean(arr <= cur) * 100.0)  # percentile rank of current
    change = cur - prev
    change_pct = (change / prev * 100.0) if prev else 0.0

    def r(v: float) -> float:
        return round(v, prec)

    return {
        "key": spec["key"],
        "name": spec["name"],
        "num": spec["num"],
        "den": spec["den"],
        "op": spec["op"],
        "unit": spec["unit"],
        "headline": bool(spec.get("headline")),
        "precision": prec,
        "current": r(cur),
        "change": round(change, prec + 1),
        "change_pct": round(change_pct, 2),
        "z_score": round(z, 2),
        "pct_rank": round(pct, 1),
        "hi": r(hi),
        "lo": r(lo),
        "mean": r(mean),
        "std": round(std, prec + 2),
        "blurb": spec["blurb"],
        "n_obs": int(arr.size),
        "data_mode": data_mode,
        "source": source,
        "history": _downsample(dates, [round(float(v), prec + 2) for v in values], MAX_HISTORY_OUT),
    }


def _live_ratio(spec: dict) -> dict | None:
    """Attempt a fully live ratio. Returns None if either leg is too thin."""
    num = _fetch_closes(spec["num"])
    den = _fetch_closes(spec["den"])
    if not num or not den:
        return None
    dates, values = _combine(num, den, spec["op"])
    if len(values) < MIN_POINTS:
        return None
    return _stats(spec, dates, values, data_mode="live", source="yfinance")


def _sample_ratio(spec: dict) -> dict:
    dates = _trading_dates(HISTORY_DAYS)
    values = list(_sample_series(spec, dates))
    return _stats(spec, dates, values, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def commodity_spreads() -> dict:
    """Cross-commodity spreads & ratios. Never raises - always returns a
    fully-populated payload tagged with data_mode / as_of / source."""
    try:
        return _commodity_spreads()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("commodity_spreads failed hard, returning sample: %s", e)
        ratios = [_sample_ratio(spec) for spec in RATIO_SPECS]
        return _assemble(ratios, data_mode="sample", source="sample")


def _commodity_spreads() -> dict:
    cached = cache.get("commodity_spreads:v1")
    if cached is not None:
        return cached

    ratios: list[dict] = []
    live_count = 0
    for spec in RATIO_SPECS:
        live = None
        try:
            live = _live_ratio(spec)
        except Exception as e:
            log.warning("commodity_spreads live %s failed: %s", spec["key"], e)
            live = None
        if live is not None:
            live_count += 1
            ratios.append(live)
        else:
            ratios.append(_sample_ratio(spec))

    # Overall honesty tag: live only when a majority of legs resolved.
    if live_count >= (len(RATIO_SPECS) + 1) // 2:
        data_mode, source = "live", "yfinance"
    else:
        data_mode, source = "sample", "sample"

    payload = _assemble(ratios, data_mode=data_mode, source=source, live_count=live_count)
    cache.set("commodity_spreads:v1", payload, SPREADS_TTL)
    return payload


def _assemble(ratios: list[dict], *, data_mode: str, source: str, live_count: int | None = None) -> dict:
    return {
        "ratios": ratios,
        "count": len(ratios),
        "live_count": live_count if live_count is not None else 0,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
