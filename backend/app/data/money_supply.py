"""Money Supply & Bank-Credit Monitor (credit-creation / liquidity panel).

Watches the plumbing of credit creation and broad liquidity, the variables that
sit upstream of nominal growth and risk-asset beta:

- M2SL              M2 money stock (FRED, monthly, $ billions)
- M2V               M2 velocity = nominal GDP / M2 (FRED, quarterly, ratio)
- TOTBKCR           Bank credit, all commercial banks (FRED, H.8, weekly, $B)
- TOTLL / BUSLOANS  Loans & leases / C&I loans (FRED, H.8, weekly, $B)
- DPSACBW027SBOG    Deposits, all commercial banks (FRED, weekly, $B)
- DRTSCILM          SLOOS: net % of banks tightening C&I standards to large/mid
                    firms (FRED, quarterly, net percent — RISING = tightening)

The intuition: bank credit and deposits ARE the broad money supply being created
or destroyed. Accelerating M2 / bank-credit / loan growth with easing lending
standards = liquidity loosening (supportive of risk and nominal growth). Slowing
money growth with banks tightening standards (rising SLOOS) = credit contracting,
liquidity tightening. M2 velocity tells you how hard each dollar is working.

Live path: FRED via app.data.macro_data.fetch_series (the shared cached helper).
When FRED is unavailable (no key / upstream error / short series) the whole panel,
or any individual missing series, degrades to a deterministic, md5-seeded SAMPLE
with realistic mid-2026 levels. This module NEVER raises: it always returns a
populated payload tagged with data_mode ("live" | "mixed" | "sample") / as_of /
source.

NOTE on coloring: for M2 / bank credit / loans / deposits, a POSITIVE yoy reading
(expansion) is the supportive/green signal. For SLOOS, a RISING net-tightening
reading is the NEGATIVE/red liquidity signal — the payload carries an explicit
`polarity` ("normal" | "inverse" | "neutral") per metric so the UI colors it by
its true economic meaning, not by sign alone.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

# YoY needs >12 months for monthly M2 and ~5 quarters for velocity/SLOOS.
LOOKBACK_DAYS = 365 * 3

# Level series carried in $ trillions for display (FRED native = $ billions).
_TO_TRILLIONS = 1 / 1000.0

# Series catalog. `loans` resolves at runtime (TOTLL preferred, BUSLOANS fallback).
_SERIES = {
    "m2":       {"id": "M2SL",           "label": "M2 Money Supply"},
    "velocity": {"id": "M2V",            "label": "M2 Velocity"},
    "credit":   {"id": "TOTBKCR",        "label": "Bank Credit"},
    "deposits": {"id": "DPSACBW027SBOG", "label": "Bank Deposits"},
    "sloos":    {"id": "DRTSCILM",       "label": "SLOOS Tightening"},
}


# ---------------------------------------------------------------------------
# Deterministic sample synthesis (md5-seeded, stable across calls)
# ---------------------------------------------------------------------------

def _noise(key: str, i: int) -> float:
    """Deterministic pseudo-random value in [-1, 1] from md5(key:i)."""
    h = hashlib.md5(f"{key}:{i}".encode()).hexdigest()[:8]
    return (int(h, 16) / 0xFFFFFFFF) * 2.0 - 1.0


def _month_starts(n: int) -> list[str]:
    """`n` month-start date strings ending this month, ascending."""
    out: list[str] = []
    d = date.today().replace(day=1)
    for _ in range(n):
        out.append(d.isoformat())
        # step back one month
        d = (d - timedelta(days=1)).replace(day=1)
    return list(reversed(out))


def _quarter_starts(n: int) -> list[str]:
    """`n` quarter-start date strings ending this quarter, ascending."""
    out: list[str] = []
    today = date.today()
    qm = ((today.month - 1) // 3) * 3 + 1
    d = date(today.year, qm, 1)
    for _ in range(n):
        out.append(d.isoformat())
        y, m = d.year, d.month - 3
        if m <= 0:
            y, m = y - 1, m + 12
        d = date(y, m, 1)
    return list(reversed(out))


def _sample_m2_growth_history() -> list[dict]:
    """24 months of M2 YoY% oscillating around a modest +3.5% expansion."""
    dates = _month_starts(24)
    out = []
    for i, dstr in enumerate(dates):
        frac = i / max(len(dates) - 1, 1)
        # drifts up from ~+2.6% toward ~+3.8% with small wobble
        v = 2.6 + 1.2 * frac + 0.35 * _noise("m2g", i)
        out.append({"date": dstr, "value": round(float(v), 2)})
    return out


def _sample_velocity_history() -> list[dict]:
    """16 quarters of M2 velocity grinding up from ~1.27 toward ~1.36."""
    dates = _quarter_starts(16)
    out = []
    for i, dstr in enumerate(dates):
        frac = i / max(len(dates) - 1, 1)
        v = 1.27 + 0.09 * frac + 0.012 * _noise("m2v", i)
        out.append({"date": dstr, "value": round(float(v), 3)})
    return out


def _sample_metrics() -> list[dict]:
    """Rich mid-2026 metric cards: money growing modestly, banks tightening a touch."""
    return [
        {"key": "m2", "label": "M2 Money Supply", "latest": 22.1, "unit": "$T",
         "yoy_pct": 3.6, "trend": "up", "polarity": "normal",
         "note": "Broad money expanding modestly"},
        {"key": "velocity", "label": "M2 Velocity", "latest": 1.355, "unit": "x",
         "yoy_pct": 1.8, "trend": "up", "polarity": "neutral",
         "note": "Each dollar turning over a touch faster"},
        {"key": "credit", "label": "Bank Credit", "latest": 18.4, "unit": "$T",
         "yoy_pct": 3.1, "trend": "up", "polarity": "normal",
         "note": "H.8 commercial-bank credit rising"},
        {"key": "loans", "label": "Loans & Leases", "latest": 12.9, "unit": "$T",
         "yoy_pct": 2.4, "trend": "up", "polarity": "normal",
         "note": "Loan books growing slowly"},
        {"key": "deposits", "label": "Bank Deposits", "latest": 17.9, "unit": "$T",
         "yoy_pct": 2.0, "trend": "up", "polarity": "normal",
         "note": "Deposit base stable, growing gently"},
        {"key": "sloos", "label": "SLOOS C&I Tightening", "latest": 7.5, "unit": "% net",
         "yoy_pct": None, "trend": "up", "polarity": "inverse",
         "note": "Net share of banks tightening — modestly restrictive"},
    ]


def _sample_payload() -> dict:
    metrics = _sample_metrics()
    return _assemble(
        metrics,
        _sample_m2_growth_history(),
        _sample_velocity_history(),
        data_mode="sample",
        source="sample",
    )


# ---------------------------------------------------------------------------
# Live FRED path helpers
# ---------------------------------------------------------------------------

def _fetch(series_id: str, days: int) -> list[tuple[str, float]]:
    """Fetch a FRED series → [(date, value)] ascending, nulls dropped. [] on any error."""
    try:
        from .macro_data import fetch_series
        raw = fetch_series(series_id, days=days)
    except Exception as e:  # absolute guard - import or fetch issue
        log.warning("money_supply: fetch_series(%s) failed: %s", series_id, e)
        return []
    if not raw:
        return []
    out: list[tuple[str, float]] = []
    for p in raw:
        v = p.get("value")
        d = p.get("date")
        if v is None or d is None:
            continue
        try:
            out.append((d, float(v)))
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda x: x[0])
    return out


def _at_lookback(points: list[tuple[str, float]], days_back: int) -> float | None:
    """Value whose date is closest to (last_date - days_back)."""
    if not points:
        return None
    try:
        last = datetime.strptime(points[-1][0], "%Y-%m-%d").date()
    except Exception:
        return None
    target = last - timedelta(days=days_back)
    best: float | None = None
    best_gap: int | None = None
    for d, v in points:
        try:
            dd = datetime.strptime(d, "%Y-%m-%d").date()
        except Exception:
            continue
        gap = abs((dd - target).days)
        if best_gap is None or gap < best_gap:
            best_gap, best = gap, v
    return best


def _yoy(points: list[tuple[str, float]]) -> float | None:
    """Year-over-year % change of the latest observation."""
    if len(points) < 2:
        return None
    latest = points[-1][1]
    prior = _at_lookback(points, 365)
    if prior is None or prior == 0:
        return None
    return round((latest / prior - 1.0) * 100.0, 2)


def _trend(points: list[tuple[str, float]], n: int = 3, eps: float = 1e-9) -> str:
    """Direction of the most recent move: 'up' | 'down' | 'flat'."""
    if len(points) < 2:
        return "flat"
    cur = points[-1][1]
    ref = points[-(n + 1)][1] if len(points) > n else points[0][1]
    if ref == 0:
        return "flat"
    rel = (cur - ref) / abs(ref)
    if rel > 0.0005:
        return "up"
    if rel < -0.0005:
        return "down"
    return "flat"


def _yoy_history(points: list[tuple[str, float]], keep: int = 24) -> list[dict]:
    """Per-observation YoY% series (for the M2-growth sparkline). Last `keep`."""
    out: list[dict] = []
    parsed: list[tuple[date, float]] = []
    for d, v in points:
        try:
            parsed.append((datetime.strptime(d, "%Y-%m-%d").date(), v))
        except Exception:
            continue
    for cur_d, cur_v in parsed:
        target = cur_d - timedelta(days=365)
        best: float | None = None
        best_gap: int | None = None
        for pd_, pv in parsed:
            if pd_ > cur_d:
                break
            gap = abs((pd_ - target).days)
            if gap <= 45 and (best_gap is None or gap < best_gap):
                best_gap, best = gap, pv
        if best is not None and best != 0:
            out.append({"date": cur_d.isoformat(), "value": round((cur_v / best - 1.0) * 100.0, 2)})
    return out[-keep:]


def _level_history(points: list[tuple[str, float]], keep: int, *,
                   scale: float = 1.0, digits: int = 3) -> list[dict]:
    """Recent level history (for the velocity sparkline). Last `keep` points."""
    out = [{"date": d, "value": round(v * scale, digits)} for d, v in points]
    return out[-keep:]


def _money_metric(key: str, label: str, points: list[tuple[str, float]],
                  *, polarity: str, note: str) -> dict | None:
    """Build a $-trillions level metric card from a FRED level series."""
    if len(points) < 6:
        return None
    latest_b = points[-1][1]
    return {
        "key": key,
        "label": label,
        "latest": round(latest_b * _TO_TRILLIONS, 2),
        "unit": "$T",
        "yoy_pct": _yoy(points),
        "trend": _trend(points),
        "polarity": polarity,
        "note": note,
    }


# ---------------------------------------------------------------------------
# Plain-English liquidity read
# ---------------------------------------------------------------------------

def _read_line(metrics: list[dict]) -> str:
    by = {m["key"]: m for m in metrics}
    m2 = by.get("m2", {}).get("yoy_pct")
    credit = by.get("credit", {}).get("yoy_pct")
    sloos = by.get("sloos", {}).get("latest")

    # credit-creation verdict from money + credit growth
    growth = [g for g in (m2, credit) if g is not None]
    avg = sum(growth) / len(growth) if growth else None
    if avg is None:
        creation = "Credit-creation data is incomplete"
    elif avg >= 6:
        creation = "Credit creation is expanding briskly"
    elif avg >= 1.5:
        creation = "Credit creation is expanding modestly"
    elif avg >= -0.5:
        creation = "Credit creation is roughly flat"
    else:
        creation = "Credit creation is contracting"

    # liquidity verdict from SLOOS lending standards
    if sloos is None:
        liq = "lending standards unclear"
    elif sloos <= -5:
        liq = "banks are easing lending standards, so liquidity is loosening"
    elif sloos <= 8:
        liq = "banks are tightening lending standards only modestly, so liquidity is roughly neutral"
    elif sloos <= 25:
        liq = "banks are tightening lending standards, so liquidity is tightening"
    else:
        liq = "banks are sharply tightening lending standards, so liquidity is contracting"

    return f"{creation} while {liq}."


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _assemble(metrics: list[dict], m2_growth_history: list[dict],
              velocity_history: list[dict], *, data_mode: str, source: str) -> dict:
    return {
        "metrics": metrics,
        "m2_growth_history": m2_growth_history,
        "velocity_history": velocity_history,
        "read": _read_line(metrics),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def money_supply() -> dict:
    """Money-supply & bank-credit monitor. Never raises — degrades to SAMPLE.

    Returns: {
        metrics: [{key, label, latest, unit, yoy_pct, trend, polarity, note}],
        m2_growth_history: [{date, value}],   # M2 YoY %, for sparkline
        velocity_history:  [{date, value}],   # M2 velocity level, for sparkline
        read: str,                            # 1-line plain-English liquidity read
        data_mode, as_of, source
    }
    """
    try:
        return _money_supply_live()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("money_supply failed hard, returning sample: %s", e)
        return _sample_payload()


def _money_supply_live() -> dict:
    m2 = _fetch(_SERIES["m2"]["id"], LOOKBACK_DAYS)
    # M2 is the spine. Without it the whole panel is sample.
    if len(m2) < 6:
        return _sample_payload()

    velocity = _fetch(_SERIES["velocity"]["id"], LOOKBACK_DAYS)
    credit = _fetch(_SERIES["credit"]["id"], LOOKBACK_DAYS)
    deposits = _fetch(_SERIES["deposits"]["id"], LOOKBACK_DAYS)
    sloos = _fetch(_SERIES["sloos"]["id"], LOOKBACK_DAYS)
    loans = _fetch("TOTLL", LOOKBACK_DAYS)
    loans_label = "Loans & Leases"
    if len(loans) < 6:
        loans = _fetch("BUSLOANS", LOOKBACK_DAYS)
        loans_label = "C&I Loans"

    live_count = 1  # M2 present
    sample = {m["key"]: m for m in _sample_metrics()}
    metrics: list[dict] = []

    # M2 (always live here)
    metrics.append({
        "key": "m2", "label": "M2 Money Supply",
        "latest": round(m2[-1][1] * _TO_TRILLIONS, 2), "unit": "$T",
        "yoy_pct": _yoy(m2), "trend": _trend(m2),
        "polarity": "normal", "note": "Broad money stock",
    })

    # M2 velocity (ratio, not $T)
    if len(velocity) >= 2:
        metrics.append({
            "key": "velocity", "label": "M2 Velocity",
            "latest": round(velocity[-1][1], 3), "unit": "x",
            "yoy_pct": _yoy(velocity), "trend": _trend(velocity, n=1),
            "polarity": "neutral", "note": "Nominal GDP / M2 turnover",
        })
        live_count += 1
    else:
        metrics.append(sample["velocity"])

    # Bank credit
    m = _money_metric("credit", "Bank Credit", credit,
                      polarity="normal", note="H.8 commercial-bank credit")
    if m:
        metrics.append(m); live_count += 1
    else:
        metrics.append(sample["credit"])

    # Loans
    m = _money_metric("loans", loans_label, loans,
                      polarity="normal", note="Bank loan books")
    if m:
        metrics.append(m); live_count += 1
    else:
        metrics.append(sample["loans"])

    # Deposits
    m = _money_metric("deposits", "Bank Deposits", deposits,
                      polarity="normal", note="Commercial-bank deposit base")
    if m:
        metrics.append(m); live_count += 1
    else:
        metrics.append(sample["deposits"])

    # SLOOS net % tightening (a level in percent, not $T; rising = restrictive)
    if len(sloos) >= 1:
        metrics.append({
            "key": "sloos", "label": "SLOOS C&I Tightening",
            "latest": round(sloos[-1][1], 1), "unit": "% net",
            "yoy_pct": None, "trend": _trend(sloos, n=1),
            "polarity": "inverse", "note": "Net share of banks tightening C&I standards",
        })
        live_count += 1
    else:
        metrics.append(sample["sloos"])

    # Histories (fall back to sample arrays when the live series is too short)
    m2_hist = _yoy_history(m2, keep=24)
    if len(m2_hist) < 4:
        m2_hist = _sample_m2_growth_history()
    vel_hist = (_level_history(velocity, keep=16, scale=1.0, digits=3)
                if len(velocity) >= 4 else _sample_velocity_history())

    # 6 series targeted; classify the blend.
    if live_count >= 6:
        data_mode, source = "live", "FRED"
    elif live_count >= 2:
        data_mode, source = "mixed", "FRED + sample"
    else:
        data_mode, source = "sample", "sample"

    return _assemble(metrics, m2_hist, vel_hist, data_mode=data_mode, source=source)
