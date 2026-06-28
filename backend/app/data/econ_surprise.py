"""Economic Surprise Index engine (Wave E - E6).

Builds a Citi-style economic surprise index per region (US / EU / CN). For a
basket of macro indicators we standardize each release's surprise as
z = (actual - consensus) / std, then aggregate the standardized surprises into a
rolling surprise-index time series. We also expose a recent-releases table and a
beats/misses tally.

The surprise data is deterministic SAMPLE data (seeded off region + indicator
via hashlib, like etf_tracking.py) so the panel is fully populated for clean
screenshots. There is no public, free, real-time consensus-vs-actual feed wired
in, so this surface is sample-only by design - but it still carries the honest
under-the-hood data_mode / as_of / source tags and NEVER raises.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache

log = logging.getLogger(__name__)

SURPRISE_TTL = 60 * 30  # 30 minutes - releases move slowly
INDEX_DAYS = 180        # length of the rolling index time series
EWMA_LAMBDA = 0.94      # decay for the rolling surprise aggregation

REGIONS = ("US", "EU", "CN")
DEFAULT_REGION = "US"

# ---------------------------------------------------------------------------
# SAMPLE indicator baskets (clearly namespaced). Each indicator carries a
# realistic consensus level, the std (typical forecast-error scale used to
# standardize the surprise), and a unit hint for the UI. `recent` is the number
# of fresh releases surfaced in the releases table per region.
# ---------------------------------------------------------------------------

SAMPLE_INDICATORS: dict[str, list[dict]] = {
    "US": [
        {"indicator": "Nonfarm Payrolls", "consensus": 175.0, "std": 65.0, "unit": "k"},
        {"indicator": "Unemployment Rate", "consensus": 4.1, "std": 0.15, "unit": "%"},
        {"indicator": "CPI YoY", "consensus": 3.1, "std": 0.25, "unit": "%"},
        {"indicator": "Core CPI YoY", "consensus": 3.4, "std": 0.2, "unit": "%"},
        {"indicator": "Retail Sales MoM", "consensus": 0.4, "std": 0.35, "unit": "%"},
        {"indicator": "ISM Manufacturing", "consensus": 49.5, "std": 1.6, "unit": "idx"},
        {"indicator": "ISM Services", "consensus": 52.5, "std": 1.5, "unit": "idx"},
        {"indicator": "GDP QoQ Ann.", "consensus": 2.3, "std": 0.6, "unit": "%"},
        {"indicator": "Initial Jobless Claims", "consensus": 220.0, "std": 18.0, "unit": "k"},
        {"indicator": "Durable Goods MoM", "consensus": 0.5, "std": 1.2, "unit": "%"},
        {"indicator": "PPI YoY", "consensus": 2.6, "std": 0.3, "unit": "%"},
        {"indicator": "Consumer Confidence", "consensus": 102.0, "std": 4.0, "unit": "idx"},
    ],
    "EU": [
        {"indicator": "HICP YoY", "consensus": 2.4, "std": 0.2, "unit": "%"},
        {"indicator": "Core HICP YoY", "consensus": 2.7, "std": 0.2, "unit": "%"},
        {"indicator": "GDP QoQ", "consensus": 0.3, "std": 0.2, "unit": "%"},
        {"indicator": "Unemployment Rate", "consensus": 6.4, "std": 0.15, "unit": "%"},
        {"indicator": "Mfg PMI", "consensus": 47.0, "std": 1.4, "unit": "idx"},
        {"indicator": "Services PMI", "consensus": 51.5, "std": 1.3, "unit": "idx"},
        {"indicator": "ZEW Sentiment", "consensus": 20.0, "std": 8.0, "unit": "idx"},
        {"indicator": "Ifo Business Climate", "consensus": 87.0, "std": 2.5, "unit": "idx"},
        {"indicator": "Retail Sales MoM", "consensus": 0.2, "std": 0.5, "unit": "%"},
        {"indicator": "Industrial Prod. MoM", "consensus": -0.1, "std": 1.1, "unit": "%"},
    ],
    "CN": [
        {"indicator": "GDP YoY", "consensus": 4.9, "std": 0.4, "unit": "%"},
        {"indicator": "CPI YoY", "consensus": 0.4, "std": 0.3, "unit": "%"},
        {"indicator": "PPI YoY", "consensus": -1.8, "std": 0.4, "unit": "%"},
        {"indicator": "Caixin Mfg PMI", "consensus": 50.5, "std": 1.0, "unit": "idx"},
        {"indicator": "Caixin Services PMI", "consensus": 52.0, "std": 1.1, "unit": "idx"},
        {"indicator": "Exports YoY", "consensus": 4.0, "std": 3.5, "unit": "%"},
        {"indicator": "Imports YoY", "consensus": 1.5, "std": 3.0, "unit": "%"},
        {"indicator": "Retail Sales YoY", "consensus": 4.5, "std": 1.2, "unit": "%"},
        {"indicator": "Industrial Prod. YoY", "consensus": 5.2, "std": 1.0, "unit": "%"},
        {"indicator": "Fixed Asset Inv. YTD", "consensus": 3.6, "std": 0.6, "unit": "%"},
    ],
}

# Per-region structural tilt of the surprise regime (a region running "hot" vs
# "cold" vs forecasts). Drives the central tendency of the sampled z-scores so
# each region reads as a distinct macro narrative.
SAMPLE_REGION_BIAS: dict[str, float] = {
    "US": 0.35,    # US data running modestly above consensus
    "EU": -0.30,   # Europe running soft
    "CN": -0.10,   # China roughly in line, slight downside
}


def _seed(*parts: str) -> int:
    return int(hashlib.md5("|".join(parts).encode()).hexdigest()[:8], 16)


def _norm_region(region: str | None) -> str:
    r = (region or DEFAULT_REGION).strip().upper()
    return r if r in REGIONS else DEFAULT_REGION


def _business_days(n: int) -> list[str]:
    """`n` weekday date strings ending today, oldest first."""
    out: list[str] = []
    d = date.today()
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _round(x: float, n: int = 2) -> float:
    return round(float(x), n)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def surprise_index(region: str = "US") -> dict:
    """Economic surprise index for one region. Never raises - degrades to a
    fully-populated sample payload tagged with data_mode / as_of / source."""
    try:
        return _surprise_index(region)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("surprise_index failed hard, returning minimal sample: %s", e)
        return _empty_payload(_norm_region(region))


def _surprise_index(region: str) -> dict:
    region = _norm_region(region)
    cache_key = f"econ_surprise:{region}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    indicators = SAMPLE_INDICATORS.get(region, SAMPLE_INDICATORS[DEFAULT_REGION])
    bias = SAMPLE_REGION_BIAS.get(region, 0.0)

    # --- Recent-releases table: one fresh standardized surprise per indicator ---
    dates = _business_days(INDEX_DAYS)
    releases: list[dict] = []
    latest_z: list[float] = []
    for off, ind in enumerate(indicators):
        name = ind["indicator"]
        consensus = float(ind["consensus"])
        std = float(ind["std"])
        rng = np.random.default_rng(_seed(region, name, "release"))
        # standardized surprise z ~ N(bias, ~0.9): region tilt plus indicator noise
        z = float(rng.normal(bias, 0.9))
        z = float(np.clip(z, -3.0, 3.0))
        actual = consensus + z * std
        # space releases out over the last few weeks (most recent first)
        rel_date = dates[-1 - off * 2] if off * 2 < len(dates) else dates[0]
        releases.append({
            "indicator": name,
            "actual": _round(actual),
            "consensus": _round(consensus),
            "surprise_z": _round(z),
            "date": rel_date,
            "unit": ind["unit"],
        })
        latest_z.append(z)

    releases.sort(key=lambda r: r["date"], reverse=True)
    beats = sum(1 for r in releases if r["surprise_z"] > 0)
    misses = sum(1 for r in releases if r["surprise_z"] < 0)

    # --- Rolling surprise-index time series ---------------------------------
    # Daily standardized surprise shocks aggregated with EWMA decay, scaled to a
    # Citi-style index (roughly +/-100). Deterministic per region.
    rng = np.random.default_rng(_seed(region, "index"))
    daily_shock = rng.normal(bias, 1.0, len(dates))
    ewma = 0.0
    index_series: list[dict] = []
    for d, shock in zip(dates, daily_shock):
        ewma = EWMA_LAMBDA * ewma + (1.0 - EWMA_LAMBDA) * float(shock)
        index_series.append({"date": d, "value": _round(ewma * 50.0, 2)})

    # Pin the latest index level to the realized average of the recent releases so
    # the headline number and the releases table tell the same story.
    latest_value = _round(float(np.mean(latest_z)) * 50.0, 2) if latest_z else 0.0
    if index_series:
        index_series[-1]["value"] = latest_value

    payload = {
        "region": region,
        "index_series": index_series,
        "latest": latest_value,
        "releases": releases,
        "beats": beats,
        "misses": misses,
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
    cache.set(cache_key, payload, SURPRISE_TTL)
    return payload


def _empty_payload(region: str) -> dict:
    return {
        "region": region,
        "index_series": [],
        "latest": 0.0,
        "releases": [],
        "beats": 0,
        "misses": 0,
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
