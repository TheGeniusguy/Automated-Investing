"""Crack Spreads & Refining Margins (Bloomberg `CRK`).

Computes the standard refiner crack spreads from front-month energy futures:
- WTI crude            CL=F  ($/bbl)
- RBOB gasoline        RB=F  ($/gal -> x42 = $/bbl)
- Heating oil / ULSD   HO=F  ($/gal -> x42 = $/bbl)

Spreads (all $/bbl):
- 3-2-1 crack   = (2*RB*42 + 1*HO*42 - 3*CL) / 3
- 5-3-2 crack   = (3*RB*42 + 2*HO*42 - 5*CL) / 5
- gasoline crack (1-1)   = RB*42 - CL
- distillate crack (1-1) = HO*42 - CL

Graceful degradation: on ANY failure we fall back to a deterministic,
md5-seeded SAMPLE series so the payload is always populated. Never raises.

Public entry point: `crack_spreads() -> dict`.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone

import numpy as np

log = logging.getLogger(__name__)

GAL_PER_BBL = 42.0
HISTORY_DAYS = 365
TRADING_DAYS = 252

# Front-month futures tickers.
CL = "CL=F"  # WTI crude, $/bbl
RB = "RB=F"  # RBOB gasoline, $/gal
HO = "HO=F"  # heating oil / ULSD, $/gal

# Realistic sample anchors (recent regime).
SAMPLE_ANCHORS = {
    "cl": {"base": 78.0, "vol": 0.018},   # $/bbl
    "rb": {"base": 2.46, "vol": 0.020},   # $/gal
    "ho": {"base": 2.55, "vol": 0.019},   # $/gal
}


# --- deterministic sample helpers -------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    """Business-day-ish date strings ending today, ascending."""
    end = datetime.now(timezone.utc).date()
    out: list[str] = []
    d = end - timedelta(days=days)
    while d <= end:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out[-TRADING_DAYS:]


def _sample_series(key: str, dates: list[str]) -> np.ndarray:
    """Deterministic mean-reverting price path for a futures leg."""
    anchor = SAMPLE_ANCHORS[key]
    base = anchor["base"]
    vol = anchor["vol"]
    n = len(dates)
    rng = np.random.default_rng(_seed("crk:" + key))
    shocks = rng.normal(0.0, vol, n)
    prices = np.empty(n, dtype=float)
    level = base
    for i in range(n):
        # gentle mean reversion toward base
        level = level * (1.0 + shocks[i]) + 0.04 * (base - level)
        prices[i] = level
    return prices


# --- spread math ------------------------------------------------------------

def _crack_321(cl, rb, ho):
    return (2.0 * rb * GAL_PER_BBL + 1.0 * ho * GAL_PER_BBL - 3.0 * cl) / 3.0


def _crack_532(cl, rb, ho):
    return (3.0 * rb * GAL_PER_BBL + 2.0 * ho * GAL_PER_BBL - 5.0 * cl) / 5.0


def _crack_gas(cl, rb, ho):
    return rb * GAL_PER_BBL - cl


def _crack_distillate(cl, rb, ho):
    return ho * GAL_PER_BBL - cl


SPREAD_DEFS = [
    ("3-2-1 Crack", "crack_321", _crack_321,
     "Blended refiner margin: 3 barrels crude -> 2 gasoline + 1 distillate."),
    ("Gasoline Crack (1-1)", "crack_gas", _crack_gas,
     "RBOB gasoline value over WTI crude, per barrel."),
    ("Distillate Crack (1-1)", "crack_distillate", _crack_distillate,
     "Heating oil / ULSD value over WTI crude, per barrel."),
    ("5-3-2 Crack", "crack_532", _crack_532,
     "Alternate refiner margin: 5 crude -> 3 gasoline + 2 distillate."),
]


def _pct_rank(series: np.ndarray, value: float) -> float:
    if series.size == 0:
        return 50.0
    return round(float(np.mean(series <= value)) * 100.0, 1)


def _build_spread(name, key, fn, note, cl, rb, ho, dates):
    """Build one spread dict from aligned leg arrays."""
    vals = fn(cl, rb, ho)
    vals = np.asarray(vals, dtype=float)
    finite = vals[np.isfinite(vals)]
    if finite.size == 0:
        finite = np.array([0.0])
    current = float(vals[-1])
    prev = float(vals[-2]) if vals.size >= 2 else current
    change = round(current - prev, 2)
    hi = round(float(np.max(finite)), 2)
    lo = round(float(np.min(finite)), 2)
    avg_20d = round(float(np.mean(vals[-20:])), 2) if vals.size else current
    history = [
        {"date": dates[i], "value": round(float(vals[i]), 2)}
        for i in range(len(dates))
        if np.isfinite(vals[i])
    ]
    span = hi - lo if hi > lo else 1.0
    rank = _pct_rank(finite, current)
    if rank >= 70:
        context = "strong - margins rich vs 1y"
    elif rank <= 30:
        context = "weak - margins compressed vs 1y"
    else:
        context = "mid-range vs 1y"
    return {
        "name": name,
        "key": key,
        "current": round(current, 2),
        "change": change,
        "unit": "$/bbl",
        "pct_rank": rank,
        "hi_1y": hi,
        "lo_1y": lo,
        "avg_20d": avg_20d,
        "context": context,
        "note": note,
        "history": history,
    }


# --- alignment of live legs -------------------------------------------------

def _to_map(bars) -> dict[str, float]:
    out: dict[str, float] = {}
    if not bars:
        return out
    for b in bars:
        v = b.get("value")
        d = b.get("date")
        if v is None or d is None:
            continue
        try:
            out[d] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def _live_payload() -> dict | None:
    """Attempt real futures. Returns None if data insufficient."""
    try:
        from app.data.macro_data import fetch_arbitrary_ticker
    except Exception as e:
        log.warning("crack_spreads: macro_data import failed: %s", e)
        return None

    cl_bars = fetch_arbitrary_ticker(CL, HISTORY_DAYS)
    rb_bars = fetch_arbitrary_ticker(RB, HISTORY_DAYS)
    ho_bars = fetch_arbitrary_ticker(HO, HISTORY_DAYS)

    cl_map = _to_map(cl_bars)
    rb_map = _to_map(rb_bars)
    ho_map = _to_map(ho_bars)

    common = sorted(set(cl_map) & set(rb_map) & set(ho_map))
    if len(common) < 30:
        return None

    cl = np.array([cl_map[d] for d in common], dtype=float)
    rb = np.array([rb_map[d] for d in common], dtype=float)
    ho = np.array([ho_map[d] for d in common], dtype=float)

    spreads = [
        _build_spread(name, key, fn, note, cl, rb, ho, common)
        for name, key, fn, note in SPREAD_DEFS
    ]
    return {
        "spreads": spreads,
        "front_month": {
            "cl": round(float(cl[-1]), 2),
            "rb": round(float(rb[-1]), 4),
            "ho": round(float(ho[-1]), 4),
        },
        "data_mode": "live",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "source": "yfinance front-month futures (CL=F, RB=F, HO=F)",
    }


def _sample_payload() -> dict:
    dates = _sample_dates(HISTORY_DAYS)
    cl = _sample_series("cl", dates)
    rb = _sample_series("rb", dates)
    ho = _sample_series("ho", dates)
    spreads = [
        _build_spread(name, key, fn, note, cl, rb, ho, dates)
        for name, key, fn, note in SPREAD_DEFS
    ]
    return {
        "spreads": spreads,
        "front_month": {
            "cl": round(float(cl[-1]), 2),
            "rb": round(float(rb[-1]), 4),
            "ho": round(float(ho[-1]), 4),
        },
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "source": "deterministic sample (md5-seeded)",
    }


def crack_spreads() -> dict:
    """Public entry point. Always returns a populated payload; never raises."""
    try:
        live = _live_payload()
        if live is not None:
            return live
    except Exception as e:
        log.warning("crack_spreads: live path failed, using sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:  # absolute last resort
        log.error("crack_spreads: sample path failed: %s", e)
        return {
            "spreads": [],
            "front_month": {"cl": 0.0, "rb": 0.0, "ho": 0.0},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(),
            "source": "fallback",
        }
