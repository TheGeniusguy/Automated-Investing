"""Financial Conditions Index Monitor (Bloomberg `BFCIUS` analogue).

A composite "are financial conditions tight or loose?" tracker. It fuses the
three official, published indices - the Chicago Fed National Financial
Conditions Index (NFCI), its Adjusted variant (ANFCI), and the St. Louis Fed
Financial Stress Index (STLFSI4) - with a homemade sub-index built bottom-up
from FRED sub-components: credit spreads (BAML HY OAS + IG OAS), equity vol
(VIX), the broad trade-weighted dollar, and 10y real rates (TIPS). Each
sub-component is z-scored against its own recent history and sign-oriented so
that POSITIVE = tighter conditions, then averaged into a single composite. The
official indices and the homemade composite roll up into one Tight / Neutral /
Loose regime verdict with a 0-100 "tightness" gauge.

Live data comes from FRED via `macro_data.fetch_series` when `settings.has_fred`
is set. When the key is missing - or too few series resolve - the module falls
back to deterministic, realistic SAMPLE values (a modestly LOOSE late-cycle
print) so the panel is always fully populated for clean screenshots. The sample
shapes are seeded so they are stable across calls.

This module never raises. The payload carries the honest under-the-hood
`data_mode` ("live" | "sample"), `as_of` and `source` tags.

Public surface:
- `financial_conditions() -> dict`   the full conditions board
"""
from __future__ import annotations

import logging
import math
from datetime import date

from ..config import settings
from . import macro_data

log = logging.getLogger(__name__)

# How much history to pull so z-scores / percentiles are meaningful (~5y).
HISTORY_DAYS = 1825
# Window used for the z-score / percentile of each series (most recent N obs).
ZWINDOW = 156  # ~3y of weekly obs; daily series get the tail of this length

# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------
# Official, published financial-conditions / stress indices. All are centered
# near zero with POSITIVE = tighter / more stress by construction.
OFFICIAL: list[dict] = [
    {"key": "NFCI",    "id": "NFCI",    "label": "Chicago Fed NFCI"},
    {"key": "ANFCI",   "id": "ANFCI",   "label": "Adjusted NFCI"},
    {"key": "STLFSI4", "id": "STLFSI4", "label": "St. Louis Fed Stress"},
]

# Homemade sub-index components. `sign` orients the raw series toward TIGHTER:
# +1 means higher raw value = tighter (spreads, vol, dollar, real rates).
COMPONENTS: list[dict] = [
    {"key": "hy_oas",    "id": "BAMLH0A0HYM2", "label": "HY Credit Spread", "unit": "%",   "sign": 1.0},
    {"key": "ig_oas",    "id": "BAMLC0A0CM",   "label": "IG Credit Spread", "unit": "%",   "sign": 1.0},
    {"key": "equity_vol","id": "VIXCLS",       "label": "Equity Vol (VIX)", "unit": "idx", "sign": 1.0},
    {"key": "usd",       "id": "DTWEXBGS",     "label": "Broad US Dollar",  "unit": "idx", "sign": 1.0},
    {"key": "real_rate", "id": "DFII10",       "label": "10y Real Rate",    "unit": "%",   "sign": 1.0},
]

# Deterministic, realistic SAMPLE snapshot: a modestly LOOSE late-cycle print.
# (latest, prior) for the official indices; positive = tighter.
SAMPLE_OFFICIAL: dict[str, tuple[float, float, float]] = {
    # id: (latest, prior, zscore)
    "NFCI":    (-0.42, -0.40, -0.55),
    "ANFCI":   (-0.18, -0.15, -0.30),
    "STLFSI4": (-0.55, -0.50, -0.62),
}

# id: (latest_raw_value, zscore_vs_history) - z already sign-oriented to tighter.
SAMPLE_COMPONENTS: dict[str, tuple[float, float]] = {
    "BAMLH0A0HYM2": (3.18, -0.85),   # HY OAS ~318bps, spreads tight -> looser
    "BAMLC0A0CM":   (0.86, -0.70),   # IG OAS ~86bps, tight -> looser
    "VIXCLS":       (15.4, -0.80),   # low vol -> looser
    "DTWEXBGS":     (121.3, 0.30),   # firm dollar -> modestly tighter
    "DFII10":       (1.94, 0.40),    # positive real rates -> modestly tighter
}


# ---------------------------------------------------------------------------
# Stats helpers
# ---------------------------------------------------------------------------

def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _std(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    mu = _mean(xs)
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))


def _zscore(latest: float, window: list[float]) -> float:
    sd = _std(window)
    if sd <= 0:
        return 0.0
    z = (latest - _mean(window)) / sd
    return max(-4.0, min(4.0, z))


def _round_val(v: float) -> float:
    a = abs(v)
    if a >= 1000:
        return round(v)
    if a >= 100:
        return round(v, 1)
    if a >= 10:
        return round(v, 2)
    return round(v, 3)


def _index_regime(value: float) -> str:
    """Official index regime. Positive = tighter by construction."""
    if value > 0.05:
        return "Tight"
    if value < -0.05:
        return "Loose"
    return "Neutral"


def _composite_regime(value: float) -> str:
    if value > 0.30:
        return "Tight"
    if value < -0.30:
        return "Loose"
    return "Neutral"


def _verdict_regime(tightness: float) -> str:
    if tightness >= 60.0:
        return "Tight"
    if tightness <= 40.0:
        return "Loose"
    return "Neutral"


def _tightness_gauge(combined: float) -> float:
    """Logistic map of the combined tighter-signal into a 0-100 gauge.

    `combined` is an average of the official index levels and the homemade
    composite z (all centered near zero, positive = tighter). 50 = neutral.
    """
    g = 100.0 / (1.0 + math.exp(-1.15 * combined))
    return round(max(0.0, min(100.0, g)), 1)


def _summary_line(regime: str, tightness: float, composite_z: float) -> str:
    if regime == "Tight":
        lead = "Financial conditions are TIGHT"
        tail = "credit, vol and rates are squeezing risk-taking"
    elif regime == "Loose":
        lead = "Financial conditions are LOOSE"
        tail = "ample liquidity and calm markets are supporting risk assets"
    else:
        lead = "Financial conditions are roughly NEUTRAL"
        tail = "the tightening and easing forces are close to balanced"
    return f"{lead} ({tightness:.0f}/100 tightness, composite z {composite_z:+.2f}) - {tail}."


def _headline(regime: str, tightness: float) -> str:
    pos = "above" if tightness >= 50 else "below"
    return f"{regime} regime - tightness gauge {tightness:.0f}/100, {pos} the neutral midpoint."


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _assemble(indices: list[dict], components: list[dict], *,
              data_mode: str, source: str) -> dict:
    # Homemade composite = mean of the sign-oriented component z-scores.
    comp_zs = [c["zscore"] for c in components]
    composite_z = round(_mean(comp_zs), 3) if comp_zs else 0.0
    n = len(components) or 1
    for c in components:
        c["contribution"] = round(c["zscore"] / n, 3)

    # Combined signal blends the official index levels with the composite z,
    # weighting the official indices and the homemade composite evenly overall.
    official_avg = _mean([i["value"] for i in indices]) if indices else 0.0
    combined = round((official_avg + composite_z) / 2.0, 3)
    tightness = _tightness_gauge(combined)
    composite_regime = _composite_regime(composite_z)
    verdict_regime = _verdict_regime(tightness)

    # Tightest / loosest sub-component by sign-oriented z.
    tightest = max(components, key=lambda c: c["zscore"]) if components else None
    loosest = min(components, key=lambda c: c["zscore"]) if components else None

    return {
        "indices": indices,
        "components": components,
        "composite": {
            "value": composite_z,
            "tightness_0_100": tightness,
            "regime": composite_regime,
        },
        "verdict": {
            "regime": verdict_regime,
            "summary_line": _summary_line(verdict_regime, tightness, composite_z),
        },
        "summary": {
            "headline": _headline(verdict_regime, tightness),
            "tightest_component": tightest["label"] if tightest else None,
            "loosest_component": loosest["label"] if loosest else None,
        },
        "data_mode": data_mode,
        "as_of": date.today().isoformat(),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _series_vals(series_id: str) -> list[float]:
    """Fetch a FRED series and return its non-null values (oldest first)."""
    try:
        raw = macro_data.fetch_series(series_id, days=HISTORY_DAYS)
    except Exception as e:  # never raise
        log.debug("financial_conditions fetch %s failed: %s", series_id, e)
        return []
    return [p["value"] for p in raw if p.get("value") is not None]


def _live_payload() -> dict | None:
    """Bounded live build from FRED. Returns None when too little resolves so
    the caller can fall back to sample. Never raises."""
    if not settings.has_fred:
        return None

    indices: list[dict] = []
    for spec in OFFICIAL:
        vals = _series_vals(spec["id"])
        if len(vals) < 8:
            continue
        latest = _round_val(vals[-1])
        prior = _round_val(vals[-2])
        window = vals[-ZWINDOW:] if len(vals) > ZWINDOW else vals
        z = round(_zscore(vals[-1], window), 2)
        indices.append({
            "key": spec["key"],
            "label": spec["label"],
            "value": latest,
            "prior": prior,
            "change": _round_val(latest - prior),
            "zscore": z,
            "regime": _index_regime(latest),
        })

    components: list[dict] = []
    for spec in COMPONENTS:
        vals = _series_vals(spec["id"])
        if len(vals) < 8:
            continue
        window = vals[-ZWINDOW:] if len(vals) > ZWINDOW else vals
        z = round(_zscore(vals[-1], window) * spec["sign"], 2)
        components.append({
            "key": spec["key"],
            "label": spec["label"],
            "value": _round_val(vals[-1]),
            "unit": spec["unit"],
            "zscore": z,
            "contribution": 0.0,  # filled in _assemble
        })

    # Require the full official trio + a majority of the homemade components.
    if len(indices) < 3 or len(components) < 3:
        return None

    return _assemble(indices, components, data_mode="live", source="FRED")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic - a modestly loose print)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    indices: list[dict] = []
    for spec in OFFICIAL:
        latest, prior, z = SAMPLE_OFFICIAL[spec["id"]]
        indices.append({
            "key": spec["key"],
            "label": spec["label"],
            "value": latest,
            "prior": prior,
            "change": _round_val(latest - prior),
            "zscore": z,
            "regime": _index_regime(latest),
        })

    components: list[dict] = []
    for spec in COMPONENTS:
        value, z = SAMPLE_COMPONENTS[spec["id"]]
        components.append({
            "key": spec["key"],
            "label": spec["label"],
            "value": value,
            "unit": spec["unit"],
            "zscore": z,
            "contribution": 0.0,  # filled in _assemble
        })

    return _assemble(indices, components, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def financial_conditions() -> dict:
    """The full financial-conditions board. See module docstring.

    Always returns a populated dict; prefers live FRED data and degrades to a
    deterministic SAMPLE print tagged with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("indices") and live.get("components"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("financial_conditions live path failed, using sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("financial_conditions sample path failed hard: %s", e)
        return {
            "indices": [],
            "components": [],
            "composite": {"value": 0.0, "tightness_0_100": 50.0, "regime": "Neutral"},
            "verdict": {"regime": "Neutral", "summary_line": "Financial conditions data unavailable."},
            "summary": {"headline": "No data", "tightest_component": None, "loosest_component": None},
            "data_mode": "sample",
            "as_of": date.today().isoformat(),
            "source": "sample",
        }
