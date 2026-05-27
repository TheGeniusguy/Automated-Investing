"""Enrich open positions with live market data from yfinance.

Fetches current price, previous close, 52-week range, beta, PE, dividend yield,
and computes market-value stats per position.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from .positions import Position

log = logging.getLogger(__name__)

_CHUNK = 10  # max symbols per yfinance batch download


def _yf_info(symbol: str) -> dict:
    """Single-symbol yfinance .info with graceful fallback."""
    try:
        import yfinance as yf
        return yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("yf.info(%s) failed: %s", symbol, e)
        return {}


def _latest_price_fallback(symbol: str) -> tuple[float | None, float | None]:
    """Use price history as last-resort price source."""
    from ..data.macro_data import fetch_arbitrary_ticker
    pts = fetch_arbitrary_ticker(symbol, days=10)
    if not pts:
        return None, None
    current = pts[-1]["value"]
    prev = pts[-2]["value"] if len(pts) >= 2 else current
    return current, prev


def enrich_positions(
    positions: list[Position],
    cash_balance: float,
) -> tuple[list[dict], dict]:
    """
    Enrich each position with live price data and computed P&L metrics.

    Returns:
        enriched   — list of per-position dicts with all computed fields
        summary    — portfolio-level totals dict
    """
    today = date.today()
    ytd_start = date(today.year, 1, 1)
    ytd_days = (today - ytd_start).days + 10

    enriched: list[dict] = []
    total_market_value = 0.0

    for pos in positions:
        info = _yf_info(pos.symbol)

        current = (
            info.get("regularMarketPrice")
            or info.get("currentPrice")
            or info.get("navPrice")
        )
        prev_close = info.get("previousClose") or info.get("regularMarketPreviousClose")

        if not current:
            current, prev_close = _latest_price_fallback(pos.symbol)

        current = float(current) if current else pos.avg_cost
        prev_close = float(prev_close) if prev_close else current

        day_change = current - prev_close
        day_change_pct = (day_change / prev_close * 100) if prev_close else 0.0

        market_value = pos.shares * current
        total_market_value += market_value
        cost = pos.total_cost
        unreal_pl = market_value - cost
        unreal_pl_pct = (unreal_pl / cost * 100) if cost > 0 else 0.0

        hi52 = info.get("fiftyTwoWeekHigh")
        lo52 = info.get("fiftyTwoWeekLow")
        pct_from_hi = ((current - hi52) / hi52 * 100) if hi52 else None

        # YTD: fetch price history from Jan 1 → compute return
        ytd_return_pct = None
        try:
            from ..data.macro_data import fetch_arbitrary_ticker
            pts = fetch_arbitrary_ticker(pos.symbol, days=ytd_days)
            jan1 = str(ytd_start)
            prior_prices = [p["value"] for p in pts if p["date"] < jan1 and p["value"]]
            first_prices = [p["value"] for p in pts if p["date"] >= jan1 and p["value"]]
            ytd_start_price = prior_prices[-1] if prior_prices else (first_prices[0] if first_prices else None)
            if ytd_start_price:
                ytd_return_pct = (current / ytd_start_price - 1) * 100
        except Exception:
            pass

        enriched.append({
            "symbol":           pos.symbol,
            "name":             info.get("longName") or info.get("shortName") or pos.symbol,
            "sector":           info.get("sector"),
            "industry":         info.get("industry"),
            "shares":           pos.shares,
            "avg_cost":         round(pos.avg_cost, 4),
            "total_cost":       round(cost, 2),
            "current_price":    round(current, 4),
            "prev_close":       round(prev_close, 4),
            "day_change":       round(day_change, 4),
            "day_change_pct":   round(day_change_pct, 4),
            "market_value":     round(market_value, 2),
            "unrealized_pl":    round(unreal_pl, 2),
            "unrealized_pl_pct":round(unreal_pl_pct, 4),
            "realized_pl":      round(pos.realized_pl, 2),
            "total_pl":         round(unreal_pl + pos.realized_pl, 2),
            "52w_high":         hi52,
            "52w_low":          lo52,
            "pct_from_52w_high":round(pct_from_hi, 2) if pct_from_hi is not None else None,
            "ytd_return_pct":   round(ytd_return_pct, 2) if ytd_return_pct is not None else None,
            "beta":             info.get("beta"),
            "volume":           info.get("regularMarketVolume") or info.get("volume"),
            "avg_volume":       info.get("averageVolume") or info.get("averageDailyVolume10Day"),
            "market_cap":       info.get("marketCap"),
            "pe_ratio":         info.get("trailingPE"),
            "forward_pe":       info.get("forwardPE"),
            "dividend_yield":   info.get("dividendYield"),
            "dividend_rate":    info.get("dividendRate"),
            "portfolio_weight": None,  # filled after total is known
            "lots": [
                {
                    "quantity":       round(lot.quantity, 6),
                    "cost_per_share": round(lot.cost_per_share, 4),
                    "trade_date":     lot.trade_date,
                }
                for lot in pos.lots
            ],
        })

    # Fill portfolio weights and day P&L
    total_value = total_market_value + cash_balance
    for p in enriched:
        p["portfolio_weight"] = round(
            (p["market_value"] / total_value * 100) if total_value > 0 else 0.0, 2
        )
        p["day_pl"] = round(p["day_change"] * p["shares"], 2)
        p["cash_weight"] = round((cash_balance / total_value * 100) if total_value > 0 else 0.0, 2)

    total_cost   = sum(p["total_cost"] for p in enriched)
    total_unreal = sum(p["unrealized_pl"] for p in enriched)
    total_real   = sum(p["realized_pl"] for p in enriched)
    total_day_pl = sum(p["day_pl"] for p in enriched)

    summary = {
        "total_market_value":  round(total_market_value, 2),
        "cash_balance":        round(cash_balance, 2),
        "total_value":         round(total_value, 2),
        "total_cost_basis":    round(total_cost, 2),
        "total_unrealized_pl": round(total_unreal, 2),
        "total_realized_pl":   round(total_real, 2),
        "total_pl":            round(total_unreal + total_real, 2),
        "total_pl_pct":        round(((total_unreal + total_real) / total_cost * 100) if total_cost > 0 else 0.0, 2),
        "total_day_pl":        round(total_day_pl, 2),
        "total_day_pl_pct":    round(
            (total_day_pl / (total_value - total_day_pl) * 100)
            if (total_value - total_day_pl) > 0 else 0.0, 2
        ),
        "position_count":      len(enriched),
        "cash_pct":            round((cash_balance / total_value * 100) if total_value > 0 else 0.0, 2),
    }

    return enriched, summary
