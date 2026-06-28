"""Commodities term-structure engine (Wave D2 - CCRV).

Builds a 12-month futures curve for a basket of major commodities
(CL, NG, GC, SI, HG, ZC, ZW), classifies each curve as contango /
backwardation / flat, computes the front-vs-second roll yield and the
full one-year curve slope, and assembles a cross-commodity comparison
table.

Live path: the front contract is anchored to the live front-month spot
via app.data.macro_data.fetch_arbitrary_ticker("CL=F" etc) when
available. The shape of the curve forward of the front month is always
modeled deterministically (seeded off the symbol via hashlib, like
etf_tracking.py) so the panel renders identically across runs for
screenshots. When no live spot resolves we fall back to a realistic
SAMPLE spot. This module never raises - it always returns a populated
payload tagged with data_mode / as_of / source.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

CURVE_TTL = 60 * 30  # 30 minutes - curve shape moves slowly
CURVE_MONTHS = 12
STRUCTURE_THRESHOLD = 0.5  # |1y slope %| below this reads as flat

_MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------
# SAMPLE term-structure profiles (clearly namespaced). Realistic recent
# levels. carry = per-month fractional drift of the curve (positive =
# contango, negative = backwardation). noise = per-contract deterministic
# wiggle amplitude so the curve looks like a real strip, not a clean line.
# ---------------------------------------------------------------------------

SAMPLE_COMMODITIES: dict[str, dict] = {
    "CL": {"name": "WTI Crude Oil", "ticker": "CL=F", "unit": "USD/bbl",
           "spot": 78.50, "carry": -0.0045, "noise": 0.0015, "precision": 2},
    "NG": {"name": "Natural Gas", "ticker": "NG=F", "unit": "USD/MMBtu",
           "spot": 2.95, "carry": 0.0190, "noise": 0.0040, "precision": 3},
    "GC": {"name": "Gold", "ticker": "GC=F", "unit": "USD/oz",
           "spot": 2350.0, "carry": 0.0035, "noise": 0.0008, "precision": 2},
    "SI": {"name": "Silver", "ticker": "SI=F", "unit": "USD/oz",
           "spot": 29.50, "carry": 0.0040, "noise": 0.0012, "precision": 3},
    "HG": {"name": "Copper", "ticker": "HG=F", "unit": "USD/lb",
           "spot": 4.45, "carry": 0.0012, "noise": 0.0020, "precision": 4},
    "ZC": {"name": "Corn", "ticker": "ZC=F", "unit": "USc/bu",
           "spot": 442.0, "carry": 0.0060, "noise": 0.0018, "precision": 2},
    "ZW": {"name": "Wheat", "ticker": "ZW=F", "unit": "USc/bu",
           "spot": 585.0, "carry": 0.0090, "noise": 0.0020, "precision": 2},
}

COMMODITY_ORDER = ["CL", "NG", "GC", "SI", "HG", "ZC", "ZW"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _contract_labels(n: int) -> list[str]:
    """Forward month labels starting next month, e.g. 'Jul '26'."""
    out: list[str] = []
    today = date.today()
    y, m = today.year, today.month
    for _ in range(n):
        m += 1
        if m > 12:
            m = 1
            y += 1
        out.append(f"{_MONTH_ABBR[m - 1]} '{y % 100:02d}")
    return out


def _live_spot(ticker: str) -> float | None:
    """Best-effort live front-month spot. Never raises."""
    try:
        pts = fetch_arbitrary_ticker(ticker, days=7)
        vals = [float(p["value"]) for p in pts if p.get("value") is not None]
        if vals:
            return vals[-1]
    except Exception as e:
        log.warning("commodity spot fetch failed for %s: %s", ticker, e)
    return None


def _build_curve(symbol: str, profile: dict, spot: float) -> list[dict]:
    """Deterministic 12-month strip. Front (months_out=1) is the anchored
    spot exactly; each forward month compounds the per-month carry plus a
    small seeded wiggle."""
    carry = float(profile["carry"])
    amp = float(profile["noise"])
    precision = int(profile["precision"])
    rng = np.random.default_rng(_seed(symbol))
    wiggle = rng.normal(0.0, amp, CURVE_MONTHS)
    labels = _contract_labels(CURVE_MONTHS)

    curve: list[dict] = []
    for i in range(CURVE_MONTHS):
        months_out = i + 1
        if i == 0:
            price = spot  # front contract anchored exactly to spot
        else:
            price = spot * ((1.0 + carry) ** i) * (1.0 + float(wiggle[i]))
        curve.append({
            "contract": labels[i],
            "months_out": months_out,
            "price": round(float(price), precision),
        })
    return curve


def _classify(curve: list[dict]) -> tuple[str, float, float]:
    """Return (structure, roll_yield_pct, slope_pct).

    roll_yield_pct: annualized front-vs-second roll, ((P1/P2)-1)*12*100.
      Positive in backwardation (rolling down the curve earns yield).
    slope_pct: full one-year slope, (P12/P1 - 1)*100. Positive in contango.
    """
    p1 = curve[0]["price"]
    p2 = curve[1]["price"] if len(curve) > 1 else p1
    pN = curve[-1]["price"]

    roll = round(((p1 / p2) - 1.0) * 12.0 * 100.0, 3) if p2 else 0.0
    slope = round(((pN / p1) - 1.0) * 100.0, 3) if p1 else 0.0

    if slope > STRUCTURE_THRESHOLD:
        structure = "contango"
    elif slope < -STRUCTURE_THRESHOLD:
        structure = "backwardation"
    else:
        structure = "flat"
    return structure, roll, slope


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def commodity_curves() -> dict:
    """Build the full commodities term-structure payload. Never raises."""
    try:
        return _commodity_curves()
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("commodity_curves failed hard, returning sample: %s", e)
        return _build_payload(force_sample=True)


def _commodity_curves() -> dict:
    cache_key = "commodity_curves:v1"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    payload = _build_payload(force_sample=False)
    cache.set(cache_key, payload, CURVE_TTL)
    return payload


def _build_payload(*, force_sample: bool) -> dict:
    commodities: list[dict] = []
    cross: list[dict] = []
    any_live = False

    for symbol in COMMODITY_ORDER:
        profile = SAMPLE_COMMODITIES[symbol]

        spot = None
        if not force_sample:
            spot = _live_spot(profile["ticker"])
        spot_live = spot is not None
        if spot_live:
            any_live = True
        else:
            spot = profile["spot"]
        spot = round(float(spot), int(profile["precision"]))

        curve = _build_curve(symbol, profile, spot)
        structure, roll_yield_pct, slope_pct = _classify(curve)

        commodities.append({
            "symbol": symbol,
            "name": profile["name"],
            "unit": profile["unit"],
            "spot": spot,
            "spot_live": spot_live,
            "curve": curve,
            "structure": structure,
            "roll_yield_pct": roll_yield_pct,
            "slope_pct": slope_pct,
            "front_price": curve[0]["price"],
            "second_price": curve[1]["price"] if len(curve) > 1 else curve[0]["price"],
        })
        cross.append({
            "symbol": symbol,
            "name": profile["name"],
            "unit": profile["unit"],
            "spot": spot,
            "structure": structure,
            "roll_yield_pct": roll_yield_pct,
            "slope_pct": slope_pct,
        })

    data_mode = "live" if any_live else "sample"
    source = "yfinance spot + curve model" if any_live else "sample"
    return {
        "commodities": commodities,
        "cross_commodity": cross,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
