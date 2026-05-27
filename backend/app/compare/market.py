"""Stock / ETF position modeling for the cross-asset comparator.

Fetches historical prices through the project's universal price entrypoint
``app.data.macro_data.fetch_arbitrary_ticker`` (cached, never raises), buys at
the first available close, optionally dollar-cost-averages a monthly
contribution, and values the position over time. Output matches the shared
comparator envelope so a market position can be overlaid on the same chart as
a real-estate deal.

Never raises — returns ``{"error": ...}`` when no price data is available.
"""
from __future__ import annotations

from datetime import date

from . import finance


def _f(params: dict, *keys, default=0.0) -> float:
    for k in keys:
        if k in params and params[k] is not None:
            try:
                return float(params[k])
            except (TypeError, ValueError):
                continue
    return float(default)


def _month_key(d: str) -> str:
    return d[:7]  # "YYYY-MM"


def model_market(params: dict) -> dict:
    """Model a market (stock/ETF) position from ``params``.

    Recognized inputs:
        symbol (required)
        initial_investment (required, > 0)
        hold_years | days        (hold_years preferred; days overrides window)
        monthly_contribution     default 0
        dividend_yield_pct       default 0 (added as a flat annual yield on value)
        label
    """
    label = params.get("label") or params.get("symbol") or "Market"
    symbol = params.get("symbol")
    if not symbol:
        return {"kind": "market", "label": label, "error": "symbol is required"}

    initial = _f(params, "initial_investment", default=0.0)
    if initial <= 0:
        return {"kind": "market", "label": label, "error": "initial_investment must be > 0"}

    hold_years = _f(params, "hold_years", default=0.0)
    if params.get("days") is not None:
        days = int(_f(params, "days", default=365))
        if hold_years <= 0:
            hold_years = days / 365.0
    else:
        days = int(round(hold_years * 365)) if hold_years > 0 else 365

    monthly_contribution = _f(params, "monthly_contribution", default=0.0)
    div_yield = _f(params, "dividend_yield_pct", default=0.0) / 100.0

    # Import inside the function so tests can monkeypatch the module attribute
    # (matches conftest.patch_data and the rest of the codebase).
    from ..data import macro_data

    prices = macro_data.fetch_arbitrary_ticker(symbol, days + 14)
    prices = [p for p in (prices or []) if p.get("value")]
    if len(prices) < 2:
        return {"kind": "market", "label": label, "error": f"no price data for {symbol}"}

    prices = sorted(prices, key=lambda p: p["date"])
    # Trim to the requested window length (keep the most recent ``days``+ bars).
    if len(prices) > days + 1:
        prices = prices[-(days + 1):]

    first_price = float(prices[0]["value"])
    if first_price <= 0:
        return {"kind": "market", "label": label, "error": "invalid first price"}

    shares = initial / first_price
    invested = initial

    monthly: list[dict] = []
    dated: list[tuple[str, float]] = []

    start_date = prices[0]["date"]
    dated.append((start_date, -initial))

    seen_months: set[str] = {_month_key(start_date)}
    # Daily div accrual converted from annual yield, applied as reinvestment.
    daily_div = (div_yield / 365.0) if div_yield > 0 else 0.0

    prev_date = start_date
    last_value = initial
    out_month_idx = 0

    for i, p in enumerate(prices):
        price = float(p["value"])
        d = p["date"]
        mk = _month_key(d)

        # Monthly contribution on the first trading day of a new month (skip t0).
        if i > 0 and monthly_contribution > 0 and mk not in seen_months:
            shares += monthly_contribution / price
            invested += monthly_contribution
            dated.append((d, -monthly_contribution))
            seen_months.add(mk)
        else:
            seen_months.add(mk)

        # Dividend reinvestment accrual (price-return stays the core driver).
        if daily_div > 0 and i > 0:
            shares += shares * daily_div

        value = shares * price
        last_value = value

        monthly.append(
            {
                "month": i,
                "date": d,
                "equity": round(value, 2),
                "value": round(value, 2),
                "shares": round(shares, 6),
                "price": round(price, 4),
                "invested": round(invested, 2),
            }
        )

    # Terminal liquidation cashflow for IRR.
    end_date = prices[-1]["date"]
    dated.append((end_date, last_value))

    years = hold_years if hold_years > 0 else max(
        (date.fromisoformat(end_date) - date.fromisoformat(start_date)).days / 365.0, 1e-9
    )

    total_profit = last_value - invested
    total_return_pct = (total_profit / invested * 100.0) if invested > 0 else None
    equity_multiple = (last_value / invested) if invested > 0 else None
    irr_annual = finance.xirr(dated)
    growth_cagr = finance.cagr(invested, last_value, years)

    return {
        "kind": "market",
        "label": label,
        "metrics": {
            "irr_annual": irr_annual,
            "total_return_pct": total_return_pct,
            "cagr": growth_cagr,
            "equity_multiple": equity_multiple,
        },
        "monthly": monthly,
        "cashflows_dated": [[d, round(a, 2)] for d, a in dated],
        "assumptions": {
            "symbol": symbol,
            "first_price": round(first_price, 4),
            "last_price": round(float(prices[-1]["value"]), 4),
            "initial_investment": initial,
            "total_invested": round(invested, 2),
            "final_value": round(last_value, 2),
            "bars": len(prices),
        },
    }
