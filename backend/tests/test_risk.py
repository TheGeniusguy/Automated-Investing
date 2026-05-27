"""Risk-analytics invariants for app.portfolio.risk.compute_portfolio_risk.

Concentration metrics are pure functions of the weights; VaR/CVaR are the
empirical percentile of the reconstructed portfolio return series. We rebuild
both independently and assert equality.
"""
from __future__ import annotations

import math

import numpy as np

from app.portfolio import risk
from .conftest import calendar_grid, register

FACTORS = risk.FACTOR_ETFS


def _setup(n_days: int = 80):
    grid = calendar_grid(n_days)
    # Two held names with distinct deterministic paths.
    aaa = [100.0 * (1 + 0.001 * i + 0.03 * math.sin(i / 3.0)) for i in range(n_days)]
    bbb = [50.0 * (1 + 0.0005 * i + 0.04 * math.cos(i / 4.0)) for i in range(n_days)]
    register("AAA", grid, aaa)
    register("BBB", grid, bbb)
    register("SPY", grid, [410.0 * (1 + 0.0008 * i + 0.02 * math.sin(i / 3.0 + 0.5)) for i in range(n_days)])
    for k, etf in enumerate(FACTORS):
        if etf == "SPY":
            continue
        register(etf, grid, [(80.0 + 10 * k) * (1 + 0.0006 * i + 0.02 * math.sin(i / (3.0 + k))) for i in range(n_days)])
    return grid


def _returns_from_prices(symbol: str):
    from .conftest import PRICE_DB
    pts = PRICE_DB[symbol]
    prices = [p["value"] for p in pts]
    dates = [pts[i]["date"] for i in range(1, len(pts))]
    rets = [(prices[i] - prices[i - 1]) / prices[i - 1] for i in range(1, len(prices))]
    return dates, rets


def test_herfindahl_and_concentration_from_weights():
    _setup()
    enriched = [
        {"symbol": "AAA", "portfolio_weight": 60.0},
        {"symbol": "BBB", "portfolio_weight": 40.0},
    ]
    r = risk.compute_portfolio_risk(enriched, lookback_days=60)
    # weights renormalize over valid symbols to [0.6, 0.4]
    assert math.isclose(r["herfindahl"], 0.52, abs_tol=1e-4)
    assert math.isclose(r["top3_concentration_pct"], 100.0, abs_tol=1e-1)
    assert math.isclose(r["largest_position_pct"], 60.0, abs_tol=1e-1)


def test_var_cvar_match_empirical_percentile():
    _setup()
    enriched = [
        {"symbol": "AAA", "portfolio_weight": 60.0},
        {"symbol": "BBB", "portfolio_weight": 40.0},
    ]
    r = risk.compute_portfolio_risk(enriched, lookback_days=60)

    _, ra = _returns_from_prices("AAA")
    _, rb = _returns_from_prices("BBB")
    port = 0.6 * np.array(ra) + 0.4 * np.array(rb)

    exp_var95 = float(np.percentile(port, 5))
    exp_cvar95 = float(np.mean(port[port <= exp_var95]))
    assert math.isclose(r["var_95_daily_pct"], round(exp_var95 * 100, 3), abs_tol=1e-2)
    assert math.isclose(r["cvar_95_daily_pct"], round(exp_cvar95 * 100, 3), abs_tol=1e-2)
    # CVaR is at least as severe as VaR (more negative or equal).
    assert r["cvar_95_daily_pct"] <= r["var_95_daily_pct"]


def test_correlation_matrix_diagonal_is_one():
    _setup()
    enriched = [
        {"symbol": "AAA", "portfolio_weight": 50.0},
        {"symbol": "BBB", "portfolio_weight": 50.0},
    ]
    r = risk.compute_portfolio_risk(enriched, lookback_days=60)
    cm = r["correlation_matrix"]
    n = len(r["symbols"])
    assert n == 2
    for i in range(n):
        assert cm[i][i] == 1.0
    # symmetric
    assert cm[0][1] == cm[1][0]


def test_factor_exposures_present_and_labeled():
    _setup()
    enriched = [{"symbol": "AAA", "portfolio_weight": 100.0}]
    r = risk.compute_portfolio_risk(enriched, lookback_days=60)
    labels = [f["factor"] for f in r["factor_exposures"]]
    assert labels == FACTORS  # order preserved
    assert r["factor_r2"] is not None


def test_empty_positions_return_empty_risk():
    r = risk.compute_portfolio_risk([], lookback_days=60)
    assert r["herfindahl"] is None
    assert r["symbols"] == []
    assert r["data_points"] == 0
