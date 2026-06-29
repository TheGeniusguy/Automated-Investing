"""Carry & Rolldown Curve RV Analyzer (Bloomberg `CARRY`).

Decomposes the expected holding-period return of every point on the Treasury
curve - and the most-watched relative-value curve trades - into its two
fundamental drivers:

  - CARRY: the yield income earned over the horizon net of funding (repo). A
    bond yielding more than it costs to fund throws off positive carry; an
    inverted front end makes carry negative.
  - ROLLDOWN: the price gain captured as a bond *ages* and rolls down a
    upward-sloping curve toward lower yields. Approximated as the yield pickup
    from the current maturity to the (maturity - horizon) point, times the
    bond's modified duration.

TOTAL carry+roll = carry + rolldown, computed for 3m / 6m / 12m horizons. We
also build the classic RV trades - a 2s10s steepener, a 5s30s, and a 2s5s10s
butterfly - and quote each trade's net carry+roll on a DV01-neutral basis so
the legs' rate-level exposure cancels and only the slope/curvature carry shows
through. Everything is ranked richest-first.

Live path: pull the spot Treasury curve from FRED via the SAME `macro_data`
fetch path `yield_curve.py` uses (DGS* series). When FRED is unavailable we
degrade to a deterministic realistic SAMPLE curve and compute the identical
analytics, tagging the payload with data_mode="sample". This module never
raises - it always returns a populated payload with data_mode / as_of / source
for honesty under the hood.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from . import macro_data

log = logging.getLogger(__name__)

# Curve points we analyze (FRED id, label, years). Short → long.
CURVE_POINTS: list[tuple[str, str, float]] = [
    ("DGS6MO", "6M",  0.5),
    ("DGS1",   "1Y",  1.0),
    ("DGS2",   "2Y",  2.0),
    ("DGS3",   "3Y",  3.0),
    ("DGS5",   "5Y",  5.0),
    ("DGS7",   "7Y",  7.0),
    ("DGS10",  "10Y", 10.0),
    ("DGS20",  "20Y", 20.0),
    ("DGS30",  "30Y", 30.0),
]

# Funding / repo proxy = the 3M bill yield (front of the curve).
FUNDING_ID = "DGS3MO"
FUNDING_YEARS = 0.25

HISTORY_DAYS = 30  # we only need the latest spot, but pull a small window.

# Horizons we always compute, in months.
HORIZONS = (3, 6, 12)

# Deterministic, realistic SAMPLE spot curve (early-2026 levels, % yields).
# Slightly inverted front, gentle re-steepening into the belly + long end.
SAMPLE_CURVE: dict[str, float] = {
    "DGS3MO": 4.55,
    "DGS6MO": 4.45,
    "DGS1":   4.20,
    "DGS2":   4.00,
    "DGS3":   3.95,
    "DGS5":   4.00,
    "DGS7":   4.15,
    "DGS10":  4.30,
    "DGS20":  4.65,
    "DGS30":  4.55,
}


# ---------------------------------------------------------------------------
# Curve helpers
# ---------------------------------------------------------------------------

def _mod_duration(yield_pct: float, years: float) -> float:
    """Modified duration of a par bond (coupon = yield). For a par bond priced
    at 100 this reduces to (1 - (1+y)^-T) / y, which → T as y → 0 and gives
    realistic levels (10Y ≈ 8, 30Y ≈ 17 at ~4% yields). Guards a tiny floor."""
    y = max(yield_pct, 0.01) / 100.0
    return round((1.0 - (1.0 + y) ** (-years)) / y, 3)


def _interp_yield(curve: list[tuple[float, float]], years: float) -> float:
    """Linear interpolation of the spot yield at an arbitrary maturity (years).
    `curve` is a sorted list of (years, yield). Clamps to the endpoints."""
    if not curve:
        return 0.0
    if years <= curve[0][0]:
        return curve[0][1]
    if years >= curve[-1][0]:
        return curve[-1][1]
    for i in range(1, len(curve)):
        x0, y0 = curve[i - 1]
        x1, y1 = curve[i]
        if years <= x1:
            w = (years - x0) / (x1 - x0) if x1 > x0 else 0.0
            return y0 + w * (y1 - y0)
    return curve[-1][1]


def _point_horizon(yield_pct: float, years: float, funding: float,
                   mod_dur: float, curve: list[tuple[float, float]],
                   horizon_months: int) -> dict:
    """Carry + rolldown (in bps) for a single curve point over one horizon."""
    h = horizon_months / 12.0
    # CARRY: yield income net of funding, accrued over the horizon fraction.
    # (y - funding) is in %, * 100 → bps, * h → horizon fraction.
    carry_bps = (yield_pct - funding) * 100.0 * h
    # ROLLDOWN: bond ages by h years → rolls to the (years - h) yield. Price
    # return ≈ -mod_dur * Δy, with Δy = y_rolled - y_now (decimal). When the
    # curve is upward-sloping y_rolled < y_now so rolldown is positive.
    rolled_years = max(years - h, FUNDING_YEARS)
    y_rolled = _interp_yield(curve, rolled_years)
    rolldown_bps = -mod_dur * (y_rolled - yield_pct) * 100.0
    total_bps = carry_bps + rolldown_bps
    return {
        "carry_bps": round(carry_bps, 1),
        "rolldown_bps": round(rolldown_bps, 1),
        "total_bps": round(total_bps, 1),
    }


def _per_dv01(yield_pct: float, years: float, funding: float, mod_dur: float,
              curve: list[tuple[float, float]], horizon_months: int) -> dict:
    """Carry + roll expressed PER UNIT OF DV01 (bps), so legs of an RV trade
    can be combined DV01-neutral and the rate-level exposure cancels.

    carry/DV01 = carry_bps / mod_dur ; roll/DV01 = -(y_rolled - y_now)*100."""
    h = horizon_months / 12.0
    dur = max(mod_dur, 0.05)
    carry = (yield_pct - funding) * 100.0 * h / dur
    rolled_years = max(years - h, FUNDING_YEARS)
    y_rolled = _interp_yield(curve, rolled_years)
    roll = -(y_rolled - yield_pct) * 100.0
    return {"carry": carry, "roll": roll}


# ---------------------------------------------------------------------------
# Trade construction (DV01-neutral net carry+roll)
# ---------------------------------------------------------------------------

# Each trade is a set of (label, weight) legs in DV01 units. Positive weight =
# long (receive), negative = short (pay). The net carry/roll is the weighted
# sum of the per-DV01 figures, scaled to a readable per-trade size.
TRADES: list[tuple[str, str, list[tuple[str, float]]]] = [
    ("2s10s Steepener",
     "Long 2Y / short 10Y, DV01-neutral — profits as the curve steepens",
     [("2Y", 1.0), ("10Y", -1.0)]),
    ("5s30s Steepener",
     "Long 5Y / short 30Y, DV01-neutral — belly vs long-end slope",
     [("5Y", 1.0), ("30Y", -1.0)]),
    ("2s5s10s Butterfly",
     "Long belly (5Y) vs short wings (2Y + 10Y) — curvature carry/roll",
     [("5Y", 2.0), ("2Y", -1.0), ("10Y", -1.0)]),
]

# Scale per-DV01 net into a representative per-trade bps figure (≈ 10y DV01).
TRADE_DV01_SCALE = 8.0


def _build_trades(dv01_by_label: dict[str, dict], horizon_months: int) -> list[dict]:
    out: list[dict] = []
    for name, desc, legs in TRADES:
        carry = 0.0
        roll = 0.0
        ok = True
        for label, w in legs:
            leg = dv01_by_label.get(label)
            if leg is None:
                ok = False
                break
            carry += w * leg["carry"]
            roll += w * leg["roll"]
        if not ok:
            continue
        carry_bps = round(carry * TRADE_DV01_SCALE, 1)
        roll_bps = round(roll * TRADE_DV01_SCALE, 1)
        out.append({
            "name": name,
            "description": desc,
            "carry_bps": carry_bps,
            "rolldown_bps": roll_bps,
            "total_bps": round(carry_bps + roll_bps, 1),
        })
    return out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _assemble(yields: dict[str, float], horizon_months: int, *,
              data_mode: str, source: str) -> dict:
    funding = yields.get(FUNDING_ID)
    if funding is None:
        funding = yields.get("DGS6MO", 4.5)

    # Sorted (years, yield) curve used for interpolation, including funding.
    curve: list[tuple[float, float]] = [(FUNDING_YEARS, funding)]
    for fid, _label, yrs in CURVE_POINTS:
        y = yields.get(fid)
        if y is not None:
            curve.append((yrs, y))
    curve.sort(key=lambda t: t[0])

    points: list[dict] = []
    dv01_by_label: dict[str, dict] = {}
    for fid, label, yrs in CURVE_POINTS:
        y = yields.get(fid)
        if y is None:
            continue
        mod_dur = _mod_duration(y, yrs)
        horizons = {
            f"horizon_{m}m": _point_horizon(y, yrs, funding, mod_dur, curve, m)
            for m in HORIZONS
        }
        sel = horizons[f"horizon_{horizon_months}m"]
        dv01_by_label[label] = _per_dv01(y, yrs, funding, mod_dur, curve, horizon_months)
        points.append({
            "tenor_label": label,
            "tenor_years": yrs,
            "yield": round(y, 3),
            "funding_rate": round(funding, 3),
            "carry_bps": sel["carry_bps"],
            "rolldown_bps": sel["rolldown_bps"],
            "total_bps": sel["total_bps"],
            "mod_duration": mod_dur,
            "horizon_3m": horizons["horizon_3m"],
            "horizon_6m": horizons["horizon_6m"],
            "horizon_12m": horizons["horizon_12m"],
        })

    points.sort(key=lambda p: p["total_bps"], reverse=True)
    trades = _build_trades(dv01_by_label, horizon_months)
    trades.sort(key=lambda t: t["total_bps"], reverse=True)

    best_point = points[0]["tenor_label"] if points else None
    best_trade = trades[0]["name"] if trades else None
    richest = points[0]["total_bps"] if points else 0.0

    return {
        "horizon_months": horizon_months,
        "points": points,
        "trades": trades,
        "summary": {
            "best_point": best_point,
            "best_trade": best_trade,
            "richest_total_bps": richest,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live + sample paths
# ---------------------------------------------------------------------------

def _live_yields() -> dict[str, float] | None:
    """Pull the latest spot yield per maturity from FRED. Returns None when too
    few points resolved so the caller falls back to the sample curve."""
    all_ids = [FUNDING_ID] + [fid for fid, _, _ in CURVE_POINTS]
    yields: dict[str, float] = {}
    for fid in all_ids:
        try:
            series = macro_data.fetch_series(fid, days=HISTORY_DAYS)
        except Exception:
            series = []
        last = macro_data.latest_value(series) if series else None
        if last is not None:
            yields[fid] = float(last)
    # Need a meaningful curve: funding + a healthy fraction of the maturities.
    if FUNDING_ID not in yields or len(yields) < 6:
        return None
    return yields


def _sample_payload(horizon_months: int) -> dict:
    return _assemble(dict(SAMPLE_CURVE), horizon_months,
                     data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point — NEVER raises
# ---------------------------------------------------------------------------

def carry_rolldown(horizon_months: int = 3) -> dict:
    """Carry + rolldown RV analysis across the Treasury curve. See module
    docstring. Always returns a populated dict; degrades to a deterministic
    SAMPLE curve and tags the payload with data_mode / as_of / source."""
    if horizon_months not in HORIZONS:
        horizon_months = 3
    try:
        yields = _live_yields()
        if yields:
            payload = _assemble(yields, horizon_months, data_mode="live", source="FRED")
            if payload.get("points"):
                return payload
    except Exception as e:  # absolute safety net — contract forbids raising
        log.warning("carry_rolldown live path failed, returning sample: %s", e)
    try:
        return _sample_payload(horizon_months)
    except Exception as e:
        log.error("carry_rolldown sample path failed hard: %s", e)
        return {
            "horizon_months": horizon_months,
            "points": [],
            "trades": [],
            "summary": {"best_point": None, "best_trade": None, "richest_total_bps": 0.0},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
