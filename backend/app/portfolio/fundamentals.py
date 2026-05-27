"""Per-position fundamental metrics sourced from yfinance .info."""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def enrich_fundamentals(symbols: list[str]) -> dict[str, dict]:
    """
    For each symbol return a dict of fundamental metrics.
    Source: yfinance Ticker(symbol).info -- single call per symbol.

    Returns per symbol:
    - pe_ttm: trailingPE
    - forward_pe: forwardPE
    - ps_ttm: priceToSalesTrailing12Months
    - pb: priceToBook
    - ev_ebitda: enterpriseToEbitda
    - ev: enterpriseValue
    - revenue_ttm: totalRevenue
    - revenue_growth_yoy: revenueGrowth (as %)
    - earnings_growth_yoy: earningsGrowth (as %)
    - gross_margin: grossMargins (as %)
    - operating_margin: operatingMargins (as %)
    - net_margin: profitMargins (as %)
    - fcf_yield: freeCashflow / marketCap (as %)
    - debt_to_equity: debtToEquity
    - return_on_equity: returnOnEquity (as %)
    - return_on_assets: returnOnAssets (as %)
    - current_ratio: currentRatio
    - quick_ratio: quickRatio
    - shares_outstanding: sharesOutstanding
    - float_shares: floatShares
    - short_ratio: shortRatio
    - short_pct_float: shortPercentOfFloat (as %)
    - book_value: bookValue
    - eps_ttm: trailingEps
    - eps_forward: forwardEps
    - peg_ratio: pegRatio
    """
    import yfinance as yf

    result: dict[str, dict] = {}

    for symbol in symbols:
        try:
            info = yf.Ticker(symbol).info or {}
            result[symbol] = _parse_fundamentals(symbol, info)
        except Exception as e:
            log.warning("enrich_fundamentals(%s) failed: %s", symbol, e)
            result[symbol] = {}

    return result


def _pct(value) -> float | None:
    """Multiply by 100 and round to 2 decimals; return None if value is None."""
    if value is None:
        return None
    try:
        return round(float(value) * 100, 2)
    except (TypeError, ValueError):
        return None


def _f(value, decimals: int = 2) -> float | None:
    """Round a float to given decimals; return None if value is None."""
    if value is None:
        return None
    try:
        return round(float(value), decimals)
    except (TypeError, ValueError):
        return None


def _parse_fundamentals(symbol: str, info: dict) -> dict:
    market_cap = info.get("marketCap")
    free_cash_flow = info.get("freeCashflow")

    fcf_yield: float | None = None
    if free_cash_flow is not None and market_cap and market_cap > 0:
        try:
            fcf_yield = round(float(free_cash_flow) / float(market_cap) * 100, 2)
        except (TypeError, ValueError, ZeroDivisionError):
            fcf_yield = None

    return {
        "symbol":                symbol,
        "pe_ttm":                _f(info.get("trailingPE"), 2),
        "forward_pe":            _f(info.get("forwardPE"), 2),
        "ps_ttm":                _f(info.get("priceToSalesTrailing12Months"), 2),
        "pb":                    _f(info.get("priceToBook"), 2),
        "ev_ebitda":             _f(info.get("enterpriseToEbitda"), 2),
        "ev":                    info.get("enterpriseValue"),
        "revenue_ttm":           info.get("totalRevenue"),
        "revenue_growth_yoy":    _pct(info.get("revenueGrowth")),
        "earnings_growth_yoy":   _pct(info.get("earningsGrowth")),
        "gross_margin":          _pct(info.get("grossMargins")),
        "operating_margin":      _pct(info.get("operatingMargins")),
        "net_margin":            _pct(info.get("profitMargins")),
        "fcf_yield":             fcf_yield,
        "debt_to_equity":        _f(info.get("debtToEquity"), 2),
        "return_on_equity":      _pct(info.get("returnOnEquity")),
        "return_on_assets":      _pct(info.get("returnOnAssets")),
        "current_ratio":         _f(info.get("currentRatio"), 2),
        "quick_ratio":           _f(info.get("quickRatio"), 2),
        "shares_outstanding":    info.get("sharesOutstanding"),
        "float_shares":          info.get("floatShares"),
        "short_ratio":           _f(info.get("shortRatio"), 2),
        "short_pct_float":       _pct(info.get("shortPercentOfFloat")),
        "book_value":            _f(info.get("bookValue"), 2),
        "eps_ttm":               _f(info.get("trailingEps"), 4),
        "eps_forward":           _f(info.get("forwardEps"), 4),
        "peg_ratio":             _f(info.get("pegRatio"), 2),
    }
