"""Generic custom cash-flow investment for the cross-asset comparator.

Lets a user describe an arbitrary investment by its dated distributions plus an
optional terminal (sale / maturity) value — e.g. a bond, a private placement, a
note. Computes IRR (annualized), CAGR, equity multiple (MOIC) and an
interpolated equity-value-over-time curve so it can be overlaid on the same
chart as the other asset classes.

Never raises — returns ``{"error": ...}`` on bad input.
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


def model_custom(params: dict) -> dict:
    """Model a generic dated-cashflow investment.

    Recognized inputs:
        label
        initial_investment (required, > 0)
        cashflows: [{date, amount}]   periodic distributions (amount > 0 in)
        terminal_value (optional)     paid at the end of the hold
        hold_years (required, > 0)
        start_date (optional)
    """
    label = params.get("label") or "Custom"
    try:
        initial = _f(params, "initial_investment", default=0.0)
        if initial <= 0:
            return {"kind": "custom", "label": label, "error": "initial_investment must be > 0"}

        hold_years = _f(params, "hold_years", default=0.0)
        if hold_years <= 0:
            return {"kind": "custom", "label": label, "error": "hold_years must be > 0"}

        start = params.get("start_date")
        try:
            start_date = date.fromisoformat(str(start)[:10]) if start else date.today()
        except ValueError:
            start_date = date.today()

        raw_flows = params.get("cashflows") or []
        # Build dated cashflows: initial outlay, then distributions.
        dated: list[tuple[str, float]] = [(start_date.isoformat(), -initial)]
        distributions: list[tuple[str, float]] = []
        for cf in raw_flows:
            try:
                d = str(cf["date"])[:10]
                amt = float(cf["amount"])
            except (KeyError, TypeError, ValueError):
                continue
            # validate parseable date
            try:
                date.fromisoformat(d)
            except ValueError:
                continue
            distributions.append((d, amt))

        distributions.sort(key=lambda p: p[0])
        for d, amt in distributions:
            dated.append((d, amt))

        # Terminal value paid at hold end.
        end_date = date(start_date.year + int(hold_years), start_date.month, 1)
        # more precise end date by adding whole years + remainder months
        months = int(round(hold_years * 12))
        ey = start_date.year + (start_date.month - 1 + months) // 12
        em = (start_date.month - 1 + months) % 12 + 1
        end_date = date(ey, em, min(start_date.day, 28))

        terminal_value = _f(params, "terminal_value", default=0.0)
        if terminal_value > 0:
            dated.append((end_date.isoformat(), terminal_value))

        # Sort the full series for the curve.
        dated.sort(key=lambda p: p[0])

        total_distributions = sum(a for _, a in distributions)
        total_inflows = total_distributions + terminal_value
        total_profit = total_inflows - initial
        total_return_pct = (total_profit / initial * 100.0) if initial > 0 else None
        moic = (total_inflows / initial) if initial > 0 else None

        irr_annual = finance.xirr(dated)
        growth_cagr = finance.cagr(initial, total_inflows, hold_years)

        # ── Interpolated equity curve ──
        # Equity starts at the initial outlay, accrues toward the terminal
        # total along a straight line on a daily axis; distributions are
        # cash returned (reduce remaining at-risk equity but already counted
        # in inflows). For overlay purposes we draw the value glide path from
        # initial → total_inflows linearly across the hold.
        monthly: list[dict] = []
        n_points = max(months, 1)
        for i in range(n_points + 1):
            frac = i / n_points
            equity = initial + (total_inflows - initial) * frac
            ay = start_date.year + (start_date.month - 1 + i) // 12
            am = (start_date.month - 1 + i) % 12 + 1
            d = date(ay, am, min(start_date.day, 28))
            monthly.append(
                {
                    "month": i,
                    "date": d.isoformat(),
                    "equity": round(equity, 2),
                    "value": round(equity, 2),
                }
            )

        return {
            "kind": "custom",
            "label": label,
            "metrics": {
                "irr_annual": irr_annual,
                "total_return_pct": total_return_pct,
                "cagr": growth_cagr,
                "equity_multiple": moic,
            },
            "monthly": monthly,
            "cashflows_dated": [[d, round(a, 2)] for d, a in dated],
            "assumptions": {
                "initial_investment": initial,
                "total_distributions": round(total_distributions, 2),
                "terminal_value": round(terminal_value, 2),
                "total_inflows": round(total_inflows, 2),
                "hold_years": hold_years,
            },
        }
    except Exception as e:  # never raise
        return {"kind": "custom", "label": label, "error": str(e)}
