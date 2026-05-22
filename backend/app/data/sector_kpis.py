"""Sector-specific KPI computation.

Each sector has a curated set of KPIs more meaningful than generic P/E.
All data pulled from yfinance .info (free, no API key required).

Computes per-stock KPI values then returns the sector median alongside
the per-stock breakdown so the frontend can show both aggregate and detail.
"""
from __future__ import annotations

import logging
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

log = logging.getLogger(__name__)

# ── KPI definitions per sector ───────────────────────────────────────────────
# Each entry: key (internal), label (display), unit, desc (tooltip text)

SECTOR_KPI_DEFS: dict[str, list[dict]] = {
    "technology": [
        {"key": "rule_of_40",     "label": "Rule of 40",     "unit": "%",   "desc": "Revenue growth % + FCF margin % — SaaS health benchmark"},
        {"key": "fcf_margin",     "label": "FCF Margin",     "unit": "%",   "desc": "Free cash flow / revenue"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Gross profit / revenue"},
        {"key": "rd_pct",         "label": "R&D / Revenue",  "unit": "%",   "desc": "Research spend intensity"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Year-over-year revenue growth"},
    ],
    "semiconductors": [
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Chip-level gross margin — key cycle indicator"},
        {"key": "rd_pct",         "label": "R&D / Revenue",  "unit": "%",   "desc": "R&D investment intensity"},
        {"key": "inventory_days", "label": "Inventory Days", "unit": "days","desc": "Days of inventory on hand — demand signal"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Cycle position indicator"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Operating leverage"},
    ],
    "real_estate": [
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Annual dividend / price — primary REIT return"},
        {"key": "price_to_book",  "label": "Price / Book",   "unit": "x",   "desc": "P/B ratio — proxy for NAV premium/discount"},
        {"key": "payout_ratio",   "label": "Payout Ratio",   "unit": "%",   "desc": "Dividends paid / earnings"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Leverage ratio"},
        {"key": "fcf_yield",      "label": "FCF Yield",      "unit": "%",   "desc": "Free cash flow / market cap"},
    ],
    "oil_gas": [
        {"key": "ev_ebitda",      "label": "EV / EBITDA",    "unit": "x",   "desc": "Enterprise value multiple — E&P primary metric"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Income component"},
        {"key": "fcf_yield",      "label": "FCF Yield",      "unit": "%",   "desc": "Free cash flow yield at current strip"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Balance sheet leverage"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Upstream/downstream spread"},
    ],
    "financials": [
        {"key": "price_to_book",  "label": "Price / Book",   "unit": "x",   "desc": "P/B — primary bank valuation metric"},
        {"key": "roe",            "label": "ROE",             "unit": "%",   "desc": "Return on equity"},
        {"key": "roa",            "label": "ROA",             "unit": "%",   "desc": "Return on assets"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Annual yield"},
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Trailing price / earnings"},
    ],
    "healthcare": [
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Product/service margin"},
        {"key": "rd_pct",         "label": "R&D / Revenue",  "unit": "%",   "desc": "Pipeline investment intensity"},
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Trailing earnings multiple"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Income component (large-cap pharma)"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Volume + pricing growth"},
    ],
    "biotech": [
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Commercialized product margin"},
        {"key": "rd_pct",         "label": "R&D / Revenue",  "unit": "%",   "desc": "Pipeline burn rate"},
        {"key": "price_to_sales", "label": "Price / Sales",  "unit": "x",   "desc": "Pre-profit valuation"},
        {"key": "cash_to_mcap",   "label": "Cash / Mkt Cap", "unit": "%",   "desc": "Cash runway signal"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Commercialization traction"},
    ],
    "consumer_discretionary": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Consumer confidence proxy"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Pricing power"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Consumer spending health"},
        {"key": "fcf_margin",     "label": "FCF Margin",     "unit": "%",   "desc": "Cash generation"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Operating leverage"},
    ],
    "industrials": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Cycle-adjusted earnings"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Operational efficiency"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Order book health"},
        {"key": "fcf_yield",      "label": "FCF Yield",      "unit": "%",   "desc": "Cash generation vs. market cap"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Payout to shareholders"},
    ],
    "consumer_staples": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Defensive premium"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Defensive income"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Brand/pricing power"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Volume vs. pricing mix"},
        {"key": "payout_ratio",   "label": "Payout Ratio",   "unit": "%",   "desc": "Dividend sustainability"},
    ],
    "utilities": [
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Primary return component"},
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Rate-base earnings multiple"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Regulated leverage"},
        {"key": "payout_ratio",   "label": "Payout Ratio",   "unit": "%",   "desc": "Dividend coverage"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Regulatory-allowed margin"},
    ],
    "materials": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Commodity cycle valuation"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Cyclical income"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Commodity spread"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Capital intensity"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Volume + price mix"},
    ],
    "communication_services": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Earnings multiple"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Platform margin"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "User + monetization growth"},
        {"key": "fcf_margin",     "label": "FCF Margin",     "unit": "%",   "desc": "Cash generation"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Operating leverage"},
    ],
    "clean_energy": [
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Adoption trajectory"},
        {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Technology maturity"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Project financing load"},
        {"key": "price_to_sales", "label": "Price / Sales",  "unit": "x",   "desc": "Growth premium"},
        {"key": "fcf_margin",     "label": "FCF Margin",     "unit": "%",   "desc": "Path to profitability"},
    ],
    "defense_aerospace": [
        {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Defense budget multiple"},
        {"key": "operating_margin","label": "Op Margin",     "unit": "%",   "desc": "Contract profitability"},
        {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Shareholder return"},
        {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Balance sheet health"},
        {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Contract wins / budget growth"},
    ],
}

# Default KPIs for any sector not in the table above.
DEFAULT_KPI_DEFS = [
    {"key": "pe_ratio",       "label": "P/E Ratio",      "unit": "x",   "desc": "Trailing price / earnings"},
    {"key": "gross_margin",   "label": "Gross Margin",   "unit": "%",   "desc": "Gross profit margin"},
    {"key": "revenue_growth", "label": "Rev Growth YoY", "unit": "%",   "desc": "Year-over-year revenue growth"},
    {"key": "dividend_yield", "label": "Dividend Yield", "unit": "%",   "desc": "Annual dividend / price"},
    {"key": "debt_to_equity", "label": "Debt / Equity",  "unit": "x",   "desc": "Leverage ratio"},
]


# ── Per-stock KPI fetch ──────────────────────────────────────────────────────

def _fetch_stock_kpis(symbol: str) -> dict:
    """Pull all KPI source fields from yfinance .info for one symbol."""
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}

        market_cap     = info.get("marketCap") or 0
        total_revenue  = info.get("totalRevenue") or 0
        free_cashflow  = info.get("freeCashflow")
        total_cash     = info.get("totalCash")
        inventory      = info.get("inventory") or 0
        cost_of_revenue = info.get("costOfRevenue") or 0
        rd_expense     = info.get("researchAndDevelopment")

        # Derived fields
        fcf_margin: Optional[float] = None
        if free_cashflow is not None and total_revenue > 0:
            fcf_margin = free_cashflow / total_revenue * 100

        fcf_yield: Optional[float] = None
        if free_cashflow is not None and market_cap > 0:
            fcf_yield = free_cashflow / market_cap * 100

        rd_pct: Optional[float] = None
        if rd_expense is not None and total_revenue > 0:
            rd_pct = rd_expense / total_revenue * 100

        revenue_growth: Optional[float] = None
        rg = info.get("revenueGrowth")
        if rg is not None:
            revenue_growth = rg * 100

        gross_margin: Optional[float] = None
        gm = info.get("grossMargins")
        if gm is not None:
            gross_margin = gm * 100

        operating_margin: Optional[float] = None
        om = info.get("operatingMargins")
        if om is not None:
            operating_margin = om * 100

        roe: Optional[float] = None
        r = info.get("returnOnEquity")
        if r is not None:
            roe = r * 100

        roa: Optional[float] = None
        ra = info.get("returnOnAssets")
        if ra is not None:
            roa = ra * 100

        dividend_yield: Optional[float] = None
        dy = info.get("dividendYield")
        if dy is not None:
            dividend_yield = dy * 100

        payout_ratio: Optional[float] = None
        pr = info.get("payoutRatio")
        if pr is not None:
            payout_ratio = pr * 100

        rule_of_40: Optional[float] = None
        if revenue_growth is not None and fcf_margin is not None:
            rule_of_40 = revenue_growth + fcf_margin

        cash_to_mcap: Optional[float] = None
        if total_cash and market_cap > 0:
            cash_to_mcap = total_cash / market_cap * 100

        inventory_days: Optional[float] = None
        if inventory > 0 and cost_of_revenue > 0:
            inventory_days = inventory / cost_of_revenue * 365

        return {
            "symbol":          symbol,
            "rule_of_40":      rule_of_40,
            "fcf_margin":      fcf_margin,
            "fcf_yield":       fcf_yield,
            "rd_pct":          rd_pct,
            "revenue_growth":  revenue_growth,
            "gross_margin":    gross_margin,
            "operating_margin":operating_margin,
            "pe_ratio":        info.get("trailingPE") or info.get("forwardPE"),
            "ev_ebitda":       info.get("enterpriseToEbitda"),
            "price_to_book":   info.get("priceToBook"),
            "price_to_sales":  info.get("priceToSalesTrailing12Months"),
            "debt_to_equity":  info.get("debtToEquity"),
            "dividend_yield":  dividend_yield,
            "payout_ratio":    payout_ratio,
            "roe":             roe,
            "roa":             roa,
            "cash_to_mcap":    cash_to_mcap,
            "inventory_days":  inventory_days,
        }
    except Exception as exc:
        log.warning("KPI fetch for %s failed: %s", symbol, exc)
        return {"symbol": symbol}


def _safe_median(values: list) -> Optional[float]:
    valid = [v for v in values if v is not None and isinstance(v, (int, float)) and not (v != v)]
    if not valid:
        return None
    try:
        return statistics.median(valid)
    except Exception:
        return None


# ── Public API ───────────────────────────────────────────────────────────────

def sector_kpis(sector_id: str, stocks: list[str]) -> dict:
    """Compute KPIs for a sector.

    Returns:
      {
        "kpi_defs": [...],          # ordered label/unit/desc for rendering
        "sector_medians": {...},    # {kpi_key: median_value}
        "stocks": [                 # per-stock breakdown
          {"symbol": ..., "kpi_key": value, ...}
        ]
      }
    """
    kpi_defs = SECTOR_KPI_DEFS.get(sector_id, DEFAULT_KPI_DEFS)
    kpi_keys = {d["key"] for d in kpi_defs}

    # Fetch top 8 stocks in parallel (capped to keep latency reasonable)
    target_stocks = stocks[:8]
    stock_data: dict[str, dict] = {}

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_stock_kpis, sym): sym for sym in target_stocks}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                stock_data[sym] = fut.result()
            except Exception as exc:
                log.warning("KPI future for %s: %s", sym, exc)
                stock_data[sym] = {"symbol": sym}

    # Ordered per-stock rows (preserve sector order)
    stock_rows = []
    for sym in target_stocks:
        row = stock_data.get(sym, {"symbol": sym})
        stock_rows.append({k: row.get(k) for k in ["symbol"] + list(kpi_keys)})

    # Sector medians
    medians: dict[str, Optional[float]] = {}
    for key in kpi_keys:
        values = [stock_data[sym].get(key) for sym in target_stocks if sym in stock_data]
        medians[key] = _safe_median(values)

    return {
        "sector_id":      sector_id,
        "kpi_defs":       kpi_defs,
        "sector_medians": medians,
        "stocks":         stock_rows,
    }
