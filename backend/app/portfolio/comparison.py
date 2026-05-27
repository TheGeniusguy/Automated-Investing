"""Side-by-side comparison of multiple portfolios."""
from __future__ import annotations

import logging

import numpy as np

from . import crud
from . import analytics
from . import risk
from .positions import compute_positions
from .valuation import enrich_positions

log = logging.getLogger(__name__)


def _normalize_curve_to_100(dates: list[str], raw_nav: list[float]) -> list[float | None]:
    """Normalize a NAV series to 100 at the first positive value."""
    first = next((v for v in raw_nav if v and v > 0), None)
    if not first:
        return [None] * len(dates)
    return [round(v / first * 100, 4) if v else None for v in raw_nav]


def _daily_returns_by_date(dates: list[str], raw_nav: list[float]) -> dict[str, float]:
    """Map each date (from index 1 onward) to its daily return."""
    out: dict[str, float] = {}
    for i in range(1, len(raw_nav)):
        prev = raw_nav[i - 1]
        cur = raw_nav[i]
        if prev and prev > 0 and cur is not None:
            out[dates[i]] = (cur - prev) / prev
    return out


def _build_one(portfolio_id: int, lookback_days: int) -> dict | None:
    """Fetch + compute all analytics for a single portfolio. Sequential by design
    (DuckDB is single-connection)."""
    pf = crud.get_portfolio(portfolio_id)
    if not pf:
        return None
    txns = crud.get_transactions(portfolio_id)

    # Equity curve (already normalized to 100 internally + raw NAV)
    try:
        curve = analytics.build_equity_curve(txns, pf["cash_balance"], lookback_days=lookback_days)
    except Exception as e:
        log.warning("build_equity_curve failed for portfolio %s: %s", portfolio_id, e)
        curve = {"dates": [], "portfolio": [], "portfolio_raw": [], "benchmarks": {}}

    # Re-normalize portfolio curve to 100 at the start of the lookback window so
    # all portfolios are directly comparable on the same scale.
    dates = curve.get("dates", [])
    raw_nav = curve.get("portfolio_raw", [])
    normalized = _normalize_curve_to_100(dates, raw_nav)

    # Performance metrics
    try:
        metrics = analytics.compute_performance_metrics(txns, pf["cash_balance"], lookback_days=lookback_days)
    except Exception as e:
        log.warning("compute_performance_metrics failed for portfolio %s: %s", portfolio_id, e)
        metrics = {}

    # Twr (time-weighted return over the window) from the normalized curve
    twr_pct = None
    valid_norm = [v for v in normalized if v is not None]
    if len(valid_norm) >= 2 and valid_norm[0]:
        twr_pct = round((valid_norm[-1] / valid_norm[0] - 1) * 100, 2)
    metrics = {**metrics, "twr_pct": twr_pct}

    # Enriched positions + summary + risk
    positions, _total_realized, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    try:
        enriched, summary = enrich_positions(positions, current_cash)
    except Exception as e:
        log.warning("enrich_positions failed for portfolio %s: %s", portfolio_id, e)
        enriched, summary = [], {}

    try:
        risk_report = risk.compute_portfolio_risk(enriched, lookback_days=lookback_days)
    except Exception as e:
        log.warning("compute_portfolio_risk failed for portfolio %s: %s", portfolio_id, e)
        risk_report = {}

    return {
        "id": pf["id"],
        "name": pf["name"],
        "curve": {
            "dates": dates,
            "portfolio": normalized,
            "benchmarks": curve.get("benchmarks", {}),
        },
        "metrics": metrics,
        "risk": risk_report,
        "summary": summary,
        # Internal: daily returns keyed by date, used for the correlation matrix.
        "_returns_by_date": _daily_returns_by_date(dates, raw_nav),
    }


def compare_portfolios(portfolio_ids: list[int], lookback_days: int = 365) -> dict:
    """
    Given a list of portfolio IDs, return side-by-side analytics for all of them.

    For each portfolio:
    - Fetch transactions from crud.get_transactions()
    - Fetch portfolio record from crud.get_portfolio()
    - Build equity curve via analytics.build_equity_curve()
    - Compute performance metrics via analytics.compute_performance_metrics()
    - Compute risk via risk.compute_portfolio_risk() (using enriched positions)

    Equity curves are normalized to 100 at the start of the lookback period so
    they're directly comparable. The correlation matrix is the pairwise Pearson
    correlation between each portfolio's daily-return series, aligned on common
    dates.
    """
    built: list[dict] = []
    for pid in portfolio_ids:
        # Sequential — DuckDB is single-connection.
        result = _build_one(pid, lookback_days)
        if result is not None:
            built.append(result)

    if not built:
        return {
            "portfolios": [],
            "common_dates": [],
            "correlation_matrix": [],
            "correlation_labels": [],
        }

    # Union of all curve dates for x-axis alignment.
    common_dates = sorted({d for b in built for d in b["curve"]["dates"]})

    # Correlation matrix between portfolio daily returns, aligned on common dates.
    labels = [b["name"] for b in built]
    return_maps = [b["_returns_by_date"] for b in built]
    n = len(built)
    corr_matrix: list[list[float | None]] = [[None] * n for _ in range(n)]

    for i in range(n):
        corr_matrix[i][i] = 1.0
        for j in range(i + 1, n):
            shared = sorted(set(return_maps[i]) & set(return_maps[j]))
            if len(shared) >= 20:
                a = np.array([return_maps[i][d] for d in shared])
                b = np.array([return_maps[j][d] for d in shared])
                if np.std(a) > 0 and np.std(b) > 0:
                    c = float(np.corrcoef(a, b)[0, 1])
                    corr_matrix[i][j] = round(c, 3)
                    corr_matrix[j][i] = round(c, 3)

    # Strip internal field before returning.
    portfolios = []
    for b in built:
        out = {k: v for k, v in b.items() if not k.startswith("_")}
        portfolios.append(out)

    return {
        "portfolios": portfolios,
        "common_dates": common_dates,
        "correlation_matrix": corr_matrix,
        "correlation_labels": labels,
    }
