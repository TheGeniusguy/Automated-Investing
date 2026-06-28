"""Sample financial profiles for the IB-level pro forma model.

Everything here is a clearly-named ``SAMPLE_*`` constant so the data is honest
under the hood even though the UI never renders a "sample" badge. All monetary
figures are in MILLIONS of USD unless noted. Ratios are decimals (0.58 == 58%).

The default profile is a realistic large-cap with a net-cash balance sheet,
mid-50s gross margins, a decelerating growth ramp, and a peer set drawn from
comparable large-caps. It is tuned so the three statements tie, the DCF prints
a sensible implied price, and the comps imply a valuation in the same zip code.
"""
from __future__ import annotations

from typing import Any


# ---------------------------------------------------------------------------
# Default target company (large-cap profile). All $ in millions.
# ---------------------------------------------------------------------------
SAMPLE_INPUTS: dict[str, Any] = {
    "ticker": "ACME",
    "company_name": "Acme Industries",
    "currency": "USD",

    # --- Base-year (LTM actuals) income drivers ---
    "revenue": 98000.0,            # last-twelve-month revenue
    "gross_margin": 0.58,          # gross profit / revenue
    "opex_pct_revenue": 0.27,      # SG&A + R&D as % of revenue (excludes D&A)
    "da_pct_revenue": 0.040,       # depreciation & amortization as % of revenue
    "capex_pct_revenue": 0.050,    # capital expenditure as % of revenue
    "tax_rate": 0.21,              # effective cash tax rate

    # --- Working-capital drivers (days) ---
    "dso_days": 42.0,              # days sales outstanding -> accounts receivable
    "dio_days": 35.0,              # days inventory outstanding -> inventory
    "dpo_days": 55.0,              # days payable outstanding -> accounts payable

    # --- Revenue growth ramp (one entry per projected year) ---
    "revenue_growth": [0.110, 0.090, 0.080, 0.070, 0.060],
    "projection_years": 5,

    # --- Starting balance sheet (year 0) ---
    "starting_cash": 25000.0,
    "starting_debt": 18000.0,
    "starting_ppe": 22000.0,       # PP&E, net
    "annual_debt_repayment": 0.0,  # scheduled principal paydown per year
    "dividend_payout": 0.0,        # dividends as % of net income

    # --- Capital structure / valuation ---
    "shares_outstanding": 1850.0,  # diluted shares, millions
    "interest_rate_on_debt": 0.050,

    # --- WACC inputs (CAPM cost of equity) ---
    "risk_free_rate": 0.042,
    "equity_risk_premium": 0.050,
    "beta": 1.15,
    "cost_of_debt": 0.050,
    "debt_weight": 0.18,           # target D / (D + E) for WACC

    # --- Terminal value ---
    "terminal_growth": 0.025,      # Gordon perpetuity growth
    "exit_multiple": 14.0,         # terminal EV / EBITDA
}


# ---------------------------------------------------------------------------
# Sample trading-comps universe. Raw financials ($MM) so multiples are
# COMPUTED, not asserted (the IB-correct way). One entry is the target.
# ---------------------------------------------------------------------------
SAMPLE_PEERS: list[dict[str, Any]] = [
    {
        "name": "Acme Industries", "ticker": "ACME", "is_target": True,
        "price": 132.00, "shares": 1850.0, "net_debt": -7000.0,
        "ebitda": 30380.0, "sales": 98000.0, "net_income": 18200.0,
    },
    {
        "name": "Vertex Systems", "ticker": "VRTX", "is_target": False,
        "price": 268.00, "shares": 920.0, "net_debt": 4200.0,
        "ebitda": 21500.0, "sales": 61000.0, "net_income": 12800.0,
    },
    {
        "name": "Pinnacle Holdings", "ticker": "PNCL", "is_target": False,
        "price": 88.50, "shares": 3100.0, "net_debt": 15500.0,
        "ebitda": 28900.0, "sales": 104000.0, "net_income": 14100.0,
    },
    {
        "name": "Northgate Technologies", "ticker": "NRTH", "is_target": False,
        "price": 415.00, "shares": 540.0, "net_debt": -3100.0,
        "ebitda": 12400.0, "sales": 33000.0, "net_income": 7900.0,
    },
    {
        "name": "Stratos Corp", "ticker": "STRA", "is_target": False,
        "price": 56.25, "shares": 2400.0, "net_debt": 9800.0,
        "ebitda": 9600.0, "sales": 42000.0, "net_income": 4300.0,
    },
    {
        "name": "Meridian Global", "ticker": "MRDN", "is_target": False,
        "price": 191.75, "shares": 1280.0, "net_debt": 6600.0,
        "ebitda": 18700.0, "sales": 58500.0, "net_income": 10200.0,
    },
]


def sample_inputs() -> dict[str, Any]:
    """Return a deep-ish copy of the default inputs (lists copied too)."""
    out = dict(SAMPLE_INPUTS)
    out["revenue_growth"] = list(SAMPLE_INPUTS["revenue_growth"])
    return out


def sample_peers() -> list[dict[str, Any]]:
    """Return a fresh copy of the sample comps universe."""
    return [dict(p) for p in SAMPLE_PEERS]
