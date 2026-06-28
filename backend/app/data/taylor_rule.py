"""Taylor Rule / Policy-Rule Estimator (Bloomberg TAYL).

Estimates where the federal funds rate "should" be under three canonical policy
rules and compares each implied rate against the actual funds rate to judge the
stance of monetary policy (restrictive / neutral / accommodative).

Rules
-----
Inputs per period: core PCE inflation YoY (pi), the unemployment rate (UNRATE),
and the natural rate of unemployment / NAIRU (NROU). The output gap is proxied
from the unemployment gap via Okun's law:

    unemployment_gap = UNRATE - NROU
    output_gap       = -2 * unemployment_gap        (Okun coefficient 2.0)

Standard Taylor (1993):
    r = r* + pi + 0.5*(pi - pi_target) + 0.5*output_gap
Balanced-approach (Yellen):
    r = r* + pi + 0.5*(pi - pi_target) + 1.0*output_gap
Inertial rule (smoothing):
    r_t = 0.85*r_{t-1} + 0.15*taylor_t

with r* (neutral real rate) = 0.5 and pi_target = 2.0.

Live path pulls FRED series via app.data.macro_data.fetch_series. When FRED is
unavailable (no key / upstream failure / short data) the module degrades to a
deterministic md5-seeded SAMPLE series with realistic recent values. It never
raises - it always returns a populated payload tagged with data_mode / as_of /
source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import date, datetime, timedelta, timezone

from .macro_data import fetch_series

log = logging.getLogger(__name__)

# Rule parameters
R_STAR = 0.5          # neutral real rate (%)
PI_TARGET = 2.0       # inflation target (%)
OKUN = 2.0            # output-gap = -OKUN * unemployment-gap
W_OUTPUT_TAYLOR = 0.5
W_OUTPUT_BALANCED = 1.0
INERTIA = 0.85        # smoothing weight on prior rate

HISTORY_MONTHS = 84   # ~7y of monthly observations
FRED_DAYS = 365 * 9   # pull ~9y to allow YoY + history window

# Recent real-world anchors for the sample fallback (approx mid-2026 readings).
SAMPLE_CORE_PCE = 2.6   # core PCE inflation YoY (%)
SAMPLE_UNRATE = 4.1     # unemployment rate (%)
SAMPLE_NAIRU = 4.4      # natural rate of unemployment (%)
SAMPLE_FUNDS = 4.4      # effective / target fed funds (%)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(label: str) -> int:
    return int(hashlib.md5(label.encode()).hexdigest()[:8], 16)


def _wiggle(label: str, i: int, amp: float) -> float:
    """Deterministic, smooth, zero-centred perturbation in [-amp, amp]."""
    s = _seed(f"{label}:{i}")
    # two incommensurate sinusoids keep it from looking periodic
    a = math.sin(s % 360 * math.pi / 180.0)
    b = math.sin((s // 7) % 360 * math.pi / 180.0)
    return amp * 0.5 * (a + b)


def _month_starts(n: int) -> list[str]:
    """`n` month-start date strings ending at the current month (ascending)."""
    today = date.today()
    y, m = today.year, today.month
    out: list[str] = []
    for k in range(n):
        mm = m - (n - 1 - k)
        yy = y
        while mm <= 0:
            mm += 12
            yy -= 1
        out.append(date(yy, mm, 1).isoformat())
    return out


def _to_pairs(points) -> list[tuple[str, float]]:
    """Coerce a fetch_series payload into clean (date, value) pairs, sorted."""
    out: list[tuple[str, float]] = []
    if not points:
        return out
    for p in points:
        try:
            d = p.get("date")
            v = p.get("value")
            if d is None or v is None:
                continue
            out.append((str(d), float(v)))
        except Exception:
            continue
    out.sort(key=lambda x: x[0])
    return out


def _asof_lookup(pairs: list[tuple[str, float]], target: str) -> float | None:
    """Most recent value on or before `target` (step / as-of join)."""
    val: float | None = None
    for d, v in pairs:
        if d <= target:
            val = v
        else:
            break
    return val


def _yoy_from_levels(pairs: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Compute YoY % change from a level series (monthly-ish). Matches each point
    to the value ~12 months earlier."""
    out: list[tuple[str, float]] = []
    for d, v in pairs:
        try:
            y, m, day = (int(x) for x in d.split("-"))
        except Exception:
            continue
        prior = date(y - 1, m, min(day, 28)).isoformat()
        base = _asof_lookup(pairs, prior)
        if base and base != 0:
            out.append((d, round((v / base - 1.0) * 100.0, 4)))
    return out


def _stance(actual: float, balanced: float) -> str:
    gap = actual - balanced
    if gap >= 0.5:
        return "Restrictive"
    if gap <= -0.5:
        return "Accommodative"
    return "Neutral"


def _taylor(pi: float, output_gap: float, w: float) -> float:
    return R_STAR + pi + 0.5 * (pi - PI_TARGET) + w * output_gap


# ---------------------------------------------------------------------------
# Core rule evaluation (shared by live + sample paths)
# ---------------------------------------------------------------------------

def _build_history(rows: list[dict]) -> list[dict]:
    """rows: ascending list of {date, core_pce_yoy, unrate, nairu, actual}.
    Returns enriched history with taylor/balanced/inertial implied rates."""
    history: list[dict] = []
    prev_inertial: float | None = None
    for r in rows:
        pi = r["core_pce_yoy"]
        u_gap = r["unrate"] - r["nairu"]
        out_gap = -OKUN * u_gap
        taylor = _taylor(pi, out_gap, W_OUTPUT_TAYLOR)
        balanced = _taylor(pi, out_gap, W_OUTPUT_BALANCED)
        if prev_inertial is None:
            inertial = taylor
        else:
            inertial = INERTIA * prev_inertial + (1.0 - INERTIA) * taylor
        prev_inertial = inertial
        history.append({
            "date": r["date"],
            "taylor": round(max(0.0, taylor), 3),
            "balanced": round(max(0.0, balanced), 3),
            "inertial": round(max(0.0, inertial), 3),
            "actual": round(r["actual"], 3),
        })
    return history


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    history = _build_history(rows)
    last_row = rows[-1]
    last = history[-1]

    pi = last_row["core_pce_yoy"]
    u_gap = round(last_row["unrate"] - last_row["nairu"], 3)
    out_gap = round(-OKUN * u_gap, 3)
    actual = last["actual"]
    stance = _stance(actual, last["balanced"])

    return {
        "current": {
            "actual": actual,
            "taylor": last["taylor"],
            "balanced": last["balanced"],
            "inertial": last["inertial"],
            "stance": stance,
            "gap_taylor": round(actual - last["taylor"], 3),
            "gap_balanced": round(actual - last["balanced"], 3),
            "gap_inertial": round(actual - last["inertial"], 3),
            "inputs": {
                "core_pce_yoy": round(pi, 3),
                "unrate": round(last_row["unrate"], 3),
                "nairu": round(last_row["nairu"], 3),
                "unemployment_gap": u_gap,
                "output_gap": out_gap,
            },
        },
        "history": history,
        "params": {
            "r_star": R_STAR,
            "pi_target": PI_TARGET,
            "okun_coef": OKUN,
            "inertia": INERTIA,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Sample fallback (deterministic)
# ---------------------------------------------------------------------------

def _sample_rows() -> list[dict]:
    dates = _month_starts(HISTORY_MONTHS)
    n = len(dates)
    rows: list[dict] = []
    for i, d in enumerate(dates):
        frac = i / (n - 1) if n > 1 else 1.0  # 0 (oldest) -> 1 (latest)

        # Inflation: post-2021 surge to ~5.5 then disinflation back toward ~2.6.
        hump = math.exp(-((frac - 0.45) ** 2) / 0.02)
        pi = 1.9 + 3.6 * hump * (1.0 - 0.55 * frac) + _wiggle("pi", i, 0.12)
        pi = max(0.8, pi - (pi - SAMPLE_CORE_PCE) * (frac ** 3) * 0.0)
        # ease the tail toward the recent anchor
        pi = pi * (1 - frac) + (pi * 0.4 + SAMPLE_CORE_PCE * 0.6) * frac

        # Unemployment: ~3.6 in the tight middle, drifting up to ~4.1 recently.
        unrate = 3.9 + 0.5 * frac - 0.4 * hump + _wiggle("u", i, 0.08)
        unrate = max(3.4, unrate)

        # NAIRU: slow glide from ~4.6 down to ~4.4.
        nairu = 4.6 - 0.2 * frac + _wiggle("n", i, 0.015)

        # Actual funds: zero-bound start, rapid hikes mid-window, plateau ~4.4.
        if frac < 0.30:
            actual = 0.10 + _wiggle("f", i, 0.02)
        elif frac < 0.55:
            actual = 0.10 + (frac - 0.30) / 0.25 * 5.25
        else:
            actual = 5.35 - (frac - 0.55) / 0.45 * (5.35 - SAMPLE_FUNDS) + _wiggle("f", i, 0.03)
        actual = max(0.05, actual)

        rows.append({
            "date": d,
            "core_pce_yoy": round(pi, 3),
            "unrate": round(unrate, 3),
            "nairu": round(nairu, 3),
            "actual": round(actual, 3),
        })

    # Pin the most recent reading to the published anchors for realism.
    rows[-1]["core_pce_yoy"] = SAMPLE_CORE_PCE
    rows[-1]["unrate"] = SAMPLE_UNRATE
    rows[-1]["nairu"] = SAMPLE_NAIRU
    rows[-1]["actual"] = SAMPLE_FUNDS
    return rows


def _sample_payload() -> dict:
    return _assemble(_sample_rows(), data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _live_rows() -> list[dict] | None:
    """Assemble monthly rows from FRED, or None if data is unusable."""
    pcepilfe = _to_pairs(fetch_series("PCEPILFE", days=FRED_DAYS))
    unrate = _to_pairs(fetch_series("UNRATE", days=FRED_DAYS))
    nrou = _to_pairs(fetch_series("NROU", days=FRED_DAYS))
    funds = _to_pairs(fetch_series("FEDFUNDS", days=FRED_DAYS))

    pi_series = _yoy_from_levels(pcepilfe)

    # Require the substantive series to be present and reasonably long.
    if len(pi_series) < 24 or len(unrate) < 24 or not funds or not nrou:
        return None

    # Anchor the monthly grid to the inflation series dates (last HISTORY_MONTHS).
    pi_dates = [d for d, _ in pi_series][-HISTORY_MONTHS:]
    pi_map = dict(pi_series)

    rows: list[dict] = []
    for d in pi_dates:
        pi = pi_map.get(d)
        u = _asof_lookup(unrate, d)
        nairu = _asof_lookup(nrou, d)
        actual = _asof_lookup(funds, d)
        if pi is None or u is None or nairu is None or actual is None:
            continue
        rows.append({
            "date": d,
            "core_pce_yoy": pi,
            "unrate": u,
            "nairu": nairu,
            "actual": actual,
        })

    if len(rows) < 24:
        return None
    return rows


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def taylor_rule() -> dict:
    """Estimate policy-rule-implied funds rates and the current stance.

    Never raises - degrades to deterministic SAMPLE data and tags the payload
    with data_mode / as_of / source.
    """
    try:
        rows = _live_rows()
        if rows:
            return _assemble(rows, data_mode="live", source="FRED")
    except Exception as e:  # safety net - the contract forbids raising
        log.warning("taylor_rule live path failed, using sample: %s", e)
    return _sample_payload()
