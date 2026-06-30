"""Natural-Gas Storage vs 5-Year Band (EIA weekly working-gas-in-storage).

The weekly EIA Natural Gas Storage Report is one of the highest-signal data
releases in energy. This module pulls the working-gas-in-storage level for the
Lower 48 (Bcf), builds a recent weekly history (~60 weeks), and frames the
current level against its seasonal norm:

  - the 5-YEAR AVERAGE by week-of-year,
  - the 5-YEAR MIN/MAX seasonal ENVELOPE (the shaded band),
  - the weekly_change = current - prior (an injection when positive, a
    withdrawal when negative), and
  - surplus_deficit_vs_avg = current - 5yr_avg (in Bcf and %).

Storage running below the 5-year average (a deficit) is bullish for gas prices;
a surplus is bearish. The seasonal band makes "tight" vs "loose" obvious at a
glance.

Live path: pull FRED `NGSTLW` (Working Gas in Underground Storage, Lower 48,
weekly, Bcf) via `macro_data.fetch_series` over ~6 years so we can derive the
5-year seasonal band by week-of-year. When the FRED key/feed is unavailable we
degrade to a deterministic md5-seeded SAMPLE curve (a realistic seasonal
storage cycle with a believable surplus/deficit) tagged data_mode="sample".

INVARIANTS held on every payload:
  - weekly_change == current_bcf - prior_bcf
  - surplus_deficit_bcf == current_bcf - five_yr_avg_bcf
  - five_yr_min_bcf <= five_yr_avg_bcf <= five_yr_max_bcf

This module NEVER raises - it always returns a populated payload carrying an
internal data_mode ("live"|"sample") + as_of + source.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

# FRED series: Working Gas in Underground Storage, Lower 48 States (weekly, Bcf).
FRED_SERIES = "NGSTLW"
# Pull ~6.3 years so we can build a 5-year band for the most recent ~60 weeks.
LIVE_DAYS = 2300
# How many of the most recent weeks to render in the history trail.
HISTORY_WEEKS = 60
# Years that make up the seasonal band.
BAND_YEARS = 5
# Surplus/deficit band: inside +/- this % of the 5yr avg we call it "Normal".
NORMAL_PCT = 1.0


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(key: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{key}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(key: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by key + salt."""
    return (_hash(key, salt) % 1_000_000) / 1_000_000.0


def _status(surplus_pct: float) -> str:
    if surplus_pct > NORMAL_PCT:
        return "Surplus"
    if surplus_pct < -NORMAL_PCT:
        return "Deficit"
    return "Normal"


def _round(x: float | None, n: int = 1) -> float | None:
    return round(float(x), n) if x is not None else None


# ---------------------------------------------------------------------------
# Seasonal-band math (shared by live + sample assembly)
# ---------------------------------------------------------------------------

def _week_of_year(d: date) -> int:
    return d.isocalendar()[1]


def _band_for_week(by_week_year: dict[int, dict[int, float]], woy: int,
                   year: int) -> tuple[float | None, float | None, float | None]:
    """5-year avg/min/max for a given week-of-year, using the BAND_YEARS calendar
    years strictly before `year`. Falls back to any other available years for
    that week when the prior-5 window is thin. Returns (avg, min, max); all None
    when no comparable history exists. min<=avg<=max holds by construction."""
    per_year = by_week_year.get(woy, {})
    vals = [v for y, v in per_year.items() if year - BAND_YEARS <= y < year]
    if not vals:
        # Fall back to any other years (excluding the point's own year).
        vals = [v for y, v in per_year.items() if y != year]
    if not vals:
        return None, None, None
    avg = sum(vals) / len(vals)
    return avg, min(vals), max(vals)


def _assemble_from_points(points: list[dict], *, data_mode: str, source: str) -> dict | None:
    """Build the payload from a list of {date, value} weekly points. Returns
    None when there is too little data to be meaningful (caller falls back)."""
    clean: list[tuple[date, float]] = []
    for p in points:
        v = p.get("value")
        d = p.get("date")
        if v is None or d is None:
            continue
        try:
            dt = datetime.fromisoformat(str(d)[:10]).date()
        except Exception:
            continue
        clean.append((dt, float(v)))
    if len(clean) < 2:
        return None
    clean.sort(key=lambda t: t[0])

    # Index values by week-of-year -> year -> value (last obs in that week wins).
    by_week_year: dict[int, dict[int, float]] = {}
    for dt, v in clean:
        woy = _week_of_year(dt)
        by_week_year.setdefault(woy, {})[dt.year] = v

    # Build the history trail (most recent HISTORY_WEEKS points).
    trail = clean[-HISTORY_WEEKS:]
    history: list[dict] = []
    for dt, lvl in trail:
        avg, lo, hi = _band_for_week(by_week_year, _week_of_year(dt), dt.year)
        history.append({
            "week": dt.isoformat(),
            "level": _round(lvl),
            "avg": _round(avg),
            "min": _round(lo),
            "max": _round(hi),
        })

    cur_dt, current = clean[-1]
    prior_dt, prior = clean[-2]
    weekly_change = current - prior

    avg, lo, hi = _band_for_week(by_week_year, _week_of_year(cur_dt), cur_dt.year)
    if avg is None:
        return None
    surplus = current - avg
    surplus_pct = (surplus / avg * 100.0) if avg else 0.0
    status = _status(surplus_pct)

    return _payload(
        current=current, prior=prior, weekly_change=weekly_change,
        avg=avg, lo=lo, hi=hi, surplus=surplus, surplus_pct=surplus_pct,
        status=status, history=history, as_of=cur_dt.isoformat(),
        data_mode=data_mode, source=source,
    )


def _payload(*, current, prior, weekly_change, avg, lo, hi, surplus, surplus_pct,
             status, history, as_of, data_mode, source) -> dict:
    flow = "injection" if weekly_change >= 0 else "withdrawal"
    if status == "Surplus":
        vs_normal = f"{abs(surplus):.0f} Bcf ({abs(surplus_pct):.1f}%) above the 5-year average"
    elif status == "Deficit":
        vs_normal = f"{abs(surplus):.0f} Bcf ({abs(surplus_pct):.1f}%) below the 5-year average"
    else:
        vs_normal = "essentially in line with the 5-year average"
    trend = flow if abs(weekly_change) >= 1 else "flat"
    headline = (
        f"Working gas at {current:,.0f} Bcf, a {abs(weekly_change):.0f} Bcf weekly "
        f"{flow}; {vs_normal}."
    )
    return {
        "current_bcf": _round(current),
        "prior_bcf": _round(prior),
        "weekly_change": _round(weekly_change),
        "five_yr_avg_bcf": _round(avg),
        "five_yr_min_bcf": _round(lo),
        "five_yr_max_bcf": _round(hi),
        "surplus_deficit_bcf": _round(surplus),
        "surplus_deficit_pct": _round(surplus_pct, 2),
        "status": status,
        "history": history,
        "summary": {
            "headline": headline,
            "vs_normal": vs_normal,
            "trend": trend,
        },
        "data_mode": data_mode,
        "as_of": as_of,
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _live_payload() -> dict | None:
    """Fetch FRED working-gas-in-storage and assemble. None on insufficient data."""
    try:
        from . import macro_data
    except Exception as e:
        log.warning("natgas_storage: macro_data import failed: %s", e)
        return None
    try:
        points = macro_data.fetch_series(FRED_SERIES, days=LIVE_DAYS) or []
    except Exception as e:
        log.warning("natgas_storage: FRED fetch failed: %s", e)
        return None
    if not points:
        return None
    try:
        return _assemble_from_points(points, data_mode="live", source="FRED:NGSTLW")
    except Exception as e:
        log.warning("natgas_storage: live assembly failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic seasonal storage cycle)
# ---------------------------------------------------------------------------

# US working-gas storage swings roughly from a ~1,700 Bcf early-spring trough to
# a ~3,700 Bcf autumn peak. We model that seasonal sine, anchor "today" near the
# spring shoulder, and bake in a small deterministic surplus/deficit.
SAMPLE_TROUGH = 1750.0   # Bcf, ~end of withdrawal season (late March)
SAMPLE_PEAK = 3750.0     # Bcf, ~end of injection season (mid November)


def _seasonal_level(woy: int) -> float:
    """Climatological 5yr-average level for a given week-of-year (Bcf).
    Trough ~week 13 (early April), peak ~week 46 (mid November)."""
    # Phase so that week 13 is the minimum of the cycle.
    phase = (woy - 13) / 52.0 * 2.0 * math.pi
    mid = (SAMPLE_PEAK + SAMPLE_TROUGH) / 2.0
    amp = (SAMPLE_PEAK - SAMPLE_TROUGH) / 2.0
    return mid - amp * math.cos(phase)


def _sample_payload() -> dict:
    today = datetime.now(timezone.utc).date()
    # Latest EIA report covers the week ending the prior Friday-ish; snap to a
    # weekly cadence anchored on `today`.
    weeks: list[date] = [today - timedelta(weeks=(HISTORY_WEEKS - 1 - i)) for i in range(HISTORY_WEEKS)]

    history: list[dict] = []
    prev_level: float | None = None
    cur_level = prior_level = 0.0
    cur_avg = cur_lo = cur_hi = 0.0
    for idx, wk in enumerate(weeks):
        woy = _week_of_year(wk)
        avg = _seasonal_level(woy)
        # Seasonal band width widens at the shoulders, tightens near extremes.
        spread = 180.0 + 90.0 * abs(math.sin((woy - 13) / 52.0 * 2.0 * math.pi))
        lo = avg - spread
        hi = avg + spread
        # Current-year line: a smooth deterministic deviation that drifts from a
        # modest surplus early in the window toward a deficit near "today".
        seed = _rand01(wk.isoformat(), "dev")
        drift = (idx / max(1, HISTORY_WEEKS - 1)) - 0.5  # -0.5 .. +0.5
        deviation = (-160.0 * drift) + (seed - 0.5) * 70.0
        # Keep the current line inside a believable range relative to the band.
        deviation = max(-spread * 0.95, min(spread * 0.95, deviation))
        level = avg + deviation
        history.append({
            "week": wk.isoformat(),
            "level": _round(level),
            "avg": _round(avg),
            "min": _round(lo),
            "max": _round(hi),
        })
        if idx == HISTORY_WEEKS - 2:
            prior_level = level
        if idx == HISTORY_WEEKS - 1:
            cur_level = level
            cur_avg, cur_lo, cur_hi = avg, lo, hi
        prev_level = level

    weekly_change = cur_level - prior_level
    surplus = cur_level - cur_avg
    surplus_pct = (surplus / cur_avg * 100.0) if cur_avg else 0.0
    status = _status(surplus_pct)
    return _payload(
        current=cur_level, prior=prior_level, weekly_change=weekly_change,
        avg=cur_avg, lo=cur_lo, hi=cur_hi, surplus=surplus, surplus_pct=surplus_pct,
        status=status, history=history, as_of=weeks[-1].isoformat(),
        data_mode="sample", source="sample",
    )


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def natgas_storage() -> dict:
    """Natural-gas working storage vs the 5-year seasonal band. See module
    docstring. Always returns a populated dict; degrades to deterministic SAMPLE
    data tagged with data_mode / as_of / source. Never raises."""
    try:
        live = _live_payload()
        if live is not None and live.get("history"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("natgas_storage live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("natgas_storage sample path failed hard: %s", e)
        now = datetime.now(timezone.utc).date().isoformat()
        return {
            "current_bcf": None, "prior_bcf": None, "weekly_change": None,
            "five_yr_avg_bcf": None, "five_yr_min_bcf": None, "five_yr_max_bcf": None,
            "surplus_deficit_bcf": None, "surplus_deficit_pct": None,
            "status": "Normal", "history": [],
            "summary": {"headline": "Natural-gas storage data unavailable.",
                        "vs_normal": "", "trend": "flat"},
            "data_mode": "sample", "as_of": now, "source": "sample",
        }
