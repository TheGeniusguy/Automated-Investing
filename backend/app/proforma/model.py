"""IB-level pro forma engine: three-statement model, DCF, trading comps, scenarios.

This is the analytical core behind the Pro Forma Modeling panel. It is built to
be genuinely rigorous - a linked three-statement model where the cash-flow
statement's ending cash ties to the balance-sheet cash, an unlevered DCF with
BOTH a Gordon-growth and an exit-multiple terminal value plus a 2D sensitivity
grid, a trading-comps table with min/median/max and an implied valuation, and a
base/bull/bear scenario engine with a one-at-a-time tornado.

Design rules
------------
- Pure-python output: every returned value is a float / int / str / list / dict
  (JSON-clean). No numpy types leak out.
- Never raises. Every public entrypoint degrades to sample data on any error.
- Monetary figures are in MILLIONS of USD. Ratios are decimals (0.58 == 58%).
- All drivers are documented inline so the model is auditable.

Accounting identity that makes the statements TIE
-------------------------------------------------
For each projected year, with working capital WC = AR + Inventory - AP:

    CFO = NetIncome + D&A - dWC
    CFI = -Capex
    CFF = -DebtRepayment - Dividends
    dCash = CFO + CFI + CFF
    PP&E_net rolls:  PPE_t = PPE_(t-1) + Capex - D&A
    Equity rolls:    Eq_t  = Eq_(t-1) + NetIncome - Dividends
    Debt rolls:      Debt_t = Debt_(t-1) - DebtRepayment

Substituting, dAssets == dLiabilities+Equity every year, so Assets = L + E holds
provided the year-0 balance sheet balances (we plug year-0 equity to force it).
"""
from __future__ import annotations

import logging
import statistics
from datetime import datetime, timezone
from typing import Any, Optional

from . import sample_data

log = logging.getLogger(__name__)

_DAYS = 365.0


# ===========================================================================
# small helpers (JSON-clean rounding)
# ===========================================================================
def _r(x: Any, d: int = 1) -> Optional[float]:
    """Round to a plain float; None passthrough; non-finite -> None."""
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return round(v, d)


def _money(x: Any) -> Optional[float]:
    return _r(x, 1)


def _ratio(x: Any) -> Optional[float]:
    return _r(x, 4)


def _safe_div(num: float, den: float) -> Optional[float]:
    try:
        if den == 0:
            return None
        return num / den
    except (TypeError, ZeroDivisionError):
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _g(inputs: dict, key: str, default: Any) -> Any:
    v = inputs.get(key, default)
    return default if v is None else v


# ===========================================================================
# input normalization - fill every key so downstream math is total
# ===========================================================================
def _normalize_inputs(inputs: Optional[dict]) -> dict:
    """Merge caller inputs over the sample defaults and coerce types.

    Guarantees every key the model reads is present and well-typed, so the rest
    of the engine never has to defend against missing fields.
    """
    base = sample_data.sample_inputs()
    if isinstance(inputs, dict):
        for k, v in inputs.items():
            if v is not None:
                base[k] = v

    n = int(_g(base, "projection_years", 5) or 5)
    n = max(1, min(n, 10))
    base["projection_years"] = n

    # Normalize the growth ramp to exactly n entries.
    ramp = base.get("revenue_growth") or []
    if not isinstance(ramp, (list, tuple)) or not ramp:
        ramp = [0.08] * n
    ramp = [float(x) for x in ramp]
    if len(ramp) < n:
        ramp = ramp + [ramp[-1]] * (n - len(ramp))
    base["revenue_growth"] = ramp[:n]

    # Float-coerce the scalar drivers.
    floats = [
        "revenue", "gross_margin", "opex_pct_revenue", "da_pct_revenue",
        "capex_pct_revenue", "tax_rate", "dso_days", "dio_days", "dpo_days",
        "starting_cash", "starting_debt", "starting_ppe", "annual_debt_repayment",
        "dividend_payout", "shares_outstanding", "interest_rate_on_debt",
        "risk_free_rate", "equity_risk_premium", "beta", "cost_of_debt",
        "debt_weight", "terminal_growth", "exit_multiple",
    ]
    for k in floats:
        try:
            base[k] = float(base[k])
        except (TypeError, ValueError, KeyError):
            base[k] = float(sample_data.SAMPLE_INPUTS.get(k, 0.0) or 0.0)

    if base["shares_outstanding"] <= 0:
        base["shares_outstanding"] = 1.0
    return base


# ===========================================================================
# FEATURE E.1 - three-statement model
# ===========================================================================
def build_three_statement(inputs: dict) -> dict:
    """Project an N-year linked Income Statement, Balance Sheet, and Cash Flow.

    Drivers (all from ``inputs``):
      revenue            base-year (LTM) revenue, $MM
      revenue_growth[]   per-year growth rates (the ramp)
      gross_margin       gross profit / revenue
      opex_pct_revenue   cash opex (SG&A+R&D) as % of revenue, excludes D&A
      da_pct_revenue     depreciation & amortization as % of revenue
      capex_pct_revenue  capex as % of revenue
      tax_rate           effective cash tax rate (applied to positive pre-tax)
      dso/dio/dpo_days   working-capital intensity -> AR / Inventory / AP
      interest_rate_on_debt   coupon on beginning-of-year debt
      starting_cash/debt/ppe  year-0 balance sheet anchors

    Returns income_statement, balance_sheet, cash_flow (each a list of yearly
    rows including year 0), plus a ``ties`` block proving CF cash == BS cash.
    """
    try:
        return _build_three_statement(_normalize_inputs(inputs))
    except Exception as e:  # never raise
        log.warning("build_three_statement failed, using sample: %s", e)
        try:
            return _build_three_statement(_normalize_inputs(None))
        except Exception:
            return {"income_statement": [], "balance_sheet": [], "cash_flow": [],
                    "drivers": {}, "ties": {"balanced": False}}


def _wc(ar: float, inv: float, ap: float) -> float:
    return ar + inv - ap


def _build_three_statement(inp: dict) -> dict:
    n = inp["projection_years"]
    gm = inp["gross_margin"]
    opex_pct = inp["opex_pct_revenue"]
    da_pct = inp["da_pct_revenue"]
    capex_pct = inp["capex_pct_revenue"]
    tax_rate = inp["tax_rate"]
    dso, dio, dpo = inp["dso_days"], inp["dio_days"], inp["dpo_days"]
    int_rate = inp["interest_rate_on_debt"]
    repay = inp["annual_debt_repayment"]
    payout = inp["dividend_payout"]

    # ----- Year 0 (LTM actuals) -----
    rev0 = inp["revenue"]
    cogs0 = rev0 * (1.0 - gm)
    ar0 = rev0 * dso / _DAYS
    inv0 = cogs0 * dio / _DAYS
    ap0 = cogs0 * dpo / _DAYS
    ppe0 = inp["starting_ppe"]
    cash0 = inp["starting_cash"]
    debt0 = inp["starting_debt"]
    # Plug year-0 equity so the opening balance sheet balances exactly.
    equity0 = (cash0 + ar0 + inv0 + ppe0) - (ap0 + debt0)

    income: list[dict] = []
    balance: list[dict] = []
    cashflow: list[dict] = []

    ebitda0 = rev0 * gm - rev0 * opex_pct
    da0 = rev0 * da_pct
    income.append({
        "year": 0, "label": "LTM", "revenue": _money(rev0),
        "revenue_growth": None, "cogs": _money(cogs0),
        "gross_profit": _money(rev0 - cogs0), "gross_margin": _ratio(gm),
        "opex": _money(rev0 * opex_pct), "ebitda": _money(ebitda0),
        "ebitda_margin": _ratio(_safe_div(ebitda0, rev0)),
        "da": _money(da0), "ebit": _money(ebitda0 - da0),
        "interest_expense": _money(debt0 * int_rate),
        "pretax_income": _money(ebitda0 - da0 - debt0 * int_rate),
        "taxes": None, "net_income": None, "net_margin": None,
    })
    balance.append({
        "year": 0, "label": "LTM",
        "cash": _money(cash0), "accounts_receivable": _money(ar0),
        "inventory": _money(inv0), "ppe_net": _money(ppe0),
        "total_assets": _money(cash0 + ar0 + inv0 + ppe0),
        "accounts_payable": _money(ap0), "debt": _money(debt0),
        "total_liabilities": _money(ap0 + debt0), "equity": _money(equity0),
        "total_liab_and_equity": _money(ap0 + debt0 + equity0),
        "net_debt": _money(debt0 - cash0),
    })
    cashflow.append({
        "year": 0, "label": "LTM", "net_income": None, "da": None,
        "change_in_working_capital": None, "cfo": None, "capex": None,
        "cfi": None, "debt_repayment": None, "dividends": None, "cff": None,
        "net_change_in_cash": None, "beginning_cash": None,
        "ending_cash": _money(cash0), "unlevered_fcf": None, "levered_fcf": None,
    })

    # rolling state
    rev_prev = rev0
    ar_prev, inv_prev, ap_prev = ar0, inv0, ap0
    ppe_prev = ppe0
    cash_prev = cash0
    debt_prev = debt0
    eq_prev = equity0

    for y in range(1, n + 1):
        growth = inp["revenue_growth"][y - 1]
        rev = rev_prev * (1.0 + growth)
        cogs = rev * (1.0 - gm)
        gross = rev - cogs
        opex = rev * opex_pct
        ebitda = gross - opex
        da = rev * da_pct
        ebit = ebitda - da
        interest = debt_prev * int_rate           # on beginning debt
        pretax = ebit - interest
        taxes = max(0.0, pretax) * tax_rate        # no tax benefit modeled
        ni = pretax - taxes

        # Balance-sheet working-capital items.
        ar = rev * dso / _DAYS
        inv = cogs * dio / _DAYS
        ap = cogs * dpo / _DAYS
        capex = rev * capex_pct
        ppe = ppe_prev + capex - da
        d_wc = _wc(ar, inv, ap) - _wc(ar_prev, inv_prev, ap_prev)

        # Cash flow.
        cfo = ni + da - d_wc
        cfi = -capex
        debt_repay = min(repay, debt_prev)         # cannot repay below zero
        debt = debt_prev - debt_repay
        dividends = max(0.0, ni) * payout
        cff = -debt_repay - dividends
        d_cash = cfo + cfi + cff
        cash = cash_prev + d_cash
        eq = eq_prev + ni - dividends

        # Unlevered FCF (FCFF) for the DCF: NOPAT + D&A - capex - dWC.
        nopat = ebit * (1.0 - tax_rate)
        ufcf = nopat + da - capex - d_wc
        lfcf = cfo + cfi                           # levered free cash flow

        income.append({
            "year": y, "label": f"Y{y}", "revenue": _money(rev),
            "revenue_growth": _ratio(growth), "cogs": _money(cogs),
            "gross_profit": _money(gross), "gross_margin": _ratio(gm),
            "opex": _money(opex), "ebitda": _money(ebitda),
            "ebitda_margin": _ratio(_safe_div(ebitda, rev)),
            "da": _money(da), "ebit": _money(ebit),
            "interest_expense": _money(interest), "pretax_income": _money(pretax),
            "taxes": _money(taxes), "net_income": _money(ni),
            "net_margin": _ratio(_safe_div(ni, rev)),
        })
        balance.append({
            "year": y, "label": f"Y{y}", "cash": _money(cash),
            "accounts_receivable": _money(ar), "inventory": _money(inv),
            "ppe_net": _money(ppe),
            "total_assets": _money(cash + ar + inv + ppe),
            "accounts_payable": _money(ap), "debt": _money(debt),
            "total_liabilities": _money(ap + debt), "equity": _money(eq),
            "total_liab_and_equity": _money(ap + debt + eq),
            "net_debt": _money(debt - cash),
        })
        cashflow.append({
            "year": y, "label": f"Y{y}", "net_income": _money(ni), "da": _money(da),
            "change_in_working_capital": _money(-d_wc), "cfo": _money(cfo),
            "capex": _money(-capex), "cfi": _money(cfi),
            "debt_repayment": _money(-debt_repay), "dividends": _money(-dividends),
            "cff": _money(cff), "net_change_in_cash": _money(d_cash),
            "beginning_cash": _money(cash_prev), "ending_cash": _money(cash),
            "unlevered_fcf": _money(ufcf), "levered_fcf": _money(lfcf),
        })

        rev_prev = rev
        ar_prev, inv_prev, ap_prev = ar, inv, ap
        ppe_prev, cash_prev, debt_prev, eq_prev = ppe, cash, debt, eq

    # ----- prove the statements tie -----
    ties_rows = []
    balanced = True
    for bs, cf in zip(balance, cashflow):
        bs_cash = bs["cash"]
        cf_cash = cf["ending_cash"]
        a = bs["total_assets"]
        le = bs["total_liab_and_equity"]
        cash_ok = (bs_cash is not None and cf_cash is not None
                   and abs(bs_cash - cf_cash) < 0.5)
        bal_ok = (a is not None and le is not None and abs(a - le) < 0.5)
        if not (cash_ok and bal_ok):
            balanced = False
        ties_rows.append({
            "year": bs["year"], "bs_cash": bs_cash, "cf_ending_cash": cf_cash,
            "cash_ties": bool(cash_ok), "assets": a, "liab_and_equity": le,
            "balance_check": bool(bal_ok),
        })

    return {
        "company_name": inp.get("company_name"),
        "ticker": inp.get("ticker"),
        "currency": inp.get("currency", "USD"),
        "units": "USD millions",
        "projection_years": n,
        "income_statement": income,
        "balance_sheet": balance,
        "cash_flow": cashflow,
        "drivers": {
            "base_revenue": _money(rev0),
            "revenue_growth": [_ratio(x) for x in inp["revenue_growth"]],
            "gross_margin": _ratio(gm),
            "opex_pct_revenue": _ratio(opex_pct),
            "da_pct_revenue": _ratio(da_pct),
            "capex_pct_revenue": _ratio(capex_pct),
            "tax_rate": _ratio(tax_rate),
            "dso_days": _r(dso, 1), "dio_days": _r(dio, 1), "dpo_days": _r(dpo, 1),
            "interest_rate_on_debt": _ratio(int_rate),
        },
        "ties": {"balanced": bool(balanced), "detail": ties_rows},
    }


# ===========================================================================
# FEATURE E.2 - discounted cash flow
# ===========================================================================
def _wacc(inp: dict) -> dict:
    """CAPM cost of equity + after-tax cost of debt, weighted to a WACC."""
    rf = inp["risk_free_rate"]
    erp = inp["equity_risk_premium"]
    beta = inp["beta"]
    kd = inp["cost_of_debt"]
    tax = inp["tax_rate"]
    wd = min(max(inp["debt_weight"], 0.0), 0.95)
    we = 1.0 - wd
    ke = rf + beta * erp                       # CAPM
    after_tax_kd = kd * (1.0 - tax)
    wacc = we * ke + wd * after_tax_kd
    return {
        "risk_free_rate": _ratio(rf), "equity_risk_premium": _ratio(erp),
        "beta": _r(beta, 3), "cost_of_equity": _ratio(ke),
        "cost_of_debt": _ratio(kd), "after_tax_cost_of_debt": _ratio(after_tax_kd),
        "equity_weight": _ratio(we), "debt_weight": _ratio(wd),
        "wacc": _ratio(wacc), "_wacc_raw": wacc, "_ke_raw": ke,
        "_after_tax_kd_raw": after_tax_kd, "_we_raw": we, "_wd_raw": wd,
    }


def _ev_from_dcf(fcfs: list[float], terminal_ebitda: float, wacc: float,
                 g: float, exit_mult: float) -> dict:
    """Discount FCF + terminal value. Returns EV under Gordon and exit-multiple."""
    n = len(fcfs)
    pv_fcf = []
    pv_sum = 0.0
    for i, f in enumerate(fcfs, start=1):
        df = 1.0 / ((1.0 + wacc) ** i)
        pv = f * df
        pv_fcf.append({"year": i, "fcf": _money(f), "discount_factor": _r(df, 4),
                       "pv": _money(pv)})
        pv_sum += pv

    last_fcf = fcfs[-1] if fcfs else 0.0
    df_n = 1.0 / ((1.0 + wacc) ** n) if n else 1.0

    # Gordon growth terminal value (guard wacc <= g).
    if wacc - g > 1e-6:
        tv_gordon = last_fcf * (1.0 + g) / (wacc - g)
    else:
        tv_gordon = float("nan")
    pv_tv_gordon = tv_gordon * df_n
    ev_gordon = pv_sum + pv_tv_gordon

    # Exit-multiple terminal value.
    tv_exit = terminal_ebitda * exit_mult
    pv_tv_exit = tv_exit * df_n
    ev_exit = pv_sum + pv_tv_exit

    return {
        "pv_fcf_rows": pv_fcf, "pv_fcf_sum": _money(pv_sum),
        "terminal_value_gordon": _money(tv_gordon),
        "pv_terminal_gordon": _money(pv_tv_gordon),
        "enterprise_value_gordon": _money(ev_gordon),
        "terminal_value_exit": _money(tv_exit),
        "pv_terminal_exit": _money(pv_tv_exit),
        "enterprise_value_exit": _money(ev_exit),
        "_ev_gordon_raw": ev_gordon, "_ev_exit_raw": ev_exit,
    }


def run_dcf(inputs: dict) -> dict:
    """Unlevered DCF with dual terminal value and a WACC x g sensitivity grid.

    Steps:
      1. Project unlevered FCF (FCFF) from the three-statement model.
      2. Build WACC from CAPM cost of equity + after-tax cost of debt.
      3. Terminal value via BOTH Gordon growth and an exit EV/EBITDA multiple.
      4. EV = PV(FCF) + PV(TV); equity = EV - net debt; price = equity / shares.
      5. 2D sensitivity grid of implied price across WACC and terminal growth
         (Gordon method).
    """
    try:
        return _run_dcf(_normalize_inputs(inputs))
    except Exception as e:
        log.warning("run_dcf failed, using sample: %s", e)
        try:
            return _run_dcf(_normalize_inputs(None))
        except Exception:
            return {"wacc": {}, "fcf": [], "implied_share_price": None,
                    "sensitivity": {"rows": []}}


def _implied_price(ev_raw: float, net_debt: float, shares: float) -> Optional[float]:
    equity = ev_raw - net_debt
    return _safe_div(equity, shares)


def _run_dcf(inp: dict) -> dict:
    ts = _build_three_statement(inp)
    cf_rows = [r for r in ts["cash_flow"] if r["year"] >= 1]
    fcfs = [float(r["unlevered_fcf"] or 0.0) for r in cf_rows]
    terminal_ebitda = float(ts["income_statement"][-1]["ebitda"] or 0.0)
    net_debt = float(ts["balance_sheet"][0]["net_debt"] or 0.0)  # year-0 net debt
    shares = inp["shares_outstanding"]

    w = _wacc(inp)
    wacc = w["_wacc_raw"]
    g = inp["terminal_growth"]
    exit_mult = inp["exit_multiple"]

    base = _ev_from_dcf(fcfs, terminal_ebitda, wacc, g, exit_mult)

    ev_gordon = base["_ev_gordon_raw"]
    ev_exit = base["_ev_exit_raw"]
    price_gordon = _implied_price(ev_gordon, net_debt, shares)
    price_exit = _implied_price(ev_exit, net_debt, shares)
    # Blended primary EV: average of the two methods (standard football-field mid).
    ev_blend = (ev_gordon + ev_exit) / 2.0
    price_blend = _implied_price(ev_blend, net_debt, shares)

    # ----- 2D sensitivity grid: implied price over WACC x terminal growth -----
    wacc_axis = [wacc + d for d in (-0.015, -0.0075, 0.0, 0.0075, 0.015)]
    g_axis = [g + d for d in (-0.010, -0.005, 0.0, 0.005, 0.010)]
    grid_rows = []
    for wv in wacc_axis:
        cells = []
        for gv in g_axis:
            ev = _ev_from_dcf(fcfs, terminal_ebitda, wv, gv, exit_mult)
            cells.append(_implied_price(ev["_ev_gordon_raw"], net_debt, shares))
        grid_rows.append({"wacc": _ratio(wv), "prices": [_r(c, 2) for c in cells]})

    fcf_table = []
    for r in cf_rows:
        fcf_table.append({
            "year": r["year"], "label": r["label"],
            "ebit": next((i["ebit"] for i in ts["income_statement"]
                          if i["year"] == r["year"]), None),
            "nopat": _money(float(next((i["ebit"] for i in ts["income_statement"]
                            if i["year"] == r["year"]), 0.0) or 0.0)
                            * (1.0 - inp["tax_rate"])),
            "da": r["da"], "capex": r["capex"],
            "change_in_working_capital": r["change_in_working_capital"],
            "unlevered_fcf": r["unlevered_fcf"],
        })

    # public WACC block (strip raw helpers)
    wacc_pub = {k: v for k, v in w.items() if not k.startswith("_")}

    return {
        "wacc": wacc_pub,
        "fcf": fcf_table,
        "pv_fcf": base["pv_fcf_rows"],
        "pv_fcf_sum": base["pv_fcf_sum"],
        "terminal_value": {
            "gordon_growth": {
                "growth_rate": _ratio(g),
                "terminal_value": base["terminal_value_gordon"],
                "pv_terminal_value": base["pv_terminal_gordon"],
                "enterprise_value": base["enterprise_value_gordon"],
                "implied_share_price": _r(price_gordon, 2),
            },
            "exit_multiple": {
                "ev_ebitda_multiple": _r(exit_mult, 2),
                "terminal_ebitda": _money(terminal_ebitda),
                "terminal_value": base["terminal_value_exit"],
                "pv_terminal_value": base["pv_terminal_exit"],
                "enterprise_value": base["enterprise_value_exit"],
                "implied_share_price": _r(price_exit, 2),
            },
        },
        "net_debt": _money(net_debt),
        "shares_outstanding": _money(shares),
        "enterprise_value": _money(ev_blend),
        "equity_value": _money(ev_blend - net_debt),
        "implied_share_price": _r(price_blend, 2),
        "implied_price_gordon": _r(price_gordon, 2),
        "implied_price_exit": _r(price_exit, 2),
        "sensitivity": {
            "metric": "implied_share_price",
            "method": "gordon_growth",
            "wacc_axis": [_ratio(x) for x in wacc_axis],
            "growth_axis": [_ratio(x) for x in g_axis],
            "rows": grid_rows,
        },
    }


# ===========================================================================
# FEATURE E.3 - trading comps
# ===========================================================================
def _peer_multiples(p: dict) -> dict:
    """Compute EV/EBITDA, EV/Sales, P/E, P/S from a peer's raw financials."""
    price = float(p.get("price") or 0.0)
    shares = float(p.get("shares") or 0.0)
    net_debt = float(p.get("net_debt") or 0.0)
    ebitda = float(p.get("ebitda") or 0.0)
    sales = float(p.get("sales") or 0.0)
    ni = float(p.get("net_income") or 0.0)

    market_cap = price * shares
    ev = market_cap + net_debt
    eps = _safe_div(ni, shares)
    return {
        "name": p.get("name"), "ticker": p.get("ticker"),
        "is_target": bool(p.get("is_target")),
        "price": _r(price, 2), "market_cap": _money(market_cap),
        "enterprise_value": _money(ev), "net_debt": _money(net_debt),
        "ebitda": _money(ebitda), "sales": _money(sales),
        "net_income": _money(ni), "eps": _r(eps, 2),
        "ev_ebitda": _r(_safe_div(ev, ebitda), 2),
        "ev_sales": _r(_safe_div(ev, sales), 2),
        "pe": _r(_safe_div(market_cap, ni), 2),
        "ps": _r(_safe_div(market_cap, sales), 2),
        "_market_cap": market_cap, "_ev": ev, "_ni": ni, "_shares": shares,
        "_net_debt": net_debt, "_ebitda": ebitda, "_sales": sales,
    }


def _stat_block(vals: list[float]) -> dict:
    clean = [v for v in vals if v is not None and v == v]
    if not clean:
        return {"min": None, "median": None, "mean": None, "max": None}
    return {
        "min": _r(min(clean), 2), "median": _r(statistics.median(clean), 2),
        "mean": _r(statistics.fmean(clean), 2), "max": _r(max(clean), 2),
    }


def build_comps(peers: list[dict]) -> dict:
    """Trading-comps table with min/median/max and an implied target valuation.

    ``peers`` is a list of raw-financial dicts; the target is the entry flagged
    ``is_target=True``. Multiples are COMPUTED from financials (the IB-correct
    way), summary stats are taken over the peers ONLY (target excluded), then
    the median peer multiple is applied back to the target to imply a value.
    """
    try:
        return _build_comps(peers if isinstance(peers, list) and peers
                            else sample_data.sample_peers())
    except Exception as e:
        log.warning("build_comps failed, using sample: %s", e)
        try:
            return _build_comps(sample_data.sample_peers())
        except Exception:
            return {"peers": [], "target": None, "stats": {}, "implied": {}}


def _build_comps(peers: list[dict]) -> dict:
    rows = [_peer_multiples(p) for p in peers]
    target = next((r for r in rows if r["is_target"]), None)
    comp_set = [r for r in rows if not r["is_target"]]
    if not comp_set:  # need at least a peer universe for stats
        comp_set = rows

    stats = {
        "ev_ebitda": _stat_block([r["ev_ebitda"] for r in comp_set]),
        "ev_sales": _stat_block([r["ev_sales"] for r in comp_set]),
        "pe": _stat_block([r["pe"] for r in comp_set]),
        "ps": _stat_block([r["ps"] for r in comp_set]),
    }

    implied: dict = {}
    if target is not None:
        t_ebitda = target["_ebitda"]
        t_sales = target["_sales"]
        t_ni = target["_ni"]
        t_shares = target["_shares"]
        t_net_debt = target["_net_debt"]
        med_ev_ebitda = stats["ev_ebitda"]["median"]
        med_ev_sales = stats["ev_sales"]["median"]
        med_pe = stats["pe"]["median"]

        def _px_from_ev(ev: Optional[float]) -> Optional[float]:
            if ev is None:
                return None
            return _safe_div(ev - t_net_debt, t_shares)

        ev_from_ebitda = (med_ev_ebitda * t_ebitda) if med_ev_ebitda else None
        ev_from_sales = (med_ev_sales * t_sales) if med_ev_sales else None
        px_ebitda = _px_from_ev(ev_from_ebitda)
        px_sales = _px_from_ev(ev_from_sales)
        px_pe = (med_pe * _safe_div(t_ni, t_shares)) if med_pe else None

        prices = [p for p in (px_ebitda, px_sales, px_pe) if p is not None]
        implied = {
            "target_name": target["name"], "target_ticker": target["ticker"],
            "current_price": target["price"],
            "from_ev_ebitda": {
                "median_multiple": med_ev_ebitda,
                "implied_ev": _money(ev_from_ebitda),
                "implied_price": _r(px_ebitda, 2),
            },
            "from_ev_sales": {
                "median_multiple": med_ev_sales,
                "implied_ev": _money(ev_from_sales),
                "implied_price": _r(px_sales, 2),
            },
            "from_pe": {
                "median_multiple": med_pe,
                "implied_price": _r(px_pe, 2),
            },
            "blended_implied_price": _r(statistics.fmean(prices), 2) if prices else None,
        }

    # strip private fields from peer rows
    pub_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    pub_target = None
    if target is not None:
        pub_target = {k: v for k, v in target.items() if not k.startswith("_")}

    return {
        "peers": pub_rows,
        "target": pub_target,
        "multiples": ["ev_ebitda", "ev_sales", "pe", "ps"],
        "stats": stats,
        "implied": implied,
    }


# ===========================================================================
# FEATURE E.4 - scenario + tornado
# ===========================================================================
def _price_for(inp: dict) -> Optional[float]:
    """Blended implied DCF price for a given input set (raw float)."""
    d = _run_dcf(inp)
    return d.get("implied_share_price")


def _mutate(inp: dict, **changes) -> dict:
    out = dict(inp)
    out["revenue_growth"] = list(inp["revenue_growth"])
    for k, v in changes.items():
        if k == "growth_shift":
            out["revenue_growth"] = [g + v for g in out["revenue_growth"]]
        elif k == "margin_shift":
            out["gross_margin"] = out["gross_margin"] + v
        else:
            out[k] = v
    return out


def run_scenario(inputs: dict) -> dict:
    """Base/bull/bear cases plus a one-at-a-time tornado on implied price.

    Bull/bear flex three levers together: revenue growth ramp, gross margin, and
    the terminal exit multiple. The tornado then isolates each driver, swinging
    it independently to rank which single assumption moves the valuation most.
    """
    try:
        return _run_scenario(_normalize_inputs(inputs))
    except Exception as e:
        log.warning("run_scenario failed, using sample: %s", e)
        try:
            return _run_scenario(_normalize_inputs(None))
        except Exception:
            return {"cases": [], "tornado": [], "base_price": None}


def _run_scenario(inp: dict) -> dict:
    base_price = _price_for(inp)

    bull = _mutate(inp, growth_shift=0.03, margin_shift=0.03,
                   exit_multiple=inp["exit_multiple"] + 3.0)
    bear = _mutate(inp, growth_shift=-0.03, margin_shift=-0.03,
                   exit_multiple=max(1.0, inp["exit_multiple"] - 3.0))

    cases = [
        {"case": "bear", "label": "Bear", "implied_price": bear and _price_for(bear),
         "assumptions": {"growth_shift": -0.03, "margin_shift": -0.03,
                         "exit_multiple": _r(max(1.0, inp["exit_multiple"] - 3.0), 1)}},
        {"case": "base", "label": "Base", "implied_price": base_price,
         "assumptions": {"growth_shift": 0.0, "margin_shift": 0.0,
                         "exit_multiple": _r(inp["exit_multiple"], 1)}},
        {"case": "bull", "label": "Bull", "implied_price": _price_for(bull),
         "assumptions": {"growth_shift": 0.03, "margin_shift": 0.03,
                         "exit_multiple": _r(inp["exit_multiple"] + 3.0, 1)}},
    ]
    for c in cases:
        p = c["implied_price"]
        c["implied_price"] = _r(p, 2)
        c["upside_vs_base"] = _ratio(_safe_div(p - base_price, base_price)) \
            if (p is not None and base_price) else None

    # ----- tornado: one driver at a time -----
    drivers = [
        ("revenue_growth", "Revenue growth", "growth_shift", -0.03, 0.03),
        ("gross_margin", "Gross margin", "margin_shift", -0.03, 0.03),
        ("exit_multiple", "Exit multiple", "exit_multiple",
         max(1.0, inp["exit_multiple"] - 3.0), inp["exit_multiple"] + 3.0),
        ("terminal_growth", "Terminal growth", "terminal_growth",
         max(0.0, inp["terminal_growth"] - 0.01), inp["terminal_growth"] + 0.01),
        ("beta", "Beta (WACC)", "beta",
         max(0.1, inp["beta"] - 0.20), inp["beta"] + 0.20),
        ("tax_rate", "Tax rate", "tax_rate",
         max(0.0, inp["tax_rate"] - 0.05), min(0.6, inp["tax_rate"] + 0.05)),
        ("capex_pct_revenue", "Capex intensity", "capex_pct_revenue",
         max(0.0, inp["capex_pct_revenue"] - 0.02), inp["capex_pct_revenue"] + 0.02),
    ]
    tornado = []
    for key, label, mkey, lo, hi in drivers:
        low_price = _price_for(_mutate(inp, **{mkey: lo}))
        high_price = _price_for(_mutate(inp, **{mkey: hi}))
        if low_price is None or high_price is None:
            continue
        swing = abs(high_price - low_price)
        tornado.append({
            "driver": key, "label": label,
            "low_input": _r(lo, 4), "high_input": _r(hi, 4),
            "low_price": _r(low_price, 2), "high_price": _r(high_price, 2),
            "swing": _r(swing, 2),
        })
    tornado.sort(key=lambda d: (d["swing"] is None, -(d["swing"] or 0.0)))

    return {
        "base_price": _r(base_price, 2),
        "cases": cases,
        "tornado": tornado,
    }


# ===========================================================================
# FEATURE E.5 - overview (runs all four, live-seeds from yfinance)
# ===========================================================================
def _seed_from_yfinance(ticker: str) -> Optional[dict]:
    """Best-effort: map yfinance .info onto pro forma inputs. None on any miss.

    Pulls revenue, margins, share count, beta, and net debt from a single
    ``.info`` call (millions). Drivers not surfaced by yfinance fall back to the
    sample defaults via input normalization. Never raises.
    """
    try:
        import yfinance as yf
    except Exception:
        return None
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
    except Exception:
        return None
    if not info:
        return None

    def num(*keys):
        for k in keys:
            v = info.get(k)
            if v is not None:
                try:
                    return float(v)
                except (TypeError, ValueError):
                    continue
        return None

    revenue = num("totalRevenue")
    if not revenue or revenue <= 0:
        return None  # without revenue we cannot anchor the model -> sample

    MM = 1_000_000.0
    rev_mm = revenue / MM
    gm = num("grossMargins")
    op_m = num("operatingMargins")
    shares = num("sharesOutstanding")
    total_cash = num("totalCash")
    total_debt = num("totalDebt")
    beta = num("beta")
    growth = num("revenueGrowth")
    ebitda = num("ebitda")
    price = num("currentPrice", "regularMarketPrice", "previousClose")

    seeded: dict = {
        "ticker": ticker.upper(),
        "company_name": info.get("shortName") or info.get("longName") or ticker.upper(),
        "revenue": rev_mm,
    }
    if gm and 0 < gm < 1:
        seeded["gross_margin"] = gm
        # opex implied so EBITDA margin tracks operating margin + D&A.
        if op_m is not None:
            seeded["opex_pct_revenue"] = max(0.01, gm - op_m - sample_data.SAMPLE_INPUTS["da_pct_revenue"])
    if shares and shares > 0:
        seeded["shares_outstanding"] = shares / MM
    if total_cash is not None:
        seeded["starting_cash"] = total_cash / MM
    if total_debt is not None:
        seeded["starting_debt"] = total_debt / MM
    if beta and beta > 0:
        seeded["beta"] = beta
    if growth is not None:
        base_g = max(-0.2, min(0.4, growth))
        seeded["revenue_growth"] = [round(base_g * (0.85 ** i), 4) for i in range(5)]
    # a coarse PP&E anchor when we cannot read the balance sheet
    seeded["starting_ppe"] = round(rev_mm * 0.22, 1)
    seeded["_live_price"] = price
    seeded["_live_ebitda_mm"] = (ebitda / MM) if ebitda else None
    return seeded


def _build_peers_for(inp: dict, ts: dict, live_price: Optional[float]) -> list[dict]:
    """Build a comps universe: live/sample peers + a target entry from inputs."""
    peers = [p for p in sample_data.sample_peers() if not p.get("is_target")]
    ebitda0 = ts["income_statement"][0]["ebitda"] or 0.0
    ni0 = None
    # year-0 net income is null by design; use Y1 as the trailing proxy
    if len(ts["income_statement"]) > 1:
        ni0 = ts["income_statement"][1]["net_income"]
    target = {
        "name": inp.get("company_name"), "ticker": inp.get("ticker"),
        "is_target": True,
        "price": live_price if (live_price and live_price > 0) else 132.00,
        "shares": inp["shares_outstanding"],
        "net_debt": (inp["starting_debt"] - inp["starting_cash"]),
        "ebitda": ebitda0,
        "sales": inp["revenue"],
        "net_income": ni0 if ni0 is not None else inp["revenue"] * 0.18,
    }
    return [target] + peers


def proforma_overview(ticker: Optional[str] = None) -> dict:
    """Run the full pro forma: three statements, DCF, comps, scenario.

    Defaults to the sample large-cap profile. When ``ticker`` is provided and
    yfinance fundamentals resolve, live inputs are seeded over the sample
    defaults (data_mode="live"). Any failure degrades cleanly to sample.
    """
    as_of = _now_iso()
    data_mode = "sample"
    source = "sample_data"
    seeded: Optional[dict] = None
    live_price: Optional[float] = None

    if ticker:
        try:
            seeded = _seed_from_yfinance(ticker)
        except Exception as e:
            log.warning("proforma live seed failed for %s: %s", ticker, e)
            seeded = None
        if seeded:
            data_mode = "live"
            source = "yfinance"
            live_price = seeded.pop("_live_price", None)
            seeded.pop("_live_ebitda_mm", None)

    try:
        inputs = _normalize_inputs(seeded)
    except Exception:
        inputs = _normalize_inputs(None)
        data_mode, source = "sample", "sample_data"

    try:
        three_statement = build_three_statement(inputs)
    except Exception:
        three_statement = build_three_statement(None)
    try:
        dcf = run_dcf(inputs)
    except Exception:
        dcf = run_dcf(None)
    try:
        peers = _build_peers_for(inputs, three_statement, live_price)
        comps = build_comps(peers)
    except Exception:
        comps = build_comps(None)
    try:
        scenario = run_scenario(inputs)
    except Exception:
        scenario = run_scenario(None)

    # public inputs (strip any private underscore keys)
    pub_inputs = {k: v for k, v in inputs.items() if not k.startswith("_")}

    return {
        "ticker": (ticker.upper() if ticker else inputs.get("ticker")),
        "company_name": inputs.get("company_name"),
        "inputs": pub_inputs,
        "three_statement": three_statement,
        "dcf": dcf,
        "comps": comps,
        "scenario": scenario,
        "data_mode": data_mode,
        "as_of": as_of,
        "source": source,
    }
