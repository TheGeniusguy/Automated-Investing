"""Real estate deep-dive -- sub-sector breakdown with stocks, prices, and indicators.

Sub-sectors: Homebuilders, REITs (by type), Mortgage Lenders, Mortgage REITs,
RE Services/Brokerages, PropTech, Title/Insurance, Building Materials.

All data from yfinance (free). Pulls prices, returns, market cap, P/E,
dividend yield, and sector-specific metrics where available.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import macro_data

log = logging.getLogger(__name__)

# ── Sub-sector definitions ───────────────────────────────────────────────

SUBSECTORS: dict[str, dict] = {
    "homebuilders": {
        "name": "Homebuilders",
        "description": "Single-family and multi-family residential construction",
        "etfs": ["XHB", "ITB"],
        "stocks": [
            "DHI", "LEN", "NVR", "PHM", "TOL", "KBH",
            "TMHC", "MHO", "MTH", "MDC", "CCS", "GRBK",
        ],
    },
    "reit_data_center": {
        "name": "Data Center REITs",
        "description": "Data center and digital infrastructure REITs",
        "etfs": [],
        "stocks": ["EQIX", "DLR", "AMT", "QTS"],
    },
    "reit_industrial": {
        "name": "Industrial REITs",
        "description": "Warehouse, logistics, and industrial property REITs",
        "etfs": [],
        "stocks": ["PLD", "STAG", "REXR", "FR", "EGP", "TRNO"],
    },
    "reit_residential": {
        "name": "Residential REITs",
        "description": "Apartment, single-family rental, and manufactured housing REITs",
        "etfs": [],
        "stocks": [
            "AVB", "EQR", "MAA", "ESS", "UDR",
            "INVH", "AMH", "CPT", "NXRT", "SUI",
        ],
    },
    "reit_retail": {
        "name": "Retail REITs",
        "description": "Shopping centers, malls, net-lease, and gaming REITs",
        "etfs": [],
        "stocks": [
            "SPG", "O", "NNN", "VICI", "KIM",
            "REG", "FRT", "BRX", "SKT", "ADC",
        ],
    },
    "reit_office": {
        "name": "Office REITs",
        "description": "Office buildings and life science campuses",
        "etfs": [],
        "stocks": ["BXP", "VNO", "SLG", "ARE", "KRC", "HIW", "CUZ", "OFC"],
    },
    "reit_healthcare": {
        "name": "Healthcare REITs",
        "description": "Senior living, medical office, and healthcare facility REITs",
        "etfs": [],
        "stocks": ["WELL", "VTR", "PEAK", "OHI", "HR", "DOC", "SBRA", "MPW"],
    },
    "reit_cell_tower": {
        "name": "Cell Tower & Infrastructure REITs",
        "description": "Wireless towers, fiber, and small cell infrastructure",
        "etfs": [],
        "stocks": ["AMT", "CCI", "SBAC", "UNIT"],
    },
    "reit_storage": {
        "name": "Storage REITs",
        "description": "Self-storage facilities",
        "etfs": [],
        "stocks": ["PSA", "EXR", "CUBE", "LSI", "NSA"],
    },
    "mortgage_lenders": {
        "name": "Mortgage Lenders & Servicers",
        "description": "Mortgage origination, servicing, and fintech lenders",
        "etfs": [],
        "stocks": [
            "RKT", "UWMC", "PFSI", "COOP", "LDI",
            "GHLD", "HMPT", "SNVY",
        ],
    },
    "mortgage_reits": {
        "name": "Mortgage REITs",
        "description": "Agency and non-agency mortgage-backed securities investors",
        "etfs": ["REM"],
        "stocks": [
            "NLY", "AGNC", "STWD", "BXMT", "TWO",
            "MFA", "ARR", "DX", "NRZ", "PMT",
        ],
    },
    "re_services": {
        "name": "RE Services & Brokerages",
        "description": "Commercial and residential real estate services, brokerage, appraisal",
        "etfs": [],
        "stocks": [
            "CBRE", "JLL", "CIGI", "RMR", "MMI",
            "EXPI", "RLGY", "DOUG", "RHR",
        ],
    },
    "proptech": {
        "name": "PropTech",
        "description": "Real estate technology, listings, iBuyers, and digital platforms",
        "etfs": [],
        "stocks": [
            "ZG", "Z", "RDFN", "OPEN", "COMP",
            "CSGP", "RKT", "FTHM",
        ],
    },
    "title_insurance": {
        "name": "Title & Insurance",
        "description": "Title insurance, settlement services, and real estate insurance",
        "etfs": [],
        "stocks": ["FNF", "FAF", "STC", "RLI", "ESNT", "MTG", "RDN", "NMIH"],
    },
    "building_materials": {
        "name": "Building Materials & Suppliers",
        "description": "Lumber, aggregates, roofing, siding, and building product manufacturers",
        "etfs": [],
        "stocks": [
            "VMC", "MLM", "BLDR", "BLD", "AZEK",
            "TREX", "OC", "BECN", "SSD", "DOOR",
        ],
    },
}

SUBSECTOR_ORDER = [
    "homebuilders", "reit_residential", "reit_industrial", "reit_data_center",
    "reit_retail", "reit_office", "reit_healthcare", "reit_cell_tower",
    "reit_storage", "mortgage_lenders", "mortgage_reits", "re_services",
    "proptech", "title_insurance", "building_materials",
]

WINDOWS = [
    {"key": "1d",  "label": "1D",  "days": 1},
    {"key": "1w",  "label": "1W",  "days": 5},
    {"key": "1m",  "label": "1M",  "days": 21},
    {"key": "3m",  "label": "3M",  "days": 63},
    {"key": "6m",  "label": "6M",  "days": 126},
    {"key": "1y",  "label": "1Y",  "days": 252},
]


def _load_closes(symbol: str, lookback: int) -> list[tuple]:
    try:
        points = macro_data.fetch_arbitrary_ticker(symbol, days=max(lookback * 2, 30))
        return [(p["date"], p["value"]) for p in points if p.get("value") is not None]
    except Exception as e:
        log.warning("Failed to load closes for %s: %s", symbol, e)
        return []


def _return_pct(closes: list[tuple], lookback: int) -> Optional[float]:
    if len(closes) < 2 or lookback < 1:
        return None
    end_close = closes[-1][1]
    start_idx = max(0, len(closes) - lookback - 1)
    start_close = closes[start_idx][1]
    if not start_close or not end_close or start_close <= 0:
        return None
    return float((end_close - start_close) / start_close * 100.0)


def _stock_info(symbol: str) -> dict:
    try:
        import yfinance as yf
        tk = yf.Ticker(symbol)
        info = tk.info or {}
        return {
            "symbol": symbol,
            "name": info.get("shortName") or info.get("longName") or symbol,
            "market_cap": info.get("marketCap"),
            "pe_ratio": info.get("trailingPE") or info.get("forwardPE"),
            "forward_pe": info.get("forwardPE"),
            "dividend_yield": info.get("dividendYield"),
            "price_to_book": info.get("priceToBook"),
            "beta": info.get("beta"),
            "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
            "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
            "avg_volume": info.get("averageVolume"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
            # REIT-specific
            "ffo_per_share": info.get("trailingEps"),  # approximate
            "payout_ratio": info.get("payoutRatio"),
            "debt_to_equity": info.get("debtToEquity"),
            "return_on_equity": info.get("returnOnEquity"),
            "revenue_growth": info.get("revenueGrowth"),
            "earnings_growth": info.get("earningsGrowth"),
        }
    except Exception as e:
        log.warning("yfinance info for %s failed: %s", symbol, e)
        return {"symbol": symbol, "name": symbol}


def _compute_stock_row(symbol: str, max_lookback: int, bench_returns: dict) -> dict:
    closes = _load_closes(symbol, max_lookback)
    last_close = closes[-1][1] if closes else None
    last_date = closes[-1][0] if closes else None

    returns = {}
    for w in WINDOWS:
        r_abs = _return_pct(closes, w["days"])
        b_r = bench_returns.get(w["key"])
        r_rel = (r_abs - b_r) if (r_abs is not None and b_r is not None) else None
        returns[w["key"]] = {"abs": r_abs, "rel": r_rel}

    info = _stock_info(symbol)

    return {
        "symbol": symbol,
        "name": info.get("name", symbol),
        "last_close": float(last_close) if last_close is not None else None,
        "last_date": str(last_date) if last_date else None,
        "returns": returns,
        "market_cap": info.get("market_cap"),
        "pe_ratio": info.get("pe_ratio"),
        "forward_pe": info.get("forward_pe"),
        "dividend_yield": info.get("dividend_yield"),
        "price_to_book": info.get("price_to_book"),
        "beta": info.get("beta"),
        "fifty_two_week_high": info.get("fifty_two_week_high"),
        "fifty_two_week_low": info.get("fifty_two_week_low"),
        "avg_volume": info.get("avg_volume"),
        "industry": info.get("industry"),
        "payout_ratio": info.get("payout_ratio"),
        "debt_to_equity": info.get("debt_to_equity"),
        "return_on_equity": info.get("return_on_equity"),
        "revenue_growth": info.get("revenue_growth"),
        "earnings_growth": info.get("earnings_growth"),
    }


def list_subsectors() -> list[dict]:
    result = []
    for sid in SUBSECTOR_ORDER:
        sub = SUBSECTORS[sid]
        result.append({
            "id": sid,
            "name": sub["name"],
            "description": sub["description"],
            "stock_count": len(sub["stocks"]),
            "etfs": sub["etfs"],
        })
    return result


def subsector_detail(subsector_id: str) -> dict:
    if subsector_id not in SUBSECTORS:
        raise ValueError(f"Unknown subsector: {subsector_id}")

    sub = SUBSECTORS[subsector_id]
    max_lookback = max(w["days"] for w in WINDOWS)

    # Benchmark: XLRE for REITs, XHB for homebuilders, SPY as fallback.
    if "reit" in subsector_id or subsector_id == "mortgage_reits":
        bench_ticker = "XLRE"
    elif subsector_id in ("homebuilders", "building_materials"):
        bench_ticker = "XHB"
    else:
        bench_ticker = "SPY"

    bench_closes = _load_closes(bench_ticker, max_lookback)
    bench_returns: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        bench_returns[w["key"]] = _return_pct(bench_closes, w["days"])

    # ETF returns.
    etf_rows = []
    for etf in sub["etfs"]:
        closes = _load_closes(etf, max_lookback)
        rets = {}
        for w in WINDOWS:
            r_abs = _return_pct(closes, w["days"])
            b_r = bench_returns.get(w["key"])
            r_rel = (r_abs - b_r) if (r_abs is not None and b_r is not None) else None
            rets[w["key"]] = {"abs": r_abs, "rel": r_rel}
        etf_rows.append({
            "ticker": etf,
            "last_close": float(closes[-1][1]) if closes else None,
            "returns": rets,
        })

    # Stocks in parallel.
    stocks = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {
            pool.submit(_compute_stock_row, sym, max_lookback, bench_returns): sym
            for sym in sub["stocks"]
        }
        for future in as_completed(futures):
            try:
                stocks.append(future.result())
            except Exception as e:
                sym = futures[future]
                log.warning("Failed for %s: %s", sym, e)
                stocks.append({"symbol": sym, "name": sym, "returns": {}, "last_close": None})

    stocks.sort(key=lambda s: s.get("market_cap") or 0, reverse=True)

    return {
        "subsector_id": subsector_id,
        "name": sub["name"],
        "description": sub["description"],
        "windows": WINDOWS,
        "benchmark": {"ticker": bench_ticker, "returns": bench_returns},
        "etfs": etf_rows,
        "stocks": stocks,
    }


def overview() -> dict:
    """Quick overview of all RE sub-sectors -- just ETF/representative returns."""
    max_lookback = max(w["days"] for w in WINDOWS)

    spy_closes = _load_closes("SPY", max_lookback)
    spy_returns: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        spy_returns[w["key"]] = _return_pct(spy_closes, w["days"])

    # Key RE benchmarks.
    benchmarks = ["XLRE", "VNQ", "XHB", "ITB", "REM"]
    bench_data = []
    for etf in benchmarks:
        closes = _load_closes(etf, max_lookback)
        rets = {}
        for w in WINDOWS:
            r_abs = _return_pct(closes, w["days"])
            s_r = spy_returns.get(w["key"])
            r_rel = (r_abs - s_r) if (r_abs is not None and s_r is not None) else None
            rets[w["key"]] = {"abs": r_abs, "rel": r_rel}
        bench_data.append({
            "ticker": etf,
            "last_close": float(closes[-1][1]) if closes else None,
            "returns": rets,
        })

    return {
        "windows": WINDOWS,
        "spy_returns": spy_returns,
        "benchmarks": bench_data,
        "subsectors": list_subsectors(),
    }
