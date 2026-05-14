"""Curated FRED series catalog — the macroeconomic universe.

Hand-picked from FRED's ~800k available series to cover the indicators a
serious US-focused investor watches: growth, inflation, employment, housing,
manufacturing, consumer, yields, credit, monetary, FX, energy, trade,
shipping/freight, fiscal, and regional surveys.

Each entry is a `FredSeries` with:
  - id: FRED series ID
  - label: short human-readable name
  - unit: display unit (used for axis labels and formatting)
  - frequency: 'D' daily | 'W' weekly | 'M' monthly | 'Q' quarterly | 'A' annual
  - note: optional one-liner about why this matters

We intentionally do NOT validate IDs at import time — FRED occasionally
discontinues / renames series. The fetcher returns an empty list on a 404
which the UI renders as a "—" cell, so the catalog stays usable even when
1-2 IDs drift.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FredSeries:
    id: str
    label: str
    unit: str = ""
    frequency: str = "M"   # D / W / M / Q / A
    note: str = ""


CATEGORY_ORDER = [
    "growth",
    "inflation",
    "employment",
    "housing",
    "manufacturing",
    "consumer",
    "yields",
    "credit",
    "monetary",
    "fx",
    "energy",
    "trade",
    "shipping",
    "fiscal",
    "regional",
]


CATEGORY_LABEL = {
    "growth":        "Growth & Activity",
    "inflation":     "Inflation",
    "employment":    "Employment & Labor",
    "housing":       "Housing & Mortgages",
    "manufacturing": "Manufacturing & Industry",
    "consumer":      "Consumer",
    "yields":        "Yields & Curves",
    "credit":        "Credit Spreads",
    "monetary":      "Monetary & Fed",
    "fx":            "Currencies",
    "energy":        "Energy",
    "trade":         "Trade",
    "shipping":      "Shipping & Freight",
    "fiscal":        "Federal Finance",
    "regional":      "Regional Fed Surveys",
}


CATALOG: dict[str, list[FredSeries]] = {
    # ---- Growth & Activity ----
    "growth": [
        FredSeries("GDP",     "Gross Domestic Product", "$B SAAR", "Q"),
        FredSeries("GDPC1",   "Real GDP", "$B SAAR 2017", "Q"),
        FredSeries("GDPDEF",  "GDP Deflator", "Idx 2017", "Q"),
        FredSeries("PCE",     "Personal Consumption Exp.", "$B SAAR", "M"),
        FredSeries("INDPRO",  "Industrial Production", "Idx 2017=100", "M",
                   note="The headline manufacturing/utilities/mining activity index."),
        FredSeries("TCU",     "Capacity Utilization", "%", "M"),
        FredSeries("DSPI",    "Disposable Personal Income", "$B SAAR", "M"),
        FredSeries("PSAVERT", "Personal Savings Rate", "%", "M"),
        FredSeries("A191RL1Q225SBEA", "Real GDP QoQ %", "% SAAR", "Q"),
    ],

    # ---- Inflation ----
    "inflation": [
        FredSeries("CPIAUCSL",         "CPI All Items", "Idx 1982-84", "M",
                   note="Headline CPI — what the press calls 'inflation'."),
        FredSeries("CPILFESL",         "Core CPI (ex food & energy)", "Idx 1982-84", "M"),
        FredSeries("PCEPI",            "PCE Price Index", "Idx 2017", "M"),
        FredSeries("PCEPILFE",         "Core PCE Price Index", "Idx 2017", "M",
                   note="The Fed's preferred inflation gauge."),
        FredSeries("PPIACO",           "PPI All Commodities", "Idx 1982", "M"),
        FredSeries("PPIFIS",           "PPI Final Demand", "Idx Nov2009", "M"),
        FredSeries("STICKCPIM157SFRBATL", "Sticky-Price CPI", "% YoY", "M",
                   note="Atlanta Fed cut — strips out volatile components."),
        FredSeries("MICH",             "U-Mich 1Y Inflation Expectations", "%", "M"),
        FredSeries("T5YIE",            "5Y Breakeven Inflation", "%", "D"),
        FredSeries("T10YIE",           "10Y Breakeven Inflation", "%", "D"),
        FredSeries("EXPINF1YR",        "Cleveland Fed 1Y Inflation Exp", "%", "M"),
    ],

    # ---- Employment ----
    "employment": [
        FredSeries("PAYEMS",   "Nonfarm Payrolls (Total)", "k", "M",
                   note="The headline jobs number reported the first Friday of every month."),
        FredSeries("UNRATE",   "Unemployment Rate", "%", "M"),
        FredSeries("U6RATE",   "U-6 Underemployment Rate", "%", "M"),
        FredSeries("CIVPART",  "Labor Force Participation Rate", "%", "M"),
        FredSeries("EMRATIO",  "Employment-Population Ratio", "%", "M"),
        FredSeries("JTSJOL",   "JOLTS: Job Openings", "k", "M"),
        FredSeries("JTSQUL",   "JOLTS: Quits Level", "k", "M",
                   note="Quits is a confidence signal — workers quit when alternatives look good."),
        FredSeries("JTSLDL",   "JOLTS: Layoffs & Discharges", "k", "M"),
        FredSeries("ICSA",     "Initial Jobless Claims", "k", "W"),
        FredSeries("CCSA",     "Continuing Claims", "k", "W"),
        FredSeries("CES0500000003", "Avg Hourly Earnings — Total Private", "$/hr", "M"),
        FredSeries("AHETPI",   "Avg Hourly Earnings — Production & Nonsupervisory", "$/hr", "M"),
        FredSeries("ECIWAG",   "Employment Cost Index — Wages", "Idx Dec05", "Q"),
    ],

    # ---- Housing ----
    "housing": [
        FredSeries("HOUST",      "Housing Starts", "k SAAR", "M"),
        FredSeries("PERMIT",     "Building Permits", "k SAAR", "M"),
        FredSeries("EXHOSLUSM495S", "Existing Home Sales", "k SAAR", "M"),
        FredSeries("HSN1F",      "New Single-Family Home Sales", "k SAAR", "M"),
        FredSeries("MSACSR",     "Months' Supply of New Houses", "months", "M"),
        FredSeries("CSUSHPISA",  "Case-Shiller National HPI", "Idx Jan00", "M",
                   note="Repeat-sales national home price index."),
        FredSeries("USSTHPI",    "FHFA US House Price Index", "Idx 1980Q1", "Q"),
        FredSeries("MORTGAGE30US", "30Y Fixed Mortgage Rate", "%", "W"),
        FredSeries("MORTGAGE15US", "15Y Fixed Mortgage Rate", "%", "W"),
        FredSeries("MEHOINUSA672N", "Real Median Household Income", "$ 2022", "A"),
    ],

    # ---- Manufacturing & Industry ----
    "manufacturing": [
        FredSeries("DGORDER",   "Durable Goods New Orders", "$M", "M"),
        FredSeries("AMTMNO",    "Manufacturing New Orders", "$M", "M"),
        FredSeries("AMTMUO",    "Manufacturing Unfilled Orders", "$M", "M"),
        FredSeries("BUSINV",    "Total Business Inventories", "$M", "M"),
        FredSeries("ISRATIO",   "Inventory/Sales Ratio", "ratio", "M"),
        FredSeries("NEWORDER",  "ISM Mfg New Orders (proxy)", "$M", "M"),
        FredSeries("IPMINE",    "Industrial Production: Mining", "Idx 2017=100", "M"),
        FredSeries("IPMAN",     "Industrial Production: Manufacturing", "Idx 2017=100", "M"),
        FredSeries("IPUTIL",    "Industrial Production: Utilities", "Idx 2017=100", "M"),
    ],

    # ---- Consumer ----
    "consumer": [
        FredSeries("UMCSENT",   "U-Mich Consumer Sentiment", "Idx 1966=100", "M"),
        FredSeries("RSXFS",     "Retail Sales ex Food Services", "$M SA", "M"),
        FredSeries("RSAFS",     "Advance Retail Sales", "$M SA", "M"),
        FredSeries("PCEC96",    "Real Personal Consumption Exp.", "$B 2017", "M"),
        FredSeries("DSPIC96",   "Real Disposable Personal Income", "$B 2017", "M"),
        FredSeries("PSAVERT",   "Personal Savings Rate", "%", "M"),
        FredSeries("CCLACBW027SBOG", "Commercial Bank Credit Card Loans", "$B", "W"),
        FredSeries("REVOLSL",   "Revolving Consumer Credit", "$B", "M"),
        FredSeries("TOTALSL",   "Total Consumer Credit Outstanding", "$B", "M"),
    ],

    # ---- Yields & Curves ----
    "yields": [
        FredSeries("DFF",       "Fed Funds Effective Rate", "%", "D"),
        FredSeries("DGS1MO",    "1M Treasury", "%", "D"),
        FredSeries("DGS3MO",    "3M Treasury", "%", "D"),
        FredSeries("DGS6MO",    "6M Treasury", "%", "D"),
        FredSeries("DGS1",      "1Y Treasury", "%", "D"),
        FredSeries("DGS2",      "2Y Treasury", "%", "D"),
        FredSeries("DGS5",      "5Y Treasury", "%", "D"),
        FredSeries("DGS7",      "7Y Treasury", "%", "D"),
        FredSeries("DGS10",     "10Y Treasury", "%", "D"),
        FredSeries("DGS20",     "20Y Treasury", "%", "D"),
        FredSeries("DGS30",     "30Y Treasury", "%", "D"),
        FredSeries("T10Y2Y",    "10Y-2Y Spread", "%", "D",
                   note="The 'recession curve.' Inversions historically precede recessions by 6-24 months."),
        FredSeries("T10Y3M",    "10Y-3M Spread", "%", "D",
                   note="NY Fed's preferred recession-probability gauge."),
        FredSeries("DFII10",    "10Y TIPS Yield (real)", "%", "D"),
        FredSeries("DFII5",     "5Y TIPS Yield (real)", "%", "D"),
        FredSeries("SOFR",      "SOFR Overnight Rate", "%", "D"),
    ],

    # ---- Credit Spreads ----
    "credit": [
        FredSeries("BAMLH0A0HYM2",  "ICE BofA HY Index OAS", "%", "D",
                   note="High-yield credit spread — stress indicator."),
        FredSeries("BAMLC0A0CM",    "ICE BofA IG Corp OAS", "%", "D"),
        FredSeries("BAMLH0A3HYC",   "ICE BofA CCC & Lower OAS", "%", "D"),
        FredSeries("BAMLC0A1CAAA",  "ICE BofA AAA Corp OAS", "%", "D"),
        FredSeries("BAMLEMCBPIOAS", "EM Corporate Bond OAS", "%", "D"),
        FredSeries("DRTSCILM",      "Banks Tightening C&I Loans (SLOOS)", "% net", "Q",
                   note="Quarterly senior loan officer survey — banks' willingness to lend."),
    ],

    # ---- Monetary & Fed ----
    "monetary": [
        FredSeries("M1SL",     "M1 Money Stock", "$B", "M"),
        FredSeries("M2SL",     "M2 Money Stock", "$B", "M"),
        FredSeries("WALCL",    "Fed Total Assets (Balance Sheet)", "$M", "W",
                   note="QE / QT visualization — Fed's balance sheet size."),
        FredSeries("BOGMBASE", "Monetary Base", "$M", "M"),
        FredSeries("RRPONTSYAWARD", "ON RRP Awarded", "$B", "D"),
        FredSeries("WLRRAL",   "Fed Reserves of Depository Institutions", "$M", "W"),
    ],

    # ---- FX / Currencies ----
    "fx": [
        FredSeries("DTWEXBGS", "Broad Dollar Index", "Idx Jan2006", "D",
                   note="The trade-weighted dollar — the truest measure of USD strength."),
        FredSeries("DEXUSEU",  "USD per EUR", "rate", "D"),
        FredSeries("DEXJPUS",  "JPY per USD", "rate", "D"),
        FredSeries("DEXCHUS",  "CNY per USD", "rate", "D"),
        FredSeries("DEXUSUK",  "USD per GBP", "rate", "D"),
        FredSeries("DEXCAUS",  "CAD per USD", "rate", "D"),
        FredSeries("DEXKOUS",  "KRW per USD", "rate", "D"),
        FredSeries("DEXMXUS",  "MXN per USD", "rate", "D"),
    ],

    # ---- Energy ----
    "energy": [
        FredSeries("DCOILWTICO",   "WTI Spot Crude Oil", "$/bbl", "D"),
        FredSeries("DCOILBRENTEU", "Brent Spot Crude Oil", "$/bbl", "D"),
        FredSeries("DHHNGSP",      "Henry Hub Natural Gas Spot", "$/MMBtu", "D"),
        FredSeries("GASREGW",      "US Regular Gasoline Price", "$/gal", "W"),
        FredSeries("DCOILWTIOK",   "WTI Crude — Cushing", "$/bbl", "D"),
        FredSeries("WCRSTUS1",     "US Commercial Crude Oil Stocks", "kbbl", "W",
                   note="Weekly EIA crude inventory — drives prices on Wednesday at 10:30am ET."),
        FredSeries("WGTSTUS1",     "US Gasoline Stocks", "kbbl", "W"),
        FredSeries("WDISTUS1",     "US Distillate Fuel Stocks", "kbbl", "W"),
        FredSeries("WCESTUS1",     "US Crude Oil Imports", "kbbl/day", "W"),
        FredSeries("IPG211111CN",  "Crude Oil Production Index", "Idx 2017", "M"),
    ],

    # ---- Trade ----
    "trade": [
        FredSeries("BOPGSTB",  "Trade Balance: Goods & Services", "$M", "M"),
        FredSeries("BOPGEXP",  "Exports of Goods", "$M", "M"),
        FredSeries("BOPGIMP",  "Imports of Goods", "$M", "M"),
        FredSeries("EXPGS",    "Exports of Goods & Services", "$B SAAR", "Q"),
        FredSeries("IMPGS",    "Imports of Goods & Services", "$B SAAR", "Q"),
        FredSeries("BOPSEXP",  "Exports of Services", "$M", "M"),
    ],

    # ---- Shipping & Freight ----
    "shipping": [
        FredSeries("RAILFRTCARLOADSD11", "Rail Freight Carloads", "k", "M",
                   note="Heavy industry's pulse — coal, chemicals, metals, autos move on rail."),
        FredSeries("TRUCKD11",   "Truck Tonnage Index", "Idx 2015=100", "M"),
        FredSeries("AMTMTI",     "Manufacturing & Trade Inventories", "$M", "M"),
        FredSeries("CFNAI",      "Chicago Fed National Activity Index", "Idx", "M",
                   note="A 85-indicator composite — a great single nowcasting signal."),
    ],

    # ---- Federal Finance ----
    "fiscal": [
        FredSeries("FYFR",      "Federal Receipts", "$B", "A"),
        FredSeries("FYONET",    "Federal Outlays Net", "$B", "A"),
        FredSeries("FYFSD",     "Federal Surplus or Deficit", "$M", "A"),
        FredSeries("GFDEBTN",   "Federal Debt: Total Public", "$M", "Q"),
        FredSeries("GFDEGDQ188S", "Federal Debt / GDP", "%", "Q",
                   note="The debt/GDP ratio — long-term sustainability signal."),
        FredSeries("FYFRGDA188S", "Federal Receipts / GDP", "%", "A"),
        FredSeries("FYONGDA188S", "Federal Outlays / GDP", "%", "A"),
    ],

    # ---- Regional Fed Surveys ----
    "regional": [
        FredSeries("GACDFSA066MSFRBPHI", "Philly Fed Mfg Activity Index", "Idx", "M"),
        FredSeries("GACDFSA066MSFRBNY",  "Empire State Mfg Survey", "Idx", "M",
                   note="New York Fed regional survey — early-cycle reading."),
        FredSeries("DRTSCILM",           "Banks Tightening C&I Loans", "% net", "Q"),
        FredSeries("GACDISA066MSFRBDAL", "Dallas Fed Mfg Production", "Idx", "M"),
        FredSeries("CFNAI",              "Chicago Fed National Activity Idx", "Idx", "M"),
        FredSeries("RESPPANWW",          "Fed H.4.1 Repurchase Agreements", "$M", "W"),
    ],
}


def all_series() -> list[FredSeries]:
    out: list[FredSeries] = []
    for cat in CATEGORY_ORDER:
        out.extend(CATALOG.get(cat, []))
    return out


def series_by_id(series_id: str) -> FredSeries | None:
    for s in all_series():
        if s.id == series_id:
            return s
    return None


def categories() -> list[dict]:
    return [
        {
            "id":    cat,
            "label": CATEGORY_LABEL.get(cat, cat),
            "count": len(CATALOG.get(cat, [])),
            "series": [
                {"id": s.id, "label": s.label, "unit": s.unit, "frequency": s.frequency, "note": s.note}
                for s in CATALOG.get(cat, [])
            ],
        }
        for cat in CATEGORY_ORDER
    ]
