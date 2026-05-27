"""Sub-industry decomposition per sector.

For each sector, group its curated key_stocks into editorial sub-industries
(e.g. Tech -> Software / Hardware / AI-GPU / Services; Financials -> Money-
center banks / Regional banks / Capital markets / Asset mgmt / Payments).

For each sub-industry, compute:
  - stock count + member tickers
  - total market cap + % of sector cap
  - cap-weighted returns over 1d/1w/1m/3m/ytd/1y
  - top performer per window (symbol + return + contribution)

This complements the constituent decomposition (which is per-stock). The
sub-industry view answers "which slice of the sector is leading."
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Optional

from . import macro_data, sector_detail

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 400  # >1y so YTD always covered

WINDOWS = [
    {"key": "1d",  "label": "1D",  "type": "bars", "days": 1},
    {"key": "1w",  "label": "1W",  "type": "bars", "days": 5},
    {"key": "1m",  "label": "1M",  "type": "bars", "days": 21},
    {"key": "3m",  "label": "3M",  "type": "bars", "days": 63},
    {"key": "ytd", "label": "YTD", "type": "calendar"},
    {"key": "1y",  "label": "1Y",  "type": "bars", "days": 252},
]


# ── Per-sector sub-industry maps ────────────────────────────────────────────
# Editorial groupings of each sector's curated key_stocks. Adding a sub-industry
# or moving a stock is a config-only change here.

SECTOR_SUB_INDUSTRIES: dict[str, dict[str, list[str]]] = {
    "technology": {
        "AI / GPU":               ["NVDA", "PLTR"],
        "Software":               ["CRM", "ADBE", "ORCL", "NOW", "INTU"],
        "Mega-cap platforms":     ["AAPL", "MSFT"],
        "Hardware / networking":  ["CSCO", "IBM"],
        "Services":               ["ACN"],
    },
    "semiconductors": {
        "Design (fabless)":   ["NVDA", "AMD", "AVGO", "QCOM", "MRVL", "ON"],
        "Foundry":            ["TSM"],
        "Equipment / WFE":    ["AMAT", "LRCX", "KLAC"],
        "Memory":             ["MU"],
        "Integrated (IDM)":   ["INTC"],
    },
    "financials": {
        "Money-center banks": ["JPM", "BAC", "WFC", "C"],
        "Regional banks":     ["USB", "PNC"],
        "Capital markets":    ["GS", "MS", "SCHW"],
        "Asset management":   ["BLK", "BX"],
        "Payments":           ["AXP"],
    },
    "healthcare": {
        "Managed care":       ["UNH"],
        "Big pharma":         ["JNJ", "LLY", "ABBV", "MRK", "PFE", "BMY"],
        "Life sci tools":     ["TMO"],
        "Medical devices":    ["ABT", "MDT", "ISRG"],
        "Biotech (large)":    ["AMGN"],
    },
    "biotech": {
        "Large-cap biopharma":["AMGN", "GILD", "VRTX", "REGN", "BIIB"],
        "mRNA / vaccines":    ["MRNA"],
        "Tools / diagnostics":["ILMN", "EXAS"],
        "Rare disease":       ["BMRN", "RARE", "ALNY"],
        "Oncology":           ["SGEN"],
    },
    "oil_gas": {
        "Integrated majors":  ["XOM", "CVX"],
        "E&P":                ["COP", "EOG", "PXD", "OXY", "DVN"],
        "Refining":           ["MPC", "PSX", "VLO"],
        "Oilfield services":  ["SLB", "HAL"],
    },
    "consumer_discretionary": {
        "E-commerce / cloud": ["AMZN"],
        "Autos / EV":         ["TSLA", "GM"],
        "Home improvement":   ["HD", "LOW"],
        "Restaurants":        ["MCD", "SBUX", "CMG"],
        "Apparel / softline": ["NKE", "TJX"],
        "Travel":             ["BKNG"],
        "Homebuilders":       ["DHI"],
    },
    "industrials": {
        "Aerospace / defense":["RTX", "BA", "LMT"],
        "Heavy machinery":    ["CAT", "DE"],
        "Diversified":        ["HON", "GE", "ETN", "ITW"],
        "Rails":              ["UNP"],
        "Logistics":          ["UPS"],
        "Waste":              ["WM"],
    },
    "consumer_staples": {
        "Household / personal":["PG", "CL"],
        "Beverages":          ["KO", "PEP", "STZ"],
        "Big-box retail":     ["COST", "WMT"],
        "Tobacco":            ["PM", "MO"],
        "Packaged food":      ["MDLZ", "KHC", "GIS"],
    },
    "utilities": {
        "Diversified utility":["NEE", "DUK", "SO", "D", "AEP", "SRE", "EXC", "XEL", "ES", "WEC", "ED"],
        "Clean power":        ["CEG"],
    },
    "materials": {
        "Industrial gases":   ["LIN", "APD"],
        "Specialty chem":     ["SHW", "ECL", "DD", "DOW"],
        "Mining":             ["FCX", "NEM", "GOLD"],
        "Steel / metals":     ["NUE"],
        "Aggregates":         ["VMC", "MLM"],
    },
    "communication_services": {
        "Big internet / ads": ["META", "GOOGL"],
        "Streaming / media":  ["NFLX", "DIS", "SPOT"],
        "Telecom":            ["T", "VZ", "TMUS", "CHTR"],
        "Gaming":             ["EA", "TTWO", "RBLX"],
    },
    "real_estate": {
        "Data centers":       ["EQIX", "DLR"],
        "Cell towers":        ["AMT"],
        "Industrial":         ["PLD"],
        "Self-storage":       ["PSA"],
        "Retail":             ["SPG", "O"],
        "Residential":        ["AVB", "EQR"],
        "Healthcare":         ["WELL", "VTR"],
        "Lab / life sci":     ["ARE"],
    },
    "clean_energy": {
        "Solar":              ["ENPH", "FSLR", "SEDG", "RUN"],
        "Hydrogen / fuel cell":["PLUG", "BE"],
        "EV / battery":       ["RIVN", "LCID", "QS"],
        "Clean power utility":["NEE", "CEG", "VST"],
    },
    "defense_aerospace": {
        "Prime contractors":  ["LMT", "RTX", "NOC", "GD", "LHX"],
        "Aerospace mfg":      ["BA"],
        "Ship / nuclear":     ["HII", "BWXT"],
        "Aero parts / suppliers": ["TDG"],
        "IT / cyber":         ["LDOS"],
        "Drones / new space": ["KTOS", "RKLB"],
    },
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _load_closes(symbol: str) -> list[tuple[str, float]]:
    try:
        pts = macro_data.fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS)
        return [(p["date"], float(p["value"])) for p in pts if p.get("value") is not None]
    except Exception as exc:
        log.warning("Sub-industry close load failed for %s: %s", symbol, exc)
        return []


def _market_cap(symbol: str) -> Optional[float]:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
        mc = info.get("marketCap")
        return float(mc) if mc else None
    except Exception as exc:
        log.warning("Sub-industry market cap failed for %s: %s", symbol, exc)
        return None


def _symbol_payload(symbol: str) -> dict:
    closes = _load_closes(symbol)
    mc = _market_cap(symbol)
    return {"symbol": symbol, "closes": closes, "market_cap": mc}


def _return_bars(closes: list[tuple[str, float]], bars: int) -> Optional[float]:
    if len(closes) < 2 or bars < 1:
        return None
    end = closes[-1][1]
    idx = max(0, len(closes) - 1 - bars)
    start = closes[idx][1]
    if not start or start <= 0:
        return None
    return float((end - start) / start * 100.0)


def _return_ytd(closes: list[tuple[str, float]]) -> Optional[float]:
    if len(closes) < 2:
        return None
    last_dt = date.fromisoformat(closes[-1][0])
    boundary = date(last_dt.year, 1, 1)
    basis = None
    for d, c in closes:
        if date.fromisoformat(d) >= boundary:
            basis = c
            break
    if basis is None or basis <= 0:
        return None
    return float((closes[-1][1] - basis) / basis * 100.0)


def _stock_return(closes: list[tuple[str, float]], window: dict) -> Optional[float]:
    if window["type"] == "bars":
        return _return_bars(closes, window["days"])
    if window["key"] == "ytd":
        return _return_ytd(closes)
    return None


# ── Public API ──────────────────────────────────────────────────────────────

def sector_sub_industries(sector_id: str) -> dict:
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")
    sec = sector_detail.SECTORS[sector_id]
    sub_map = SECTOR_SUB_INDUSTRIES.get(sector_id)
    if not sub_map:
        return {
            "sector_id": sector_id,
            "name":      sec["name"],
            "etf":       sec["etf"],
            "available": False,
            "reason":    "No sub-industry map configured for this sector yet",
            "sub_industries": [],
            "windows":   [{"key": w["key"], "label": w["label"]} for w in WINDOWS],
        }

    # Fetch all symbols once. Some stocks live in multiple sub-industries
    # (clean_energy has NEE under "Clean power utility" but NEE is also in
    # utilities — fine, each sector has its own copy).
    all_symbols: set[str] = set()
    for syms in sub_map.values():
        for s in syms:
            all_symbols.add(s)

    payloads: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(_symbol_payload, s): s for s in all_symbols}
        for fut in as_completed(futs):
            sym = futs[fut]
            try:
                payloads[sym] = fut.result()
            except Exception as exc:
                log.warning("payload failed for %s: %s", sym, exc)
                payloads[sym] = {"symbol": sym, "closes": [], "market_cap": None}

    # Total cap across the sector (for weight % calculation).
    sector_total_cap = sum(
        (payloads[s].get("market_cap") or 0) for s in all_symbols
    )

    out_subs: list[dict] = []
    for name, symbols in sub_map.items():
        # Members + per-stock returns over all windows.
        members: list[dict] = []
        subi_cap = 0.0
        for s in symbols:
            p = payloads.get(s, {})
            mc = p.get("market_cap")
            closes = p.get("closes") or []
            stock_returns: dict[str, Optional[float]] = {}
            for w in WINDOWS:
                stock_returns[w["key"]] = _stock_return(closes, w)
            members.append({
                "symbol":      s,
                "market_cap":  mc,
                "returns_pct": stock_returns,
            })
            if mc:
                subi_cap += mc

        # Cap-weighted return per window (drop members with missing return per window).
        subi_returns: dict[str, Optional[float]] = {}
        for w in WINDOWS:
            key = w["key"]
            valid = [(m, m["returns_pct"].get(key)) for m in members
                     if m["market_cap"] and m["returns_pct"].get(key) is not None]
            total_w = sum(m["market_cap"] for m, _ in valid)
            if total_w <= 0:
                subi_returns[key] = None
            else:
                subi_returns[key] = sum(
                    (m["market_cap"] / total_w) * r for m, r in valid
                )

        # Top performer per window.
        top_per_window: dict[str, Optional[dict]] = {}
        for w in WINDOWS:
            key = w["key"]
            ranked = [
                (m["symbol"], m["returns_pct"].get(key),
                 (m["market_cap"] / subi_cap) if (m["market_cap"] and subi_cap) else None)
                for m in members
                if m["returns_pct"].get(key) is not None
            ]
            if not ranked:
                top_per_window[key] = None
                continue
            ranked.sort(key=lambda x: x[1], reverse=True)
            sym, ret, weight = ranked[0]
            contribution = (weight * ret) if (weight is not None) else None
            top_per_window[key] = {
                "symbol":          sym,
                "return_pct":      round(ret, 3),
                "weight_in_subi":  round(weight * 100, 2) if weight is not None else None,
                "contribution_pct": round(contribution, 3) if contribution is not None else None,
            }

        out_subs.append({
            "name":               name,
            "stock_count":        len(symbols),
            "total_market_cap":   subi_cap if subi_cap > 0 else None,
            "weight_pct_of_sector": round(subi_cap / sector_total_cap * 100, 2) if sector_total_cap > 0 else None,
            "members":            [{
                "symbol":     m["symbol"],
                "market_cap": m["market_cap"],
                "returns_pct":{k: (round(v, 3) if v is not None else None)
                               for k, v in m["returns_pct"].items()},
            } for m in members],
            "returns_pct":        {k: (round(v, 3) if v is not None else None)
                                   for k, v in subi_returns.items()},
            "top_per_window":     top_per_window,
        })

    return {
        "sector_id":    sector_id,
        "name":         sec["name"],
        "etf":          sec["etf"],
        "available":    True,
        "windows":      [{"key": w["key"], "label": w["label"]} for w in WINDOWS],
        "sub_industries": out_subs,
        "sector_total_market_cap": sector_total_cap if sector_total_cap > 0 else None,
        "notes": (
            "Sub-industries are editorial groupings of the sector's curated "
            "key_stocks list. Returns are cap-weighted within each sub-industry."
        ),
    }
