"""Dividend income analytics per position."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def _unix_to_iso(ts) -> str | None:
    """Convert a unix timestamp int to an ISO date string (YYYY-MM-DD). Returns None on failure."""
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return None


def compute_dividend_income(enriched_positions: list[dict]) -> dict:
    """
    enriched_positions: output from valuation.enrich_positions (has symbol, shares,
    current_price, market_value).

    For each position:
    - trailing_12m_div_per_share: dividendRate from yfinance info
    - dividend_yield_pct: dividendYield * 100
    - annual_income: dividendRate * shares (if dividendRate)
    - next_ex_date: exDividendDate (unix timestamp -> ISO date string)
    - payout_ratio_pct: payoutRatio * 100

    Portfolio-level:
    - total_annual_income: sum of all position annual_income
    - portfolio_yield_pct: total_annual_income / total_portfolio_value * 100
    - monthly_income: total_annual_income / 12
    - income_positions: positions that pay dividends, sorted by annual_income desc

    Return structure:
    {
        "positions": [per-position dict with above fields],
        "total_annual_income": float,
        "portfolio_yield_pct": float,
        "monthly_income": float,
        "income_positions_count": int,
    }
    """
    import yfinance as yf

    positions_out: list[dict] = []
    total_portfolio_value = sum(p.get("market_value") or 0.0 for p in enriched_positions)

    for pos in enriched_positions:
        symbol = pos.get("symbol", "")
        shares = float(pos.get("shares") or 0.0)

        # Try to fetch dividend info from yfinance
        try:
            info = yf.Ticker(symbol).info or {}
        except Exception as e:
            log.warning("compute_dividend_income yf.info(%s) failed: %s", symbol, e)
            info = {}

        dividend_rate = info.get("dividendRate")  # trailing 12m per share
        dividend_yield = info.get("dividendYield")
        ex_div_date_raw = info.get("exDividendDate")
        payout_ratio = info.get("payoutRatio")

        trailing_12m_div_per_share: float | None = None
        if dividend_rate is not None:
            try:
                trailing_12m_div_per_share = round(float(dividend_rate), 4)
            except (TypeError, ValueError):
                pass

        dividend_yield_pct: float | None = None
        if dividend_yield is not None:
            try:
                dividend_yield_pct = round(float(dividend_yield) * 100, 4)
            except (TypeError, ValueError):
                pass

        annual_income: float | None = None
        if trailing_12m_div_per_share is not None and shares > 0:
            annual_income = round(trailing_12m_div_per_share * shares, 2)

        next_ex_date = _unix_to_iso(ex_div_date_raw)

        payout_ratio_pct: float | None = None
        if payout_ratio is not None:
            try:
                payout_ratio_pct = round(float(payout_ratio) * 100, 2)
            except (TypeError, ValueError):
                pass

        positions_out.append({
            "symbol":                    symbol,
            "shares":                    shares,
            "market_value":              pos.get("market_value"),
            "trailing_12m_div_per_share": trailing_12m_div_per_share,
            "dividend_yield_pct":        dividend_yield_pct,
            "annual_income":             annual_income,
            "next_ex_date":              next_ex_date,
            "payout_ratio_pct":          payout_ratio_pct,
        })

    # Portfolio-level aggregates
    total_annual_income = sum(
        p["annual_income"] for p in positions_out if p["annual_income"] is not None
    )
    total_annual_income = round(total_annual_income, 2)

    portfolio_yield_pct = 0.0
    if total_portfolio_value > 0:
        portfolio_yield_pct = round(total_annual_income / total_portfolio_value * 100, 4)

    monthly_income = round(total_annual_income / 12, 2)

    income_positions = sorted(
        [p for p in positions_out if p.get("annual_income")],
        key=lambda x: -(x["annual_income"] or 0.0),
    )
    income_positions_count = len(income_positions)

    return {
        "positions": positions_out,
        "total_annual_income": total_annual_income,
        "portfolio_yield_pct": portfolio_yield_pct,
        "monthly_income": monthly_income,
        "income_positions_count": income_positions_count,
    }
