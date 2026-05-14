"""Quarterly fundamentals ingestion.

yfinance exposes the income statement, balance sheet, and cash flow as wide
DataFrames indexed by date (period_end). We pull all three, line them up on
the common quarter ends, and upsert one row per (symbol, period_end) into
fundamentals_quarterly.

Margins are computed once and persisted so the panel can show them without
recomputing on every request.
"""
from __future__ import annotations

import logging
from datetime import datetime

from ..db import engine

log = logging.getLogger(__name__)


# yfinance's row labels are not stable across versions — define a small
# resolver that tries multiple candidates and returns the first non-null value.
INCOME_KEYS = {
    "revenue":          ["Total Revenue", "Revenue", "TotalRevenue", "Operating Revenue"],
    "gross_profit":     ["Gross Profit", "GrossProfit"],
    "operating_income": ["Operating Income", "OperatingIncome"],
    "net_income":       ["Net Income", "NetIncome", "Net Income Common Stockholders"],
    "eps_basic":        ["Basic EPS", "BasicEPS"],
    "eps_diluted":      ["Diluted EPS", "DilutedEPS"],
}

BALANCE_KEYS = {
    "total_assets":      ["Total Assets", "TotalAssets"],
    "total_liabilities": ["Total Liabilities Net Minority Interest", "Total Liab", "TotalLiabilities"],
    "total_equity":      ["Stockholders Equity", "Total Equity Gross Minority Interest", "TotalEquity"],
    "cash_and_equiv":    ["Cash And Cash Equivalents", "Cash", "CashAndCashEquivalents"],
    "long_term_debt":    ["Long Term Debt", "LongTermDebt"],
}

CASHFLOW_KEYS = {
    "operating_cash_flow": ["Operating Cash Flow", "OperatingCashFlow", "Cash Flow From Continuing Operating Activities"],
    "capex":               ["Capital Expenditure", "CapitalExpenditures"],
    "free_cash_flow":      ["Free Cash Flow", "FreeCashFlow"],
}


def _yf():
    import yfinance as yf
    return yf


def _first_value(df, date_col, candidate_labels: list[str]) -> float | None:
    """Look up a value in a yfinance fundamentals DataFrame, trying multiple
    candidate row labels. Returns None on miss or NaN.
    """
    if df is None or df.empty:
        return None
    if date_col not in df.columns:
        return None
    for label in candidate_labels:
        if label in df.index:
            v = df.at[label, date_col]
            try:
                f = float(v)
                if f == f:  # NaN check
                    return f
            except (TypeError, ValueError):
                continue
    return None


def _resolve_keys(df, date_col, keys_map: dict[str, list[str]]) -> dict[str, float | None]:
    return {k: _first_value(df, date_col, labels) for k, labels in keys_map.items()}


def _safe_margin(num: float | None, den: float | None) -> float | None:
    if num is None or den is None or den == 0:
        return None
    return num / den


def ingest_fundamentals(symbol: str) -> dict:
    yf = _yf()
    symbol = symbol.upper().strip()
    run_id = engine.etl_start("fundamentals", target=symbol)
    error: str | None = None
    written = 0

    try:
        t = yf.Ticker(symbol)
        income   = t.quarterly_income_stmt
        balance  = t.quarterly_balance_sheet
        cashflow = t.quarterly_cashflow

        # The income stmt is the source of truth for "what quarters exist";
        # balance and cashflow are pulled if they overlap.
        if income is None or income.empty:
            engine.etl_finish(run_id, status="ok", note="empty (no quarterly statement)")
            return {"symbol": symbol, "rows": 0, "error": "no quarterly income statement", "run_id": run_id}

        with engine.conn() as c:
            for date_col in income.columns:
                period_end = date_col.strftime("%Y-%m-%d") if hasattr(date_col, "strftime") else str(date_col)
                period_label = _period_label(period_end)

                income_vals   = _resolve_keys(income,   date_col, INCOME_KEYS)
                balance_vals  = _resolve_keys(balance,  date_col, BALANCE_KEYS)
                cashflow_vals = _resolve_keys(cashflow, date_col, CASHFLOW_KEYS)

                revenue = income_vals["revenue"]
                gross_margin     = _safe_margin(income_vals["gross_profit"],     revenue)
                operating_margin = _safe_margin(income_vals["operating_income"], revenue)
                net_margin       = _safe_margin(income_vals["net_income"],       revenue)

                try:
                    c.execute(
                        """
                        INSERT INTO fundamentals_quarterly (
                            symbol, period_end, period_label,
                            revenue, gross_profit, operating_income, net_income,
                            eps_basic, eps_diluted,
                            total_assets, total_liabilities, total_equity, cash_and_equiv, long_term_debt,
                            operating_cash_flow, capex, free_cash_flow,
                            gross_margin, operating_margin, net_margin,
                            source, ingested_at
                        ) VALUES (
                            ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?,
                            ?, ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            'yfinance', current_timestamp
                        )
                        ON CONFLICT (symbol, period_end) DO UPDATE SET
                            period_label = EXCLUDED.period_label,
                            revenue = EXCLUDED.revenue,
                            gross_profit = EXCLUDED.gross_profit,
                            operating_income = EXCLUDED.operating_income,
                            net_income = EXCLUDED.net_income,
                            eps_basic = EXCLUDED.eps_basic,
                            eps_diluted = EXCLUDED.eps_diluted,
                            total_assets = EXCLUDED.total_assets,
                            total_liabilities = EXCLUDED.total_liabilities,
                            total_equity = EXCLUDED.total_equity,
                            cash_and_equiv = EXCLUDED.cash_and_equiv,
                            long_term_debt = EXCLUDED.long_term_debt,
                            operating_cash_flow = EXCLUDED.operating_cash_flow,
                            capex = EXCLUDED.capex,
                            free_cash_flow = EXCLUDED.free_cash_flow,
                            gross_margin = EXCLUDED.gross_margin,
                            operating_margin = EXCLUDED.operating_margin,
                            net_margin = EXCLUDED.net_margin,
                            ingested_at = now()
                        """,
                        [
                            symbol, period_end, period_label,
                            revenue, income_vals["gross_profit"], income_vals["operating_income"], income_vals["net_income"],
                            income_vals["eps_basic"], income_vals["eps_diluted"],
                            balance_vals["total_assets"], balance_vals["total_liabilities"], balance_vals["total_equity"],
                            balance_vals["cash_and_equiv"], balance_vals["long_term_debt"],
                            cashflow_vals["operating_cash_flow"], cashflow_vals["capex"], cashflow_vals["free_cash_flow"],
                            gross_margin, operating_margin, net_margin,
                        ],
                    )
                    written += 1
                except Exception as e:
                    log.warning("fundamentals upsert failed for %s %s: %s", symbol, period_end, e)

        engine.etl_finish(run_id, status="ok", rows_in=len(income.columns), rows_out=written)
    except Exception as e:
        log.exception("ingest_fundamentals failed for %s", symbol)
        error = str(e)
        engine.etl_finish(run_id, status="error", note=error)

    return {"symbol": symbol, "rows": written, "error": error, "run_id": run_id}


def ingest_fundamentals_batch(symbols: list[str]) -> dict:
    started = datetime.utcnow()
    per_symbol = [ingest_fundamentals(s) for s in symbols if s.strip()]
    elapsed = (datetime.utcnow() - started).total_seconds()
    return {
        "per_symbol": per_symbol,
        "total_rows": sum(p["rows"] for p in per_symbol),
        "elapsed_s":  round(elapsed, 2),
    }


def _period_label(period_end: str) -> str:
    try:
        d = datetime.strptime(period_end, "%Y-%m-%d")
        return f"Q{(d.month - 1) // 3 + 1} {d.year}"
    except Exception:
        return period_end
