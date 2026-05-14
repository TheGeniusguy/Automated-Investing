"""Energy detail module.

A curated dashboard of the highest-signal energy series. Composes FRED
(spot prices, inventories) with yfinance (futures + select equity proxies)
so the panel works partially even without a FRED key.

Categories:
  - prices:       spot crude / Brent / Henry Hub gas / gasoline + futures
  - inventories:  US crude / gasoline / distillate stocks (weekly EIA via FRED)
  - production:   US crude production index, refinery utilization
  - logistics:    crude imports
"""
from __future__ import annotations

import logging
from datetime import datetime

from . import macro_data

log = logging.getLogger(__name__)


ENERGY_LAYOUT = [
    {
        "section": "prices",
        "label":   "Prices",
        "tiles": [
            # FRED daily spot
            {"id": "DCOILWTICO",   "label": "WTI Crude (spot)",     "unit": "$/bbl", "source": "fred"},
            {"id": "DCOILBRENTEU", "label": "Brent Crude (spot)",   "unit": "$/bbl", "source": "fred"},
            {"id": "DHHNGSP",      "label": "Henry Hub Nat Gas",    "unit": "$/MMBtu", "source": "fred"},
            {"id": "GASREGW",      "label": "US Regular Gasoline",  "unit": "$/gal", "source": "fred"},
            # yfinance futures fallback
            {"id": "CL=F", "label": "WTI Crude Front Month",  "unit": "$/bbl", "source": "yfinance"},
            {"id": "BZ=F", "label": "Brent Front Month",      "unit": "$/bbl", "source": "yfinance"},
            {"id": "NG=F", "label": "Natural Gas Front Month","unit": "$/MMBtu", "source": "yfinance"},
            {"id": "HO=F", "label": "Heating Oil Front Month","unit": "$/gal", "source": "yfinance"},
            {"id": "RB=F", "label": "Gasoline Front Month",   "unit": "$/gal", "source": "yfinance"},
        ],
    },
    {
        "section": "inventories",
        "label":   "Inventories (weekly EIA)",
        "tiles": [
            {"id": "WCRSTUS1", "label": "US Commercial Crude Stocks",  "unit": "kbbl", "source": "fred"},
            {"id": "WGTSTUS1", "label": "US Gasoline Stocks",          "unit": "kbbl", "source": "fred"},
            {"id": "WDISTUS1", "label": "US Distillate Stocks",        "unit": "kbbl", "source": "fred"},
        ],
    },
    {
        "section": "production",
        "label":   "Production & Refining",
        "tiles": [
            {"id": "IPG211111CN", "label": "Crude Production Index",       "unit": "Idx 2017", "source": "fred"},
            {"id": "TCU",         "label": "Capacity Utilization (all)",   "unit": "%",        "source": "fred"},
            {"id": "WCESTUS1",    "label": "US Crude Imports",             "unit": "kbbl/day", "source": "fred"},
        ],
    },
    {
        "section": "equity_proxies",
        "label":   "Energy Equities",
        "tiles": [
            {"id": "XLE",   "label": "Energy Select Sector SPDR", "unit": "$",   "source": "yfinance"},
            {"id": "XOP",   "label": "S&P Oil & Gas E&P ETF",     "unit": "$",   "source": "yfinance"},
            {"id": "OIH",   "label": "Oil Services ETF",          "unit": "$",   "source": "yfinance"},
            {"id": "USO",   "label": "United States Oil Fund",    "unit": "$",   "source": "yfinance"},
            {"id": "UNG",   "label": "United States Nat Gas Fund","unit": "$",   "source": "yfinance"},
        ],
    },
]


def fetch_section(section: str, *, days: int = 180) -> dict:
    """Return a section of the energy dashboard with current values + trails."""
    target = next((s for s in ENERGY_LAYOUT if s["section"] == section), None)
    if target is None:
        return {"section": section, "label": section, "tiles": []}
    tiles = []
    for spec in target["tiles"]:
        try:
            points = macro_data.fetch_explicit(spec["id"], source=spec["source"], days=days)
            values = [p["value"] for p in points if p["value"] is not None]
            latest = values[-1] if values else None
            prior  = values[-2] if len(values) >= 2 else None
            tiles.append({
                **spec,
                "latest":     latest,
                "prior":      prior,
                "delta_pct":  ((latest / prior - 1.0) if (latest is not None and prior) else None),
                "latest_date": points[-1]["date"] if points else None,
                "trail":      [p for p in points[-50:] if p["value"] is not None],
            })
        except Exception as e:
            log.warning("energy section %s tile %s failed: %s", section, spec["id"], e)
            tiles.append({**spec, "latest": None, "prior": None, "trail": [], "error": str(e)})
    return {
        "section":     target["section"],
        "label":       target["label"],
        "tiles":       tiles,
        "fetched_at":  datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


def fetch_full() -> dict:
    return {
        "sections":   [fetch_section(s["section"]) for s in ENERGY_LAYOUT],
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
