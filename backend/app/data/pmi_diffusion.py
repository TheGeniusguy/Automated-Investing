"""PMI / Business-Survey Diffusion Aggregator (Bloomberg `PMI` / `ECST`).

A single board that aggregates the major U.S. business-activity surveys into one
diffusion heatmap and a composite forward-activity read. Two survey families sit
side by side:

- National ISM / S&P Global PMIs - centered at 50, where a print above 50 means
  the sector is expanding and below 50 means it is contracting.
- Regional Federal Reserve manufacturing surveys (Empire State, Philadelphia,
  Dallas, Kansas City, Richmond) - diffusion indices centered at 0, where a
  positive print means activity is expanding and a negative print means it is
  contracting.

Both conventions are normalized into a common "expanding/contracting" boolean and
a 0-100 heat score so the grid can be colored on one scale (50 = neutral). The
surveys are averaged into one composite diffusion score whose momentum
(accelerating / decelerating) is read against the prior month's composite.

Live path: pull whatever resolves from FRED through the SAME cached
`app.data.macro_data.fetch_series` helper the shipped FRED macro modules use. The
regional Fed diffusion indices are published on FRED; the headline ISM/S&P Global
series are frequently discontinued there, so those legs fall to a deterministic
realistic SAMPLE reading when the series is gone. If too little resolves we return
None and the caller serves the full sample board.

This module NEVER raises - it always returns a populated payload carrying an
internal data_mode ("live" | "sample") + as_of + source for honesty under the
hood. No on-screen badge.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 6.0
# Require at least this many surveys to resolve live before trusting the board.
LIVE_MIN_SURVEYS = 4

CATEGORY_ORDER = ["National ISM / S&P Global", "Regional Fed Manufacturing"]


# ---------------------------------------------------------------------------
# Survey catalog.
#   center      - the expansion/contraction threshold (50 for PMI, 0 for the
#                 regional Fed diffusion indices)
#   fred_id     - FRED series for the live leg (None / discontinued legs fall to
#                 the curated sample value)
#   curated_*   - realistic mid-2026 readings used for the sample board / missing
#                 legs (value + prior month)
#   slope       - heat-mapping gain: how many heat points per unit of distance
#                 from `center` (tuned so a typical print spans the 0-100 grid)
# ---------------------------------------------------------------------------

SURVEYS: list[dict] = [
    # --- National ISM / S&P Global (centered at 50) ---
    {
        "key": "ism_mfg", "label": "ISM Manufacturing PMI",
        "category": "National ISM / S&P Global", "center": 50.0, "slope": 3.2,
        "fred_id": "NAPM", "curated_value": 48.5, "curated_prior": 47.9,
    },
    {
        "key": "ism_services", "label": "ISM Services PMI",
        "category": "National ISM / S&P Global", "center": 50.0, "slope": 3.2,
        "fred_id": "NMFBAI", "curated_value": 52.0, "curated_prior": 51.4,
    },
    {
        "key": "spg_mfg", "label": "S&P Global Mfg PMI",
        "category": "National ISM / S&P Global", "center": 50.0, "slope": 3.2,
        "fred_id": None, "curated_value": 51.2, "curated_prior": 50.6,
    },
    {
        "key": "spg_services", "label": "S&P Global Services PMI",
        "category": "National ISM / S&P Global", "center": 50.0, "slope": 3.2,
        "fred_id": None, "curated_value": 53.5, "curated_prior": 52.9,
    },
    {
        "key": "spg_composite", "label": "S&P Global Composite PMI",
        "category": "National ISM / S&P Global", "center": 50.0, "slope": 3.2,
        "fred_id": None, "curated_value": 52.8, "curated_prior": 52.1,
    },
    # --- Regional Fed manufacturing surveys (centered at 0) ---
    {
        "key": "empire", "label": "Empire State (NY Fed)",
        "category": "Regional Fed Manufacturing", "center": 0.0, "slope": 2.2,
        "fred_id": "GACDISA066MSFRBNY", "curated_value": 3.0, "curated_prior": -6.0,
    },
    {
        "key": "philly", "label": "Philadelphia Fed",
        "category": "Regional Fed Manufacturing", "center": 0.0, "slope": 2.2,
        "fred_id": "GACDFSA066MSFRBPHI", "curated_value": -2.0, "curated_prior": 1.5,
    },
    {
        "key": "dallas", "label": "Dallas Fed (TMOS)",
        "category": "Regional Fed Manufacturing", "center": 0.0, "slope": 2.2,
        "fred_id": "BACTSAMFRBDAL", "curated_value": -4.5, "curated_prior": -7.2,
    },
    {
        "key": "kansas_city", "label": "Kansas City Fed",
        "category": "Regional Fed Manufacturing", "center": 0.0, "slope": 2.2,
        "fred_id": "MFCIM066SFRBKC", "curated_value": -1.0, "curated_prior": -5.0,
    },
    {
        "key": "richmond", "label": "Richmond Fed",
        "category": "Regional Fed Manufacturing", "center": 0.0, "slope": 2.2,
        "fred_id": "BACTSAMFRBRIC", "curated_value": -3.0, "curated_prior": -10.0,
    },
]


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _heat_0_100(value: float, center: float, slope: float) -> float:
    """Map a survey reading onto a common 0-100 heat scale where 50 is neutral.

    Works for BOTH conventions: PMI-style readings centered at 50 and regional-Fed
    diffusion indices centered at 0. The distance from `center` is scaled by
    `slope` so a typical print spans the grid; the result is clamped to [0, 100].
    """
    return round(_clamp(50.0 + (value - center) * slope), 1)


def _expanding(value: float, center: float) -> bool:
    return value > center


def _last_two(series: list[dict]) -> tuple[float | None, float | None]:
    """Return (latest, prior) non-None values from a FRED series list."""
    vals = [p["value"] for p in series if p.get("value") is not None]
    if not vals:
        return None, None
    if len(vals) == 1:
        return float(vals[-1]), None
    return float(vals[-1]), float(vals[-2])


# ---------------------------------------------------------------------------
# Live FRED pull
# ---------------------------------------------------------------------------

def _live_payload() -> dict | None:
    """Bounded, fast live FRED scan. Returns None when too few surveys resolve so
    the caller can fall back to sample. Never raises (caller also guards)."""
    try:
        from . import macro_data
    except Exception as e:
        log.warning("pmi_diffusion: macro_data import failed: %s", e)
        return None

    started = time.monotonic()
    rows: list[dict] = []
    resolved = 0

    for spec in SURVEYS:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        latest = prior = None
        fred_id = spec.get("fred_id")
        if fred_id:
            try:
                series = macro_data.fetch_series(fred_id, days=540) or []
                latest, prior = _last_two(series)
            except Exception:
                latest = prior = None
        if latest is None:
            # Missing / discontinued leg: fall back to the curated reading so the
            # board stays complete, but it does not count toward live breadth.
            rows.append(_build_row(spec, spec["curated_value"], spec["curated_prior"]))
            continue
        resolved += 1
        if prior is None:
            prior = spec["curated_prior"]
        rows.append(_build_row(spec, latest, prior))

    if resolved < LIVE_MIN_SURVEYS:
        return None

    return _assemble(rows, data_mode="live", source="FRED regional Fed surveys + curated ISM/PMI")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic readings)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    rows = [_build_row(spec, spec["curated_value"], spec["curated_prior"]) for spec in SURVEYS]
    return _assemble(rows, data_mode="sample", source="curated business-survey readings")


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_row(spec: dict, value: float, prior: float | None) -> dict:
    value = round(float(value), 1)
    center = float(spec["center"])
    slope = float(spec["slope"])
    prior_f = round(float(prior), 1) if prior is not None else None
    change = round(value - prior_f, 1) if prior_f is not None else None
    return {
        "key": spec["key"],
        "label": spec["label"],
        "category": spec["category"],
        "value": value,
        "prior": prior_f,
        "change": change,
        "center": center,
        "expanding": _expanding(value, center),
        "heat_0_100": _heat_0_100(value, center, slope),
    }


def _composite_for(rows: list[dict], use_prior: bool) -> float:
    """Average normalized heat across surveys. When use_prior is True, recompute
    each survey's heat from its prior reading so momentum can be measured."""
    heats: list[float] = []
    for r in rows:
        spec = _SPEC_BY_KEY.get(r["key"])
        if spec is None:
            continue
        if use_prior:
            if r["prior"] is None:
                continue
            heats.append(_heat_0_100(r["prior"], spec["center"], spec["slope"]))
        else:
            heats.append(r["heat_0_100"])
    return round(sum(heats) / len(heats), 1) if heats else 50.0


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    # Group by category, then by heat (hottest first) within each category.
    order = {c: i for i, c in enumerate(CATEGORY_ORDER)}
    rows = sorted(rows, key=lambda r: (order.get(r["category"], 99), -r["heat_0_100"]))

    expanding_count = sum(1 for r in rows if r["expanding"])
    contracting_count = len(rows) - expanding_count
    expanding_share = round(expanding_count / len(rows), 3) if rows else 0.0

    diffusion_score = _composite_for(rows, use_prior=False)
    prior_score = _composite_for(rows, use_prior=True)
    delta = round(diffusion_score - prior_score, 1)
    if delta > 0.5:
        momentum = "accelerating"
    elif delta < -0.5:
        momentum = "decelerating"
    else:
        momentum = "stable"

    strongest = max(rows, key=lambda r: r["heat_0_100"]) if rows else None
    weakest = min(rows, key=lambda r: r["heat_0_100"]) if rows else None

    if diffusion_score >= 55:
        tone = "broadly expanding"
    elif diffusion_score >= 48:
        tone = "near stall-speed"
    else:
        tone = "broadly contracting"
    headline = (
        f"Business activity is {tone} ({expanding_count} of {len(rows)} surveys above "
        f"threshold); composite {diffusion_score:.0f}/100 and {momentum}."
    )

    return {
        "surveys": rows,
        "composite": {
            "diffusion_score": diffusion_score,
            "prior_score": prior_score,
            "momentum_delta": delta,
            "momentum": momentum,
            "expanding_share": expanding_share,
        },
        "summary": {
            "headline": headline,
            "strongest": strongest["label"] if strongest else None,
            "weakest": weakest["label"] if weakest else None,
            "expanding_count": expanding_count,
            "contracting_count": contracting_count,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


_SPEC_BY_KEY: dict[str, dict] = {s["key"]: s for s in SURVEYS}


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def pmi_diffusion() -> dict:
    """Aggregate the major business-activity surveys into a diffusion board.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("surveys"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("pmi_diffusion live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("pmi_diffusion sample path failed hard: %s", e)
        return {
            "surveys": [],
            "composite": {
                "diffusion_score": 50.0, "prior_score": 50.0,
                "momentum_delta": 0.0, "momentum": "stable", "expanding_share": 0.0,
            },
            "summary": {
                "headline": "No survey data available.",
                "strongest": None, "weakest": None,
                "expanding_count": 0, "contracting_count": 0,
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
