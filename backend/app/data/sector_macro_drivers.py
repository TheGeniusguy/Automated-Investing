"""Macro correlation drivers per sector.

For each sector we define a curated list of macro series (FRED or yfinance)
that are economically meaningful drivers of that sector's returns.

Then we compute rolling 90-day Pearson correlation between:
  - sector ETF daily returns (from yfinance via the existing cache)
  - each macro driver's daily changes

FRED series require FRED_API_KEY. yfinance drivers work without any key.
If FRED is not configured, only yfinance-sourced drivers are returned.
"""
from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import macro_data
from ..config import settings

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 365  # fetch 1y of history to compute rolling corr

# ── Per-sector driver definitions ────────────────────────────────────────────
# Each driver: id, label, source ("fred"|"yfinance"), direction hint, desc.
# direction: "+" means higher driver -> higher sector (positive correlation expected)
#            "-" means higher driver -> lower sector (negative expected)

SECTOR_DRIVERS: dict[str, list[dict]] = {
    "technology": [
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Higher rates compress growth multiples"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk-off hurts high-beta tech"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Strong dollar reduces overseas revenue"},
        {"id": "DGS10",         "label": "10Y Real",     "source": "fred",     "direction": "-", "desc": "Real rates = biggest DCF headwind"},
        {"id": "BAMLH0A0HYM2",  "label": "HY Spread",   "source": "fred",     "direction": "-", "desc": "Credit risk-off = multiple compression"},
    ],
    "semiconductors": [
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Rate sensitivity via capex cycles"},
        {"id": "DTWEXBGS",      "label": "Trade-Wtd USD","source": "fred",     "direction": "-", "desc": "Export revenue FX sensitivity"},
        {"id": "INDPRO",        "label": "Industrial Prod","source": "fred",   "direction": "+", "desc": "Semi demand tracks global manufacturing"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk sentiment drives cycle stocks"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Asian revenue FX headwind"},
    ],
    "real_estate": [
        {"id": "DGS10",         "label": "10Y Treasury", "source": "fred",     "direction": "-", "desc": "Primary REIT discount rate"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Cap rate / REIT valuation"},
        {"id": "MORTGAGE30US",  "label": "30Y Mortgage", "source": "fred",     "direction": "-", "desc": "Housing demand / residential REITs"},
        {"id": "CPIAUCSL",      "label": "CPI",          "source": "fred",     "direction": "+", "desc": "Inflation lifts rents and NOI"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk-off pressure on REITs"},
    ],
    "oil_gas": [
        {"id": "CL=F",          "label": "WTI Crude",    "source": "yfinance", "direction": "+", "desc": "Primary revenue driver"},
        {"id": "NG=F",          "label": "Natural Gas",  "source": "yfinance", "direction": "+", "desc": "Gas E&P revenue"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Oil priced in USD — inverse relationship"},
        {"id": "DCOILWTICO",    "label": "WTI FRED",     "source": "fred",     "direction": "+", "desc": "Spot crude (FRED lagged)"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk-off reduces commodity demand"},
    ],
    "financials": [
        {"id": "DGS10",         "label": "10Y Treasury", "source": "fred",     "direction": "+", "desc": "Higher rates = wider NIM for banks"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "+", "desc": "NIM expansion with steeper curve"},
        {"id": "T10Y2Y",        "label": "Yield Curve",  "source": "fred",     "direction": "+", "desc": "Steeper curve = bank profitability"},
        {"id": "BAMLH0A0HYM2",  "label": "HY Spread",   "source": "fred",     "direction": "-", "desc": "Credit stress = loan loss provisioning"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Volatility hurts trading revenue"},
    ],
    "healthcare": [
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "+", "desc": "Defensive: outperforms in risk-off"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Rate sensitivity for biotech growth names"},
        {"id": "UNRATE",        "label": "Unemployment", "source": "fred",     "direction": "+", "desc": "Defensive demand is employment-insensitive"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "International pharma revenue FX"},
        {"id": "CPIAUCSL",      "label": "CPI",          "source": "fred",     "direction": "+", "desc": "Drug pricing tied to inflation debates"},
    ],
    "biotech": [
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Long-duration growth: biggest rate sensitivity"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk-off crushes speculative biotech"},
        {"id": "BAMLH0A0HYM2",  "label": "HY Spread",   "source": "fred",     "direction": "-", "desc": "Credit conditions affect biotech funding"},
        {"id": "DGS10",         "label": "10Y Real",     "source": "fred",     "direction": "-", "desc": "Real rates = DCF headwind for zero-revenue names"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Dollar strength reduces global M&A appeal"},
    ],
    "consumer_discretionary": [
        {"id": "UMCSENT",       "label": "Consumer Sent","source": "fred",     "direction": "+", "desc": "Discretionary demand tracks sentiment"},
        {"id": "UNRATE",        "label": "Unemployment", "source": "fred",     "direction": "-", "desc": "Jobs = consumer spending capacity"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Higher rates squeeze consumer credit"},
        {"id": "GASREGCOVW",    "label": "Gas Price",    "source": "fred",     "direction": "-", "desc": "Gas prices drain discretionary spending"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Risk-off = consumer caution"},
    ],
    "industrials": [
        {"id": "INDPRO",        "label": "Industrial Prod","source": "fred",   "direction": "+", "desc": "Core demand signal for industrials"},
        {"id": "NAPM",          "label": "ISM Mfg PMI",  "source": "fred",     "direction": "+", "desc": "Manufacturing activity = order book"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Export competitiveness"},
        {"id": "CL=F",          "label": "WTI Crude",    "source": "yfinance", "direction": "-", "desc": "Energy input cost"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Capex financing cost"},
    ],
    "consumer_staples": [
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "+", "desc": "Defensive: staples outperform in risk-off"},
        {"id": "UNRATE",        "label": "Unemployment", "source": "fred",     "direction": "+", "desc": "Staple demand is employment-insensitive"},
        {"id": "CPIAUCSL",      "label": "CPI",          "source": "fred",     "direction": "+", "desc": "Pricing power allows inflation pass-through"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "International revenue FX headwind"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Rate sensitivity compresses bond-proxy premium"},
    ],
    "utilities": [
        {"id": "DGS10",         "label": "10Y Treasury", "source": "fred",     "direction": "-", "desc": "Utilities = bond proxies; rates are primary driver"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Rate competitor for income investors"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "+", "desc": "Defensive: outperforms in risk-off"},
        {"id": "CPIAUCSL",      "label": "CPI",          "source": "fred",     "direction": "+", "desc": "Rate base + fuel cost inflation pass-through"},
        {"id": "NG=F",          "label": "Natural Gas",  "source": "yfinance", "direction": "-", "desc": "Fuel cost for gas-fired power generation"},
    ],
    "materials": [
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "-", "desc": "Commodities priced in USD — inverse"},
        {"id": "INDPRO",        "label": "Industrial Prod","source": "fred",   "direction": "+", "desc": "Materials demand tracks global output"},
        {"id": "CPIAUCSL",      "label": "CPI",          "source": "fred",     "direction": "+", "desc": "Commodity inflation boosts materials margins"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Capex financing cost"},
        {"id": "GC=F",          "label": "Gold",         "source": "yfinance", "direction": "+", "desc": "Precious metals segment proxy"},
    ],
    "communication_services": [
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Growth valuation rate sensitivity"},
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "-", "desc": "Ad revenue cyclicality in risk-off"},
        {"id": "UMCSENT",       "label": "Consumer Sent","source": "fred",     "direction": "+", "desc": "Ad spend tracks consumer confidence"},
        {"id": "UNRATE",        "label": "Unemployment", "source": "fred",     "direction": "-", "desc": "Employment drives ad market health"},
        {"id": "BAMLH0A0HYM2",  "label": "HY Spread",   "source": "fred",     "direction": "-", "desc": "Credit stress hits streaming/media M&A"},
    ],
    "clean_energy": [
        {"id": "DGS10",         "label": "10Y Treasury", "source": "fred",     "direction": "-", "desc": "Project financing cost — critical for solar/wind IRR"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Rate sensitivity of long-duration green assets"},
        {"id": "CL=F",          "label": "WTI Crude",    "source": "yfinance", "direction": "+", "desc": "Higher oil = better renewable energy economics"},
        {"id": "NG=F",          "label": "Natural Gas",  "source": "yfinance", "direction": "+", "desc": "Gas prices drive grid parity for solar/wind"},
        {"id": "BAMLH0A0HYM2",  "label": "HY Spread",   "source": "fred",     "direction": "-", "desc": "Project finance credit conditions"},
    ],
    "defense_aerospace": [
        {"id": "^VIX",          "label": "VIX",          "source": "yfinance", "direction": "+", "desc": "Geopolitical risk drives defense spending"},
        {"id": "^TNX",          "label": "10Y Yield",    "source": "yfinance", "direction": "-", "desc": "Debt financing cost for long programs"},
        {"id": "DX-Y.NYB",      "label": "DXY",          "source": "yfinance", "direction": "+", "desc": "Strong dollar boosts export contract value"},
        {"id": "INDPRO",        "label": "Industrial Prod","source": "fred",   "direction": "+", "desc": "Manufacturing capacity for defense output"},
        {"id": "CL=F",          "label": "WTI Crude",    "source": "yfinance", "direction": "+", "desc": "Energy security spending correlates with oil"},
    ],
}

DEFAULT_DRIVERS = [
    {"id": "^TNX",         "label": "10Y Yield",  "source": "yfinance", "direction": "-", "desc": "Interest rate benchmark"},
    {"id": "^VIX",         "label": "VIX",        "source": "yfinance", "direction": "-", "desc": "Market risk sentiment"},
    {"id": "DX-Y.NYB",     "label": "DXY",        "source": "yfinance", "direction": "-", "desc": "Dollar strength"},
]


# ── Correlation computation ───────────────────────────────────────────────────

def _pct_changes(points: list[dict]) -> dict[str, float]:
    """Convert {date, value} list to {date: pct_change} dict (daily returns)."""
    result: dict[str, float] = {}
    for i in range(1, len(points)):
        prev = points[i - 1].get("value")
        curr = points[i].get("value")
        if prev and curr and prev != 0:
            result[points[i]["date"]] = (curr - prev) / prev
    return result


def _pearson(xs: list[float], ys: list[float]) -> Optional[float]:
    """Pearson correlation for two aligned lists."""
    n = len(xs)
    if n < 10:
        return None
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den_x = math.sqrt(sum((x - mean_x) ** 2 for x in xs))
    den_y = math.sqrt(sum((y - mean_y) ** 2 for y in ys))
    if den_x == 0 or den_y == 0:
        return None
    return round(num / (den_x * den_y), 3)


def _fetch_driver_returns(driver: dict) -> tuple[str, dict[str, float]]:
    """Fetch a driver series and convert to daily returns dict."""
    series_id = driver["id"]
    source = driver["source"]
    try:
        if source == "yfinance":
            points = macro_data.fetch_arbitrary_ticker(series_id, days=LOOKBACK_DAYS)
        else:
            # FRED — use fetch_explicit for source-typed path
            points = macro_data.fetch_explicit(series_id, source="fred", days=LOOKBACK_DAYS)
        return series_id, _pct_changes(points)
    except Exception as exc:
        log.warning("Driver fetch %s failed: %s", series_id, exc)
        return series_id, {}


# ── Public API ────────────────────────────────────────────────────────────────

def sector_macro_drivers(sector_id: str, etf_ticker: str) -> dict:
    """Compute rolling 90-day correlations between sector ETF and macro drivers.

    Returns:
      {
        "sector_id": ...,
        "etf": ...,
        "lookback_days": 90,
        "drivers": [
          {
            "id": ..., "label": ..., "source": ..., "direction": ..., "desc": ...,
            "correlation": float|null,   # 90d rolling Pearson
            "available": bool,           # false if FRED key missing
          }
        ]
      }
    """
    drivers = SECTOR_DRIVERS.get(sector_id, DEFAULT_DRIVERS)

    # Filter FRED drivers if key not configured (no point fetching)
    active_drivers = [
        d for d in drivers
        if d["source"] == "yfinance" or settings.has_fred
    ]

    # Fetch ETF returns
    etf_points = macro_data.fetch_arbitrary_ticker(etf_ticker, days=LOOKBACK_DAYS)
    etf_returns = _pct_changes(etf_points)

    # Fetch all driver series in parallel
    driver_returns: dict[str, dict[str, float]] = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_driver_returns, d): d for d in active_drivers}
        for fut in as_completed(futures):
            series_id, returns = fut.result()
            driver_returns[series_id] = returns

    # Compute correlations
    result_drivers = []
    for driver in drivers:
        sid = driver["id"]
        is_fred = driver["source"] == "fred"
        if is_fred and not settings.has_fred:
            result_drivers.append({**driver, "correlation": None, "available": False})
            continue

        dr = driver_returns.get(sid, {})
        # Align dates
        common_dates = sorted(set(etf_returns.keys()) & set(dr.keys()))
        xs = [etf_returns[d] for d in common_dates]
        ys = [dr[d] for d in common_dates]
        corr = _pearson(xs, ys)

        result_drivers.append({
            **driver,
            "correlation": corr,
            "available": True,
            "n_obs": len(xs),
        })

    # Sort by absolute correlation descending (nulls last)
    result_drivers.sort(
        key=lambda x: abs(x["correlation"]) if x["correlation"] is not None else -1,
        reverse=True,
    )

    return {
        "sector_id":    sector_id,
        "etf":          etf_ticker,
        "lookback_days": LOOKBACK_DAYS,
        "fred_available": settings.has_fred,
        "drivers":      result_drivers,
    }
