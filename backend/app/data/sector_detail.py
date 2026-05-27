"""Sector detail module -- comprehensive per-sector drill-down data.

Defines 12+ sectors with key stocks, sub-industries, and related ETFs.
All data sourced from yfinance (free, no API key). Pulls:
  - ETF + stock price returns over multiple windows
  - Market cap, P/E, dividend yield, 52-week range from yfinance .info
  - Volume metrics

Uses the existing macro_data.fetch_arbitrary_ticker for cached price data
and yfinance Ticker.info for fundamental snapshots.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import macro_data

log = logging.getLogger(__name__)

# ── Sector definitions ──────────────────────────────────────────────────

SECTORS: dict[str, dict] = {
    "technology": {
        "name": "Technology",
        "etf": "XLK",
        "icon": "cpu",
        "description": "Software, hardware, IT services, cloud computing",
        "sub_industries": ["Software", "Hardware", "IT Services", "Cloud", "Cybersecurity"],
        "key_stocks": ["AAPL", "MSFT", "NVDA", "CRM", "ADBE", "ORCL", "CSCO", "ACN", "IBM", "INTU", "NOW", "PLTR"],
        "related_etfs": ["QQQ", "VGT", "IGV", "SKYY", "HACK"],
    },
    "semiconductors": {
        "name": "Semiconductors",
        "etf": "SMH",
        "icon": "chip",
        "description": "Chip design, manufacturing, equipment, packaging",
        "sub_industries": ["Chip Design", "Foundries", "Equipment", "Memory", "Analog"],
        "key_stocks": ["NVDA", "AMD", "INTC", "TSM", "AVGO", "QCOM", "MU", "AMAT", "LRCX", "KLAC", "MRVL", "ON"],
        "related_etfs": ["SOXX", "SMH", "PSI", "SOXQ"],
    },
    "real_estate": {
        "name": "Real Estate",
        "etf": "XLRE",
        "icon": "building",
        "description": "REITs, commercial, residential, data centers, cell towers",
        "sub_industries": ["Data Centers", "Cell Towers", "Industrial", "Residential", "Retail", "Office", "Healthcare"],
        "key_stocks": ["AMT", "PLD", "EQIX", "SPG", "PSA", "O", "WELL", "DLR", "AVB", "EQR", "VTR", "ARE"],
        "related_etfs": ["VNQ", "IYR", "SCHH", "RWR"],
    },
    "oil_gas": {
        "name": "Oil & Gas",
        "etf": "XLE",
        "icon": "flame",
        "description": "Exploration, production, refining, oilfield services, midstream",
        "sub_industries": ["E&P", "Integrated", "Refining", "Oilfield Services", "Midstream/MLPs"],
        "key_stocks": ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "VLO", "PXD", "OXY", "HAL", "DVN"],
        "related_etfs": ["XOP", "OIH", "AMLP", "IEO"],
    },
    "financials": {
        "name": "Financials",
        "etf": "XLF",
        "icon": "landmark",
        "description": "Banks, insurance, asset management, fintech, capital markets",
        "sub_industries": ["Banks", "Insurance", "Asset Management", "Capital Markets", "Fintech"],
        "key_stocks": ["JPM", "BAC", "GS", "MS", "WFC", "BLK", "SCHW", "AXP", "C", "USB", "PNC", "BX"],
        "related_etfs": ["KBE", "KRE", "IAI", "IYF"],
    },
    "healthcare": {
        "name": "Healthcare",
        "etf": "XLV",
        "icon": "heart-pulse",
        "description": "Pharma, biotech, medical devices, managed care, diagnostics",
        "sub_industries": ["Pharma", "Biotech", "Medical Devices", "Managed Care", "Diagnostics", "Life Sciences"],
        "key_stocks": ["UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "AMGN", "BMY", "ISRG", "MDT"],
        "related_etfs": ["IBB", "XBI", "IHI", "VHT"],
    },
    "consumer_discretionary": {
        "name": "Consumer Discretionary",
        "etf": "XLY",
        "icon": "shopping-cart",
        "description": "Retail, autos, homebuilders, restaurants, travel, luxury",
        "sub_industries": ["E-Commerce", "Autos", "Homebuilders", "Restaurants", "Apparel", "Travel"],
        "key_stocks": ["AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "TJX", "BKNG", "CMG", "DHI", "GM"],
        "related_etfs": ["XRT", "IBUY", "ITB", "PEJ"],
    },
    "industrials": {
        "name": "Industrials",
        "etf": "XLI",
        "icon": "factory",
        "description": "Aerospace & defense, machinery, railroads, waste management",
        "sub_industries": ["Aerospace & Defense", "Machinery", "Railroads", "Airlines", "Waste Mgmt", "Electrical Equipment"],
        "key_stocks": ["CAT", "UNP", "HON", "RTX", "BA", "DE", "LMT", "GE", "UPS", "WM", "ETN", "ITW"],
        "related_etfs": ["ITA", "XAR", "JETS", "IYT"],
    },
    "consumer_staples": {
        "name": "Consumer Staples",
        "etf": "XLP",
        "icon": "package",
        "description": "Food & beverage, household products, tobacco, retail staples",
        "sub_industries": ["Food & Beverage", "Household Products", "Tobacco", "Drug Retail", "Grocery"],
        "key_stocks": ["PG", "KO", "PEP", "COST", "WMT", "PM", "MO", "CL", "MDLZ", "KHC", "STZ", "GIS"],
        "related_etfs": ["VDC", "IYK", "FSTA"],
    },
    "utilities": {
        "name": "Utilities",
        "etf": "XLU",
        "icon": "zap",
        "description": "Electric, gas, water utilities, renewable energy, nuclear",
        "sub_industries": ["Electric", "Gas", "Water", "Multi-Utility", "Renewable/IPP"],
        "key_stocks": ["NEE", "DUK", "SO", "D", "AEP", "SRE", "EXC", "XEL", "ED", "WEC", "ES", "CEG"],
        "related_etfs": ["VPU", "IDU", "FUTY"],
    },
    "materials": {
        "name": "Materials",
        "etf": "XLB",
        "icon": "gem",
        "description": "Chemicals, metals & mining, packaging, construction materials",
        "sub_industries": ["Chemicals", "Metals & Mining", "Packaging", "Construction Materials", "Gold"],
        "key_stocks": ["LIN", "APD", "SHW", "ECL", "FCX", "NEM", "NUE", "DOW", "DD", "VMC", "MLM", "GOLD"],
        "related_etfs": ["GDX", "XME", "PICK", "LIT"],
    },
    "communication_services": {
        "name": "Communication Services",
        "etf": "XLC",
        "icon": "wifi",
        "description": "Social media, streaming, telecom, advertising, gaming",
        "sub_industries": ["Social Media", "Streaming", "Telecom", "Advertising", "Gaming"],
        "key_stocks": ["META", "GOOGL", "NFLX", "DIS", "T", "VZ", "TMUS", "CHTR", "EA", "TTWO", "SPOT", "RBLX"],
        "related_etfs": ["VOX", "FCOM", "IYZ"],
    },
    "clean_energy": {
        "name": "Clean Energy",
        "etf": "ICLN",
        "icon": "leaf",
        "description": "Solar, wind, EV, hydrogen, energy storage, smart grid",
        "sub_industries": ["Solar", "Wind", "EV/Battery", "Hydrogen", "Energy Storage"],
        "key_stocks": ["ENPH", "FSLR", "SEDG", "RUN", "PLUG", "BE", "NEE", "CEG", "VST", "RIVN", "LCID", "QS"],
        "related_etfs": ["TAN", "FAN", "LIT", "QCLN", "PBW"],
    },
    "defense_aerospace": {
        "name": "Defense & Aerospace",
        "etf": "ITA",
        "icon": "shield",
        "description": "Defense contractors, space, military tech, cybersecurity",
        "sub_industries": ["Prime Contractors", "Space", "Military Tech", "Cyber Defense", "Drones/UAVs"],
        "key_stocks": ["LMT", "RTX", "NOC", "GD", "BA", "LHX", "HII", "TDG", "LDOS", "BWXT", "KTOS", "RKLB"],
        "related_etfs": ["XAR", "PPA", "DFEN", "UFO"],
    },
    "biotech": {
        "name": "Biotech",
        "etf": "XBI",
        "icon": "dna",
        "description": "Gene therapy, oncology, rare disease, immunology, mRNA",
        "sub_industries": ["Large-Cap Pharma/Bio", "Clinical-Stage", "Gene Therapy", "Oncology", "mRNA/Vaccines"],
        "key_stocks": ["AMGN", "GILD", "VRTX", "REGN", "MRNA", "BIIB", "ILMN", "SGEN", "ALNY", "BMRN", "EXAS", "RARE"],
        "related_etfs": ["IBB", "ARKG", "BBH", "LABU"],
    },
}

SECTOR_ORDER = [
    "technology", "semiconductors", "financials", "healthcare", "biotech",
    "oil_gas", "real_estate", "consumer_discretionary", "industrials",
    "defense_aerospace", "consumer_staples", "communication_services",
    "utilities", "materials", "clean_energy",
]

# Return windows (same as sector_rotation for consistency).
WINDOWS = [
    {"key": "1d",  "label": "1D",  "days": 1},
    {"key": "1w",  "label": "1W",  "days": 5},
    {"key": "1m",  "label": "1M",  "days": 21},
    {"key": "3m",  "label": "3M",  "days": 63},
    {"key": "6m",  "label": "6M",  "days": 126},
    {"key": "1y",  "label": "1Y",  "days": 252},
]


def _load_closes(symbol: str, lookback: int) -> list[tuple]:
    """Pull (date, close) from yfinance via the cached fetcher."""
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
    """Pull key fundamentals from yfinance .info (cached by yfinance internally)."""
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
            "beta": info.get("beta"),
            "fifty_two_week_high": info.get("fiftyTwoWeekHigh"),
            "fifty_two_week_low": info.get("fiftyTwoWeekLow"),
            "avg_volume": info.get("averageVolume"),
            "sector": info.get("sector"),
            "industry": info.get("industry"),
        }
    except Exception as e:
        log.warning("yfinance info for %s failed: %s", symbol, e)
        return {"symbol": symbol, "name": symbol}


def _compute_stock_row(symbol: str, max_lookback: int, spy_returns: dict) -> dict:
    """Build a complete stock row: price returns + fundamentals."""
    closes = _load_closes(symbol, max_lookback)
    last_close = closes[-1][1] if closes else None
    last_date = closes[-1][0] if closes else None

    returns = {}
    for w in WINDOWS:
        r_abs = _return_pct(closes, w["days"])
        spy_r = spy_returns.get(w["key"])
        r_rel = (r_abs - spy_r) if (r_abs is not None and spy_r is not None) else None
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
        "beta": info.get("beta"),
        "fifty_two_week_high": info.get("fifty_two_week_high"),
        "fifty_two_week_low": info.get("fifty_two_week_low"),
        "avg_volume": info.get("avg_volume"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }


def list_sectors() -> list[dict]:
    """Return the full sector catalog for sidebar rendering."""
    result = []
    for sid in SECTOR_ORDER:
        sec = SECTORS[sid]
        result.append({
            "id": sid,
            "name": sec["name"],
            "etf": sec["etf"],
            "icon": sec["icon"],
            "description": sec["description"],
            "stock_count": len(sec["key_stocks"]),
        })
    return result


def sector_detail(sector_id: str) -> dict:
    """Full drill-down for one sector. Returns ETF performance, all key stocks
    with returns + fundamentals, sub-industries, and related ETFs."""
    if sector_id not in SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")

    sec = SECTORS[sector_id]
    max_lookback = max(w["days"] for w in WINDOWS)

    # SPY benchmark returns for relative calculations.
    spy_closes = _load_closes("SPY", max_lookback)
    spy_returns: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        spy_returns[w["key"]] = _return_pct(spy_closes, w["days"])

    # ETF returns.
    etf_closes = _load_closes(sec["etf"], max_lookback)
    etf_returns = {}
    for w in WINDOWS:
        r_abs = _return_pct(etf_closes, w["days"])
        spy_r = spy_returns.get(w["key"])
        r_rel = (r_abs - spy_r) if (r_abs is not None and spy_r is not None) else None
        etf_returns[w["key"]] = {"abs": r_abs, "rel": r_rel}

    etf_last = etf_closes[-1][1] if etf_closes else None
    etf_info = _stock_info(sec["etf"])

    # Key stocks -- fetch in parallel for speed.
    stocks = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {
            pool.submit(_compute_stock_row, sym, max_lookback, spy_returns): sym
            for sym in sec["key_stocks"]
        }
        for future in as_completed(futures):
            try:
                stocks.append(future.result())
            except Exception as e:
                sym = futures[future]
                log.warning("Failed to compute row for %s: %s", sym, e)
                stocks.append({"symbol": sym, "name": sym, "returns": {}, "last_close": None})

    # Sort by market cap descending (largest first), nulls last.
    stocks.sort(key=lambda s: s.get("market_cap") or 0, reverse=True)

    # Related ETFs -- just returns, no fundamentals.
    related = []
    for retf in sec.get("related_etfs", []):
        closes = _load_closes(retf, max_lookback)
        rets = {}
        for w in WINDOWS:
            r_abs = _return_pct(closes, w["days"])
            spy_r = spy_returns.get(w["key"])
            r_rel = (r_abs - spy_r) if (r_abs is not None and spy_r is not None) else None
            rets[w["key"]] = {"abs": r_abs, "rel": r_rel}
        related.append({
            "ticker": retf,
            "last_close": float(closes[-1][1]) if closes else None,
            "returns": rets,
        })

    return {
        "sector_id": sector_id,
        "name": sec["name"],
        "description": sec["description"],
        "icon": sec["icon"],
        "sub_industries": sec["sub_industries"],
        "windows": WINDOWS,
        "benchmark": {
            "ticker": "SPY",
            "returns": spy_returns,
        },
        "etf": {
            "ticker": sec["etf"],
            "name": etf_info.get("name", sec["etf"]),
            "last_close": float(etf_last) if etf_last is not None else None,
            "returns": etf_returns,
            "market_cap": etf_info.get("market_cap"),
        },
        "stocks": stocks,
        "related_etfs": related,
    }


def sector_overview() -> dict:
    """Quick overview of all sectors -- just ETF returns, no individual stocks.
    Used for the sidebar sector summary / heatmap."""
    max_lookback = max(w["days"] for w in WINDOWS)

    spy_closes = _load_closes("SPY", max_lookback)
    spy_returns: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        spy_returns[w["key"]] = _return_pct(spy_closes, w["days"])

    sectors = []
    for sid in SECTOR_ORDER:
        sec = SECTORS[sid]
        closes = _load_closes(sec["etf"], max_lookback)
        etf_returns = {}
        for w in WINDOWS:
            r_abs = _return_pct(closes, w["days"])
            spy_r = spy_returns.get(w["key"])
            r_rel = (r_abs - spy_r) if (r_abs is not None and spy_r is not None) else None
            etf_returns[w["key"]] = {"abs": r_abs, "rel": r_rel}

        sectors.append({
            "id": sid,
            "name": sec["name"],
            "etf": sec["etf"],
            "icon": sec["icon"],
            "last_close": float(closes[-1][1]) if closes else None,
            "returns": etf_returns,
        })

    return {
        "windows": WINDOWS,
        "benchmark": {"ticker": "SPY", "returns": spy_returns},
        "sectors": sectors,
    }
