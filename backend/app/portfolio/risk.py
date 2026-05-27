"""Portfolio risk analytics — VaR, CVaR, correlation, factor exposures.

All computations use historical daily returns from DuckDB prices_daily
(falling back to yfinance). numpy is used for numerical work; scipy for OLS.
"""
from __future__ import annotations

import logging
import math
from datetime import date, timedelta

import numpy as np
from scipy import stats

log = logging.getLogger(__name__)

FACTOR_ETFS = ["SPY", "QQQ", "IWM", "HYG", "GLD", "TLT"]
TRADING_DAYS = 252


def _fetch_returns(symbol: str, days: int) -> tuple[list[str], list[float]]:
    """Return (dates, daily_returns) for a symbol."""
    from ..data.macro_data import fetch_arbitrary_ticker
    pts = fetch_arbitrary_ticker(symbol, days=days + 5)
    if len(pts) < 2:
        return [], []
    valid = [(p["date"], float(p["value"])) for p in pts if p["value"] is not None]
    if len(valid) < 2:
        return [], []
    dates  = [v[0] for v in valid[1:]]
    prices = [v[1] for v in valid]
    rets   = [(prices[i] - prices[i-1]) / prices[i-1] for i in range(1, len(prices))]
    return dates, rets


def _align_series(
    dates_a: list[str], rets_a: list[float],
    dates_b: list[str], rets_b: list[float],
) -> tuple[list[float], list[float]]:
    """Align two return series on common dates."""
    b_map = dict(zip(dates_b, rets_b))
    aligned_a, aligned_b = [], []
    for d, ra in zip(dates_a, rets_a):
        if d in b_map:
            aligned_a.append(ra)
            aligned_b.append(b_map[d])
    return aligned_a, aligned_b


def compute_portfolio_risk(
    enriched_positions: list[dict],
    lookback_days: int = 252,
) -> dict:
    """
    Full quant risk report for the portfolio.

    Returns:
    - VaR (95%, 99%) and CVaR at same confidence levels
    - Portfolio annualized volatility
    - Per-position beta vs SPY
    - Correlation matrix (pairwise Pearson)
    - Factor exposures (OLS betas to SPY/QQQ/IWM/HYG/GLD/TLT)
    - Concentration metrics
    """
    symbols  = [p["symbol"] for p in enriched_positions]
    weights  = np.array([p["portfolio_weight"] / 100.0 for p in enriched_positions])

    if not symbols:
        return _empty_risk()

    # --- Fetch individual return series ---
    returns_map: dict[str, tuple[list[str], list[float]]] = {}
    for sym in symbols:
        d, r = _fetch_returns(sym, lookback_days)
        returns_map[sym] = (d, r)

    spy_dates, spy_rets = _fetch_returns("SPY", lookback_days)

    # --- Build aligned return matrix (all symbols on common dates) ---
    # Use SPY dates as reference (most complete)
    common_dates: list[str] = spy_dates if spy_dates else sorted(
        {d for dates, _ in returns_map.values() for d in dates}
    )

    ret_matrix: list[np.ndarray] = []
    valid_symbols: list[str]     = []
    valid_weights: list[float]   = []

    for sym, wt, pos in zip(symbols, weights, enriched_positions):
        dates, rets = returns_map.get(sym, ([], []))
        if not rets:
            continue
        date_map = dict(zip(dates, rets))
        aligned = [date_map.get(d) for d in common_dates]
        # Fill short gaps with 0
        filled = [r if r is not None else 0.0 for r in aligned]
        if sum(1 for r in filled if r != 0.0) < 20:
            continue
        ret_matrix.append(np.array(filled))
        valid_symbols.append(sym)
        valid_weights.append(wt)

    if not ret_matrix:
        return _empty_risk()

    # Renormalize weights for valid positions only
    wts = np.array(valid_weights)
    total_wt = wts.sum()
    wts = wts / total_wt if total_wt > 0 else wts

    ret_mat  = np.stack(ret_matrix, axis=0)   # (n_assets, n_days)
    port_ret = wts @ ret_mat                   # (n_days,)

    # --- VaR + CVaR ---
    def _var_cvar(returns: np.ndarray, confidence: float):
        threshold = np.percentile(returns, (1 - confidence) * 100)
        cvar = float(np.mean(returns[returns <= threshold]))
        return float(threshold), cvar

    var_95, cvar_95 = _var_cvar(port_ret, 0.95)
    var_99, cvar_99 = _var_cvar(port_ret, 0.99)

    # --- Portfolio volatility ---
    port_vol = float(np.std(port_ret, ddof=1) * math.sqrt(TRADING_DAYS))

    # --- Per-position beta vs SPY ---
    spy_map = dict(zip(spy_dates, spy_rets))
    position_betas: dict[str, float | None] = {}
    for sym in valid_symbols:
        dates, rets = returns_map.get(sym, ([], []))
        aligned_sym, aligned_spy = _align_series(dates, rets, spy_dates, spy_rets)
        if len(aligned_sym) >= 20:
            cov = np.cov(aligned_sym, aligned_spy)
            b = float(cov[0, 1] / cov[1, 1]) if cov[1, 1] > 0 else None
            position_betas[sym] = round(b, 3) if b is not None else None
        else:
            position_betas[sym] = None

    # --- Correlation matrix ---
    n = len(valid_symbols)
    corr_matrix: list[list[float | None]] = [[None] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                corr_matrix[i][j] = 1.0
            elif j > i:
                a, b = ret_matrix[i], ret_matrix[j]
                nonzero = (a != 0) | (b != 0)
                if nonzero.sum() >= 20:
                    c = float(np.corrcoef(a[nonzero], b[nonzero])[0, 1])
                    corr_matrix[i][j] = round(c, 3)
                    corr_matrix[j][i] = round(c, 3)

    # --- Factor exposures: OLS portfolio returns vs 6 factor ETFs ---
    factor_exposures: list[dict] = []
    factor_rets: list[np.ndarray] = []
    factor_labels: list[str] = []

    for sym in FACTOR_ETFS:
        fd, fr = _fetch_returns(sym, lookback_days)
        fm = dict(zip(fd, fr))
        aligned_f = np.array([fm.get(d, 0.0) for d in common_dates])
        factor_rets.append(aligned_f)
        factor_labels.append(sym)

    if factor_rets and len(port_ret) >= 30:
        X = np.stack(factor_rets, axis=1)   # (n_days, n_factors)
        # Add intercept
        X_int = np.column_stack([np.ones(X.shape[0]), X])
        try:
            coefs, resid, rank, sv = np.linalg.lstsq(X_int, port_ret, rcond=None)
            intercept = float(coefs[0]) * TRADING_DAYS  # annualized alpha
            betas = coefs[1:]
            predicted = X_int @ coefs
            ss_res = float(np.sum((port_ret - predicted) ** 2))
            ss_tot = float(np.sum((port_ret - np.mean(port_ret)) ** 2))
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
            for lbl, b in zip(factor_labels, betas):
                factor_exposures.append({"factor": lbl, "beta": round(float(b), 3)})
            factor_r2 = round(r2, 3)
        except Exception as e:
            log.warning("Factor OLS failed: %s", e)
            factor_r2 = None
    else:
        factor_r2 = None

    # --- Concentration metrics ---
    herfindahl = float(np.sum(wts ** 2))
    top3_weight = float(np.sum(np.sort(wts)[::-1][:3]))
    max_weight  = float(np.max(wts)) if len(wts) > 0 else 0.0

    return {
        "var_95_daily_pct":  round(var_95 * 100, 3),
        "cvar_95_daily_pct": round(cvar_95 * 100, 3),
        "var_99_daily_pct":  round(var_99 * 100, 3),
        "cvar_99_daily_pct": round(cvar_99 * 100, 3),
        "var_95_annual_pct": round(var_95 * math.sqrt(TRADING_DAYS) * 100, 2),
        "portfolio_volatility_pct": round(port_vol * 100, 2),
        "position_betas":    position_betas,
        "symbols":           valid_symbols,
        "correlation_matrix":corr_matrix,
        "factor_exposures":  factor_exposures,
        "factor_r2":         factor_r2,
        "herfindahl":        round(herfindahl, 4),
        "top3_concentration_pct": round(top3_weight * 100, 1),
        "largest_position_pct":   round(max_weight * 100, 1),
        "lookback_days":     lookback_days,
        "data_points":       len(port_ret),
    }


def _empty_risk() -> dict:
    return {
        "var_95_daily_pct": None, "cvar_95_daily_pct": None,
        "var_99_daily_pct": None, "cvar_99_daily_pct": None,
        "var_95_annual_pct": None, "portfolio_volatility_pct": None,
        "position_betas": {}, "symbols": [],
        "correlation_matrix": [], "factor_exposures": [],
        "factor_r2": None, "herfindahl": None,
        "top3_concentration_pct": None, "largest_position_pct": None,
        "lookback_days": 0, "data_points": 0,
    }
