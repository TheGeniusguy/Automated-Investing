"""Tests for the cross-asset return comparator.

No network: ``finance.py`` is exercised directly against hand-verified
numbers; ``realestate``/``custom``/``engine`` need no network. ``model_market``
is exercised only through a monkeypatched ``fetch_arbitrary_ticker`` (the
``patch_data`` fixture in conftest routes it to the in-memory PRICE_DB).
"""
from __future__ import annotations

from app.compare import finance, realestate, custom, engine
from tests.conftest import register, calendar_grid


# ──────────────────────────────────────────────────────────────────────────
# finance.mortgage_payment
# ──────────────────────────────────────────────────────────────────────────
def test_mortgage_payment_300k_6pct_30y():
    pmt = finance.mortgage_payment(300000, 6.0, 30)
    assert abs(pmt - 1798.65) < 0.5


def test_mortgage_payment_zero_rate_straight_line():
    # 120000 over 10y at 0% == 120000 / 120 == 1000 exactly
    assert finance.mortgage_payment(120000, 0.0, 10) == 1000.0


def test_amortization_schedule_pays_off():
    sched = finance.amortization_schedule(120000, 0.0, 10)
    assert len(sched) == 120
    assert sched[-1]["balance"] == 0.0


# ──────────────────────────────────────────────────────────────────────────
# finance.irr / npv
# ──────────────────────────────────────────────────────────────────────────
def test_irr_per_period_and_npv_zero():
    cf = [-1000, 0, 0, 0, 0, 2000]
    rate = finance.irr(cf)
    assert rate is not None
    # doubling over 5 periods -> per-period rate ~ 2^(1/5) - 1
    assert abs(rate - 0.1487) < 1e-3
    assert abs(finance.npv(rate, cf)) < 1e-3


def test_irr_no_sign_change_returns_none():
    assert finance.irr([100, 200, 300]) is None
    assert finance.irr([-100, -200]) is None


# ──────────────────────────────────────────────────────────────────────────
# finance.cagr
# ──────────────────────────────────────────────────────────────────────────
def test_cagr_doubling_over_5y():
    assert abs(finance.cagr(1000, 2000, 5) - 0.1487) < 1e-3


def test_cagr_invalid_inputs():
    assert finance.cagr(0, 2000, 5) is None
    assert finance.cagr(1000, 2000, 0) is None
    assert finance.cagr(1000, -100, 5) is None


# ──────────────────────────────────────────────────────────────────────────
# finance.xirr
# ──────────────────────────────────────────────────────────────────────────
def test_xirr_one_year_doubling():
    flows = [("2023-01-01", -1000.0), ("2024-01-01", 2000.0)]
    rate = finance.xirr(flows)
    assert rate is not None
    # one-year doubling -> ~100% annualized
    assert abs(rate - 1.0) < 1e-2


def test_xirr_no_sign_change_returns_none():
    assert finance.xirr([("2023-01-01", -100.0), ("2024-01-01", -50.0)]) is None


# ──────────────────────────────────────────────────────────────────────────
# realestate.model_real_estate — all-cash sanity
# ──────────────────────────────────────────────────────────────────────────
def test_real_estate_all_cash_cash_on_cash():
    # 100% down, 0% loan, rent > expenses, no appreciation, 1y hold.
    params = {
        "label": "AllCash",
        "purchase_price": 100000,
        "down_payment_pct": 100,
        "loan_rate": 0.0,
        "loan_term_years": 30,
        "monthly_rent": 1000,
        "monthly_expenses": 300,
        "vacancy_pct": 0,
        "annual_appreciation_pct": 0,
        "hold_years": 1,
        "sale_cost_pct": 0,
    }
    r = realestate.model_real_estate(params)
    assert "error" not in r
    # annual net = (1000 - 300) * 12 = 8400; outlay = 100000 (all cash, no closing)
    expected_coc = 8400 / 100000 * 100.0  # 8.4 (percent)
    assert abs(r["metrics"]["cash_on_cash_year1"] - expected_coc) < 0.5
    assert r["metrics"]["equity_multiple"] > 1.0
    # first monthly row is the initial outlay
    assert r["monthly"][0]["month"] == 0
    assert r["monthly"][0]["equity"] == 100000.0


def test_real_estate_bad_input_no_raise():
    r = realestate.model_real_estate({"purchase_price": -5, "hold_years": 1})
    assert "error" in r


# ──────────────────────────────────────────────────────────────────────────
# custom.model_custom — known IRR series
# ──────────────────────────────────────────────────────────────────────────
def test_custom_known_irr():
    # Invest 1000, get back 2000 in one year via terminal value -> ~100% IRR.
    params = {
        "label": "Note",
        "initial_investment": 1000,
        "cashflows": [],
        "terminal_value": 2000,
        "hold_years": 1,
        "start_date": "2023-01-01",
    }
    r = custom.model_custom(params)
    assert "error" not in r
    assert abs(r["metrics"]["irr_annual"] - 1.0) < 1e-2
    assert abs(r["metrics"]["equity_multiple"] - 2.0) < 1e-6
    # cagr of 1000 -> 2000 over 1y is 1.0
    assert abs(r["metrics"]["cagr"] - 1.0) < 1e-2


def test_custom_with_periodic_distributions():
    params = {
        "label": "Bond",
        "initial_investment": 1000,
        "cashflows": [
            {"date": "2023-07-01", "amount": 50},
            {"date": "2024-01-01", "amount": 50},
        ],
        "terminal_value": 1000,
        "hold_years": 1,
        "start_date": "2023-01-01",
    }
    r = custom.model_custom(params)
    assert "error" not in r
    # total inflows = 1100, invested 1000 -> MOIC 1.1
    assert abs(r["metrics"]["equity_multiple"] - 1.1) < 1e-6
    assert r["metrics"]["irr_annual"] is not None and r["metrics"]["irr_annual"] > 0


# ──────────────────────────────────────────────────────────────────────────
# engine.compare_investments
# ──────────────────────────────────────────────────────────────────────────
def test_engine_compares_and_ranks():
    investments = [
        {
            "kind": "custom",
            "label": "Double",
            "params": {
                "initial_investment": 1000,
                "cashflows": [],
                "terminal_value": 2000,
                "hold_years": 1,
                "start_date": "2023-01-01",
            },
        },
        {
            "kind": "custom",
            "label": "Flat",
            "params": {
                "initial_investment": 1000,
                "cashflows": [],
                "terminal_value": 1050,
                "hold_years": 1,
                "start_date": "2023-01-01",
            },
        },
    ]
    out = engine.compare_investments(investments)
    table = out["comparison"]["metrics_table"]
    assert len(table) == 2
    # Double has the higher IRR -> ranked best
    assert out["comparison"]["best_by_irr"] == "Double"
    # normalized series start at 100
    for label, vals in out["comparison"]["series"].items():
        first = next(v for v in vals if v is not None)
        assert abs(first - 100.0) < 1e-6


def test_engine_flags_errored_investment():
    investments = [
        {"kind": "custom", "label": "Bad", "params": {"initial_investment": 0, "hold_years": 1}},
        {"kind": "nonsense", "label": "Huh", "params": {}},
    ]
    out = engine.compare_investments(investments)
    # both kept in investments list, both carry error, none in the table
    assert len(out["investments"]) == 2
    assert all("error" in inv for inv in out["investments"])
    assert out["comparison"]["metrics_table"] == []
    assert out["comparison"]["best_by_irr"] is None


def test_engine_market_via_patched_fetch(patch_data):
    # PRICE_DB doubling over ~1y -> normalized curve + positive return.
    dates = calendar_grid(370)
    # linear ramp from 100 -> 200
    values = [100 + 100 * i / (len(dates) - 1) for i in range(len(dates))]
    register("FAKE", dates, values)

    investments = [
        {
            "kind": "market",
            "label": "FAKE",
            "params": {"symbol": "FAKE", "initial_investment": 1000, "days": 365},
        }
    ]
    out = engine.compare_investments(investments)
    inv = out["investments"][0]
    assert "error" not in inv
    assert inv["metrics"]["equity_multiple"] > 1.5
    assert "FAKE" in out["comparison"]["series"]
