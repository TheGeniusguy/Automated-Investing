"""Central-Bank Balance Sheet & Net-Liquidity Monitor (Bloomberg FARBAST).

Builds the famous Fed "net liquidity" series, the proxy that macro desks watch
because it tracks risk-asset beta closely:

    NET LIQUIDITY = WALCL - TGA - RRP

where (all normalized to $ BILLIONS):
- WALCL     Fed total assets (FRED, native unit: $ millions)
- WTREGEN   Treasury General Account at the Fed (FRED, native unit: $ millions)
- RRPONTSYD Overnight Reverse Repo (FRED, native unit: $ billions)
- WRESBAL   Reserve balances (FRED, native unit: $ millions, optional)

The intuition: Fed assets create reserves (liquidity); cash parked in the TGA or
the RRP facility drains reserves back out of the banking system. Net liquidity is
the balance that actually reaches markets.

Live path: FRED via app.data.macro_data.fetch_series. When FRED is unavailable
(no key / upstream error / short series) we degrade to a deterministic,
md5-seeded SAMPLE series with realistic recent levels. This module NEVER raises:
it always returns a populated payload tagged with data_mode / as_of / source.

UNIT: every dollar figure in the payload is in $ BILLIONS.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

log = logging.getLogger(__name__)

UNIT = "$B"  # every dollar field below is in billions of dollars

# ~2.5 years of weekly history. WALCL is published weekly (Wednesday).
LOOKBACK_DAYS = 365 * 3
WEEKS = 132  # length of the synthetic weekly series in sample mode

# FRED native units -> billions multiplier
_TO_BILLIONS = {
    "WALCL": 1 / 1000.0,      # millions -> billions
    "WTREGEN": 1 / 1000.0,    # millions -> billions
    "RRPONTSYD": 1.0,         # already billions
    "WRESBAL": 1 / 1000.0,    # millions -> billions
}


# ---------------------------------------------------------------------------
# Deterministic sample-series synthesis (md5-seeded, stable across calls)
# ---------------------------------------------------------------------------

def _noise(key: str, i: int) -> float:
    """Deterministic pseudo-random value in [-1, 1] from md5(key:i)."""
    h = hashlib.md5(f"{key}:{i}".encode()).hexdigest()[:8]
    return (int(h, 16) / 0xFFFFFFFF) * 2.0 - 1.0


def _weekly_dates(weeks: int) -> list[str]:
    """`weeks` Wednesday date strings ending on/just before today, ascending."""
    out: list[str] = []
    d = date.today()
    # snap back to the most recent Wednesday (weekday 2)
    d -= timedelta(days=(d.weekday() - 2) % 7)
    for _ in range(weeks):
        out.append(d.isoformat())
        d -= timedelta(days=7)
    return list(reversed(out))


def _sample_series() -> list[dict]:
    """Rich, realistic weekly net-liquidity series.

    Tells the real 2023-2026 story: WALCL grinds lower under QT, the RRP facility
    drains from ~$2.1T toward ~$0.4T, the TGA oscillates around debt-ceiling and
    refunding cycles. Recent levels land near WALCL ~6.7T, TGA ~0.7T, RRP ~0.4T,
    net liquidity ~5.6T.
    """
    dates = _weekly_dates(WEEKS)
    n = len(dates)
    series: list[dict] = []
    for i, dstr in enumerate(dates):
        frac = i / max(n - 1, 1)  # 0 (oldest) -> 1 (newest)

        # WALCL: ~8.40T down to ~6.70T, gentle convex runoff + small wobble
        walcl = 8400.0 - 1700.0 * frac + 35.0 * _noise("walcl", i)

        # RRP: ~2100B draining toward ~400B (front-loaded drain, then flattening)
        rrp = 400.0 + 1700.0 * (1.0 - frac) ** 1.7 + 25.0 * _noise("rrp", i)
        rrp = max(rrp, 18.0)

        # TGA: oscillates 450-850 around refunding cycles, ends ~700
        tga = 650.0 + 130.0 * np.sin(frac * 9.0 + 0.6) + 45.0 * _noise("tga", i)
        tga = max(tga, 120.0)

        net = walcl - tga - rrp
        series.append({
            "date": dstr,
            "walcl": round(float(walcl), 1),
            "tga": round(float(tga), 1),
            "rrp": round(float(rrp), 1),
            "net_liquidity": round(float(net), 1),
        })
    return series


def _sample_reserves(series: list[dict]) -> float:
    """Reserves track net liquidity loosely; anchor current near ~3.3T."""
    # Reserves ~= a stable share of net liquidity with a small offset.
    last = series[-1]["net_liquidity"]
    return round(float(last) * 0.585 + 50.0, 1)


# ---------------------------------------------------------------------------
# Live FRED path helpers
# ---------------------------------------------------------------------------

def _fetch_normalized(series_id: str, days: int) -> list[tuple[str, float]]:
    """Fetch a FRED series and normalize to $ billions. Returns [(date, value)]
    ascending, nulls dropped. Empty list on any failure."""
    try:
        from .macro_data import fetch_series
        raw = fetch_series(series_id, days=days)
    except Exception as e:  # absolute guard - import or fetch issue
        log.warning("net_liquidity: fetch_series(%s) failed: %s", series_id, e)
        return []
    if not raw:
        return []
    mult = _TO_BILLIONS.get(series_id, 1.0)
    out: list[tuple[str, float]] = []
    for p in raw:
        v = p.get("value")
        d = p.get("date")
        if v is None or d is None:
            continue
        try:
            out.append((d, float(v) * mult))
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x[0])
    return out


def _asof(points: list[tuple[str, float]], target_date: str) -> float | None:
    """Most recent value with date <= target_date (forward-fill / as-of join)."""
    best: float | None = None
    for d, v in points:
        if d <= target_date:
            best = v
        else:
            break
    if best is None and points:
        best = points[0][1]  # before the series starts, clamp to first
    return best


def _value_at_lookback(series: list[dict], key: str, days_back: int) -> float | None:
    """Value of `key` closest to (last_date - days_back)."""
    if not series:
        return None
    try:
        last = datetime.strptime(series[-1]["date"], "%Y-%m-%d").date()
    except Exception:
        return None
    target = last - timedelta(days=days_back)
    best = None
    best_gap = None
    for row in series:
        try:
            d = datetime.strptime(row["date"], "%Y-%m-%d").date()
        except Exception:
            continue
        gap = abs((d - target).days)
        if best_gap is None or gap < best_gap:
            best_gap = gap
            best = row[key]
    return None if best is None else float(best)


def _qt_pace(series: list[dict]) -> float:
    """WALCL slope in $B per month over the last ~6 months (linear fit)."""
    if len(series) < 4:
        return 0.0
    try:
        d0 = datetime.strptime(series[-1]["date"], "%Y-%m-%d").date()
        cutoff = d0 - timedelta(days=183)
        xs: list[float] = []
        ys: list[float] = []
        for row in series:
            d = datetime.strptime(row["date"], "%Y-%m-%d").date()
            if d >= cutoff:
                xs.append((d - d0).days)  # negative -> 0
                ys.append(float(row["walcl"]))
        if len(xs) < 3:
            return 0.0
        slope_per_day = float(np.polyfit(np.array(xs), np.array(ys), 1)[0])
        return round(slope_per_day * 30.0, 1)  # $B per ~month
    except Exception:
        return 0.0


def _build_changes(series: list[dict]) -> dict:
    cur = series[-1]["net_liquidity"]
    out = {}
    for label, days_back in (("chg_1m", 30), ("chg_3m", 91), ("chg_6m", 183), ("chg_1y", 365)):
        past = _value_at_lookback(series, "net_liquidity", days_back)
        out[label] = round(float(cur) - past, 1) if past is not None else None
    return out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _assemble(series: list[dict], reserves: float | None,
              *, data_mode: str, source: str) -> dict:
    last = series[-1]
    current = {
        "net_liquidity": round(float(last["net_liquidity"]), 1),
        "walcl": round(float(last["walcl"]), 1),
        "tga": round(float(last["tga"]), 1),
        "rrp": round(float(last["rrp"]), 1),
        "reserves": round(float(reserves), 1) if reserves is not None else None,
    }
    return {
        "series": series,
        "current": current,
        "changes": _build_changes(series),
        "qt_pace_b_per_month": _qt_pace(series),
        "unit": UNIT,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _sample_payload() -> dict:
    series = _sample_series()
    return _assemble(series, _sample_reserves(series),
                     data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def net_liquidity() -> dict:
    """Fed net-liquidity monitor. Never raises - degrades to SAMPLE data and
    tags the payload with data_mode / as_of / source.

    Returns: {
        series: [{date, walcl, tga, rrp, net_liquidity}],   # $B, weekly
        current: {net_liquidity, walcl, tga, rrp, reserves}, # $B
        changes: {chg_1m, chg_3m, chg_6m, chg_1y},           # $B deltas
        qt_pace_b_per_month: float,                          # $B / month (negative = runoff)
        unit, data_mode, as_of, source
    }
    """
    try:
        return _net_liquidity_live()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("net_liquidity failed hard, returning sample: %s", e)
        return _sample_payload()


def _net_liquidity_live() -> dict:
    walcl = _fetch_normalized("WALCL", LOOKBACK_DAYS)
    tga = _fetch_normalized("WTREGEN", LOOKBACK_DAYS)
    rrp = _fetch_normalized("RRPONTSYD", LOOKBACK_DAYS)
    reserves_pts = _fetch_normalized("WRESBAL", LOOKBACK_DAYS)

    # WALCL is the spine. If it (or either drain) is missing/short, go sample.
    if len(walcl) < 12 or len(tga) < 4 or len(rrp) < 4:
        return _sample_payload()

    series: list[dict] = []
    for d, wv in walcl:
        tv = _asof(tga, d)
        rv = _asof(rrp, d)
        if tv is None or rv is None:
            continue
        series.append({
            "date": d,
            "walcl": round(float(wv), 1),
            "tga": round(float(tv), 1),
            "rrp": round(float(rv), 1),
            "net_liquidity": round(float(wv - tv - rv), 1),
        })

    if len(series) < 12:
        return _sample_payload()

    reserves = _asof(reserves_pts, series[-1]["date"]) if reserves_pts else None
    return _assemble(series, reserves, data_mode="live", source="FRED")
