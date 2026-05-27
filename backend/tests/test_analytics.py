"""Performance-metric invariants for app.portfolio.analytics.

Rather than asserting magic numbers, these rebuild the documented formula from
the function's own equity curve and assert equality. That locks the *contract*:
- Sortino denominator divides by ALL N days (sqrt(mean(min(r-rf,0)**2))), not
  the count of down days.
- R^2 is the true OLS fit via numpy.linalg.lstsq, not a Jensen's-alpha proxy.
- YTD anchors to the last close on or before Dec 31 of the prior year.
"""
from __future__ import annotations

import math

import numpy as np

from app.portfolio import analytics
from .conftest import calendar_grid, register, RF_ANNUAL

TDY = analytics.TRADING_DAYS_PER_YEAR


def _setup_market(n_days: int = 780):
    """Register deterministic, non-trivial price paths for a held name + benchmarks."""
    grid = calendar_grid(n_days)
    held, spy, qqq = [], [], []
    for i in range(n_days):
        held.append(100.0 * (1 + 0.0003 * i + 0.02 * math.sin(i / 5.0)))
        spy.append(400.0 * (1 + 0.00022 * i + 0.015 * math.sin(i / 5.0 + 0.7)))
        qqq.append(350.0 * (1 + 0.00025 * i + 0.018 * math.sin(i / 4.0 + 1.1)))
    register("HELD", grid, held)
    register("SPY", grid, spy)
    register("QQQ", grid, qqq)
    return grid, held


def _txns(grid, held):
    return [{
        "id": 1, "symbol": "HELD", "trade_type": "buy",
        "quantity": 100.0, "price": held[0], "trade_date": grid[0],
        "commission": 0.0,
    }]


def test_sortino_uses_all_n_day_denominator(txn):
    grid, held = _setup_market()
    RF_ANNUAL["value"] = 0.0
    txns = _txns(grid, held)

    ec = analytics.build_equity_curve(txns, initial_cash=100_000.0, lookback_days=756)
    metrics = analytics.compute_performance_metrics(txns, initial_cash=100_000.0, lookback_days=252)

    nav = np.array(ec["portfolio_raw"], dtype=float)
    daily = np.diff(nav) / nav[:-1]
    n = len(daily)
    ann_return = float((nav[-1] / nav[0]) ** (TDY / n) - 1)

    # ALL-N denominator (the invariant)
    semi_sq = np.minimum(daily - 0.0, 0.0) ** 2
    downside_std = float(np.sqrt(np.mean(semi_sq)) * math.sqrt(TDY))
    expected_sortino = (ann_return - 0.0) / downside_std

    assert metrics["sortino"] is not None
    assert math.isclose(metrics["sortino"], round(expected_sortino, 3), abs_tol=1e-3)

    # Guard: the WRONG (down-day-count) denominator would differ materially here.
    down = daily[daily < 0]
    wrong_denom = float(np.sqrt(np.sum(semi_sq) / len(down)) * math.sqrt(TDY))
    wrong_sortino = (ann_return - 0.0) / wrong_denom
    assert not math.isclose(metrics["sortino"], round(wrong_sortino, 3), abs_tol=1e-3)


def test_r_squared_equals_direct_lstsq(txn):
    grid, held = _setup_market()
    RF_ANNUAL["value"] = 0.0
    txns = _txns(grid, held)

    ec = analytics.build_equity_curve(txns, initial_cash=100_000.0, lookback_days=756)
    metrics = analytics.compute_performance_metrics(txns, initial_cash=100_000.0, lookback_days=252)

    nav = np.array(ec["portfolio_raw"], dtype=float)
    daily = np.diff(nav) / nav[:-1]
    dates = ec["dates"]
    spy_curve = ec["benchmarks"]["SPY"]

    valid = [
        (daily[i], spy_curve[i + 1], spy_curve[i])
        for i in range(len(daily))
        if spy_curve[i] is not None and spy_curve[i + 1] is not None
    ]
    pa = np.array([v[0] for v in valid])
    sa = np.array([(v[1] - v[2]) / v[2] for v in valid])

    X = np.column_stack([np.ones(len(pa)), sa])
    coefs, _, _, _ = np.linalg.lstsq(X, pa, rcond=None)
    predicted = X @ coefs
    ss_tot = float(np.sum((pa - np.mean(pa)) ** 2))
    ss_res = float(np.sum((pa - predicted) ** 2))
    expected_r2 = 1 - ss_res / ss_tot

    assert metrics["r_squared"] is not None
    assert math.isclose(metrics["r_squared"], round(expected_r2, 3), abs_tol=1e-3)
    # Meaningful, partial fit (phase-shifted benchmark) — not degenerate.
    assert 0.0 < metrics["r_squared"] < 1.0


def test_beta_matches_covariance_definition(txn):
    grid, held = _setup_market()
    RF_ANNUAL["value"] = 0.0
    txns = _txns(grid, held)

    ec = analytics.build_equity_curve(txns, initial_cash=100_000.0, lookback_days=756)
    metrics = analytics.compute_performance_metrics(txns, initial_cash=100_000.0, lookback_days=252)

    nav = np.array(ec["portfolio_raw"], dtype=float)
    daily = np.diff(nav) / nav[:-1]
    spy_curve = ec["benchmarks"]["SPY"]
    valid = [
        (daily[i], spy_curve[i + 1], spy_curve[i])
        for i in range(len(daily))
        if spy_curve[i] is not None and spy_curve[i + 1] is not None
    ]
    pa = np.array([v[0] for v in valid])
    sa = np.array([(v[1] - v[2]) / v[2] for v in valid])
    cov = np.cov(pa, sa)
    expected_beta = cov[0, 1] / cov[1, 1]
    assert math.isclose(metrics["beta"], round(float(expected_beta), 3), abs_tol=1e-3)


def test_ytd_anchors_to_prior_year_close(txn):
    grid, held = _setup_market()
    RF_ANNUAL["value"] = 0.0
    txns = _txns(grid, held)

    ec = analytics.build_equity_curve(txns, initial_cash=100_000.0, lookback_days=756)
    metrics = analytics.compute_performance_metrics(txns, initial_cash=100_000.0, lookback_days=252)

    from datetime import date
    jan1 = f"{date.today().year}-01-01"
    dates = ec["dates"]
    raw = ec["portfolio_raw"]
    pairs = [(d, v) for d, v in zip(dates, raw) if v is not None]
    before = [(d, v) for d, v in pairs if d < jan1]
    # The test grid spans into the prior year, so a Dec-prior base must exist.
    assert before, "expected a prior-year close in the grid"
    base = before[-1][1]
    expected_ytd = (pairs[-1][1] / base - 1) * 100

    ytd_row = next(r for r in metrics["rolling"] if r["window"] == "ytd")
    assert ytd_row["portfolio_pct"] is not None
    assert math.isclose(ytd_row["portfolio_pct"], round(expected_ytd, 2), abs_tol=2e-2)


def test_empty_transactions_yield_empty_metrics():
    m = analytics.compute_performance_metrics([], initial_cash=0.0, lookback_days=252)
    assert m["data_points"] == 0
    assert m["sharpe"] is None
    assert m["sortino"] is None
