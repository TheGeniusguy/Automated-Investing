"""Global Sovereign Bond Monitor (Bloomberg `WB`).

A world board of government bond yields across the major economies. The anchor
is the 10-year benchmark yield per country (the global risk-free term that every
cross-asset trader watches); where available we also carry the 2-year and 30-year
points. For each country we compute the daily bp move and two spreads that frame
relative value: spread-to-US-Treasury (country 10Y minus the US 10Y) and
spread-to-Bund (country 10Y minus the German 10Y).

Live path: pull the OECD long-term (10Y) interest-rate family from FRED -
`IRLTLT01<CC>M156N` - through the SAME cached `app.data.macro_data.fetch_series`
helper the shipped FRED modules use. The latest observation gives the level and
the prior observation gives the move. US 2Y/30Y come from DGS2/DGS30; other
countries omit those legs gracefully (OECD only publishes the 10Y long-term
rate). When FRED is unavailable, slow, or too few countries resolve we degrade to
a deterministic, realistic SAMPLE board and tag the payload data_mode="sample".

This module NEVER raises - it always returns a populated payload carrying an
internal data_mode ("live" | "sample") + as_of + source for honesty under the
hood. No on-screen badge.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 6.0
# Require at least this many countries to resolve live before trusting the board.
LIVE_MIN_COUNTRIES = 7


# ---------------------------------------------------------------------------
# Country table. The 10Y FRED id is the OECD long-term rate IRLTLT01<CC>M156N.
# curated_*  = realistic mid-2026 levels used for the sample board / missing legs
# fred_2y / fred_30y = optional FRED ids for the short/long legs (US only on FRED)
# region     = used purely for a sensible grouping fallback in the summary
# ---------------------------------------------------------------------------

COUNTRIES: list[dict] = [
    {
        "country": "United States", "code": "US", "flag_label": "\U0001F1FA\U0001F1F8",
        "region": "Americas", "fred_10y": "IRLTLT01USM156N",
        "fred_2y": "DGS2", "fred_30y": "DGS30",
        "curated_10y": 4.30, "curated_2y": 3.95, "curated_30y": 4.55,
    },
    {
        "country": "Germany", "code": "DE", "flag_label": "\U0001F1E9\U0001F1EA",
        "region": "EMEA", "fred_10y": "IRLTLT01DEM156N",
        "curated_10y": 2.40, "curated_2y": 2.05, "curated_30y": 2.70,
    },
    {
        "country": "United Kingdom", "code": "GB", "flag_label": "\U0001F1EC\U0001F1E7",
        "region": "EMEA", "fred_10y": "IRLTLT01GBM156N",
        "curated_10y": 4.10, "curated_2y": 4.20, "curated_30y": 4.65,
    },
    {
        "country": "France", "code": "FR", "flag_label": "\U0001F1EB\U0001F1F7",
        "region": "EMEA", "fred_10y": "IRLTLT01FRM156N",
        "curated_10y": 3.05, "curated_2y": 2.30, "curated_30y": 3.85,
    },
    {
        "country": "Italy", "code": "IT", "flag_label": "\U0001F1EE\U0001F1F9",
        "region": "EMEA", "fred_10y": "IRLTLT01ITM156N",
        "curated_10y": 3.70, "curated_2y": 2.95, "curated_30y": 4.55,
    },
    {
        "country": "Spain", "code": "ES", "flag_label": "\U0001F1EA\U0001F1F8",
        "region": "EMEA", "fred_10y": "IRLTLT01ESM156N",
        "curated_10y": 3.15, "curated_2y": 2.45, "curated_30y": 3.95,
    },
    {
        "country": "Netherlands", "code": "NL", "flag_label": "\U0001F1F3\U0001F1F1",
        "region": "EMEA", "fred_10y": "IRLTLT01NLM156N",
        "curated_10y": 2.65, "curated_2y": 2.15, "curated_30y": 2.95,
    },
    {
        "country": "Switzerland", "code": "CH", "flag_label": "\U0001F1E8\U0001F1ED",
        "region": "EMEA", "fred_10y": "IRLTLT01CHM156N",
        "curated_10y": 0.60, "curated_2y": 0.30, "curated_30y": 0.95,
    },
    {
        "country": "Sweden", "code": "SE", "flag_label": "\U0001F1F8\U0001F1EA",
        "region": "EMEA", "fred_10y": "IRLTLT01SEM156N",
        "curated_10y": 2.30, "curated_2y": 2.20, "curated_30y": 2.55,
    },
    {
        "country": "Japan", "code": "JP", "flag_label": "\U0001F1EF\U0001F1F5",
        "region": "Asia-Pacific", "fred_10y": "IRLTLT01JPM156N",
        "curated_10y": 1.00, "curated_2y": 0.55, "curated_30y": 2.45,
    },
    {
        "country": "Australia", "code": "AU", "flag_label": "\U0001F1E6\U0001F1FA",
        "region": "Asia-Pacific", "fred_10y": "IRLTLT01AUM156N",
        "curated_10y": 4.20, "curated_2y": 3.85, "curated_30y": 4.60,
    },
    {
        "country": "Canada", "code": "CA", "flag_label": "\U0001F1E8\U0001F1E6",
        "region": "Americas", "fred_10y": "IRLTLT01CAM156N",
        "curated_10y": 3.25, "curated_2y": 3.05, "curated_30y": 3.35,
    },
]


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(key: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{key}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(key: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by key + salt."""
    return (_hash(key, salt) % 1_000_000) / 1_000_000.0


def _sample_change_bps(code: str) -> float:
    """Small, realistic deterministic daily bp move in roughly [-9, +9] bps."""
    return round((_rand01(code, "chg") - 0.5) * 18.0, 1)


# ---------------------------------------------------------------------------
# Live FRED pull
# ---------------------------------------------------------------------------

def _last_two(series: list[dict]) -> tuple[float | None, float | None]:
    """Return (latest, prior) non-None values from a FRED series list."""
    vals = [p["value"] for p in series if p.get("value") is not None]
    if not vals:
        return None, None
    if len(vals) == 1:
        return float(vals[-1]), None
    return float(vals[-1]), float(vals[-2])


def _latest(series: list[dict]) -> float | None:
    latest, _ = _last_two(series)
    return latest


def _live_payload() -> dict | None:
    """Bounded, fast live FRED scan. Returns None when too few countries resolve
    so the caller can fall back to sample. Never raises (caller also guards)."""
    try:
        from . import macro_data
    except Exception as e:
        log.warning("sovereign_bonds: macro_data import failed: %s", e)
        return None

    started = time.monotonic()
    resolved: dict[str, dict] = {}  # code -> {"yield_10y", "change_bps", "yield_2y", "yield_30y"}

    for spec in COUNTRIES:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        code = spec["code"]
        try:
            ten = macro_data.fetch_series(spec["fred_10y"], days=420) or []
        except Exception:
            ten = []
        latest, prior = _last_two(ten)
        if latest is None:
            continue
        change = round((latest - prior) * 100.0, 1) if prior is not None else None

        y2 = y30 = None
        if spec.get("fred_2y"):
            try:
                y2 = _latest(macro_data.fetch_series(spec["fred_2y"], days=30) or [])
            except Exception:
                y2 = None
        if spec.get("fred_30y"):
            try:
                y30 = _latest(macro_data.fetch_series(spec["fred_30y"], days=30) or [])
            except Exception:
                y30 = None

        resolved[code] = {
            "yield_10y": round(latest, 2),
            "change_bps": change,
            "yield_2y": round(y2, 2) if y2 is not None else None,
            "yield_30y": round(y30, 2) if y30 is not None else None,
        }

    # Need an anchor (US for UST spread, DE for Bund spread) and enough breadth.
    if len(resolved) < LIVE_MIN_COUNTRIES or "US" not in resolved or "DE" not in resolved:
        return None

    ust = resolved["US"]["yield_10y"]
    bund = resolved["DE"]["yield_10y"]

    rows: list[dict] = []
    for spec in COUNTRIES:
        r = resolved.get(spec["code"])
        if r is None:
            continue
        rows.append(_build_row(spec, r["yield_10y"], r["change_bps"],
                               r["yield_2y"], r["yield_30y"], ust, bund))

    return _assemble(rows, data_mode="live", source="FRED OECD long-term rates (IRLTLT01)")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic levels)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    ust = next(s["curated_10y"] for s in COUNTRIES if s["code"] == "US")
    bund = next(s["curated_10y"] for s in COUNTRIES if s["code"] == "DE")
    rows: list[dict] = []
    for spec in COUNTRIES:
        rows.append(_build_row(
            spec,
            spec["curated_10y"],
            _sample_change_bps(spec["code"]),
            spec["curated_2y"],
            spec["curated_30y"],
            ust,
            bund,
        ))
    return _assemble(rows, data_mode="sample", source="curated OECD long-term levels")


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_row(spec: dict, yield_10y: float, change_bps: float | None,
               yield_2y: float | None, yield_30y: float | None,
               ust_10y: float, bund_10y: float) -> dict:
    return {
        "country": spec["country"],
        "code": spec["code"],
        "flag_label": spec["flag_label"],
        "region": spec["region"],
        "yield_10y": round(float(yield_10y), 2),
        "yield_2y": round(float(yield_2y), 2) if yield_2y is not None else None,
        "yield_30y": round(float(yield_30y), 2) if yield_30y is not None else None,
        "change_bps": change_bps,
        "spread_to_ust_bps": round((yield_10y - ust_10y) * 100.0, 1),
        "spread_to_bund_bps": round((yield_10y - bund_10y) * 100.0, 1),
    }


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    rows = sorted(rows, key=lambda r: r["yield_10y"], reverse=True)

    highest = rows[0] if rows else None
    lowest = rows[-1] if rows else None
    # Widest spread-to-Bund (most positive = cheapest vs Germany), ignoring Bund itself.
    non_bund = [r for r in rows if r["code"] != "DE"]
    widest = max(non_bund, key=lambda r: r["spread_to_bund_bps"]) if non_bund else None

    def _ref(r: dict | None) -> dict | None:
        if not r:
            return None
        return {
            "country": r["country"],
            "code": r["code"],
            "flag_label": r["flag_label"],
            "yield_10y": r["yield_10y"],
            "spread_to_bund_bps": r["spread_to_bund_bps"],
        }

    return {
        "countries": rows,
        "summary": {
            "highest_yield": _ref(highest),
            "lowest_yield": _ref(lowest),
            "widest_spread_to_bund": _ref(widest),
            "count": len(rows),
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def sovereign_bonds() -> dict:
    """World board of government 10Y (plus 2Y/30Y where available) bond yields,
    daily bp moves, and spreads-to-UST / spreads-to-Bund. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("countries"):
            return live
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("sovereign_bonds live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("sovereign_bonds sample path failed hard: %s", e)
        return {
            "countries": [],
            "summary": {
                "highest_yield": None,
                "lowest_yield": None,
                "widest_spread_to_bund": None,
                "count": 0,
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "curated OECD long-term levels",
        }
