"""Compare module -- side-by-side performance comparison for any tickers.

Provides:
  1. Normalized price series (rebased to 100) for chart overlay
  2. Returns comparison table with Sharpe, max drawdown, volatility, correlation
  3. Portfolio simulator with weighted blended metrics

All data from yfinance (free).
"""
from __future__ import annotations

import logging
import math
from typing import Optional

from . import macro_data

log = logging.getLogger(__name__)


def _load_prices(symbol: str, days: int) -> list[dict]:
    """Load (date, close) as dicts."""
    try:
        points = macro_data.fetch_arbitrary_ticker(symbol, days=max(days * 2, 60))
        return [{"date": p["date"], "close": p["value"]}
                for p in points if p.get("value") is not None]
    except Exception as e:
        log.warning("Failed to load %s: %s", symbol, e)
        return []


def _daily_returns(prices: list[dict]) -> list[float]:
    """Compute daily percentage returns."""
    rets = []
    for i in range(1, len(prices)):
        prev = prices[i - 1]["close"]
        cur = prices[i]["close"]
        if prev and prev > 0:
            rets.append((cur - prev) / prev)
        else:
            rets.append(0.0)
    return rets


def _annualized_return(prices: list[dict]) -> Optional[float]:
    if len(prices) < 2:
        return None
    start = prices[0]["close"]
    end = prices[-1]["close"]
    if not start or start <= 0:
        return None
    total = end / start
    trading_days = len(prices) - 1
    years = trading_days / 252.0
    if years <= 0:
        return None
    return (total ** (1.0 / years) - 1.0) * 100.0


def _total_return(prices: list[dict]) -> Optional[float]:
    if len(prices) < 2:
        return None
    start = prices[0]["close"]
    end = prices[-1]["close"]
    if not start or start <= 0:
        return None
    return (end - start) / start * 100.0


def _volatility(daily_rets: list[float]) -> Optional[float]:
    if len(daily_rets) < 2:
        return None
    mean = sum(daily_rets) / len(daily_rets)
    variance = sum((r - mean) ** 2 for r in daily_rets) / (len(daily_rets) - 1)
    return math.sqrt(variance) * math.sqrt(252) * 100.0  # annualized %


def _max_drawdown(prices: list[dict]) -> Optional[float]:
    if len(prices) < 2:
        return None
    peak = prices[0]["close"]
    max_dd = 0.0
    for p in prices:
        if p["close"] > peak:
            peak = p["close"]
        dd = (peak - p["close"]) / peak if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd
    return max_dd * 100.0


def _sharpe_ratio(daily_rets: list[float], risk_free_annual: float = 4.5) -> Optional[float]:
    if len(daily_rets) < 30:
        return None
    rf_daily = risk_free_annual / 100.0 / 252.0
    excess = [r - rf_daily for r in daily_rets]
    mean_excess = sum(excess) / len(excess)
    variance = sum((r - mean_excess) ** 2 for r in excess) / (len(excess) - 1)
    std = math.sqrt(variance)
    if std == 0:
        return None
    return (mean_excess / std) * math.sqrt(252)


def _correlation(rets_a: list[float], rets_b: list[float]) -> Optional[float]:
    n = min(len(rets_a), len(rets_b))
    if n < 10:
        return None
    a = rets_a[-n:]
    b = rets_b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / (n - 1)
    std_a = math.sqrt(sum((x - mean_a) ** 2 for x in a) / (n - 1))
    std_b = math.sqrt(sum((x - mean_b) ** 2 for x in b) / (n - 1))
    if std_a == 0 or std_b == 0:
        return None
    return cov / (std_a * std_b)


def _dividend_yield(symbol: str) -> Optional[float]:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
        return info.get("dividendYield")
    except Exception:
        return None


def compare(tickers: list[str], days: int = 365) -> dict:
    """Full comparison payload for 2+ tickers.

    Returns:
      - normalized: rebased-to-100 price series per ticker (for mountain chart)
      - metrics: per-ticker stats (total return, annualized, vol, Sharpe, max DD, div yield)
      - correlation_matrix: pairwise correlations
    """
    all_prices: dict[str, list[dict]] = {}
    all_daily_rets: dict[str, list[float]] = {}

    for t in tickers:
        prices = _load_prices(t.upper(), days)
        if prices:
            all_prices[t.upper()] = prices
            all_daily_rets[t.upper()] = _daily_returns(prices)

    # Normalized series: rebase each to 100 at the start.
    # Align to common date range.
    all_dates: set[str] = set()
    for prices in all_prices.values():
        for p in prices:
            all_dates.add(p["date"])
    sorted_dates = sorted(all_dates)

    normalized: dict[str, list[dict]] = {}
    for sym, prices in all_prices.items():
        if not prices:
            continue
        base = prices[0]["close"]
        if not base or base <= 0:
            continue
        price_map = {p["date"]: p["close"] for p in prices}
        series = []
        for d in sorted_dates:
            if d in price_map:
                series.append({"date": d, "value": round(price_map[d] / base * 100, 2)})
        normalized[sym] = series

    # Per-ticker metrics.
    metrics: list[dict] = []
    for sym in tickers:
        sym = sym.upper()
        prices = all_prices.get(sym, [])
        rets = all_daily_rets.get(sym, [])

        total_ret = _total_return(prices)
        ann_ret = _annualized_return(prices)
        vol = _volatility(rets)
        sharpe = _sharpe_ratio(rets)
        max_dd = _max_drawdown(prices)
        div_yield = _dividend_yield(sym)

        metrics.append({
            "symbol": sym,
            "data_points": len(prices),
            "start_date": prices[0]["date"] if prices else None,
            "end_date": prices[-1]["date"] if prices else None,
            "start_price": prices[0]["close"] if prices else None,
            "end_price": prices[-1]["close"] if prices else None,
            "total_return_pct": round(total_ret, 2) if total_ret is not None else None,
            "annualized_return_pct": round(ann_ret, 2) if ann_ret is not None else None,
            "volatility_pct": round(vol, 2) if vol is not None else None,
            "sharpe_ratio": round(sharpe, 2) if sharpe is not None else None,
            "max_drawdown_pct": round(max_dd, 2) if max_dd is not None else None,
            "dividend_yield": round(div_yield, 4) if div_yield is not None else None,
        })

    # Correlation matrix.
    syms = [t.upper() for t in tickers if t.upper() in all_daily_rets]
    corr_matrix: list[list[Optional[float]]] = []
    for i, a in enumerate(syms):
        row = []
        for j, b in enumerate(syms):
            if i == j:
                row.append(1.0)
            else:
                c = _correlation(all_daily_rets[a], all_daily_rets[b])
                row.append(round(c, 3) if c is not None else None)
        corr_matrix.append(row)

    return {
        "tickers": [t.upper() for t in tickers],
        "days": days,
        "normalized": normalized,
        "metrics": metrics,
        "correlation": {
            "symbols": syms,
            "matrix": corr_matrix,
        },
    }


def portfolio_simulate(positions: list[dict], days: int = 365) -> dict:
    """Simulate a weighted portfolio.

    positions: [{"ticker": "XLRE", "weight": 0.4}, ...]
    Returns blended return, volatility, Sharpe, income yield, and
    the normalized portfolio equity curve.
    """
    all_prices: dict[str, list[dict]] = {}
    all_daily_rets: dict[str, list[float]] = {}

    for pos in positions:
        sym = pos["ticker"].upper()
        prices = _load_prices(sym, days)
        if prices:
            all_prices[sym] = prices
            all_daily_rets[sym] = _daily_returns(prices)

    # Align to common dates.
    date_sets = [set(p["date"] for p in prices) for prices in all_prices.values()]
    if not date_sets:
        return {"error": "No price data found"}
    common_dates = sorted(set.intersection(*date_sets))
    if len(common_dates) < 2:
        return {"error": "Insufficient overlapping dates"}

    # Build price maps.
    price_maps = {}
    for sym, prices in all_prices.items():
        price_maps[sym] = {p["date"]: p["close"] for p in prices}

    # Portfolio equity curve.
    portfolio_values = []
    for d in common_dates:
        val = 0.0
        for pos in positions:
            sym = pos["ticker"].upper()
            w = pos["weight"]
            if sym in price_maps and d in price_maps[sym]:
                base = price_maps[sym].get(common_dates[0], 1)
                if base and base > 0:
                    val += w * (price_maps[sym][d] / base)
        portfolio_values.append({"date": d, "value": round(val * 100, 2)})

    # Portfolio daily returns.
    port_rets = []
    for i in range(1, len(portfolio_values)):
        prev = portfolio_values[i - 1]["value"]
        cur = portfolio_values[i]["value"]
        if prev > 0:
            port_rets.append((cur - prev) / prev)

    # Blended metrics.
    total_ret = None
    if portfolio_values:
        start = portfolio_values[0]["value"]
        end = portfolio_values[-1]["value"]
        if start > 0:
            total_ret = (end - start) / start * 100.0

    ann_ret = None
    if total_ret is not None and len(portfolio_values) > 1:
        years = (len(portfolio_values) - 1) / 252.0
        if years > 0:
            total_mult = portfolio_values[-1]["value"] / portfolio_values[0]["value"]
            ann_ret = (total_mult ** (1.0 / years) - 1.0) * 100.0

    vol = _volatility(port_rets)
    sharpe = _sharpe_ratio(port_rets)

    # Max drawdown on portfolio curve.
    max_dd = 0.0
    peak = portfolio_values[0]["value"] if portfolio_values else 0
    for pv in portfolio_values:
        if pv["value"] > peak:
            peak = pv["value"]
        dd = (peak - pv["value"]) / peak if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    # Blended dividend yield.
    blended_yield = 0.0
    for pos in positions:
        sym = pos["ticker"].upper()
        dy = _dividend_yield(sym)
        if dy is not None:
            blended_yield += pos["weight"] * dy

    return {
        "positions": positions,
        "days": days,
        "common_dates": len(common_dates),
        "equity_curve": portfolio_values,
        "total_return_pct": round(total_ret, 2) if total_ret is not None else None,
        "annualized_return_pct": round(ann_ret, 2) if ann_ret is not None else None,
        "volatility_pct": round(vol, 2) if vol is not None else None,
        "sharpe_ratio": round(sharpe, 2) if sharpe is not None else None,
        "max_drawdown_pct": round(max_dd, 2) if max_dd is not None else None,
        "blended_dividend_yield": round(blended_yield, 4) if blended_yield else None,
    }
