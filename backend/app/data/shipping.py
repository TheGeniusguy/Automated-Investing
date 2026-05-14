"""Shipping & freight intelligence.

US economic activity moves on rails and trucks; international goods move on
container and dry-bulk vessels. Combining these into one view reveals
goods-economy momentum independently of GDP releases.

Sources:
  - yfinance (^BDI):     Baltic Dry Index — dry bulk shipping rates
  - FRED:                rail carloads, truck tonnage, mfg & trade inventories,
                         Chicago Fed Activity Index
"""
from __future__ import annotations

import logging
from datetime import datetime

from . import macro_data

log = logging.getLogger(__name__)


SHIPPING_TILES = [
    # Baltic Dry Index doesn't have a Yahoo Finance ticker; BDRY ETF tracks it instead.
    {"id": "BDRY",                 "label": "Breakwave Dry Bulk Shipping ETF",  "unit": "$",  "source": "yfinance",
     "note": "Tracks the Baltic Dry Index via dry-bulk freight futures. Proxy for global dry-bulk shipping rates."},
    {"id": "SEA",                  "label": "Invesco Shipping ETF",        "unit": "$",   "source": "yfinance"},
    {"id": "FTRI",                 "label": "Frontline Ltd (Tankers)",     "unit": "$",   "source": "yfinance",
     "note": "Single-stock proxy for crude tanker rates."},
    {"id": "RAILFRTCARLOADSD11",   "label": "US Rail Freight Carloads",    "unit": "k",   "source": "fred"},
    {"id": "TRUCKD11",             "label": "US Truck Tonnage Index",      "unit": "Idx 2015=100", "source": "fred"},
    {"id": "AMTMTI",               "label": "Manufacturing & Trade Invs",  "unit": "$M",  "source": "fred"},
    {"id": "CFNAI",                "label": "Chicago Fed Activity Idx",    "unit": "Idx", "source": "fred",
     "note": "85-indicator composite — single-number nowcasting signal."},
    {"id": "ISRATIO",              "label": "Inventory/Sales Ratio",       "unit": "ratio", "source": "fred"},
]


def fetch_shipping(*, days: int = 365) -> dict:
    tiles = []
    for spec in SHIPPING_TILES:
        try:
            points = macro_data.fetch_explicit(spec["id"], source=spec["source"], days=days)
            values = [p["value"] for p in points if p["value"] is not None]
            latest = values[-1] if values else None
            prior  = values[-2] if len(values) >= 2 else None
            tiles.append({
                **spec,
                "latest":      latest,
                "prior":       prior,
                "delta_pct":   ((latest / prior - 1.0) if (latest is not None and prior) else None),
                "latest_date": points[-1]["date"] if points else None,
                "trail":       [p for p in points[-60:] if p["value"] is not None],
            })
        except Exception as e:
            log.warning("shipping tile %s failed: %s", spec["id"], e)
            tiles.append({**spec, "latest": None, "prior": None, "trail": [], "error": str(e)})
    return {
        "tiles":       tiles,
        "fetched_at":  datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
