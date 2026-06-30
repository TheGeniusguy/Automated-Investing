"""Heating & Cooling Degree Days (HDD / CDD) - the core weather-demand driver.

Population-weighted national heating degree days (HDD) and cooling degree days
(CDD) with deviation-from-normal, decomposed by U.S. census region. HDD measures
how much (and for how long) outside air was below the 65F base - the heating
load that drives winter natural-gas demand. CDD measures air above 65F - the
cooling load that drives summer power burn (and, via gas-fired generation, gas
demand again). Together they are the single biggest swing factor in short-run
natural-gas and power demand, which is why the desk watches the *deviation from
normal* (current minus the 30y climatological value) more than the level.

Method
------
Four census regions (Northeast, Midwest, South, West) carry population weights
that sum to 1. Per region we report current-period HDD and CDD, the normal
(climatological) value for the calendar position, and deviation = current -
normal. The national figure is the population-weighted sum of the regional
values, so national HDD == sum(weight * region_hdd) by construction. HDD
dominates in winter, CDD in summer (a seasonal cosine drives both).

Live path: best-effort FRED via `macro_data.fetch_series` / `latest_value`.
Weather degree-day feeds are unreliable and there is no clean population-weighted
national HDD/CDD on FRED, so this almost always degrades to a deterministic,
seasonally-realistic SAMPLE payload tagged data_mode="sample". The sample shapes
are md5-seeded so they are stable across calls within a period.

This module never raises. Every payload carries the honest under-the-hood
`data_mode` ("live" | "sample") + `as_of` + `source`.

Public surface:
- `degree_days() -> dict`   the full HDD/CDD board
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import date

from ..config import settings
from . import macro_data

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Census regions + population weights (2020 census shares, sum to 1.0)
# ---------------------------------------------------------------------------
# Each region carries its climatological weekly degree-day character:
#   hdd_peak = typical weekly HDD at the coldest week of the year
#   cdd_peak = typical weekly CDD at the hottest week of the year
# Cold-winter regions (Midwest/Northeast) carry high HDD peaks; the South carries
# the highest CDD peak. Minimums are ~0 (no heating in mid-summer, etc.).
REGIONS: list[dict] = [
    {"region": "Northeast", "pop_weight": 0.172, "hdd_peak": 185.0, "cdd_peak": 42.0},
    {"region": "Midwest",   "pop_weight": 0.208, "hdd_peak": 205.0, "cdd_peak": 52.0},
    {"region": "South",     "pop_weight": 0.382, "hdd_peak": 95.0,  "cdd_peak": 92.0},
    {"region": "West",      "pop_weight": 0.238, "hdd_peak": 120.0, "cdd_peak": 50.0},
]

# Best-effort FRED anchors for the live path. There is no official
# population-weighted national HDD/CDD on FRED, so these are tried opportunistically
# and the module falls back to SAMPLE when they do not resolve (the expected case).
FRED_HDD_CANDIDATES = ["USHDD", "HDD"]
FRED_CDD_CANDIDATES = ["USCDD", "CDD"]


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable within a period)
# ---------------------------------------------------------------------------

def _hash(key: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{key}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(key: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by key + salt."""
    return (_hash(key, salt) % 1_000_000) / 1_000_000.0


def _round(v: float, n: int = 1) -> float:
    return round(float(v), n)


# ---------------------------------------------------------------------------
# Seasonal climatology
# ---------------------------------------------------------------------------

def _winter_factor(d: date) -> float:
    """0..1 cosine peaking at 1 in mid-January (coldest) and 0 in mid-July
    (hottest). Drives HDD up in winter and down in summer."""
    doy = d.timetuple().tm_yday
    return (math.cos(2.0 * math.pi * (doy - 15) / 365.25) + 1.0) / 2.0


# Mild weather (avg temps near the 65F base) produces neither much heating nor
# much cooling, so a shoulder-season "dead band" keeps a region from showing a
# large HDD and a large CDD at the same time - heating intensity only ramps in
# as the winter factor climbs above the band, cooling only as it falls below.
_SEASON_DEAD_BAND = 0.45


def _season_intensity(wf: float) -> tuple[float, float]:
    """Map the winter factor (0..1) to mutually-damped heating / cooling
    intensities in [0,1]. Winter peak (wf=1) -> full heating, 0 cooling; summer
    peak (wf=0) -> full cooling, 0 heating; the dead band around the equinox
    keeps both modest in shoulder weeks (no heavy heating *and* heavy cooling in
    the same region/week)."""
    denom = 1.0 - _SEASON_DEAD_BAND
    heat = max(0.0, wf - _SEASON_DEAD_BAND) / denom
    cool = max(0.0, (1.0 - wf) - _SEASON_DEAD_BAND) / denom
    return heat, cool


def _season_context(d: date) -> tuple[str, str]:
    """Returns (label, dominant) where dominant is 'HDD' or 'CDD'."""
    m = d.month
    if m in (12, 1, 2):
        return "Winter - heating-dominated (HDD drives gas demand)", "HDD"
    if m in (6, 7, 8):
        return "Summer - cooling-dominated (CDD drives power burn)", "CDD"
    if m in (3, 4, 5):
        return "Spring shoulder - light weather demand both ways", "HDD"
    return "Autumn shoulder - heating demand building", "HDD"


def _period_key(d: date) -> str:
    """Stable seeding key for the current period (ISO year-week)."""
    iso = d.isocalendar()
    return f"{iso[0]}W{iso[1]:02d}"


def _demand_signal(dominant_dev: float) -> str:
    """Map the deviation of the dominant degree-day to a gas-demand read.
    Positive deviation = more weather demand = bullish for gas/power."""
    if dominant_dev >= 12.0:
        return "Strong"
    if dominant_dev >= 4.0:
        return "Above normal"
    if dominant_dev <= -12.0:
        return "Weak"
    if dominant_dev <= -4.0:
        return "Below normal"
    return "Normal"


# ---------------------------------------------------------------------------
# Region builder (shared by live + sample)
# ---------------------------------------------------------------------------

def _build_region(spec: dict, d: date, *, hdd_scale: float = 1.0,
                  cdd_scale: float = 1.0, live: bool = False) -> dict:
    """Build one region's HDD/CDD row. The `normal` is always the (unscaled)
    climatological value for the calendar position. In the SAMPLE path the
    current level is the normal plus a deterministic deviation. In the LIVE path
    the current level is the climatology rescaled to the live national anchor
    (`*_scale`), so the per-region deviation is a real share of the genuine
    national live-vs-normal anomaly - not fabricated noise. INVARIANT: HDD,CDD
    >= 0 and deviation == current - normal."""
    region = spec["region"]
    wf = _winter_factor(d)          # 1 in deep winter, 0 in peak summer
    heat, cool = _season_intensity(wf)

    hdd_normal = _round(spec["hdd_peak"] * heat)
    cdd_normal = _round(spec["cdd_peak"] * cool)

    if live:
        # Anchor the current level to the live national print; the regional share
        # of the national anomaly follows the climatological shape.
        hdd = max(0.0, _round(spec["hdd_peak"] * heat * hdd_scale))
        cdd = max(0.0, _round(spec["cdd_peak"] * cool * cdd_scale))
    else:
        pkey = _period_key(d)
        # Deviation amplitude scales with the seasonal magnitude (min floor so
        # even shoulder weeks show a little spread). Centered on zero.
        hdd_amp = max(6.0, 0.16 * hdd_normal)
        cdd_amp = max(4.0, 0.16 * cdd_normal)
        hdd_dev_raw = (_rand01(region + pkey, "hdd") * 2.0 - 1.0) * hdd_amp
        cdd_dev_raw = (_rand01(region + pkey, "cdd") * 2.0 - 1.0) * cdd_amp
        hdd = max(0.0, _round(hdd_normal + hdd_dev_raw))
        cdd = max(0.0, _round(cdd_normal + cdd_dev_raw))

    hdd_deviation = _round(hdd - hdd_normal)
    cdd_deviation = _round(cdd - cdd_normal)

    # Which load dominates this region right now, and how far from normal.
    dominant_dev = hdd_deviation if hdd >= cdd else cdd_deviation
    return {
        "region": region,
        "pop_weight": round(spec["pop_weight"], 3),
        "hdd": hdd,
        "cdd": cdd,
        "hdd_normal": hdd_normal,
        "cdd_normal": cdd_normal,
        "hdd_deviation": hdd_deviation,
        "cdd_deviation": cdd_deviation,
        "demand_signal": _demand_signal(dominant_dev),
    }


# ---------------------------------------------------------------------------
# Payload assembly (national = population-weighted sum of regions)
# ---------------------------------------------------------------------------

def _assemble(regions: list[dict], d: date, *, data_mode: str, source: str) -> dict:
    season_label, dominant = _season_context(d)

    def wsum(field: str) -> float:
        return _round(sum(r["pop_weight"] * r[field] for r in regions))

    nat_hdd = wsum("hdd")
    nat_cdd = wsum("cdd")
    nat_hdd_normal = wsum("hdd_normal")
    nat_cdd_normal = wsum("cdd_normal")
    nat_hdd_dev = _round(nat_hdd - nat_hdd_normal)
    nat_cdd_dev = _round(nat_cdd - nat_cdd_normal)

    national = {
        "hdd": nat_hdd,
        "cdd": nat_cdd,
        "hdd_normal": nat_hdd_normal,
        "cdd_normal": nat_cdd_normal,
        "hdd_deviation": nat_hdd_dev,
        "cdd_deviation": nat_cdd_dev,
    }

    # Headline + plain-language gas-demand read, oriented to the dominant load.
    dom_dev = nat_hdd_dev if dominant == "HDD" else nat_cdd_dev
    dom_label = "heating" if dominant == "HDD" else "cooling"
    if dom_dev >= 8.0:
        tone, read_word = "above normal", "bullish"
    elif dom_dev >= 3.0:
        tone, read_word = "modestly above normal", "supportive"
    elif dom_dev <= -8.0:
        tone, read_word = "below normal", "bearish"
    elif dom_dev <= -3.0:
        tone, read_word = "modestly below normal", "soft"
    else:
        tone, read_word = "near normal", "neutral"

    headline = f"National {dom_label} demand {tone}"
    sign = "+" if dom_dev >= 0 else ""
    gas_demand_read = (
        f"{dom_label.capitalize()}-degree days are running {tone} "
        f"({sign}{dom_dev:g} vs the climatological normal), a {read_word} signal "
        f"for near-term natural-gas and power demand."
    )
    vs_normal = (
        f"HDD {('+' if nat_hdd_dev >= 0 else '')}{nat_hdd_dev:g} vs normal, "
        f"CDD {('+' if nat_cdd_dev >= 0 else '')}{nat_cdd_dev:g} vs normal"
    )

    return {
        "season_context": season_label,
        "national": national,
        "regions": regions,
        "summary": {
            "headline": headline,
            "gas_demand_read": gas_demand_read,
            "vs_normal": vs_normal,
        },
        "data_mode": data_mode,
        "as_of": d.isoformat(),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live path (best-effort FRED anchor - expected to degrade to sample)
# ---------------------------------------------------------------------------

def _fred_latest(candidates: list[str]) -> float | None:
    for sid in candidates:
        try:
            pts = macro_data.fetch_series(sid, days=120)
        except Exception as e:  # never raise
            log.debug("degree_days FRED fetch %s failed: %s", sid, e)
            continue
        val = macro_data.latest_value(pts)
        if val is not None and val >= 0:
            return float(val)
    return None


def _live_payload(d: date) -> dict | None:
    """Best-effort live build anchored to a national FRED HDD/CDD print, with the
    regional split coming from climatology. Returns None when the (unreliable)
    weather feed does not resolve so the caller falls back to sample. Never raises."""
    if not settings.has_fred:
        return None

    nat_hdd = _fred_latest(FRED_HDD_CANDIDATES)
    nat_cdd = _fred_latest(FRED_CDD_CANDIDATES)
    # Require BOTH national anchors to resolve; otherwise the population-weighted
    # decomposition would be fabricated - degrade to the honest sample path.
    if nat_hdd is None or nat_cdd is None:
        return None

    # Scale the climatological regional shape so the population-weighted national
    # CURRENT level matches the live anchor while each region's NORMAL stays the
    # unscaled climatology - so the national deviation is the genuine live-minus-
    # normal anomaly. Guard against a zero seasonal base.
    heat, cool = _season_intensity(_winter_factor(d))
    base_hdd = sum(s["pop_weight"] * s["hdd_peak"] * heat for s in REGIONS)
    base_cdd = sum(s["pop_weight"] * s["cdd_peak"] * cool for s in REGIONS)
    hdd_scale = (nat_hdd / base_hdd) if base_hdd > 1e-6 else 1.0
    cdd_scale = (nat_cdd / base_cdd) if base_cdd > 1e-6 else 1.0

    regions = [_build_region(s, d, hdd_scale=hdd_scale, cdd_scale=cdd_scale, live=True)
               for s in REGIONS]
    return _assemble(regions, d, data_mode="live", source="FRED/NOAA-CPC")


# ---------------------------------------------------------------------------
# Sample path (deterministic, seasonally realistic)
# ---------------------------------------------------------------------------

def _sample_payload(d: date) -> dict:
    regions = [_build_region(s, d) for s in REGIONS]
    return _assemble(regions, d, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def degree_days() -> dict:
    """Population-weighted national HDD/CDD with deviation-from-normal. See the
    module docstring.

    Always returns a populated dict; prefers a live FRED anchor and degrades to a
    deterministic, seasonally-realistic SAMPLE payload tagged with
    data_mode / as_of / source.
    """
    d = date.today()
    try:
        live = _live_payload(d)
        if live is not None and live.get("regions") and live.get("national"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("degree_days live path failed, using sample: %s", e)
    try:
        return _sample_payload(d)
    except Exception as e:
        log.error("degree_days sample path failed hard: %s", e)
        zero = {"hdd": 0.0, "cdd": 0.0, "hdd_normal": 0.0, "cdd_normal": 0.0,
                "hdd_deviation": 0.0, "cdd_deviation": 0.0}
        return {
            "season_context": "Unavailable",
            "national": zero,
            "regions": [],
            "summary": {
                "headline": "Degree-day data unavailable",
                "gas_demand_read": "No weather-demand data available.",
                "vs_normal": "",
            },
            "data_mode": "sample",
            "as_of": d.isoformat(),
            "source": "sample",
        }
