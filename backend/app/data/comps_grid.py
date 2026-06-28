"""Relative Valuation Comps Grid engine (Bloomberg `RV` function equivalent).

Builds the iconic peer-multiples comparison screen: a target company plus an
auto-selected set of its closest comparables, each carried with the standard
valuation multiples (trailing / forward P/E, EV/EBITDA, EV/Revenue, P/B, P/S),
profitability and growth, and market cap. On top of the raw grid it computes the
PEER MEDIAN per metric and every company's premium / discount to that median, so
the target can be read as cheap (green) or rich (red) versus its peer set at a
glance.

Live path: yfinance `.Ticker(t).info` (every field guarded with .get + try/except,
the same pattern etf_tracking.py uses for metadata). When yfinance is unavailable
or too sparse we degrade to deterministic, md5-seeded SAMPLE multiples that are
realistic per name, and tag the payload data_mode="sample". This module never
raises - it always returns a populated payload tagged with data_mode / as_of /
source for honesty under the hood. Target row is always first.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

SOURCE_LIVE = "yfinance"
SOURCE_SAMPLE = "sample"

# Metrics carried per company (key -> human label). Order drives the grid columns.
METRICS = ["pe", "fwd_pe", "ev_ebitda", "ev_rev", "pb", "ps", "profit_margin", "rev_growth"]


# ---------------------------------------------------------------------------
# Curated peer map. ~35 well-known tickers -> their 4-7 closest comparables.
# Used to auto-select a peer set for any requested symbol.
# ---------------------------------------------------------------------------

PEER_MAP: dict[str, list[str]] = {
    # Mega-cap tech / internet
    "AAPL": ["MSFT", "GOOGL", "AMZN", "META"],
    "MSFT": ["AAPL", "GOOGL", "AMZN", "ORCL", "CRM"],
    "GOOGL": ["META", "MSFT", "AMZN", "AAPL", "NFLX"],
    "GOOG": ["META", "MSFT", "AMZN", "AAPL", "NFLX"],
    "META": ["GOOGL", "SNAP", "PINS", "MSFT", "NFLX"],
    "AMZN": ["MSFT", "GOOGL", "WMT", "AAPL", "EBAY"],
    "NFLX": ["DIS", "WBD", "PARA", "GOOGL", "META"],
    "NVDA": ["AMD", "AVGO", "INTC", "QCOM", "TSM"],
    "AMD": ["NVDA", "INTC", "AVGO", "QCOM", "MU"],
    "INTC": ["AMD", "NVDA", "QCOM", "TXN", "MU"],
    "AVGO": ["QCOM", "NVDA", "TXN", "AMD", "ADI"],
    "QCOM": ["AVGO", "NVDA", "AMD", "TXN", "MRVL"],
    "ORCL": ["MSFT", "SAP", "CRM", "IBM", "WDAY"],
    "CRM": ["MSFT", "ORCL", "ADBE", "NOW", "WDAY"],
    "ADBE": ["CRM", "MSFT", "NOW", "INTU", "ORCL"],
    "TSLA": ["GM", "F", "TM", "RIVN", "NIO"],
    # Financials
    "JPM": ["BAC", "WFC", "C", "GS", "MS"],
    "BAC": ["JPM", "WFC", "C", "USB", "PNC"],
    "WFC": ["JPM", "BAC", "C", "USB", "TFC"],
    "C": ["JPM", "BAC", "WFC", "GS", "MS"],
    "GS": ["MS", "JPM", "C", "BAC", "SCHW"],
    "MS": ["GS", "JPM", "C", "BAC", "SCHW"],
    "V": ["MA", "AXP", "PYPL", "DFS", "COF"],
    "MA": ["V", "AXP", "PYPL", "DFS", "COF"],
    "BRK-B": ["JPM", "BAC", "WFC", "AXP", "V"],
    # Healthcare / pharma
    "JNJ": ["PFE", "MRK", "ABBV", "LLY", "BMY"],
    "PFE": ["MRK", "JNJ", "ABBV", "BMY", "LLY"],
    "MRK": ["PFE", "JNJ", "ABBV", "BMY", "LLY"],
    "LLY": ["NVO", "MRK", "PFE", "ABBV", "JNJ"],
    "ABBV": ["MRK", "PFE", "BMY", "AMGN", "JNJ"],
    "UNH": ["ELV", "CI", "HUM", "CVS", "CNC"],
    # Energy
    "XOM": ["CVX", "COP", "SLB", "EOG", "OXY"],
    "CVX": ["XOM", "COP", "EOG", "OXY", "SLB"],
    "COP": ["XOM", "CVX", "EOG", "OXY", "DVN"],
    # Consumer staples / discretionary
    "KO": ["PEP", "MNST", "KDP", "CL", "PG"],
    "PEP": ["KO", "MNST", "KDP", "MDLZ", "CL"],
    "PG": ["CL", "KMB", "UL", "CHD", "KO"],
    "WMT": ["TGT", "COST", "KR", "AMZN", "DG"],
    "COST": ["WMT", "TGT", "BJ", "KR", "DG"],
    "MCD": ["SBUX", "YUM", "CMG", "QSR", "WEN"],
    "NKE": ["LULU", "UAA", "SKX", "DECK"],
    "DIS": ["NFLX", "WBD", "PARA", "CMCSA", "FOX"],
    # Industrials
    "BA": ["LMT", "RTX", "GD", "NOC", "GE"],
    "CAT": ["DE", "CMI", "PCAR", "HON", "EMR"],
    # Telecom
    "T": ["VZ", "TMUS", "CMCSA", "CHTR"],
    "VZ": ["T", "TMUS", "CMCSA", "CHTR"],
}

# Default fallback peer set when the symbol is not in the curated map.
DEFAULT_PEERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA"]


# ---------------------------------------------------------------------------
# SAMPLE multiples (clearly namespaced). Realistic per-name valuation profile.
# pe / fwd_pe / ev_ebitda / ev_rev / pb / ps are ratios; profit_margin and
# rev_growth are percent; market_cap is in raw dollars. Used both as the live
# fallback and to seed the deterministic synthetic generator.
# ---------------------------------------------------------------------------

SAMPLE_MULTIPLES: dict[str, dict] = {
    "AAPL": {"name": "Apple Inc.", "market_cap": 3_350_000_000_000, "pe": 33.1, "fwd_pe": 29.4, "ev_ebitda": 25.2, "ev_rev": 8.7, "pb": 52.6, "ps": 8.9, "profit_margin": 26.3, "rev_growth": 6.1},
    "MSFT": {"name": "Microsoft Corp.", "market_cap": 3_180_000_000_000, "pe": 36.4, "fwd_pe": 31.2, "ev_ebitda": 24.1, "ev_rev": 12.8, "pb": 11.3, "ps": 13.2, "profit_margin": 36.1, "rev_growth": 15.7},
    "GOOGL": {"name": "Alphabet Inc.", "market_cap": 2_180_000_000_000, "pe": 24.8, "fwd_pe": 21.3, "ev_ebitda": 16.4, "ev_rev": 6.3, "pb": 6.8, "ps": 6.6, "profit_margin": 28.6, "rev_growth": 13.4},
    "GOOG": {"name": "Alphabet Inc. Class C", "market_cap": 2_180_000_000_000, "pe": 24.9, "fwd_pe": 21.4, "ev_ebitda": 16.5, "ev_rev": 6.3, "pb": 6.8, "ps": 6.6, "profit_margin": 28.6, "rev_growth": 13.4},
    "META": {"name": "Meta Platforms Inc.", "market_cap": 1_480_000_000_000, "pe": 27.3, "fwd_pe": 23.1, "ev_ebitda": 17.2, "ev_rev": 9.1, "pb": 8.9, "ps": 9.4, "profit_margin": 35.2, "rev_growth": 21.6},
    "AMZN": {"name": "Amazon.com Inc.", "market_cap": 2_010_000_000_000, "pe": 41.7, "fwd_pe": 32.8, "ev_ebitda": 18.9, "ev_rev": 3.2, "pb": 7.4, "ps": 3.3, "profit_margin": 8.1, "rev_growth": 11.9},
    "NFLX": {"name": "Netflix Inc.", "market_cap": 410_000_000_000, "pe": 45.2, "fwd_pe": 36.1, "ev_ebitda": 32.4, "ev_rev": 9.8, "pb": 18.2, "ps": 10.1, "profit_margin": 22.4, "rev_growth": 14.8},
    "NVDA": {"name": "NVIDIA Corp.", "market_cap": 3_400_000_000_000, "pe": 52.6, "fwd_pe": 38.2, "ev_ebitda": 45.1, "ev_rev": 27.4, "pb": 48.3, "ps": 28.1, "profit_margin": 51.8, "rev_growth": 78.4},
    "AMD": {"name": "Advanced Micro Devices", "market_cap": 270_000_000_000, "pe": 102.4, "fwd_pe": 38.6, "ev_ebitda": 48.2, "ev_rev": 9.6, "pb": 4.1, "ps": 9.8, "profit_margin": 9.4, "rev_growth": 18.2},
    "INTC": {"name": "Intel Corp.", "market_cap": 95_000_000_000, "pe": 0.0, "fwd_pe": 28.4, "ev_ebitda": 11.2, "ev_rev": 2.4, "pb": 1.1, "ps": 1.8, "profit_margin": -3.2, "rev_growth": -2.1},
    "AVGO": {"name": "Broadcom Inc.", "market_cap": 820_000_000_000, "pe": 38.4, "fwd_pe": 28.7, "ev_ebitda": 26.3, "ev_rev": 16.1, "pb": 12.6, "ps": 16.4, "profit_margin": 24.6, "rev_growth": 34.2},
    "QCOM": {"name": "Qualcomm Inc.", "market_cap": 195_000_000_000, "pe": 17.8, "fwd_pe": 14.2, "ev_ebitda": 13.1, "ev_rev": 4.6, "pb": 6.9, "ps": 4.8, "profit_margin": 26.1, "rev_growth": 9.6},
    "TXN": {"name": "Texas Instruments", "market_cap": 185_000_000_000, "pe": 35.1, "fwd_pe": 30.4, "ev_ebitda": 23.8, "ev_rev": 11.2, "pb": 10.4, "ps": 11.5, "profit_margin": 31.2, "rev_growth": 2.8},
    "MU": {"name": "Micron Technology", "market_cap": 110_000_000_000, "pe": 24.1, "fwd_pe": 9.8, "ev_ebitda": 10.4, "ev_rev": 4.2, "pb": 2.6, "ps": 4.3, "profit_margin": 18.6, "rev_growth": 61.5},
    "MRVL": {"name": "Marvell Technology", "market_cap": 75_000_000_000, "pe": 0.0, "fwd_pe": 31.2, "ev_ebitda": 38.4, "ev_rev": 12.1, "pb": 4.8, "ps": 12.4, "profit_margin": -4.1, "rev_growth": 6.2},
    "ADI": {"name": "Analog Devices", "market_cap": 115_000_000_000, "pe": 64.2, "fwd_pe": 28.1, "ev_ebitda": 22.4, "ev_rev": 11.8, "pb": 3.1, "ps": 12.1, "profit_margin": 19.4, "rev_growth": -8.2},
    "TSM": {"name": "Taiwan Semiconductor", "market_cap": 980_000_000_000, "pe": 28.4, "fwd_pe": 22.1, "ev_ebitda": 14.2, "ev_rev": 9.4, "pb": 7.8, "ps": 9.6, "profit_margin": 40.5, "rev_growth": 33.1},
    "ORCL": {"name": "Oracle Corp.", "market_cap": 480_000_000_000, "pe": 42.1, "fwd_pe": 28.4, "ev_ebitda": 24.6, "ev_rev": 9.1, "pb": 38.2, "ps": 9.3, "profit_margin": 21.4, "rev_growth": 8.6},
    "CRM": {"name": "Salesforce Inc.", "market_cap": 310_000_000_000, "pe": 46.2, "fwd_pe": 28.1, "ev_ebitda": 24.1, "ev_rev": 8.2, "pb": 4.6, "ps": 8.4, "profit_margin": 18.2, "rev_growth": 9.1},
    "ADBE": {"name": "Adobe Inc.", "market_cap": 230_000_000_000, "pe": 38.4, "fwd_pe": 24.6, "ev_ebitda": 22.8, "ev_rev": 9.8, "pb": 13.4, "ps": 10.1, "profit_margin": 27.6, "rev_growth": 10.8},
    "NOW": {"name": "ServiceNow Inc.", "market_cap": 215_000_000_000, "pe": 142.0, "fwd_pe": 58.4, "ev_ebitda": 68.2, "ev_rev": 19.4, "pb": 22.1, "ps": 19.8, "profit_margin": 14.1, "rev_growth": 22.4},
    "WDAY": {"name": "Workday Inc.", "market_cap": 65_000_000_000, "pe": 38.1, "fwd_pe": 26.4, "ev_ebitda": 42.1, "ev_rev": 7.9, "pb": 6.8, "ps": 8.1, "profit_margin": 19.2, "rev_growth": 16.8},
    "INTU": {"name": "Intuit Inc.", "market_cap": 185_000_000_000, "pe": 58.4, "fwd_pe": 31.2, "ev_ebitda": 33.4, "ev_rev": 11.4, "pb": 9.1, "ps": 11.6, "profit_margin": 19.8, "rev_growth": 13.2},
    "SAP": {"name": "SAP SE", "market_cap": 280_000_000_000, "pe": 88.4, "fwd_pe": 38.2, "ev_ebitda": 28.1, "ev_rev": 7.6, "pb": 5.4, "ps": 7.8, "profit_margin": 9.1, "rev_growth": 10.2},
    "IBM": {"name": "IBM Corp.", "market_cap": 215_000_000_000, "pe": 28.1, "fwd_pe": 22.4, "ev_ebitda": 17.2, "ev_rev": 3.8, "pb": 8.4, "ps": 3.4, "profit_margin": 12.6, "rev_growth": 2.1},
    "SNAP": {"name": "Snap Inc.", "market_cap": 18_000_000_000, "pe": 0.0, "fwd_pe": 0.0, "ev_ebitda": 0.0, "ev_rev": 3.6, "pb": 6.2, "ps": 3.4, "profit_margin": -14.2, "rev_growth": 15.8},
    "PINS": {"name": "Pinterest Inc.", "market_cap": 24_000_000_000, "pe": 9.4, "fwd_pe": 18.2, "ev_ebitda": 24.1, "ev_rev": 6.1, "pb": 6.4, "ps": 6.3, "profit_margin": 64.2, "rev_growth": 18.6},
    "DIS": {"name": "Walt Disney Co.", "market_cap": 200_000_000_000, "pe": 38.1, "fwd_pe": 18.4, "ev_ebitda": 13.2, "ev_rev": 2.8, "pb": 1.9, "ps": 2.2, "profit_margin": 6.2, "rev_growth": 3.1},
    "WBD": {"name": "Warner Bros. Discovery", "market_cap": 28_000_000_000, "pe": 0.0, "fwd_pe": 22.1, "ev_ebitda": 7.4, "ev_rev": 1.6, "pb": 0.7, "ps": 0.7, "profit_margin": -28.4, "rev_growth": -4.6},
    "PARA": {"name": "Paramount Global", "market_cap": 9_000_000_000, "pe": 0.0, "fwd_pe": 11.2, "ev_ebitda": 9.1, "ev_rev": 0.9, "pb": 0.4, "ps": 0.3, "profit_margin": -2.1, "rev_growth": -1.2},
    "CMCSA": {"name": "Comcast Corp.", "market_cap": 165_000_000_000, "pe": 11.4, "fwd_pe": 9.8, "ev_ebitda": 6.8, "ev_rev": 2.1, "pb": 2.0, "ps": 1.3, "profit_margin": 12.1, "rev_growth": 1.4},
    "GM": {"name": "General Motors", "market_cap": 55_000_000_000, "pe": 6.1, "fwd_pe": 5.2, "ev_ebitda": 9.4, "ev_rev": 0.9, "pb": 0.9, "ps": 0.3, "profit_margin": 5.6, "rev_growth": 9.1},
    "F": {"name": "Ford Motor Co.", "market_cap": 48_000_000_000, "pe": 12.4, "fwd_pe": 7.1, "ev_ebitda": 12.1, "ev_rev": 1.1, "pb": 1.0, "ps": 0.3, "profit_margin": 3.1, "rev_growth": 4.2},
    "TM": {"name": "Toyota Motor Corp.", "market_cap": 280_000_000_000, "pe": 8.4, "fwd_pe": 9.1, "ev_ebitda": 10.2, "ev_rev": 1.0, "pb": 1.1, "ps": 0.9, "profit_margin": 10.2, "rev_growth": 4.6},
    "RIVN": {"name": "Rivian Automotive", "market_cap": 14_000_000_000, "pe": 0.0, "fwd_pe": 0.0, "ev_ebitda": 0.0, "ev_rev": 2.4, "pb": 1.8, "ps": 2.6, "profit_margin": -98.2, "rev_growth": 24.1},
    "NIO": {"name": "NIO Inc.", "market_cap": 11_000_000_000, "pe": 0.0, "fwd_pe": 0.0, "ev_ebitda": 0.0, "ev_rev": 1.2, "pb": 3.2, "ps": 1.4, "profit_margin": -32.1, "rev_growth": 18.4},
    "TSLA": {"name": "Tesla Inc.", "market_cap": 820_000_000_000, "pe": 74.2, "fwd_pe": 68.1, "ev_ebitda": 52.4, "ev_rev": 8.4, "pb": 12.1, "ps": 8.6, "profit_margin": 13.1, "rev_growth": 8.4},
    # Financials
    "JPM": {"name": "JPMorgan Chase & Co.", "market_cap": 680_000_000_000, "pe": 12.8, "fwd_pe": 13.4, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 2.1, "ps": 4.1, "profit_margin": 33.2, "rev_growth": 9.4},
    "BAC": {"name": "Bank of America Corp.", "market_cap": 320_000_000_000, "pe": 13.6, "fwd_pe": 11.2, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.2, "ps": 3.2, "profit_margin": 27.8, "rev_growth": 4.1},
    "WFC": {"name": "Wells Fargo & Co.", "market_cap": 215_000_000_000, "pe": 12.1, "fwd_pe": 11.4, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.3, "ps": 2.6, "profit_margin": 24.1, "rev_growth": 1.8},
    "C": {"name": "Citigroup Inc.", "market_cap": 130_000_000_000, "pe": 11.4, "fwd_pe": 9.1, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 0.7, "ps": 1.6, "profit_margin": 15.2, "rev_growth": 3.2},
    "GS": {"name": "Goldman Sachs Group", "market_cap": 165_000_000_000, "pe": 14.8, "fwd_pe": 12.6, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.7, "ps": 3.1, "profit_margin": 28.4, "rev_growth": 12.1},
    "MS": {"name": "Morgan Stanley", "market_cap": 195_000_000_000, "pe": 16.2, "fwd_pe": 14.1, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 2.2, "ps": 3.4, "profit_margin": 22.6, "rev_growth": 10.4},
    "USB": {"name": "U.S. Bancorp", "market_cap": 75_000_000_000, "pe": 13.2, "fwd_pe": 10.8, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.3, "ps": 2.8, "profit_margin": 21.4, "rev_growth": 2.1},
    "PNC": {"name": "PNC Financial Services", "market_cap": 78_000_000_000, "pe": 14.1, "fwd_pe": 12.1, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.4, "ps": 3.4, "profit_margin": 24.2, "rev_growth": 1.4},
    "TFC": {"name": "Truist Financial", "market_cap": 58_000_000_000, "pe": 12.6, "fwd_pe": 10.4, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.0, "ps": 2.6, "profit_margin": 20.1, "rev_growth": -1.2},
    "SCHW": {"name": "Charles Schwab Corp.", "market_cap": 130_000_000_000, "pe": 24.1, "fwd_pe": 18.2, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 3.1, "ps": 6.4, "profit_margin": 28.1, "rev_growth": 6.2},
    "V": {"name": "Visa Inc.", "market_cap": 580_000_000_000, "pe": 31.2, "fwd_pe": 27.4, "ev_ebitda": 26.1, "ev_rev": 16.2, "pb": 14.1, "ps": 16.8, "profit_margin": 53.2, "rev_growth": 10.1},
    "MA": {"name": "Mastercard Inc.", "market_cap": 460_000_000_000, "pe": 37.4, "fwd_pe": 31.1, "ev_ebitda": 29.4, "ev_rev": 17.1, "pb": 58.2, "ps": 17.4, "profit_margin": 45.1, "rev_growth": 11.8},
    "AXP": {"name": "American Express Co.", "market_cap": 195_000_000_000, "pe": 19.4, "fwd_pe": 17.2, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 6.1, "ps": 3.1, "profit_margin": 16.4, "rev_growth": 9.1},
    "PYPL": {"name": "PayPal Holdings", "market_cap": 78_000_000_000, "pe": 17.1, "fwd_pe": 14.2, "ev_ebitda": 12.4, "ev_rev": 2.4, "pb": 3.8, "ps": 2.5, "profit_margin": 14.1, "rev_growth": 7.2},
    "DFS": {"name": "Discover Financial", "market_cap": 42_000_000_000, "pe": 13.1, "fwd_pe": 11.4, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 2.4, "ps": 2.6, "profit_margin": 18.2, "rev_growth": 8.1},
    "COF": {"name": "Capital One Financial", "market_cap": 68_000_000_000, "pe": 14.2, "fwd_pe": 10.1, "ev_ebitda": 0.0, "ev_rev": 0.0, "pb": 1.1, "ps": 1.8, "profit_margin": 14.6, "rev_growth": 6.4},
    "BRK-B": {"name": "Berkshire Hathaway", "market_cap": 1_010_000_000_000, "pe": 13.4, "fwd_pe": 22.1, "ev_ebitda": 11.2, "ev_rev": 2.6, "pb": 1.6, "ps": 2.6, "profit_margin": 22.4, "rev_growth": 3.8},
    # Healthcare
    "JNJ": {"name": "Johnson & Johnson", "market_cap": 380_000_000_000, "pe": 22.1, "fwd_pe": 15.2, "ev_ebitda": 14.1, "ev_rev": 4.4, "pb": 5.4, "ps": 4.6, "profit_margin": 21.2, "rev_growth": 4.1},
    "PFE": {"name": "Pfizer Inc.", "market_cap": 145_000_000_000, "pe": 16.4, "fwd_pe": 9.4, "ev_ebitda": 9.1, "ev_rev": 2.4, "pb": 1.6, "ps": 2.3, "profit_margin": 14.2, "rev_growth": 6.2},
    "MRK": {"name": "Merck & Co.", "market_cap": 245_000_000_000, "pe": 18.6, "fwd_pe": 13.1, "ev_ebitda": 12.4, "ev_rev": 3.8, "pb": 5.8, "ps": 3.9, "profit_margin": 21.4, "rev_growth": 7.1},
    "LLY": {"name": "Eli Lilly and Co.", "market_cap": 780_000_000_000, "pe": 78.4, "fwd_pe": 42.1, "ev_ebitda": 48.2, "ev_rev": 18.4, "pb": 48.1, "ps": 18.6, "profit_margin": 24.1, "rev_growth": 32.1},
    "ABBV": {"name": "AbbVie Inc.", "market_cap": 320_000_000_000, "pe": 58.1, "fwd_pe": 16.2, "ev_ebitda": 16.4, "ev_rev": 6.1, "pb": 58.2, "ps": 5.8, "profit_margin": 10.4, "rev_growth": 3.8},
    "BMY": {"name": "Bristol-Myers Squibb", "market_cap": 105_000_000_000, "pe": 0.0, "fwd_pe": 7.8, "ev_ebitda": 9.1, "ev_rev": 2.6, "pb": 4.8, "ps": 2.3, "profit_margin": -18.2, "rev_growth": 6.4},
    "AMGN": {"name": "Amgen Inc.", "market_cap": 150_000_000_000, "pe": 32.1, "fwd_pe": 13.8, "ev_ebitda": 14.2, "ev_rev": 6.1, "pb": 24.1, "ps": 4.6, "profit_margin": 14.8, "rev_growth": 12.1},
    "NVO": {"name": "Novo Nordisk", "market_cap": 480_000_000_000, "pe": 32.4, "fwd_pe": 24.1, "ev_ebitda": 22.1, "ev_rev": 11.2, "pb": 26.4, "ps": 11.4, "profit_margin": 34.6, "rev_growth": 25.4},
    "UNH": {"name": "UnitedHealth Group", "market_cap": 520_000_000_000, "pe": 28.4, "fwd_pe": 16.1, "ev_ebitda": 13.4, "ev_rev": 1.4, "pb": 4.8, "ps": 1.3, "profit_margin": 6.1, "rev_growth": 8.2},
    "ELV": {"name": "Elevance Health", "market_cap": 95_000_000_000, "pe": 16.4, "fwd_pe": 11.2, "ev_ebitda": 9.8, "ev_rev": 0.6, "pb": 2.4, "ps": 0.5, "profit_margin": 3.6, "rev_growth": 4.1},
    "CI": {"name": "The Cigna Group", "market_cap": 88_000_000_000, "pe": 18.2, "fwd_pe": 9.4, "ev_ebitda": 9.1, "ev_rev": 0.4, "pb": 1.9, "ps": 0.4, "profit_margin": 2.1, "rev_growth": 25.1},
    "HUM": {"name": "Humana Inc.", "market_cap": 32_000_000_000, "pe": 22.1, "fwd_pe": 13.4, "ev_ebitda": 11.1, "ev_rev": 0.3, "pb": 2.1, "ps": 0.3, "profit_margin": 1.4, "rev_growth": 9.4},
    "CVS": {"name": "CVS Health Corp.", "market_cap": 78_000_000_000, "pe": 16.1, "fwd_pe": 9.8, "ev_ebitda": 8.4, "ev_rev": 0.3, "pb": 1.1, "ps": 0.2, "profit_margin": 1.8, "rev_growth": 7.2},
    "CNC": {"name": "Centene Corp.", "market_cap": 32_000_000_000, "pe": 11.4, "fwd_pe": 9.1, "ev_ebitda": 7.8, "ev_rev": 0.2, "pb": 1.1, "ps": 0.2, "profit_margin": 1.9, "rev_growth": 5.1},
    # Energy
    "XOM": {"name": "Exxon Mobil Corp.", "market_cap": 480_000_000_000, "pe": 14.2, "fwd_pe": 12.4, "ev_ebitda": 7.1, "ev_rev": 1.4, "pb": 2.1, "ps": 1.4, "profit_margin": 9.8, "rev_growth": 2.1},
    "CVX": {"name": "Chevron Corp.", "market_cap": 280_000_000_000, "pe": 15.1, "fwd_pe": 13.1, "ev_ebitda": 7.4, "ev_rev": 1.6, "pb": 1.8, "ps": 1.6, "profit_margin": 9.1, "rev_growth": 1.2},
    "COP": {"name": "ConocoPhillips", "market_cap": 130_000_000_000, "pe": 12.4, "fwd_pe": 11.2, "ev_ebitda": 6.1, "ev_rev": 2.4, "pb": 2.6, "ps": 2.3, "profit_margin": 17.4, "rev_growth": 4.1},
    "SLB": {"name": "Schlumberger NV", "market_cap": 62_000_000_000, "pe": 13.1, "fwd_pe": 10.4, "ev_ebitda": 8.4, "ev_rev": 2.0, "pb": 3.4, "ps": 1.9, "profit_margin": 13.1, "rev_growth": 9.8},
    "EOG": {"name": "EOG Resources", "market_cap": 70_000_000_000, "pe": 10.8, "fwd_pe": 9.8, "ev_ebitda": 5.4, "ev_rev": 2.8, "pb": 2.4, "ps": 2.9, "profit_margin": 27.1, "rev_growth": 3.1},
    "OXY": {"name": "Occidental Petroleum", "market_cap": 52_000_000_000, "pe": 16.4, "fwd_pe": 13.1, "ev_ebitda": 5.8, "ev_rev": 2.4, "pb": 1.9, "ps": 1.9, "profit_margin": 12.4, "rev_growth": -2.1},
    "DVN": {"name": "Devon Energy Corp.", "market_cap": 28_000_000_000, "pe": 8.4, "fwd_pe": 8.1, "ev_ebitda": 4.6, "ev_rev": 2.1, "pb": 2.1, "ps": 1.9, "profit_margin": 22.1, "rev_growth": 4.6},
    # Staples / discretionary
    "KO": {"name": "Coca-Cola Co.", "market_cap": 280_000_000_000, "pe": 26.1, "fwd_pe": 22.4, "ev_ebitda": 19.4, "ev_rev": 6.4, "pb": 11.2, "ps": 6.1, "profit_margin": 23.4, "rev_growth": 3.1},
    "PEP": {"name": "PepsiCo Inc.", "market_cap": 220_000_000_000, "pe": 22.4, "fwd_pe": 18.1, "ev_ebitda": 15.2, "ev_rev": 2.6, "pb": 11.4, "ps": 2.4, "profit_margin": 10.4, "rev_growth": 2.4},
    "MNST": {"name": "Monster Beverage", "market_cap": 52_000_000_000, "pe": 31.2, "fwd_pe": 26.1, "ev_ebitda": 22.1, "ev_rev": 7.1, "pb": 6.4, "ps": 7.2, "profit_margin": 22.8, "rev_growth": 8.1},
    "KDP": {"name": "Keurig Dr Pepper", "market_cap": 48_000_000_000, "pe": 20.1, "fwd_pe": 16.2, "ev_ebitda": 14.1, "ev_rev": 3.4, "pb": 1.9, "ps": 3.2, "profit_margin": 14.1, "rev_growth": 3.4},
    "MDLZ": {"name": "Mondelez International", "market_cap": 88_000_000_000, "pe": 21.4, "fwd_pe": 18.4, "ev_ebitda": 15.1, "ev_rev": 3.1, "pb": 3.1, "ps": 2.6, "profit_margin": 12.4, "rev_growth": 1.4},
    "CL": {"name": "Colgate-Palmolive", "market_cap": 78_000_000_000, "pe": 26.4, "fwd_pe": 23.1, "ev_ebitda": 17.4, "ev_rev": 3.8, "pb": 0.0, "ps": 3.9, "profit_margin": 14.8, "rev_growth": 3.1},
    "PG": {"name": "Procter & Gamble", "market_cap": 380_000_000_000, "pe": 26.8, "fwd_pe": 22.4, "ev_ebitda": 18.1, "ev_rev": 4.6, "pb": 7.8, "ps": 4.6, "profit_margin": 18.4, "rev_growth": 2.1},
    "KMB": {"name": "Kimberly-Clark Corp.", "market_cap": 45_000_000_000, "pe": 18.4, "fwd_pe": 17.1, "ev_ebitda": 12.4, "ev_rev": 2.2, "pb": 32.1, "ps": 2.3, "profit_margin": 12.1, "rev_growth": 1.1},
    "CHD": {"name": "Church & Dwight", "market_cap": 24_000_000_000, "pe": 28.1, "fwd_pe": 25.4, "ev_ebitda": 19.1, "ev_rev": 3.8, "pb": 4.6, "ps": 3.9, "profit_margin": 13.8, "rev_growth": 3.4},
    "UL": {"name": "Unilever PLC", "market_cap": 145_000_000_000, "pe": 21.4, "fwd_pe": 17.8, "ev_ebitda": 14.1, "ev_rev": 2.4, "pb": 7.1, "ps": 2.3, "profit_margin": 11.1, "rev_growth": 1.8},
    "WMT": {"name": "Walmart Inc.", "market_cap": 580_000_000_000, "pe": 38.1, "fwd_pe": 31.4, "ev_ebitda": 18.4, "ev_rev": 0.9, "pb": 8.4, "ps": 0.9, "profit_margin": 2.6, "rev_growth": 5.1},
    "TGT": {"name": "Target Corp.", "market_cap": 62_000_000_000, "pe": 14.1, "fwd_pe": 13.2, "ev_ebitda": 7.8, "ev_rev": 0.6, "pb": 4.1, "ps": 0.6, "profit_margin": 4.1, "rev_growth": 1.1},
    "COST": {"name": "Costco Wholesale", "market_cap": 410_000_000_000, "pe": 52.4, "fwd_pe": 46.1, "ev_ebitda": 28.4, "ev_rev": 1.6, "pb": 16.2, "ps": 1.6, "profit_margin": 2.9, "rev_growth": 6.4},
    "KR": {"name": "The Kroger Co.", "market_cap": 42_000_000_000, "pe": 16.1, "fwd_pe": 12.4, "ev_ebitda": 6.8, "ev_rev": 0.3, "pb": 3.6, "ps": 0.3, "profit_margin": 1.8, "rev_growth": 1.2},
    "DG": {"name": "Dollar General Corp.", "market_cap": 28_000_000_000, "pe": 14.2, "fwd_pe": 16.1, "ev_ebitda": 9.4, "ev_rev": 0.9, "pb": 3.1, "ps": 0.7, "profit_margin": 4.1, "rev_growth": 4.8},
    "BJ": {"name": "BJ's Wholesale Club", "market_cap": 12_000_000_000, "pe": 22.1, "fwd_pe": 20.4, "ev_ebitda": 11.4, "ev_rev": 0.6, "pb": 7.1, "ps": 0.6, "profit_margin": 2.6, "rev_growth": 4.6},
    "MCD": {"name": "McDonald's Corp.", "market_cap": 215_000_000_000, "pe": 26.1, "fwd_pe": 22.4, "ev_ebitda": 17.4, "ev_rev": 8.4, "pb": 0.0, "ps": 8.6, "profit_margin": 32.1, "rev_growth": 2.1},
    "SBUX": {"name": "Starbucks Corp.", "market_cap": 105_000_000_000, "pe": 26.4, "fwd_pe": 24.1, "ev_ebitda": 16.1, "ev_rev": 3.4, "pb": 0.0, "ps": 3.1, "profit_margin": 11.4, "rev_growth": 0.6},
    "YUM": {"name": "Yum! Brands Inc.", "market_cap": 38_000_000_000, "pe": 24.1, "fwd_pe": 21.4, "ev_ebitda": 18.4, "ev_rev": 5.8, "pb": 0.0, "ps": 5.6, "profit_margin": 23.1, "rev_growth": 6.4},
    "CMG": {"name": "Chipotle Mexican Grill", "market_cap": 78_000_000_000, "pe": 48.1, "fwd_pe": 38.4, "ev_ebitda": 32.1, "ev_rev": 6.8, "pb": 18.4, "ps": 6.9, "profit_margin": 13.8, "rev_growth": 14.1},
    "QSR": {"name": "Restaurant Brands Intl", "market_cap": 32_000_000_000, "pe": 18.1, "fwd_pe": 16.4, "ev_ebitda": 15.1, "ev_rev": 4.6, "pb": 6.1, "ps": 3.6, "profit_margin": 18.4, "rev_growth": 12.1},
    "WEN": {"name": "Wendy's Co.", "market_cap": 3_400_000_000, "pe": 16.4, "fwd_pe": 14.1, "ev_ebitda": 12.1, "ev_rev": 2.4, "pb": 4.1, "ps": 1.6, "profit_margin": 9.8, "rev_growth": 1.4},
    "LULU": {"name": "Lululemon Athletica", "market_cap": 38_000_000_000, "pe": 18.4, "fwd_pe": 16.1, "ev_ebitda": 11.4, "ev_rev": 3.1, "pb": 6.8, "ps": 3.2, "profit_margin": 17.1, "rev_growth": 9.4},
    "UAA": {"name": "Under Armour Inc.", "market_cap": 3_200_000_000, "pe": 0.0, "fwd_pe": 18.4, "ev_ebitda": 9.1, "ev_rev": 0.6, "pb": 1.4, "ps": 0.6, "profit_margin": -1.2, "rev_growth": -3.4},
    "SKX": {"name": "Skechers U.S.A.", "market_cap": 10_000_000_000, "pe": 14.1, "fwd_pe": 12.4, "ev_ebitda": 9.4, "ev_rev": 1.1, "pb": 2.1, "ps": 1.1, "profit_margin": 7.8, "rev_growth": 11.4},
    "DECK": {"name": "Deckers Outdoor", "market_cap": 22_000_000_000, "pe": 24.1, "fwd_pe": 21.1, "ev_ebitda": 16.4, "ev_rev": 4.1, "pb": 8.4, "ps": 4.2, "profit_margin": 17.4, "rev_growth": 18.1},
    "NKE": {"name": "Nike Inc.", "market_cap": 110_000_000_000, "pe": 22.4, "fwd_pe": 28.1, "ev_ebitda": 17.1, "ev_rev": 2.2, "pb": 7.8, "ps": 2.1, "profit_margin": 9.8, "rev_growth": -9.1},
    "EBAY": {"name": "eBay Inc.", "market_cap": 32_000_000_000, "pe": 16.1, "fwd_pe": 13.4, "ev_ebitda": 11.4, "ev_rev": 3.1, "pb": 4.6, "ps": 3.0, "profit_margin": 18.4, "rev_growth": 2.1},
    # Industrials
    "BA": {"name": "Boeing Co.", "market_cap": 130_000_000_000, "pe": 0.0, "fwd_pe": 42.1, "ev_ebitda": 0.0, "ev_rev": 2.1, "pb": 0.0, "ps": 1.9, "profit_margin": -11.2, "rev_growth": -8.1},
    "LMT": {"name": "Lockheed Martin", "market_cap": 110_000_000_000, "pe": 18.4, "fwd_pe": 16.1, "ev_ebitda": 12.4, "ev_rev": 1.8, "pb": 18.1, "ps": 1.6, "profit_margin": 8.6, "rev_growth": 5.1},
    "RTX": {"name": "RTX Corp.", "market_cap": 165_000_000_000, "pe": 38.1, "fwd_pe": 22.4, "ev_ebitda": 16.1, "ev_rev": 2.4, "pb": 2.8, "ps": 2.1, "profit_margin": 5.6, "rev_growth": 8.4},
    "GD": {"name": "General Dynamics", "market_cap": 78_000_000_000, "pe": 22.1, "fwd_pe": 19.4, "ev_ebitda": 15.4, "ev_rev": 1.8, "pb": 3.8, "ps": 1.6, "profit_margin": 7.8, "rev_growth": 12.1},
    "NOC": {"name": "Northrop Grumman", "market_cap": 72_000_000_000, "pe": 18.1, "fwd_pe": 18.4, "ev_ebitda": 14.1, "ev_rev": 1.8, "pb": 4.6, "ps": 1.8, "profit_margin": 9.8, "rev_growth": 5.4},
    "GE": {"name": "GE Aerospace", "market_cap": 215_000_000_000, "pe": 38.4, "fwd_pe": 38.1, "ev_ebitda": 28.1, "ev_rev": 5.6, "pb": 9.4, "ps": 5.4, "profit_margin": 16.4, "rev_growth": 9.1},
    "DE": {"name": "Deere & Co.", "market_cap": 115_000_000_000, "pe": 18.4, "fwd_pe": 20.1, "ev_ebitda": 16.1, "ev_rev": 3.4, "pb": 6.1, "ps": 2.4, "profit_margin": 14.1, "rev_growth": -8.4},
    "CMI": {"name": "Cummins Inc.", "market_cap": 45_000_000_000, "pe": 22.1, "fwd_pe": 16.4, "ev_ebitda": 13.4, "ev_rev": 1.4, "pb": 4.8, "ps": 1.4, "profit_margin": 6.4, "rev_growth": 1.1},
    "PCAR": {"name": "PACCAR Inc.", "market_cap": 52_000_000_000, "pe": 13.4, "fwd_pe": 14.1, "ev_ebitda": 9.8, "ev_rev": 1.4, "pb": 3.1, "ps": 1.4, "profit_margin": 11.4, "rev_growth": -4.1},
    "HON": {"name": "Honeywell International", "market_cap": 145_000_000_000, "pe": 24.1, "fwd_pe": 20.4, "ev_ebitda": 16.4, "ev_rev": 3.8, "pb": 7.1, "ps": 3.8, "profit_margin": 15.8, "rev_growth": 4.1},
    "EMR": {"name": "Emerson Electric", "market_cap": 72_000_000_000, "pe": 32.1, "fwd_pe": 20.1, "ev_ebitda": 16.1, "ev_rev": 4.1, "pb": 2.4, "ps": 4.2, "profit_margin": 13.1, "rev_growth": 8.4},
    "CAT": {"name": "Caterpillar Inc.", "market_cap": 175_000_000_000, "pe": 16.4, "fwd_pe": 18.1, "ev_ebitda": 12.1, "ev_rev": 3.1, "pb": 9.4, "ps": 2.8, "profit_margin": 16.4, "rev_growth": -3.4},
    # Telecom
    "T": {"name": "AT&T Inc.", "market_cap": 165_000_000_000, "pe": 18.4, "fwd_pe": 11.1, "ev_ebitda": 7.1, "ev_rev": 2.4, "pb": 1.6, "ps": 1.4, "profit_margin": 8.4, "rev_growth": 1.4},
    "VZ": {"name": "Verizon Communications", "market_cap": 180_000_000_000, "pe": 10.1, "fwd_pe": 9.1, "ev_ebitda": 7.4, "ev_rev": 2.4, "pb": 1.8, "ps": 1.3, "profit_margin": 12.8, "rev_growth": 0.6},
    "TMUS": {"name": "T-Mobile US Inc.", "market_cap": 250_000_000_000, "pe": 24.1, "fwd_pe": 18.4, "ev_ebitda": 9.8, "ev_rev": 3.4, "pb": 4.1, "ps": 3.1, "profit_margin": 13.4, "rev_growth": 4.8},
    "CHTR": {"name": "Charter Communications", "market_cap": 52_000_000_000, "pe": 8.4, "fwd_pe": 7.8, "ev_ebitda": 6.4, "ev_rev": 2.1, "pb": 2.6, "ps": 0.9, "profit_margin": 11.1, "rev_growth": 0.4},
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _jitter(symbol: str, metric: str, base: float, spread: float = 0.18) -> float:
    """Deterministic +/- jitter around a base value, seeded per (symbol, metric)
    so synthetic multiples are stable across calls but vary realistically."""
    h = _seed(f"{symbol}:{metric}")
    frac = (h % 1000) / 1000.0  # 0..1
    factor = 1.0 + (frac - 0.5) * 2.0 * spread  # 1 +/- spread
    return round(base * factor, 2)


def _name_for(symbol: str) -> str:
    s = SAMPLE_MULTIPLES.get(symbol)
    if s and s.get("name"):
        return s["name"]
    return symbol


def _peers_for(symbol: str) -> tuple[list[str], bool]:
    """Return (peer_tickers, used_default). Peers exclude the target itself."""
    peers = PEER_MAP.get(symbol)
    used_default = False
    if not peers:
        peers = list(DEFAULT_PEERS)
        used_default = True
    # de-dupe, drop the target, keep order, cap at 7
    out: list[str] = []
    for p in peers:
        pu = p.strip().upper()
        if pu and pu != symbol and pu not in out:
            out.append(pu)
    return out[:7], used_default


# ---------------------------------------------------------------------------
# Sample multiples (deterministic synthesis for unknown names)
# ---------------------------------------------------------------------------

def _sample_row(symbol: str, is_target: bool) -> dict:
    """A fully populated comps row for `symbol`, from the curated table when
    available, otherwise deterministically synthesized so it looks realistic."""
    base = SAMPLE_MULTIPLES.get(symbol)
    if base is None:
        # Synthesize a plausible large/mid-cap profile, seeded by ticker.
        mc_base = 30_000_000_000 + (_seed(symbol) % 400) * 1_000_000_000
        base = {
            "name": symbol,
            "market_cap": mc_base,
            "pe": _jitter(symbol, "pe", 22.0, 0.45),
            "fwd_pe": _jitter(symbol, "fwd_pe", 18.0, 0.4),
            "ev_ebitda": _jitter(symbol, "ev_ebitda", 14.0, 0.4),
            "ev_rev": _jitter(symbol, "ev_rev", 4.0, 0.5),
            "pb": _jitter(symbol, "pb", 4.5, 0.6),
            "ps": _jitter(symbol, "ps", 3.8, 0.5),
            "profit_margin": _jitter(symbol, "margin", 14.0, 0.5),
            "rev_growth": _jitter(symbol, "growth", 8.0, 0.8),
        }
    return {
        "symbol": symbol,
        "name": base.get("name", symbol),
        "market_cap": base.get("market_cap"),
        "pe": _clean_ratio(base.get("pe")),
        "fwd_pe": _clean_ratio(base.get("fwd_pe")),
        "ev_ebitda": _clean_ratio(base.get("ev_ebitda")),
        "ev_rev": _clean_ratio(base.get("ev_rev")),
        "pb": _clean_ratio(base.get("pb")),
        "ps": _clean_ratio(base.get("ps")),
        "profit_margin": _round(base.get("profit_margin")),
        "rev_growth": _round(base.get("rev_growth")),
        "is_target": is_target,
    }


# ---------------------------------------------------------------------------
# Live multiples via yfinance .info (guarded; never raises)
# ---------------------------------------------------------------------------

def _round(v) -> float | None:
    try:
        if v is None:
            return None
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def _clean_ratio(v) -> float | None:
    """Ratios <= 0 or absurd are treated as N/M (not meaningful) -> None, except
    we keep them out of the median. A 0.0 in the sample table means N/M."""
    r = _round(v)
    if r is None:
        return None
    if r <= 0:
        return None
    if r > 1000:  # implausible multiple, treat as N/M
        return None
    return r


def _live_row(symbol: str, is_target: bool) -> dict | None:
    """Best-effort yfinance multiples. Returns a populated row dict or None if
    yfinance is unavailable / too sparse. Never raises."""
    try:
        import yfinance as yf
    except Exception:
        return None
    try:
        t = yf.Ticker(symbol)
        info = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}
        if not info:
            return None

        name = info.get("longName") or info.get("shortName") or _name_for(symbol)
        market_cap = info.get("marketCap")
        # yfinance: profitMargins / revenueGrowth are decimals -> convert to percent
        pm = info.get("profitMargins")
        rg = info.get("revenueGrowth")
        row = {
            "symbol": symbol,
            "name": name,
            "market_cap": _round(market_cap) if market_cap is not None else None,
            "pe": _clean_ratio(info.get("trailingPE")),
            "fwd_pe": _clean_ratio(info.get("forwardPE")),
            "ev_ebitda": _clean_ratio(info.get("enterpriseToEbitda")),
            "ev_rev": _clean_ratio(info.get("enterpriseToRevenue")),
            "pb": _clean_ratio(info.get("priceToBook")),
            "ps": _clean_ratio(info.get("priceToSalesTrailing12Months")),
            "profit_margin": _round(pm * 100) if pm is not None else None,
            "rev_growth": _round(rg * 100) if rg is not None else None,
            "is_target": is_target,
        }
        # Require at least a couple of core multiples to call it live.
        core = [row["pe"], row["fwd_pe"], row["ev_ebitda"], row["pb"], row["ps"]]
        if sum(1 for c in core if c is not None) < 2:
            return None
        if row["market_cap"] is None:
            row["market_cap"] = SAMPLE_MULTIPLES.get(symbol, {}).get("market_cap")
        return row
    except Exception as e:
        log.warning("yfinance comps row failed for %s: %s", symbol, e)
        return None


# ---------------------------------------------------------------------------
# Median + premium/discount math
# ---------------------------------------------------------------------------

def _median(values: list[float]) -> float | None:
    vals = sorted(v for v in values if v is not None)
    n = len(vals)
    if n == 0:
        return None
    mid = n // 2
    if n % 2 == 1:
        return round(vals[mid], 2)
    return round((vals[mid - 1] + vals[mid]) / 2.0, 2)


def _compute_medians(rows: list[dict]) -> dict:
    """Peer median per metric. Computed over the PEER rows only (not the target),
    so premium/discount measures the target against its peer set."""
    peers = [r for r in rows if not r.get("is_target")]
    src = peers if peers else rows
    medians: dict[str, float | None] = {}
    for m in METRICS:
        medians[m] = _median([r.get(m) for r in src])
    return medians


def _premium_discount(rows: list[dict], medians: dict) -> dict:
    """For every row, percent premium (+) / discount (-) to the peer median per
    metric. e.g. pe_pct = (row.pe / median.pe - 1) * 100."""
    out: dict[str, dict] = {}
    for r in rows:
        sym = r["symbol"]
        pd: dict[str, float | None] = {}
        for m in METRICS:
            med = medians.get(m)
            val = r.get(m)
            if med and val is not None and med != 0:
                pd[f"{m}_pct"] = round((val / med - 1.0) * 100, 1)
            else:
                pd[f"{m}_pct"] = None
        out[sym] = pd
    return out


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def comps_grid(symbol: str) -> dict:
    """Relative valuation comps grid for `symbol`. See module docstring.

    Never raises - degrades to deterministic SAMPLE multiples and tags the
    payload with data_mode / as_of / source.
    """
    try:
        return _comps_grid(symbol)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("comps_grid failed hard, returning sample: %s", e)
        sym = (symbol or "AAPL").strip().upper() or "AAPL"
        return _comps_grid_sample(sym)


def _comps_grid(symbol: str) -> dict:
    sym = (symbol or "AAPL").strip().upper() or "AAPL"
    peers, used_default = _peers_for(sym)
    universe = [sym, *peers]

    rows: list[dict] = []
    live_hits = 0
    for i, t in enumerate(universe):
        is_target = i == 0
        live = _live_row(t, is_target)
        if live is not None:
            rows.append(live)
            live_hits += 1
        else:
            rows.append(_sample_row(t, is_target))

    # Treat the grid as "live" only if a clear majority of names resolved live.
    data_mode = "live" if live_hits >= max(3, (len(universe) + 1) // 2) else "sample"
    source = SOURCE_LIVE if data_mode == "live" else SOURCE_SAMPLE

    return _finalize(sym, peers, rows, used_default, data_mode, source)


def _comps_grid_sample(symbol: str) -> dict:
    sym = (symbol or "AAPL").strip().upper() or "AAPL"
    peers, used_default = _peers_for(sym)
    universe = [sym, *peers]
    rows = [_sample_row(t, i == 0) for i, t in enumerate(universe)]
    return _finalize(sym, peers, rows, used_default, "sample", SOURCE_SAMPLE)


def _finalize(symbol, peers, rows, used_default, data_mode, source) -> dict:
    medians = _compute_medians(rows)
    premium_discount = _premium_discount(rows, medians)
    return {
        "symbol": symbol,
        "peers": peers,
        "peer_source": "default" if used_default else "curated",
        "rows": rows,
        "medians": medians,
        "premium_discount": premium_discount,
        "metrics": METRICS,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
