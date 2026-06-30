"""Repo & Money-Market Funding Monitor (Bloomberg RRP).

Tracks the short end of the money market - the rates the Fed actually steers and
the plumbing that tells you whether funding markets are calm or stressed:

    SOFR          Secured Overnight Financing Rate (FRED, %)
    EFFR          Effective Federal Funds Rate (FRED, %)
    OBFR          Overnight Bank Funding Rate (FRED, %)
    IORB          Interest On Reserve Balances - the Fed's admin floor (FRED, %)
    RRPONTSYAWARD ON-RRP award rate - the lower bound of the corridor (FRED, %)
    RRPONTSYD     ON-RRP take-up volume - cash parked at the Fed (FRED, $B)
    WRESBAL       Reserve balances in the banking system (FRED, $M -> $B)

The story these tell together: IORB and the ON-RRP award rate bracket the policy
corridor; SOFR / EFFR / OBFR are where the market actually clears. When reserves
are abundant and RRP take-up is high, secured rates sit a few bp BELOW IORB and
funding is calm. As reserves drain (QT) and RRP empties out, SOFR drifts UP toward
and then through IORB - the classic early-warning of a funding squeeze (cf. Sep
2019). The three key spreads we surface - SOFR-EFFR, SOFR-IORB, EFFR-IORB - are the
desk's funding-stress gauges, all expressed in BASIS POINTS.

Live path: FRED via app.data.macro_data.fetch_series. When FRED is unavailable
(no key / upstream error / short series) we degrade to a deterministic, realistic
mid-2026 SAMPLE payload. This module NEVER raises: it always returns a populated
payload tagged with data_mode / as_of / source. Live is always preferred.

UNITS: rate fields are in %, rate CHANGES and spreads are in BASIS POINTS, dollar
fields (RRP volume, reserves) are in $ BILLIONS.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

UNIT_RATE = "%"
UNIT_BP = "bp"
UNIT_VOL = "$B"

# ~6 months of daily history feeds the sparkline + the trend reads.
LOOKBACK_DAYS = 200

# FRED series -> short display label. Order is the on-screen rate board order.
RATE_SERIES: list[tuple[str, str]] = [
    ("SOFR", "SOFR"),
    ("EFFR", "EFFR"),
    ("OBFR", "OBFR"),
    ("IORB", "IORB"),
    ("RRPONTSYAWARD", "ON-RRP Rate"),
]

# WRESBAL is published in $ millions; everything else dollar-denominated is $B.
_WRESBAL_TO_B = 1 / 1000.0


# ---------------------------------------------------------------------------
# Deterministic mid-2026 SAMPLE payload
# ---------------------------------------------------------------------------
# Calm, abundant-reserves regime: secured rates a few bp below the IORB floor,
# RRP take-up drained to a small residual, reserves ~$3.2T.

_SAMPLE_RATES: dict[str, tuple[float, float]] = {
    # series: (level %, daily change bp)
    "SOFR": (4.31, -1.0),
    "EFFR": (4.33, 0.0),
    "OBFR": (4.32, 0.0),
    "IORB": (4.40, 0.0),
    "RRPONTSYAWARD": (4.25, 0.0),
}
_SAMPLE_RRP_VOL = 118.0          # $B, low take-up
_SAMPLE_RRP_PREV = 134.0         # $B, ~1w ago (draining)
_SAMPLE_RESERVES = 3210.0        # $B
_SAMPLE_RESERVES_PREV = 3245.0   # $B, ~1w ago (gently draining under QT)


def _sample_history() -> list[dict]:
    """~90 business-day-ish daily series for the sparkline.

    SOFR oscillates in a tight band just under IORB, with periodic month-/quarter-end
    upticks (repo always firms into turns). EFFR and IORB are near-flat admin rates.
    Deterministic - no RNG - so screenshots are stable.
    """
    import math

    n = 90
    base_sofr = 4.31
    out: list[dict] = []
    today = datetime.now(timezone.utc).date()
    from datetime import timedelta
    for i in range(n):
        # oldest -> newest
        day = today - timedelta(days=(n - 1 - i))
        # tight wobble + small month-end firming bump
        wob = 0.004 * math.sin(i / 4.0) + 0.003 * math.cos(i / 7.0)
        turn = 0.02 if day.day >= 28 or day.day <= 1 else 0.0
        sofr = round(base_sofr + wob + turn, 3)
        effr = 4.33
        iorb = 4.40
        out.append({
            "date": day.isoformat(),
            "sofr": sofr,
            "effr": effr,
            "iorb": iorb,
        })
    return out


def _sample_payload() -> dict:
    rates = [
        {"key": key, "label": label,
         "level": _SAMPLE_RATES[key][0], "chg_bp": _SAMPLE_RATES[key][1],
         "unit": UNIT_RATE}
        for key, label in RATE_SERIES
    ]
    levels = {key: _SAMPLE_RATES[key][0] for key, _ in RATE_SERIES}
    return _assemble(
        rates=rates,
        levels=levels,
        rrp_vol=_SAMPLE_RRP_VOL, rrp_prev=_SAMPLE_RRP_PREV,
        reserves=_SAMPLE_RESERVES, reserves_prev=_SAMPLE_RESERVES_PREV,
        history=_sample_history(),
        data_mode="sample", source="sample",
    )


# ---------------------------------------------------------------------------
# Live FRED path helpers
# ---------------------------------------------------------------------------

def _fetch(series_id: str) -> list[tuple[str, float]]:
    """Fetch a FRED series. Returns [(date, value)] ascending, nulls dropped.
    Empty list on any failure."""
    try:
        from .macro_data import fetch_series
        raw = fetch_series(series_id, days=LOOKBACK_DAYS)
    except Exception as e:  # absolute guard - import or fetch issue
        log.warning("repo_funding: fetch_series(%s) failed: %s", series_id, e)
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


def _latest_two(points: list[tuple[str, float]]) -> tuple[float | None, float | None]:
    """(latest value, prior value). Either may be None if the series is short."""
    if not points:
        return None, None
    latest = points[-1][1]
    prev = points[-2][1] if len(points) >= 2 else None
    return latest, prev


def _value_back(points: list[tuple[str, float]], n: int) -> float | None:
    """Value ~n observations before the last (for a weekly-ish trend read)."""
    if not points:
        return None
    idx = len(points) - 1 - n
    if idx < 0:
        idx = 0
    return points[idx][1]


# ---------------------------------------------------------------------------
# Stress + trend logic
# ---------------------------------------------------------------------------

def _trend(latest: float | None, prev: float | None, *, eps: float) -> str:
    if latest is None or prev is None:
        return "flat"
    d = latest - prev
    if d > eps:
        return "rising"
    if d < -eps:
        return "falling"
    return "flat"


def _stress(sofr_iorb_bp: float | None, sofr_chg_bp: float | None) -> dict:
    """Funding-stress read keyed off SOFR-IORB (secured rate vs the admin floor)
    and the latest daily SOFR move. Below the floor = calm; pushing above it =
    the early signature of a reserve squeeze."""
    if sofr_iorb_bp is None:
        return {
            "label": "Unknown",
            "verdict": "Insufficient data to read funding conditions.",
        }
    s = sofr_iorb_bp
    move = sofr_chg_bp or 0.0
    if s >= 10:
        label = "Stressed"
        verdict = (
            f"SOFR is {s:.0f}bp ABOVE IORB - secured funding is bid through the Fed's "
            "floor, the classic signature of a reserve squeeze. Watch RRP and reserves."
        )
    elif s >= 3:
        label = "Firming"
        verdict = (
            f"SOFR is {s:.0f}bp above IORB - funding is firming toward the top of the "
            "corridor. Not stress yet, but reserves are no longer obviously abundant."
        )
    elif s >= -3:
        label = "Neutral"
        verdict = (
            f"SOFR is trading right around IORB ({s:+.0f}bp) - balanced funding, the "
            "Fed's floor is holding and reserves look adequate."
        )
    else:
        label = "Calm"
        verdict = (
            f"SOFR is {abs(s):.0f}bp BELOW IORB - abundant reserves, cash looking for a "
            "home. Funding markets are calm and the floor system is working as designed."
        )
    if move >= 8 and s >= 3:
        verdict += f" Note the {move:+.0f}bp single-day SOFR jump."
    return {"label": label, "verdict": verdict}


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _spread_bp(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return round((a - b) * 100.0, 1)


def _assemble(*, rates: list[dict], levels: dict[str, float | None],
              rrp_vol: float | None, rrp_prev: float | None,
              reserves: float | None, reserves_prev: float | None,
              history: list[dict], data_mode: str, source: str) -> dict:
    sofr = levels.get("SOFR")
    effr = levels.get("EFFR")
    iorb = levels.get("IORB")

    sofr_effr = _spread_bp(sofr, effr)
    sofr_iorb = _spread_bp(sofr, iorb)
    effr_iorb = _spread_bp(effr, iorb)

    spreads = [
        {"key": "SOFR_EFFR", "label": "SOFR-EFFR", "value_bp": sofr_effr},
        {"key": "SOFR_IORB", "label": "SOFR-IORB", "value_bp": sofr_iorb},
        {"key": "EFFR_IORB", "label": "EFFR-IORB", "value_bp": effr_iorb},
    ]

    # SOFR daily change drives the stress add-on.
    sofr_chg = next((r["chg_bp"] for r in rates if r["key"] == "SOFR"), None)

    rrp_chg = (round(rrp_vol - rrp_prev, 1)
               if rrp_vol is not None and rrp_prev is not None else None)
    res_chg = (round(reserves - reserves_prev, 1)
               if reserves is not None and reserves_prev is not None else None)

    return {
        "rates": rates,
        "spreads": spreads,
        "rrp": {
            "volume_b": round(rrp_vol, 1) if rrp_vol is not None else None,
            "chg_b": rrp_chg,
            "trend": _trend(rrp_vol, rrp_prev, eps=2.0),
        },
        "reserves": {
            "level_b": round(reserves, 1) if reserves is not None else None,
            "chg_b": res_chg,
            "trend": _trend(reserves, reserves_prev, eps=5.0),
        },
        "history": history,
        "stress": _stress(sofr_iorb, sofr_chg),
        "unit_rate": UNIT_RATE,
        "unit_bp": UNIT_BP,
        "unit_vol": UNIT_VOL,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def repo_funding() -> dict:
    """Repo & money-market funding monitor. Never raises - degrades to SAMPLE data
    and tags the payload with data_mode / as_of / source.

    Returns: {
        rates: [{key, label, level (%), chg_bp, unit}],          # SOFR/EFFR/OBFR/IORB/RRP rate
        spreads: [{key, label, value_bp}],                       # SOFR-EFFR, SOFR-IORB, EFFR-IORB
        rrp: {volume_b, chg_b, trend},                           # ON-RRP take-up ($B)
        reserves: {level_b, chg_b, trend},                       # bank reserves ($B)
        history: [{date, sofr, effr, iorb}],                     # daily, for sparkline
        stress: {label, verdict},                                # plain-English funding read
        unit_rate, unit_bp, unit_vol, data_mode, as_of, source
    }
    """
    try:
        return _repo_funding_live()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("repo_funding failed hard, returning sample: %s", e)
        return _sample_payload()


def _repo_funding_live() -> dict:
    # Pull every rate series best-effort.
    rate_points: dict[str, list[tuple[str, float]]] = {
        key: _fetch(key) for key, _ in RATE_SERIES
    }

    # SOFR and IORB are the spine (secured rate vs the floor). If either is missing
    # or too short to be meaningful, fall back to the rich sample payload.
    if len(rate_points.get("SOFR", [])) < 2 or len(rate_points.get("IORB", [])) < 2:
        return _sample_payload()

    rates: list[dict] = []
    levels: dict[str, float | None] = {}
    any_missing = False
    for key, label in RATE_SERIES:
        pts = rate_points.get(key, [])
        latest, prev = _latest_two(pts)
        levels[key] = latest
        if latest is None:
            any_missing = True
        chg_bp = (round((latest - prev) * 100.0, 1)
                  if latest is not None and prev is not None else None)
        rates.append({
            "key": key, "label": label,
            "level": round(latest, 3) if latest is not None else None,
            "chg_bp": chg_bp, "unit": UNIT_RATE,
        })

    # RRP take-up volume ($B, already in billions on FRED).
    rrp_pts = _fetch("RRPONTSYD")
    rrp_vol, _ = _latest_two(rrp_pts)
    rrp_prev = _value_back(rrp_pts, 5) if rrp_pts else None  # ~1 week ago

    # Reserve balances ($M -> $B), published weekly.
    res_pts_raw = _fetch("WRESBAL")
    res_pts = [(d, v * _WRESBAL_TO_B) for d, v in res_pts_raw]
    reserves, _ = _latest_two(res_pts)
    reserves_prev = _value_back(res_pts, 1) if res_pts else None  # prior weekly print

    if rrp_vol is None or reserves is None:
        any_missing = True

    # Build the sparkline history from the overlapping SOFR/EFFR/IORB series.
    history = _build_history(rate_points)
    if not history:
        any_missing = True

    data_mode = "mixed" if any_missing else "live"
    return _assemble(
        rates=rates, levels=levels,
        rrp_vol=rrp_vol, rrp_prev=rrp_prev,
        reserves=reserves, reserves_prev=reserves_prev,
        history=history,
        data_mode=data_mode, source="FRED",
    )


def _build_history(rate_points: dict[str, list[tuple[str, float]]]) -> list[dict]:
    """Join SOFR/EFFR/IORB on SOFR's dates (as-of/forward-fill the slower series)."""
    sofr = rate_points.get("SOFR", [])
    if not sofr:
        return []
    effr = rate_points.get("EFFR", [])
    iorb = rate_points.get("IORB", [])

    def asof(points: list[tuple[str, float]], date: str) -> float | None:
        best: float | None = None
        for d, v in points:
            if d <= date:
                best = v
            else:
                break
        if best is None and points:
            best = points[0][1]
        return best

    out: list[dict] = []
    for d, sv in sofr:
        row = {"date": d, "sofr": round(sv, 3)}
        ev = asof(effr, d)
        iv = asof(iorb, d)
        if ev is not None:
            row["effr"] = round(ev, 3)
        if iv is not None:
            row["iorb"] = round(iv, 3)
        out.append(row)
    return out
