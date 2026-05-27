"""Real-estate deal modeling for the cross-asset comparator.

Builds a MONTHLY cash-flow projection for a leveraged (or all-cash) rental,
then derives apples-to-apples return metrics shared across asset classes:
IRR (annualized via XIRR on dated flows), cash-on-cash, cap rate, equity
multiple, total profit / total return, and CAGR on equity.

Never raises — returns ``{"error": ...}`` on bad input.
"""
from __future__ import annotations

from datetime import date, timedelta

from . import finance


def _f(params: dict, *keys, default=0.0) -> float:
    """First present, numeric value among ``keys`` (else ``default``)."""
    for k in keys:
        if k in params and params[k] is not None:
            try:
                return float(params[k])
            except (TypeError, ValueError):
                continue
    return float(default)


def _add_months(d: date, months: int) -> date:
    """Add ``months`` to a date, clamping the day to month length."""
    m = d.month - 1 + months
    year = d.year + m // 12
    month = m % 12 + 1
    # clamp day
    day = min(
        d.day,
        [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
         31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1],
    )
    return date(year, month, day)


def model_real_estate(params: dict) -> dict:
    """Model a rental real-estate deal from ``params``.

    Recognized inputs (all optional unless noted):
        purchase_price (required, > 0)
        down_payment | down_payment_pct       (pct is 0..100)
        loan_rate (annual %)                   default 0
        loan_term_years                        default 30
        monthly_rent                           default 0
        monthly_expenses | expense_ratio       (ratio 0..1 of rent)
        vacancy_pct                            default 0
        annual_appreciation_pct                default 0
        rent_growth_pct                        default 0
        expense_growth_pct                     default 0
        hold_years (required, > 0)
        sale_cost_pct                          default 0
        closing_cost_pct                       default 0
        label, start_date

    Returns the shared comparator envelope. ``monthly`` carries the
    equity-value curve (equity per month, starting at the initial outlay);
    ``cashflows_dated`` is the dated series used for the annualized IRR.
    """
    try:
        label = params.get("label") or "Real Estate"
        purchase_price = _f(params, "purchase_price")
        if purchase_price <= 0:
            return {"kind": "real_estate", "label": label, "error": "purchase_price must be > 0"}

        hold_years = _f(params, "hold_years", default=0.0)
        if hold_years <= 0:
            return {"kind": "real_estate", "label": label, "error": "hold_years must be > 0"}

        # Down payment (explicit dollars wins over pct).
        if params.get("down_payment") is not None:
            down_payment = _f(params, "down_payment")
        else:
            dp_pct = _f(params, "down_payment_pct", default=20.0)
            down_payment = purchase_price * (dp_pct / 100.0)
        down_payment = max(0.0, min(down_payment, purchase_price))

        loan_amount = purchase_price - down_payment
        loan_rate = _f(params, "loan_rate", default=0.0)
        loan_term_years = _f(params, "loan_term_years", default=30.0)

        monthly_rent0 = _f(params, "monthly_rent", default=0.0)
        if params.get("monthly_expenses") is not None:
            monthly_exp0 = _f(params, "monthly_expenses")
        else:
            expense_ratio = _f(params, "expense_ratio", default=0.0)
            monthly_exp0 = monthly_rent0 * expense_ratio

        vacancy = _f(params, "vacancy_pct", default=0.0) / 100.0
        appr = _f(params, "annual_appreciation_pct", default=0.0) / 100.0
        rent_growth = _f(params, "rent_growth_pct", default=0.0) / 100.0
        exp_growth = _f(params, "expense_growth_pct", default=0.0) / 100.0
        sale_cost = _f(params, "sale_cost_pct", default=0.0) / 100.0
        closing_cost = _f(params, "closing_cost_pct", default=0.0) / 100.0

        start = params.get("start_date")
        try:
            start_date = date.fromisoformat(str(start)[:10]) if start else date.today()
        except ValueError:
            start_date = date.today()

        # Amortization (level monthly debt service).
        monthly_rate = (loan_rate / 100.0) / 12.0
        debt_service = (
            finance.mortgage_payment(loan_amount, loan_rate, loan_term_years, 12)
            if loan_amount > 0
            else 0.0
        )

        closing_costs = purchase_price * closing_cost
        initial_outlay = down_payment + closing_costs

        n_months = int(round(hold_years * 12))
        balance = loan_amount
        value = purchase_price

        monthly: list[dict] = []
        dated: list[tuple[str, float]] = []

        # t0: investor pays the initial outlay (negative); equity = outlay.
        dated.append((start_date.isoformat(), -initial_outlay))
        monthly.append(
            {
                "month": 0,
                "date": start_date.isoformat(),
                "equity": round(initial_outlay, 2),
                "value": round(value, 2),
                "balance": round(balance, 2),
                "net_cash_flow": round(-initial_outlay, 2),
            }
        )

        net_cf_year1 = 0.0
        gross_rent_year1 = 0.0

        for m in range(1, n_months + 1):
            year_idx = (m - 1) // 12  # 0-based year for growth compounding
            rent = monthly_rent0 * ((1.0 + rent_growth) ** year_idx)
            effective_rent = rent * (1.0 - vacancy)
            expenses = monthly_exp0 * ((1.0 + exp_growth) ** year_idx)

            interest = balance * monthly_rate
            principal_paid = max(0.0, debt_service - interest) if debt_service > 0 else 0.0
            if principal_paid > balance:
                principal_paid = balance
            balance = max(0.0, balance - principal_paid)

            net_cash_flow = effective_rent - expenses - debt_service

            # property value compounds monthly toward the annual appreciation
            value = purchase_price * ((1.0 + appr) ** (m / 12.0))

            equity = value - balance

            if m <= 12:
                net_cf_year1 += net_cash_flow
                gross_rent_year1 += effective_rent

            d = _add_months(start_date, m)
            flow = net_cash_flow

            # Sale at end of hold: add net proceeds.
            if m == n_months:
                sale_proceeds = value * (1.0 - sale_cost) - balance
                flow += sale_proceeds
                # equity realized at sale = net proceeds in hand
                equity = value - balance

            dated.append((d.isoformat(), flow))
            monthly.append(
                {
                    "month": m,
                    "date": d.isoformat(),
                    "equity": round(equity, 2),
                    "value": round(value, 2),
                    "balance": round(balance, 2),
                    "net_cash_flow": round(net_cash_flow, 2),
                }
            )

        # ── Metrics ──
        final_value = value
        final_balance = balance
        net_sale = final_value * (1.0 - sale_cost) - final_balance

        total_inflows = sum(a for _, a in dated if a > 0)
        total_profit = total_inflows - initial_outlay
        total_return_pct = (total_profit / initial_outlay * 100.0) if initial_outlay > 0 else None
        equity_multiple = (total_inflows / initial_outlay) if initial_outlay > 0 else None

        cash_on_cash_year1 = (net_cf_year1 / initial_outlay * 100.0) if initial_outlay > 0 else None

        # Cap rate = year-1 net operating income (before debt service) / price.
        noi_year1 = gross_rent_year1 - sum(
            monthly_exp0 * ((1.0 + exp_growth) ** ((m - 1) // 12)) for m in range(1, min(12, n_months) + 1)
        )
        cap_rate = (noi_year1 / purchase_price * 100.0) if purchase_price > 0 else None

        irr_annual = finance.xirr(dated)
        equity_cagr = finance.cagr(initial_outlay, total_inflows, hold_years)

        return {
            "kind": "real_estate",
            "label": label,
            "metrics": {
                "irr_annual": irr_annual,
                "cash_on_cash_year1": cash_on_cash_year1,
                "cap_rate": cap_rate,
                "equity_multiple": equity_multiple,
                "total_profit": round(total_profit, 2),
                "total_return_pct": total_return_pct,
                "cagr": equity_cagr,
            },
            "monthly": monthly,
            "cashflows_dated": [[d, round(a, 2)] for d, a in dated],
            "assumptions": {
                "purchase_price": purchase_price,
                "down_payment": round(down_payment, 2),
                "loan_amount": round(loan_amount, 2),
                "monthly_debt_service": round(debt_service, 2),
                "initial_outlay": round(initial_outlay, 2),
                "hold_years": hold_years,
                "net_sale_proceeds": round(net_sale, 2),
            },
        }
    except Exception as e:  # never raise
        return {"kind": "real_estate", "label": params.get("label", "Real Estate"), "error": str(e)}
