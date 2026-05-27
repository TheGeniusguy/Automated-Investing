"""Sector operational KPIs -- the "factory dashboard" per sector.

Different from sector_macro_drivers (which measures correlation to broad
macro). Operational KPIs are the industry-specific operating data a CEO
inside that sector watches: oil inventories, mortgage rates, ISM new orders,
crack spreads, commodity input costs, etc.

Data sources: FRED (requires FRED_API_KEY) and yfinance (no key). When FRED
is unavailable, FRED-sourced KPIs return null and are flagged with
available=false; yfinance KPIs always render. Some KPIs are computed
client-side from other KPIs (e.g. 3-2-1 crack spread).

The buckets per sector are curated, not auto-generated. Adding a sector or
KPI is a config-only change here.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import macro_data
from ..config import settings

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 365  # 1y window so we can compute 1d/1w/1m/3m/ytd changes
SPARK_TAIL = 90      # last N points returned as sparkline


# ── Per-sector operational KPI catalog ───────────────────────────────────────
# Each KPI: id, label, source ("fred"|"yfinance"), unit, desc
# Each sector groups KPIs into buckets (e.g. "Prices", "Inventories").

SECTOR_OPERATIONAL: dict[str, dict] = {
    "oil_gas": {
        "buckets": [
            {"label": "Spot Prices (EIA via FRED)", "kpis": [
                {"id": "DCOILWTICO",   "label": "WTI Crude",          "source": "fred",     "unit": "$/bbl",   "desc": "US benchmark crude spot"},
                {"id": "DCOILBRENTEU", "label": "Brent Crude",        "source": "fred",     "unit": "$/bbl",   "desc": "Global benchmark crude"},
                {"id": "DHHNGSP",      "label": "Henry Hub Nat Gas",  "source": "fred",     "unit": "$/MMBtu", "desc": "US benchmark gas spot"},
                {"id": "GASREGW",      "label": "US Retail Gasoline", "source": "fred",     "unit": "$/gal",   "desc": "Weekly EIA retail price"},
            ]},
            {"label": "Futures (yfinance)", "kpis": [
                {"id": "CL=F", "label": "WTI Front Month",   "source": "yfinance", "unit": "$/bbl",  "desc": "Most-traded crude future"},
                {"id": "BZ=F", "label": "Brent Front Month", "source": "yfinance", "unit": "$/bbl",  "desc": "Global crude future"},
                {"id": "NG=F", "label": "Nat Gas Front",     "source": "yfinance", "unit": "$/MMBtu","desc": "Henry Hub gas future"},
                {"id": "RB=F", "label": "Gasoline Front",    "source": "yfinance", "unit": "$/gal",  "desc": "RBOB gasoline future"},
                {"id": "HO=F", "label": "Heating Oil Front", "source": "yfinance", "unit": "$/gal",  "desc": "ULSD distillate future"},
            ]},
            {"label": "Inventories (EIA weekly)", "kpis": [
                {"id": "WCRSTUS1", "label": "Commercial Crude Stocks", "source": "fred", "unit": "kbbl", "desc": "US crude inventory ex-SPR"},
                {"id": "WGTSTUS1", "label": "Gasoline Stocks",         "source": "fred", "unit": "kbbl", "desc": "US gasoline inventory"},
                {"id": "WDISTUS1", "label": "Distillate Stocks",       "source": "fred", "unit": "kbbl", "desc": "US ULSD + heating oil inventory"},
            ]},
            {"label": "Production & Refining", "kpis": [
                {"id": "IPG211111CN", "label": "Crude Production Idx", "source": "fred", "unit": "Idx", "desc": "US crude output index, 2017=100"},
                {"id": "TCU",         "label": "Capacity Utilization", "source": "fred", "unit": "%",   "desc": "US industrial cap utilization"},
                {"id": "WCESTUS1",    "label": "Crude Imports",        "source": "fred", "unit": "kbpd","desc": "Weekly US crude imports"},
            ]},
        ],
        "derived": [
            {"id": "crack_3_2_1", "label": "3-2-1 Crack Spread",
             "formula": "((RB=F*42)*2 + (HO=F*42)*1 - CL=F*3) / 3",
             "deps": ["RB=F", "HO=F", "CL=F"],
             "unit": "$/bbl",
             "desc": "Classic refiner margin: 3 bbl crude → 2 bbl gasoline + 1 bbl distillate"},
        ],
    },
    "financials": {
        "buckets": [
            {"label": "Yield Curve (the literal sector P&L)", "kpis": [
                {"id": "DGS10",   "label": "10Y Treasury",  "source": "fred",     "unit": "%", "desc": "Long-rate benchmark"},
                {"id": "DGS2",    "label": "2Y Treasury",   "source": "fred",     "unit": "%", "desc": "Short-rate benchmark"},
                {"id": "T10Y2Y",  "label": "10Y-2Y Spread", "source": "fred",     "unit": "bp","desc": "Curve steepness — NIM proxy"},
                {"id": "T10Y3M",  "label": "10Y-3M Spread", "source": "fred",     "unit": "bp","desc": "Recession-signal curve"},
                {"id": "FEDFUNDS","label": "Fed Funds Rate","source": "fred",     "unit": "%", "desc": "Policy rate"},
            ]},
            {"label": "Credit Conditions", "kpis": [
                {"id": "BAMLH0A0HYM2", "label": "HY OAS",   "source": "fred", "unit": "%",  "desc": "High-yield spread — loan-loss leading indicator"},
                {"id": "BAMLC0A0CM",   "label": "IG OAS",   "source": "fred", "unit": "%",  "desc": "Investment-grade spread"},
                {"id": "MORTGAGE30US", "label": "30Y Mortg","source": "fred", "unit": "%",  "desc": "Drives consumer + CRE demand"},
            ]},
            {"label": "Bank Balance Sheet (FRED H.8)", "kpis": [
                {"id": "BUSLOANS",            "label": "C&I Loans",         "source": "fred", "unit": "$B", "desc": "Commercial + industrial loans"},
                {"id": "TOTLL",               "label": "Total Loans + Leases","source":"fred","unit": "$B", "desc": "Bank credit growth signal"},
                {"id": "DPSACBW027SBOG",      "label": "Deposits",           "source": "fred", "unit": "$B", "desc": "Deposit base trajectory"},
                {"id": "DRCLACBS",            "label": "C&I Delinquency",    "source": "fred", "unit": "%",  "desc": "Quarterly loan delinquency rate"},
            ]},
        ],
        "derived": [],
    },
    "real_estate": {
        "buckets": [
            {"label": "Mortgage Market", "kpis": [
                {"id": "MORTGAGE30US","label": "30Y Mortgage Rate","source": "fred", "unit": "%", "desc": "Primary affordability driver"},
                {"id": "MORTGAGE15US","label": "15Y Mortgage Rate","source": "fred", "unit": "%", "desc": "Refi pulse"},
                {"id": "DGS10",       "label": "10Y Treasury",     "source": "fred", "unit": "%", "desc": "REIT discount rate"},
            ]},
            {"label": "Housing Activity", "kpis": [
                {"id": "HOUST",        "label": "Housing Starts",   "source": "fred", "unit": "k SAAR","desc": "Single + multi-family starts"},
                {"id": "PERMIT",       "label": "Building Permits", "source": "fred", "unit": "k SAAR","desc": "Forward-looking starts proxy"},
                {"id": "HSN1F",        "label": "New Home Sales",   "source": "fred", "unit": "k SAAR","desc": "New construction demand"},
                {"id": "EXHOSLUSM495S","label": "Existing Home Sales","source":"fred","unit": "k SAAR","desc": "Resale market velocity"},
            ]},
            {"label": "Prices & Vacancy", "kpis": [
                {"id": "CSUSHPINSA",   "label": "Case-Shiller National","source":"fred","unit":"Idx", "desc": "US home price index, NSA"},
                {"id": "MSPUS",        "label": "Median Sale Price",    "source":"fred","unit":"$",   "desc": "Median US sale price (quarterly)"},
                {"id": "RRVRUSQ156N",  "label": "Rental Vacancy Rate",  "source":"fred","unit":"%",   "desc": "US rental vacancy (quarterly)"},
            ]},
            {"label": "REIT Proxies", "kpis": [
                {"id": "VNQ",  "label": "Vanguard REIT ETF",   "source": "yfinance", "unit": "$", "desc": "Broad US REIT exposure"},
                {"id": "IYR",  "label": "iShares US Real Est", "source": "yfinance", "unit": "$", "desc": "Broad US real-estate ETF"},
            ]},
        ],
        "derived": [
            {"id": "mortgage_10y_spread", "label": "30Y Mortg - 10Y Spread",
             "formula": "MORTGAGE30US - DGS10",
             "deps": ["MORTGAGE30US", "DGS10"],
             "unit": "bp",
             "desc": "Primary-secondary mortgage spread; wider = mortgage market stress"},
        ],
    },
    "industrials": {
        "buckets": [
            {"label": "Manufacturing Activity", "kpis": [
                {"id": "INDPRO",       "label": "Industrial Production","source":"fred","unit": "Idx", "desc": "Core US manufacturing output"},
                {"id": "IPMAN",        "label": "Mfg Production",       "source":"fred","unit": "Idx", "desc": "Manufacturing-only sub-index"},
                {"id": "TCU",          "label": "Capacity Utilization", "source":"fred","unit": "%",   "desc": "How tight is US production capacity"},
                {"id": "MANEMP",       "label": "Mfg Employment",       "source":"fred","unit": "k",   "desc": "Manufacturing payrolls"},
            ]},
            {"label": "Orders & Backlog", "kpis": [
                {"id": "DGORDER",      "label": "Durable Goods Orders", "source":"fred","unit": "$M", "desc": "New orders for durables"},
                {"id": "NEWORDER",     "label": "Core Capex Orders",    "source":"fred","unit": "$M", "desc": "Nondefense ex-aircraft orders"},
                {"id": "AMTMUO",       "label": "Mfg Unfilled Orders",  "source":"fred","unit": "$M", "desc": "Order backlog"},
            ]},
            {"label": "Cost Inputs", "kpis": [
                {"id": "CL=F",      "label": "WTI Crude",       "source": "yfinance", "unit": "$/bbl", "desc": "Energy + transport cost"},
                {"id": "DX-Y.NYB",  "label": "Dollar Index",    "source": "yfinance", "unit": "Idx",   "desc": "Export competitiveness"},
                {"id": "PPIACO",    "label": "PPI All Commodities","source": "fred", "unit": "Idx",   "desc": "Producer input cost trend"},
            ]},
        ],
        "derived": [],
    },
    "materials": {
        "buckets": [
            {"label": "Industrial Metals (yfinance)", "kpis": [
                {"id": "HG=F", "label": "Copper Front",   "source": "yfinance", "unit": "$/lb",   "desc": "Dr. Copper — global growth gauge"},
                {"id": "ALI=F","label": "Aluminum Front", "source": "yfinance", "unit": "$/t",    "desc": "Aluminum LME proxy"},
                {"id": "ZN=F", "label": "Zinc Front",     "source": "yfinance", "unit": "$/t",    "desc": "Galvanizing demand proxy"},
                {"id": "PL=F", "label": "Platinum Front", "source": "yfinance", "unit": "$/oz",   "desc": "Platinum group metals"},
            ]},
            {"label": "Precious Metals", "kpis": [
                {"id": "GC=F", "label": "Gold Front",     "source": "yfinance", "unit": "$/oz",   "desc": "Gold benchmark"},
                {"id": "SI=F", "label": "Silver Front",   "source": "yfinance", "unit": "$/oz",   "desc": "Silver benchmark"},
            ]},
            {"label": "Construction & Soft", "kpis": [
                {"id": "LBR=F", "label": "Lumber Front",  "source": "yfinance", "unit": "$/Mbf",  "desc": "Building materials proxy"},
                {"id": "PPIACO","label": "PPI Commodities","source":"fred",     "unit": "Idx",    "desc": "Broad commodity inflation"},
                {"id": "INDPRO","label": "Industrial Prod","source":"fred",     "unit": "Idx",    "desc": "Global demand for materials"},
            ]},
            {"label": "FX + Rates", "kpis": [
                {"id": "DX-Y.NYB","label": "Dollar Index","source": "yfinance", "unit": "Idx", "desc": "Commodities priced in USD — inverse"},
                {"id": "DGS10",   "label": "10Y Treasury","source":"fred",      "unit": "%",   "desc": "Mining capex finance cost"},
            ]},
        ],
        "derived": [],
    },
    "consumer_staples": {
        "buckets": [
            {"label": "Agricultural Inputs", "kpis": [
                {"id": "ZC=F", "label": "Corn Front",     "source": "yfinance", "unit": "¢/bu", "desc": "Animal feed + sweetener input"},
                {"id": "ZW=F", "label": "Wheat Front",    "source": "yfinance", "unit": "¢/bu", "desc": "Baked goods input"},
                {"id": "ZS=F", "label": "Soybeans Front", "source": "yfinance", "unit": "¢/bu", "desc": "Oil + animal feed input"},
                {"id": "ZL=F", "label": "Soybean Oil",    "source": "yfinance", "unit": "¢/lb", "desc": "Processed food input"},
            ]},
            {"label": "Protein + Beverage", "kpis": [
                {"id": "LE=F", "label": "Live Cattle",     "source": "yfinance", "unit": "¢/lb",  "desc": "Beef input cost"},
                {"id": "HE=F", "label": "Lean Hogs",       "source": "yfinance", "unit": "¢/lb",  "desc": "Pork input cost"},
                {"id": "KC=F", "label": "Coffee Front",    "source": "yfinance", "unit": "$/lb",  "desc": "Coffee bean spot"},
                {"id": "CC=F", "label": "Cocoa Front",     "source": "yfinance", "unit": "$/t",   "desc": "Chocolate input cost"},
                {"id": "SB=F", "label": "Sugar #11",       "source": "yfinance", "unit": "¢/lb",  "desc": "Sweetener input"},
            ]},
            {"label": "Macro Tape", "kpis": [
                {"id": "CPIAUCSL", "label": "CPI All Items","source":"fred",      "unit": "Idx", "desc": "Pricing-power test"},
                {"id": "DX-Y.NYB", "label": "Dollar Index", "source": "yfinance", "unit": "Idx", "desc": "International revenue FX"},
            ]},
        ],
        "derived": [],
    },
    "consumer_discretionary": {
        "buckets": [
            {"label": "Consumer Pulse", "kpis": [
                {"id": "UMCSENT", "label": "Consumer Sentiment", "source":"fred", "unit":"Idx", "desc": "U Michigan survey"},
                {"id": "UNRATE",  "label": "Unemployment Rate",  "source":"fred", "unit":"%",   "desc": "Jobs = spending capacity"},
                {"id": "ICSA",    "label": "Initial Claims",     "source":"fred", "unit":"k",   "desc": "Weekly jobless claims"},
                {"id": "PSAVERT", "label": "Personal Savings",   "source":"fred", "unit":"%",   "desc": "Savings rate — dry powder gauge"},
            ]},
            {"label": "Spending + Credit", "kpis": [
                {"id": "RSXFS",    "label": "Retail Sales ex Food","source":"fred", "unit":"$M", "desc": "Core retail spending"},
                {"id": "DSPIC96",  "label": "Real Disp Income",   "source":"fred", "unit":"$B", "desc": "Inflation-adjusted income"},
                {"id": "TOTALSL",  "label": "Consumer Credit",    "source":"fred", "unit":"$B", "desc": "Revolving + non-revolving debt"},
            ]},
            {"label": "Affordability Drag", "kpis": [
                {"id": "GASREGW",     "label": "Gas Price",        "source":"fred",      "unit":"$/gal", "desc": "Discretionary squeeze when high"},
                {"id": "MORTGAGE30US","label": "30Y Mortgage Rate","source":"fred",      "unit":"%",     "desc": "Housing-cost wedge on disc"},
                {"id": "^TNX",        "label": "10Y Yield",        "source":"yfinance",  "unit":"%",     "desc": "Consumer credit cost"},
            ]},
        ],
        "derived": [],
    },
    "utilities": {
        "buckets": [
            {"label": "Rate Sensitivity", "kpis": [
                {"id": "DGS10",   "label": "10Y Treasury",  "source":"fred",     "unit": "%", "desc": "Bond-proxy discount rate"},
                {"id": "DGS30",   "label": "30Y Treasury",  "source":"fred",     "unit": "%", "desc": "Long-duration discount rate"},
                {"id": "^TNX",    "label": "10Y Yield",     "source":"yfinance", "unit": "%", "desc": "Live rate competitor"},
            ]},
            {"label": "Fuel Costs", "kpis": [
                {"id": "DHHNGSP", "label": "Henry Hub Gas","source":"fred",      "unit":"$/MMBtu","desc":"Gas-fired generation cost"},
                {"id": "NG=F",    "label": "Nat Gas Front","source":"yfinance",  "unit":"$/MMBtu","desc":"Live gas price"},
                {"id": "DCOILWTICO","label":"WTI Crude",   "source":"fred",      "unit":"$/bbl",  "desc": "Oil-fired peaker fuel"},
            ]},
            {"label": "Electricity Market", "kpis": [
                {"id": "CPIELESL","label": "Electricity CPI","source":"fred", "unit":"Idx", "desc": "Retail power price index"},
                {"id": "IPN213111N","label":"Mining Electric","source":"fred","unit":"Idx", "desc": "Industrial power demand proxy"},
            ]},
        ],
        "derived": [],
    },
    "healthcare": {
        "buckets": [
            {"label": "Healthcare Inflation", "kpis": [
                {"id": "CPIMEDSL",  "label": "Medical Care CPI",         "source":"fred", "unit":"Idx", "desc": "Aggregate health-care inflation"},
                {"id": "CUSR0000SEMC","label":"Hospital Services CPI",   "source":"fred", "unit":"Idx", "desc": "Hospital pricing trajectory"},
                {"id": "CUSR0000SEMF","label":"Drug Prescription CPI",   "source":"fred", "unit":"Idx", "desc": "Prescription drug pricing"},
            ]},
            {"label": "Pharma PPI", "kpis": [
                {"id": "PCU325412325412","label": "Pharma Mfg PPI",     "source":"fred", "unit":"Idx", "desc": "Drug-manufacturer pricing power"},
                {"id": "PCU3391133911",  "label": "Medical Equip PPI",  "source":"fred", "unit":"Idx", "desc": "Medical-device pricing power"},
            ]},
            {"label": "Labor + Demand", "kpis": [
                {"id": "CES6562000001","label": "Health Care Employment","source":"fred","unit":"k", "desc": "Healthcare payrolls"},
                {"id": "UNRATE",       "label": "Unemployment",         "source":"fred", "unit":"%", "desc": "Defensive demand check"},
            ]},
            {"label": "Rates (biotech lever)", "kpis": [
                {"id": "DGS10",  "label": "10Y Treasury",  "source":"fred",     "unit":"%",  "desc": "DCF rate for growth biotech"},
                {"id": "^VIX",   "label": "VIX",           "source":"yfinance", "unit":"Idx","desc": "Defensive bid signal"},
            ]},
        ],
        "derived": [],
    },
    "biotech": {
        "buckets": [
            {"label": "Funding Conditions (the biotech lifeline)", "kpis": [
                {"id": "DGS10",         "label": "10Y Treasury",  "source":"fred",     "unit":"%",  "desc": "Long-duration DCF rate"},
                {"id": "^TNX",          "label": "10Y Yield",     "source":"yfinance", "unit":"%",  "desc": "Live long-rate"},
                {"id": "BAMLH0A0HYM2",  "label": "HY OAS",        "source":"fred",     "unit":"%",  "desc": "Risk capital availability"},
                {"id": "^VIX",          "label": "VIX",           "source":"yfinance", "unit":"Idx","desc": "Speculative risk gauge"},
            ]},
            {"label": "Drug Pricing + Demand", "kpis": [
                {"id": "PCU325412325412","label":"Pharma PPI",         "source":"fred", "unit":"Idx","desc": "Drug-manufacturer pricing"},
                {"id": "CPIMEDSL",      "label":"Medical Care CPI",    "source":"fred", "unit":"Idx","desc": "Healthcare price index"},
            ]},
            {"label": "Biotech Indexes", "kpis": [
                {"id": "XBI",   "label": "SPDR S&P Biotech",       "source":"yfinance", "unit":"$", "desc": "Equal-weight biotech ETF"},
                {"id": "IBB",   "label": "iShares Nasdaq Bio",     "source":"yfinance", "unit":"$", "desc": "Cap-weight biotech ETF"},
                {"id": "ARKG",  "label": "ARK Genomic Rev",        "source":"yfinance", "unit":"$", "desc": "Speculative biotech proxy"},
            ]},
        ],
        "derived": [],
    },
    "defense_aerospace": {
        "buckets": [
            {"label": "Geopolitical Tape", "kpis": [
                {"id": "^VIX",      "label": "VIX",          "source":"yfinance", "unit":"Idx",   "desc": "Risk-off catalyst for defense"},
                {"id": "CL=F",      "label": "WTI Crude",    "source":"yfinance", "unit":"$/bbl", "desc": "Energy-security spending signal"},
                {"id": "GC=F",      "label": "Gold",         "source":"yfinance", "unit":"$/oz",  "desc": "Safe-haven flow proxy"},
                {"id": "DX-Y.NYB",  "label": "Dollar Index", "source":"yfinance", "unit":"Idx",   "desc": "Export contract value"},
            ]},
            {"label": "Mfg Backbone", "kpis": [
                {"id": "INDPRO",   "label": "Industrial Prod",     "source":"fred", "unit":"Idx", "desc": "Capacity for defense output"},
                {"id": "IPMAN",    "label": "Mfg Production",      "source":"fred", "unit":"Idx", "desc": "Manufacturing sub-index"},
                {"id": "NEWORDER", "label": "Core Capex Orders",   "source":"fred", "unit":"$M",  "desc": "Capex pipeline"},
            ]},
            {"label": "Rate Sensitivity", "kpis": [
                {"id": "DGS10",  "label": "10Y Treasury", "source":"fred",     "unit":"%",  "desc": "Long-program finance cost"},
                {"id": "^TNX",   "label": "10Y Yield",    "source":"yfinance", "unit":"%",  "desc": "Live long rate"},
            ]},
        ],
        "derived": [],
    },
    "technology": {
        "buckets": [
            {"label": "Discount Rate (the tech multiple lever)", "kpis": [
                {"id": "DGS10",  "label": "10Y Treasury",  "source":"fred",      "unit":"%",  "desc": "Primary DCF rate for growth"},
                {"id": "^TNX",   "label": "10Y Yield",     "source":"yfinance",  "unit":"%",  "desc": "Live long-rate proxy"},
                {"id": "DFII10", "label": "10Y Real Yield","source":"fred",      "unit":"%",  "desc": "Real rate = DCF headwind"},
            ]},
            {"label": "Overseas Revenue Exposure", "kpis": [
                {"id": "DX-Y.NYB",  "label": "Dollar Index",     "source":"yfinance", "unit":"Idx", "desc": "Tech ~50% non-US revenue"},
                {"id": "DTWEXBGS",  "label": "Trade-Wtd USD",    "source":"fred",     "unit":"Idx", "desc": "Broad dollar"},
            ]},
            {"label": "Semi + Hardware Proxies", "kpis": [
                {"id": "SOXX", "label": "iShares Semi ETF",  "source":"yfinance", "unit":"$", "desc": "Hardware demand cycle"},
                {"id": "QQQ",  "label": "Nasdaq 100",        "source":"yfinance", "unit":"$", "desc": "Broad tech tape"},
                {"id": "EWT",  "label": "Taiwan ETF",        "source":"yfinance", "unit":"$", "desc": "Supply-chain exposure proxy"},
            ]},
            {"label": "Sentiment", "kpis": [
                {"id": "^VIX",  "label": "VIX",          "source":"yfinance", "unit":"Idx", "desc": "Risk-off drag on high-beta tech"},
            ]},
        ],
        "derived": [],
    },
    "semiconductors": {
        "buckets": [
            {"label": "Cycle Signals", "kpis": [
                {"id": "INDPRO",   "label": "Industrial Production","source":"fred",     "unit":"Idx", "desc": "Global mfg demand for chips"},
                {"id": "IPMAN",    "label": "Mfg Production",       "source":"fred",     "unit":"Idx", "desc": "Mfg-only sub-index"},
                {"id": "DGORDER",  "label": "Durable Goods Orders", "source":"fred",     "unit":"$M",  "desc": "End-market demand pull"},
            ]},
            {"label": "Supply Chain Geographies", "kpis": [
                {"id": "EWT",  "label": "Taiwan ETF",      "source":"yfinance", "unit":"$",   "desc": "TSMC + foundry exposure"},
                {"id": "EWY",  "label": "South Korea ETF", "source":"yfinance", "unit":"$",   "desc": "Memory (Samsung, SK Hynix)"},
                {"id": "MCHI", "label": "China ETF",       "source":"yfinance", "unit":"$",   "desc": "End-customer demand"},
            ]},
            {"label": "Chip Sub-baskets", "kpis": [
                {"id": "SOXX", "label": "iShares Semi ETF","source":"yfinance", "unit":"$", "desc": "Cap-weight chip ETF"},
                {"id": "SMH",  "label": "VanEck Semi ETF", "source":"yfinance", "unit":"$", "desc": "Heavily NVDA-weighted"},
                {"id": "PSI",  "label": "Invesco Semi ETF","source":"yfinance", "unit":"$", "desc": "Equal-weight chip ETF"},
            ]},
            {"label": "FX + Rates", "kpis": [
                {"id": "DX-Y.NYB","label": "Dollar Index", "source":"yfinance", "unit":"Idx","desc": "Asian revenue FX"},
                {"id": "DGS10",   "label": "10Y Treasury", "source":"fred",     "unit":"%",  "desc": "Capex finance cost"},
            ]},
        ],
        "derived": [],
    },
    "communication_services": {
        "buckets": [
            {"label": "Ad-Market Pulse", "kpis": [
                {"id": "UMCSENT", "label": "Consumer Sentiment", "source":"fred",     "unit":"Idx", "desc": "Ad spend tracks confidence"},
                {"id": "UNRATE",  "label": "Unemployment",       "source":"fred",     "unit":"%",   "desc": "Employment drives ad budgets"},
                {"id": "RSXFS",   "label": "Retail Sales ex Food","source":"fred",    "unit":"$M",  "desc": "Ad-dependent retail demand"},
            ]},
            {"label": "Streaming + Subs", "kpis": [
                {"id": "DSPIC96", "label": "Real Disp Income",  "source":"fred",     "unit":"$B", "desc": "Subscription wallet"},
                {"id": "CPIAUCSL","label": "CPI All Items",     "source":"fred",     "unit":"Idx","desc": "Sub-price pass-through test"},
            ]},
            {"label": "Rate + FX", "kpis": [
                {"id": "DGS10",    "label": "10Y Treasury","source":"fred",     "unit":"%",   "desc": "Growth-name DCF rate"},
                {"id": "DX-Y.NYB", "label": "Dollar Index","source":"yfinance", "unit":"Idx", "desc": "International ad/sub revenue FX"},
                {"id": "^VIX",     "label": "VIX",         "source":"yfinance", "unit":"Idx", "desc": "Ad-cyclicality risk gauge"},
            ]},
        ],
        "derived": [],
    },
    "clean_energy": {
        "buckets": [
            {"label": "Project Finance Cost", "kpis": [
                {"id": "DGS10",         "label": "10Y Treasury",  "source":"fred",     "unit":"%", "desc": "Long-IRR projects most exposed"},
                {"id": "^TNX",          "label": "10Y Yield",     "source":"yfinance", "unit":"%", "desc": "Live long-rate"},
                {"id": "BAMLH0A0HYM2",  "label": "HY OAS",        "source":"fred",     "unit":"%", "desc": "Project-finance credit conditions"},
            ]},
            {"label": "Substitute Economics", "kpis": [
                {"id": "CL=F",      "label": "WTI Crude",     "source":"yfinance", "unit":"$/bbl",   "desc": "Higher oil = better renewable IRR"},
                {"id": "NG=F",      "label": "Nat Gas Front", "source":"yfinance", "unit":"$/MMBtu", "desc": "Gas parity test for solar/wind"},
                {"id": "DCOILWTICO","label": "WTI Spot",      "source":"fred",     "unit":"$/bbl",   "desc": "EIA spot benchmark"},
            ]},
            {"label": "Input Metals", "kpis": [
                {"id": "HG=F",  "label": "Copper Front",  "source":"yfinance", "unit":"$/lb", "desc": "Grid + EV motor copper"},
                {"id": "SI=F",  "label": "Silver Front",  "source":"yfinance", "unit":"$/oz", "desc": "Solar panel input"},
            ]},
            {"label": "Theme ETFs", "kpis": [
                {"id": "ICLN", "label": "iShares Global Clean","source":"yfinance","unit":"$","desc": "Broad clean energy ETF"},
                {"id": "TAN",  "label": "Invesco Solar ETF",   "source":"yfinance","unit":"$","desc": "Solar pure-play"},
                {"id": "LIT",  "label": "Global X Lithium",    "source":"yfinance","unit":"$","desc": "Battery supply chain"},
            ]},
        ],
        "derived": [],
    },
}


SECTOR_OPERATIONAL_KEYS = list(SECTOR_OPERATIONAL.keys())


# ── Compute helpers ──────────────────────────────────────────────────────────

def _pct_change(points: list[dict], lookback: int) -> Optional[float]:
    """Percent change between last point and `lookback` points ago."""
    valid = [p for p in points if p.get("value") is not None]
    if len(valid) < 2 or lookback < 1:
        return None
    last = valid[-1]["value"]
    idx = max(0, len(valid) - 1 - lookback)
    base = valid[idx]["value"]
    if not base or base == 0:
        return None
    return round(float((last - base) / base * 100.0), 2)


def _abs_change(points: list[dict], lookback: int) -> Optional[float]:
    """Absolute change (for things measured in % like yields where pct of pct is weird)."""
    valid = [p for p in points if p.get("value") is not None]
    if len(valid) < 2 or lookback < 1:
        return None
    last = valid[-1]["value"]
    idx = max(0, len(valid) - 1 - lookback)
    base = valid[idx]["value"]
    return round(float(last - base), 4)


def _ytd_lookback(points: list[dict]) -> Optional[int]:
    """Number of points back to find the first observation of the current year."""
    valid = [p for p in points if p.get("value") is not None]
    if not valid:
        return None
    last_date = valid[-1]["date"]
    last_year = last_date[:4]
    # Walk back until we find the previous year's last observation
    for i in range(len(valid) - 1, -1, -1):
        if valid[i]["date"][:4] != last_year:
            return (len(valid) - 1) - i
    return len(valid) - 1  # entire series is current year


def _fetch_kpi(kpi: dict) -> tuple[str, list[dict]]:
    sid = kpi["id"]
    source = kpi["source"]
    try:
        points = macro_data.fetch_explicit(sid, source=source, days=LOOKBACK_DAYS)
        return sid, points
    except Exception as exc:
        log.warning("Operational KPI fetch %s failed: %s", sid, exc)
        return sid, []


def _compute_tile(kpi: dict, points: list[dict]) -> dict:
    """Add last value, change metrics, and sparkline to a KPI definition."""
    valid = [p for p in points if p.get("value") is not None]
    last = valid[-1]["value"] if valid else None
    last_date = valid[-1]["date"] if valid else None
    unit = kpi.get("unit", "")
    # For rates / spreads / percentages, surface absolute change too. For everything
    # else the percent change is the natural read.
    is_rate = unit in ("%", "bp")

    return {
        **kpi,
        "last_value": float(last) if last is not None else None,
        "last_date":  last_date,
        "change_1d_pct":  _pct_change(points, 1),
        "change_1w_pct":  _pct_change(points, 5),
        "change_1m_pct":  _pct_change(points, 21),
        "change_3m_pct":  _pct_change(points, 63),
        "change_ytd_pct": _pct_change(points, _ytd_lookback(points) or 0)
                          if _ytd_lookback(points) else None,
        "change_1d_abs":  _abs_change(points, 1) if is_rate else None,
        "change_1w_abs":  _abs_change(points, 5) if is_rate else None,
        "change_1m_abs":  _abs_change(points, 21) if is_rate else None,
        "spark": [
            {"date": p["date"], "value": p["value"]}
            for p in points[-SPARK_TAIL:] if p.get("value") is not None
        ],
        "available": last is not None,
    }


def _compute_derived(spec: dict, fetched: dict[str, list[dict]]) -> dict:
    """Compute a derived KPI from primitive series.

    Supports simple, hand-rolled formulas listed in SECTOR_OPERATIONAL. Each
    derived KPI declares its `deps` so we can short-circuit if any input is
    missing.
    """
    deps_points = {dep: fetched.get(dep, []) for dep in spec["deps"]}
    # Need every dep populated to compute.
    if any(not pts for pts in deps_points.values()):
        return {
            **{k: v for k, v in spec.items() if k != "formula" and k != "deps"},
            "source": "derived",
            "last_value": None, "last_date": None,
            "change_1d_pct": None, "change_1w_pct": None, "change_1m_pct": None,
            "change_3m_pct": None, "change_ytd_pct": None,
            "change_1d_abs": None, "change_1w_abs": None, "change_1m_abs": None,
            "spark": [],
            "available": False,
            "id": spec["id"],
        }

    # Build a date-indexed map per dep, then compute on the intersection of dates.
    indexed = {dep: {p["date"]: p["value"] for p in pts if p.get("value") is not None}
               for dep, pts in deps_points.items()}
    common_dates = sorted(set.intersection(*[set(d.keys()) for d in indexed.values()]))

    series: list[dict] = []
    sid = spec["id"]
    for d in common_dates:
        vals = {dep: indexed[dep][d] for dep in indexed}
        try:
            if sid == "crack_3_2_1":
                # Inputs: RB=F ($/gal), HO=F ($/gal), CL=F ($/bbl). Convert gal->bbl (*42).
                v = ((vals["RB=F"] * 42) * 2 + (vals["HO=F"] * 42) * 1 - vals["CL=F"] * 3) / 3.0
            elif sid == "mortgage_10y_spread":
                # Both in %; result in basis points.
                v = (vals["MORTGAGE30US"] - vals["DGS10"]) * 100.0
            else:
                v = None
        except Exception:
            v = None
        if v is not None:
            series.append({"date": d, "value": float(v)})

    return _compute_tile(
        {
            "id":     spec["id"],
            "label":  spec["label"],
            "source": "derived",
            "unit":   spec.get("unit", ""),
            "desc":   spec.get("desc", ""),
        },
        series,
    )


# ── Public API ───────────────────────────────────────────────────────────────

def list_supported_sectors() -> list[str]:
    """Sectors with curated operational KPI buckets."""
    return SECTOR_OPERATIONAL_KEYS


def sector_operational(sector_id: str) -> dict:
    """Return per-sector operational KPIs grouped into buckets.

    Response shape:
    {
      "sector_id": str,
      "fred_available": bool,
      "buckets": [
        {"label": str, "kpis": [<computed tile>]},
        ...
      ],
      "derived": [<computed tile>],
      "available": bool,    # true if at least one KPI returned a value
    }
    """
    config = SECTOR_OPERATIONAL.get(sector_id)
    if not config:
        return {
            "sector_id": sector_id,
            "fred_available": settings.has_fred,
            "buckets": [],
            "derived": [],
            "available": False,
            "reason": "No curated operational KPIs for this sector yet",
        }

    # Flatten all KPIs to fetch in parallel. Skip FRED ones if no key.
    all_kpis: list[dict] = []
    for bucket in config["buckets"]:
        for kpi in bucket["kpis"]:
            if kpi["source"] == "fred" and not settings.has_fred:
                continue
            all_kpis.append(kpi)

    fetched: dict[str, list[dict]] = {}
    if all_kpis:
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_fetch_kpi, k): k for k in all_kpis}
            for fut in as_completed(futures):
                sid, points = fut.result()
                fetched[sid] = points

    # Build response buckets.
    out_buckets: list[dict] = []
    any_available = False
    for bucket in config["buckets"]:
        tiles = []
        for kpi in bucket["kpis"]:
            if kpi["source"] == "fred" and not settings.has_fred:
                tiles.append({
                    **kpi,
                    "last_value": None, "last_date": None,
                    "change_1d_pct": None, "change_1w_pct": None,
                    "change_1m_pct": None, "change_3m_pct": None,
                    "change_ytd_pct": None,
                    "change_1d_abs": None, "change_1w_abs": None,
                    "change_1m_abs": None,
                    "spark": [],
                    "available": False,
                    "reason": "FRED_API_KEY not configured",
                })
                continue
            tile = _compute_tile(kpi, fetched.get(kpi["id"], []))
            if tile["available"]:
                any_available = True
            tiles.append(tile)
        out_buckets.append({"label": bucket["label"], "kpis": tiles})

    # Derived KPIs.
    derived_tiles: list[dict] = []
    for spec in config.get("derived", []):
        # Need to make sure all deps were fetched (and not skipped due to FRED).
        deps_ok = all(
            dep in fetched and fetched[dep]
            for dep in spec["deps"]
        )
        if not deps_ok:
            derived_tiles.append({
                "id": spec["id"], "label": spec["label"], "source": "derived",
                "unit": spec.get("unit", ""), "desc": spec.get("desc", ""),
                "last_value": None, "last_date": None,
                "change_1d_pct": None, "change_1w_pct": None,
                "change_1m_pct": None, "change_3m_pct": None,
                "change_ytd_pct": None,
                "change_1d_abs": None, "change_1w_abs": None,
                "change_1m_abs": None,
                "spark": [], "available": False,
                "reason": "Missing input series",
            })
            continue
        derived_tiles.append(_compute_derived(spec, fetched))

    return {
        "sector_id":      sector_id,
        "fred_available": settings.has_fred,
        "lookback_days":  LOOKBACK_DAYS,
        "spark_tail":     SPARK_TAIL,
        "buckets":        out_buckets,
        "derived":        derived_tiles,
        "available":      any_available,
    }
