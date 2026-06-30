"""Country / Global Macro Scorecard (Bloomberg `ECST`).

A cross-country G20 / OECD heatmap that puts the major economies side by side on
the six indicators every macro desk watches: real GDP growth (YoY), CPI inflation
(YoY), the unemployment rate, the policy rate, a PMI / business-activity proxy, and
the current-account balance as a share of GDP.

Every cell is scored onto a common 0-100 HEAT scale where 100 is unambiguously the
"good" end and 0 the "bad" end FOR THAT INDICATOR'S ECONOMIC MEANING. The score
direction is therefore indicator-specific and economically correct:

- GDP growth        higher is better  -> higher value raises heat (greener); neutral 50 at ~2% trend
- CPI inflation     2% target is best  -> distance from 2% lowers heat (TENT, non-monotone: both
                                          runaway inflation AND deflation are penalized)
- Unemployment      higher is worse   -> higher value lowers heat (redder)
- Policy rate       tighter is worse  -> higher value lowers heat (more restrictive)
- PMI               higher is better  -> above 50 raises heat (greener)
- Current account   surplus is better -> larger surplus raises heat (greener)

Because the CPI score is a tent peaked at the 2% target, its `direction` tag is the
non-monotone sentinel "target_2pct" (NOT "higher_worse") so a consumer rendering
arrows / a legend never mislabels sub-target / near-deflation readings.

A per-country COMPOSITE is a WEIGHTED mean of that country's six cell heats - a
consistent function of the cells, never an independent number - so countries can be
ranked strongest-first. Real-economy momentum (GDP growth + PMI activity) carries 2x
weight; the nominal / stability legs (CPI, policy rate, unemployment, external
balance) carry 1x, because growth and leading activity are the primary signals of
economic strength - a low-inflation, low-rate economy that is nonetheless stagnating
should not outrank a fast-growing, expanding one. Nothing is fabricated as live: a
handful of US legs are pulled best-effort from FRED via the SAME cached
`app.data.macro_data.fetch_series` helper the shipped FRED modules use; everything
else is a curated, realistic mid-2026 grid. When FRED is unavailable we serve the
full curated board.

This module NEVER raises - it always returns a populated payload carrying an
internal data_mode ("mixed" | "sample") + as_of + source for honesty under the hood.
"mixed" means a few US legs resolved live over the curated cross-country grid; it is
never tagged a blanket "live" when ~70 of 72 cells stay curated. No on-screen badge.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 5.0
# How many indicator cells must resolve live before the board is tagged "mixed"
# (partial-live: a few US legs over the curated grid). Never tagged a blanket "live".
LIVE_MIN_CELLS = 2

# Fixed indicator order - columns of the heatmap.
INDICATORS: list[str] = ["GDP", "CPI", "Unemployment", "PolicyRate", "PMI", "CurrentAccount"]

# Economic direction of each indicator. "higher_better" means a larger value is a
# stronger economy (more heat / greener); "higher_worse" means a larger value is a
# weaker economy (less heat / redder); "target_2pct" is the NON-MONOTONE sentinel
# for CPI, whose heat is a tent peaked at the 2% target (closer to 2% = greener, with
# both runaway inflation and deflation penalized) - a single monotone arrow cannot
# describe it, so consumers must special-case this tag. The heat functions honor this.
DIRECTION: dict[str, str] = {
    "GDP": "higher_better",
    "CPI": "target_2pct",
    "Unemployment": "higher_worse",
    "PolicyRate": "higher_worse",
    "PMI": "higher_better",
    "CurrentAccount": "higher_better",
}

# Composite weights: real-economy momentum (GDP growth + PMI activity) at 2x, the
# nominal / stability legs at 1x. See module docstring for the rationale. The
# composite is the WEIGHTED mean of the six cell heats - still a strict, consistent
# function of the cells.
COMPOSITE_WEIGHTS: dict[str, float] = {
    "GDP": 2.0,
    "PMI": 2.0,
    "CPI": 1.0,
    "Unemployment": 1.0,
    "PolicyRate": 1.0,
    "CurrentAccount": 1.0,
}

# Per-indicator metadata for the panel (label + unit). Values only; no UI here.
INDICATOR_META: dict[str, dict] = {
    "GDP": {"label": "GDP Growth", "unit": "% YoY"},
    "CPI": {"label": "CPI Inflation", "unit": "% YoY"},
    "Unemployment": {"label": "Unemployment", "unit": "%"},
    "PolicyRate": {"label": "Policy Rate", "unit": "%"},
    "PMI": {"label": "PMI", "unit": "idx"},
    "CurrentAccount": {"label": "Current Acct", "unit": "% GDP"},
}

# Map indicator -> the curated value key on each country spec.
_VALUE_KEY: dict[str, str] = {
    "GDP": "gdp",
    "CPI": "cpi",
    "Unemployment": "unemp",
    "PolicyRate": "policy",
    "PMI": "pmi",
    "CurrentAccount": "current_account",
}

# Map indicator -> optional FRED series key on the spec for a best-effort live
# override. Only legs FRED publishes as a direct percent level are eligible.
_FRED_KEY: dict[str, str] = {
    "Unemployment": "fred_unemp",
    "PolicyRate": "fred_policy",
}


# ---------------------------------------------------------------------------
# Country table. curated_* reflect realistic mid-2026 readings. fred_* are
# optional FRED ids for a direct-level live override (US only - the OECD
# cross-country families are unreliable on FRED, so the rest stays curated).
#   gdp             real GDP growth, % YoY
#   cpi             headline CPI inflation, % YoY
#   unemp           unemployment rate, %
#   policy          central-bank policy rate, %
#   pmi             composite PMI / activity proxy, diffusion index (50 = neutral)
#   current_account current-account balance, % of GDP (+ surplus / - deficit)
# ---------------------------------------------------------------------------

COUNTRIES: list[dict] = [
    {
        "country": "United States", "code": "US", "flag_label": "\U0001F1FA\U0001F1F8",
        "gdp": 2.1, "cpi": 2.6, "unemp": 4.2, "policy": 4.50, "pmi": 51.5, "current_account": -3.2,
        "fred_unemp": "UNRATE", "fred_policy": "DFEDTARU",
    },
    {
        "country": "Euro Area / Germany", "code": "EA", "flag_label": "\U0001F1EA\U0001F1FA",
        "gdp": 0.8, "cpi": 2.1, "unemp": 6.3, "policy": 2.15, "pmi": 50.2, "current_account": 2.6,
    },
    {
        "country": "United Kingdom", "code": "GB", "flag_label": "\U0001F1EC\U0001F1E7",
        "gdp": 1.1, "cpi": 3.1, "unemp": 4.5, "policy": 4.00, "pmi": 50.8, "current_account": -2.8,
    },
    {
        "country": "Japan", "code": "JP", "flag_label": "\U0001F1EF\U0001F1F5",
        "gdp": 0.9, "cpi": 2.8, "unemp": 2.5, "policy": 0.75, "pmi": 49.5, "current_account": 3.4,
    },
    {
        "country": "China", "code": "CN", "flag_label": "\U0001F1E8\U0001F1F3",
        "gdp": 4.7, "cpi": 0.6, "unemp": 5.1, "policy": 2.90, "pmi": 49.8, "current_account": 1.4,
    },
    {
        "country": "India", "code": "IN", "flag_label": "\U0001F1EE\U0001F1F3",
        "gdp": 6.5, "cpi": 3.2, "unemp": 7.8, "policy": 5.50, "pmi": 56.2, "current_account": -1.2,
    },
    {
        "country": "Brazil", "code": "BR", "flag_label": "\U0001F1E7\U0001F1F7",
        "gdp": 2.2, "cpi": 4.6, "unemp": 6.6, "policy": 14.25, "pmi": 51.0, "current_account": -2.3,
    },
    {
        "country": "Canada", "code": "CA", "flag_label": "\U0001F1E8\U0001F1E6",
        "gdp": 1.4, "cpi": 2.3, "unemp": 6.1, "policy": 2.75, "pmi": 50.5, "current_account": -0.8,
    },
    {
        "country": "Australia", "code": "AU", "flag_label": "\U0001F1E6\U0001F1FA",
        "gdp": 1.7, "cpi": 2.9, "unemp": 4.1, "policy": 3.60, "pmi": 50.9, "current_account": 1.1,
    },
    {
        "country": "Mexico", "code": "MX", "flag_label": "\U0001F1F2\U0001F1FD",
        "gdp": 1.2, "cpi": 3.8, "unemp": 2.8, "policy": 7.75, "pmi": 49.2, "current_account": -0.9,
    },
    {
        "country": "South Korea", "code": "KR", "flag_label": "\U0001F1F0\U0001F1F7",
        "gdp": 2.0, "cpi": 2.2, "unemp": 2.9, "policy": 2.50, "pmi": 49.7, "current_account": 3.8,
    },
    {
        "country": "Turkiye", "code": "TR", "flag_label": "\U0001F1F9\U0001F1F7",
        "gdp": 3.0, "cpi": 33.5, "unemp": 8.7, "policy": 43.00, "pmi": 47.5, "current_account": -3.5,
    },
]


# ---------------------------------------------------------------------------
# Heat scoring - 0-100 where 100 is the GOOD end for that indicator. Each branch
# encodes the correct economic direction; the bands are fixed reference ranges
# tuned to span the cross-country grid.
# ---------------------------------------------------------------------------

def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _heat(indicator: str, value: float) -> float:
    """Map an indicator reading onto a common 0-100 heat scale (100 = good/green,
    0 = bad/red) with the economically correct direction for that indicator."""
    v = float(value)
    if indicator == "GDP":
        # Higher growth is better. Band [-2% .. +6%] so neutral 50 lands at ~2% trend
        # growth (healthy growth reads green, contraction reads red).
        return round(_clamp((v + 2.0) / 8.0 * 100.0), 1)
    if indicator == "CPI":
        # Closer to the 2% target is best; above target is penalized harder than
        # below, so runaway inflation is firmly red.
        if v <= 2.0:
            return round(_clamp(100.0 - (2.0 - v) * 8.0), 1)
        return round(_clamp(100.0 - (v - 2.0) * 9.0), 1)
    if indicator == "Unemployment":
        # Higher unemployment is worse. Band roughly [3% .. 12%].
        return round(_clamp(100.0 - (v - 3.0) / 9.0 * 100.0), 1)
    if indicator == "PolicyRate":
        # Higher policy rate is more restrictive -> a tighter headwind. Band [0% .. 15%].
        return round(_clamp(100.0 - v / 15.0 * 100.0), 1)
    if indicator == "PMI":
        # Higher PMI is better; 50 is the neutral midpoint. Band roughly [42 .. 58].
        return round(_clamp(50.0 + (v - 50.0) * 6.25), 1)
    if indicator == "CurrentAccount":
        # Larger surplus is better. Band roughly [-6% .. +8%] of GDP.
        return round(_clamp((v + 6.0) / 14.0 * 100.0), 1)
    return 50.0


# ---------------------------------------------------------------------------
# Best-effort live FRED override (direct percent levels only)
# ---------------------------------------------------------------------------

def _collect_live() -> dict[tuple[str, str], float]:
    """Pull the few directly-available percent-level legs from FRED. Returns a
    {(country_code, indicator): value} map of whatever resolved. Bounded by a wall
    clock budget and fully guarded - never raises."""
    out: dict[tuple[str, str], float] = {}
    try:
        from . import macro_data
    except Exception as e:
        log.warning("macro_scorecard: macro_data import failed: %s", e)
        return out

    started = time.monotonic()
    for spec in COUNTRIES:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        for indicator, fred_key in _FRED_KEY.items():
            fred_id = spec.get(fred_key)
            if not fred_id:
                continue
            try:
                pts = macro_data.fetch_series(fred_id, days=120) or []
                val = macro_data.latest_value(pts)
            except Exception:
                val = None
            if val is not None:
                out[(spec["code"], indicator)] = round(float(val), 2)
    return out


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_country(spec: dict, live: dict[tuple[str, str], float]) -> tuple[dict, int]:
    """Build one country row with all six indicator cells. Returns (row, live_cells)."""
    cells: list[dict] = []
    weighted_sum = 0.0
    weight_total = 0.0
    live_cells = 0
    for indicator in INDICATORS:
        value = float(spec[_VALUE_KEY[indicator]])
        live_v = live.get((spec["code"], indicator))
        if live_v is not None:
            value = live_v
            live_cells += 1
        heat = _heat(indicator, value)
        w = COMPOSITE_WEIGHTS.get(indicator, 1.0)
        weighted_sum += heat * w
        weight_total += w
        cells.append({
            "indicator": indicator,
            "value": round(value, 2),
            "heat": heat,
            "direction": DIRECTION[indicator],
        })
    # Composite is a strict, consistent function of the cells: the WEIGHTED mean of
    # heats (growth + activity 2x; see COMPOSITE_WEIGHTS).
    composite = round(weighted_sum / weight_total, 1)
    return {
        "country": spec["country"],
        "code": spec["code"],
        "flag_label": spec["flag_label"],
        "cells": cells,
        "composite": composite,
    }, live_cells


def _cell_value(row: dict, indicator: str) -> float | None:
    for c in row["cells"]:
        if c["indicator"] == indicator:
            return c["value"]
    return None


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    # Strongest economy first (highest composite).
    rows = sorted(rows, key=lambda r: r["composite"], reverse=True)

    strongest = rows[0] if rows else None
    weakest = rows[-1] if rows else None
    hottest = max(rows, key=lambda r: _cell_value(r, "CPI") or float("-inf")) if rows else None

    def _ref(r: dict | None, extra_key: str, extra_indicator: str | None) -> dict | None:
        if not r:
            return None
        ref = {
            "country": r["country"],
            "code": r["code"],
            "flag_label": r["flag_label"],
            "composite": r["composite"],
        }
        if extra_indicator is not None:
            ref[extra_key] = _cell_value(r, extra_indicator)
        return ref

    return {
        "indicators": list(INDICATORS),
        "indicator_meta": INDICATOR_META,
        "countries": rows,
        "summary": {
            "strongest": _ref(strongest, "composite", None),
            "weakest": _ref(weakest, "composite", None),
            "hottest_inflation": _ref(hottest, "cpi", "CPI"),
            "count": len(rows),
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def macro_scorecard() -> dict:
    """Cross-country G20 / OECD macro heatmap with economically-correct heat
    direction per indicator and a consistent per-country composite. See module
    docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        return _build(_collect_live())
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("macro_scorecard failed hard, returning sample: %s", e)
        try:
            return _build({})
        except Exception as e2:
            log.error("macro_scorecard sample path failed hard: %s", e2)
            return {
                "indicators": list(INDICATORS),
                "indicator_meta": INDICATOR_META,
                "countries": [],
                "summary": {
                    "strongest": None, "weakest": None,
                    "hottest_inflation": None, "count": 0,
                },
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": "curated cross-country macro grid",
            }


def _build(live: dict[tuple[str, str], float]) -> dict:
    rows: list[dict] = []
    total_live = 0
    for spec in COUNTRIES:
        row, live_cells = _build_country(spec, live)
        total_live += live_cells
        rows.append(row)

    if total_live >= LIVE_MIN_CELLS:
        # "mixed", not "live": only a few US legs are live over the curated grid, so a
        # blanket "live" tag would overclaim. The source string spells this out.
        return _assemble(rows, data_mode="mixed",
                         source="FRED (US legs) + curated cross-country macro grid")
    return _assemble(rows, data_mode="sample", source="curated cross-country macro grid")
