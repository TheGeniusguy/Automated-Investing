"""Portfolio performance analytics — equity curve, returns, risk-adjusted metrics.

All statistics are computed from daily NAV (Net Asset Value) series which is
derived by replaying the transaction log against historical close prices.
"""
from __future__ import annotations

import logging
import math
from datetime import date, timedelta

import numpy as np

from .positions import compute_positions

log = logging.getLogger(__name__)

RISK_FREE_SERIES = "DGS3MO"   # 3-month T-bill from FRED
BENCHMARK_SYMS   = ["SPY", "QQQ"]
TRADING_DAYS_PER_YEAR = 252


def _fetch_prices(symbol: str, days: int) -> dict[str, float]:
    """Returns {date_str: close_price} for the last `days` calendar days."""
    from ..data.macro_data import fetch_arbitrary_ticker
    pts = fetch_arbitrary_ticker(symbol, days=days)
    return {p["date"]: float(p["value"]) for p in pts if p["value"] is not None}


def _fetch_risk_free_rate() -> float:
    """Annualized risk-free rate (DGS3MO / 100). Falls back to 5%."""
    try:
        from ..data.macro_data import fetch_series
        pts = fetch_series(RISK_FREE_SERIES, days=30)
        recent = [p["value"] for p in pts if p["value"] is not None]
        return recent[-1] / 100.0 if recent else 0.05
    except Exception:
        return 0.05


def _last_price_before(prices: dict[str, float], as_of: str) -> float | None:
    """Return the most recent price on or before `as_of`."""
    candidates = sorted((d, p) for d, p in prices.items() if d <= as_of)
    return candidates[-1][1] if candidates else None


def build_equity_curve(
    transactions: list[dict],
    initial_cash: float,
    lookback_days: int = 365,
) -> dict:
    """
    Construct a daily portfolio NAV series from the transaction log.

    Strategy:
    - Collect all unique symbols traded.
    - Fetch price histories for all symbols + benchmarks in one pass.
    - Walk through trading dates from max(inception, today-lookback_days).
    - On each date, replay transactions up to that date to get holdings.
    - Compute NAV = sum(shares * price) + cash.
    - Normalize to 100 at the first date where NAV > 0.

    Returns a dict with keys: dates, portfolio, benchmarks (dict of sym→values),
    portfolio_raw (un-normalized NAVs for return computation).
    """
    if not transactions:
        return {"dates": [], "portfolio": [], "portfolio_raw": [], "benchmarks": {}}

    sorted_txns = sorted(
        transactions,
        key=lambda t: (t.get("trade_date") or "", t.get("id") or 0),
    )
    first_date = sorted_txns[0].get("trade_date") or str(date.today())

    cutoff = (date.today() - timedelta(days=lookback_days)).isoformat()
    start_str = max(first_date, cutoff)

    # Symbols needed
    equity_syms = list({
        t["symbol"].upper() for t in transactions
        if t.get("trade_type") in ("buy", "sell")
    })
    all_syms = list({*equity_syms, *BENCHMARK_SYMS})

    # Fetch all price histories (cached by data module)
    days_to_fetch = (date.today() - date.fromisoformat(start_str)).days + 30
    price_data: dict[str, dict[str, float]] = {}
    for sym in all_syms:
        price_data[sym] = _fetch_prices(sym, days=days_to_fetch)

    # Collect all trading dates in range
    all_dates = sorted({
        d for sym_prices in price_data.values()
        for d in sym_prices
        if d >= start_str
    })
    if not all_dates:
        return {"dates": [], "portfolio": [], "portfolio_raw": [], "benchmarks": {}}

    # Replay transactions across dates
    nav_values: list[float] = []
    txn_idx = 0
    holdings: dict[str, float] = {}
    cash = initial_cash

    # Pre-apply all transactions before start_str to get initial state
    while txn_idx < len(sorted_txns) and (sorted_txns[txn_idx].get("trade_date") or "") < start_str:
        t = sorted_txns[txn_idx]
        _apply_txn(t, holdings, lambda delta: None)  # mutates holdings
        # track cash separately
        cash = _apply_cash(cash, t)
        txn_idx += 1

    # Also advance holdings to start_str
    pre_txns = [t for t in sorted_txns if (t.get("trade_date") or "") < start_str]
    pre_positions, _, pre_cash_delta = compute_positions(pre_txns)
    holdings = {p.symbol: p.shares for p in pre_positions}
    cash = initial_cash + pre_cash_delta

    # Now walk through each trading date
    for d in all_dates:
        # Apply transactions on this date (in order)
        while txn_idx < len(sorted_txns) and (sorted_txns[txn_idx].get("trade_date") or "") <= d:
            t = sorted_txns[txn_idx]
            ttype = t.get("trade_type", "")
            qty   = float(t.get("quantity", 0))
            price = float(t.get("price", 0))
            comm  = float(t.get("commission") or 0)
            sym   = t["symbol"].upper()

            if ttype == "buy":
                holdings[sym] = holdings.get(sym, 0.0) + qty
                cash -= qty * price + comm
            elif ttype == "sell":
                holdings[sym] = max(0.0, holdings.get(sym, 0.0) - qty)
                if holdings[sym] == 0:
                    holdings.pop(sym, None)
                cash += qty * price - comm
            elif ttype in ("dividend", "deposit"):
                cash += qty * price
            elif ttype == "withdrawal":
                cash -= qty * price
            txn_idx += 1

        # Compute NAV
        nav = cash
        for sym, shares in holdings.items():
            price = _last_price_before(price_data.get(sym, {}), d)
            if price:
                nav += shares * price

        nav_values.append(nav)

    # Normalize to 100 at inception
    first_nav = next((v for v in nav_values if v > 0), None)
    if not first_nav:
        normalized = nav_values
    else:
        normalized = [round(v / first_nav * 100, 4) for v in nav_values]

    # Build benchmark curves (also normalized to 100 at start_str)
    benchmarks: dict[str, list[float | None]] = {}
    for sym in BENCHMARK_SYMS:
        bench_prices = price_data.get(sym, {})
        if not bench_prices:
            continue
        first_bench = _last_price_before(bench_prices, all_dates[0])
        if not first_bench:
            continue
        curve = []
        for d in all_dates:
            p = _last_price_before(bench_prices, d)
            curve.append(round(p / first_bench * 100, 4) if p else None)
        benchmarks[sym] = curve

    return {
        "dates":         all_dates,
        "portfolio":     normalized,
        "portfolio_raw": [round(v, 2) for v in nav_values],
        "benchmarks":    benchmarks,
    }


def compute_performance_metrics(
    transactions: list[dict],
    initial_cash: float,
    lookback_days: int = 252,
) -> dict:
    """
    Compute comprehensive performance and risk-adjusted metrics.

    Builds a lookback_days equity curve, computes daily returns, then derives:
    - Rolling returns: 1d, 1w, 1m, 3m, 6m, 1y, YTD, all-time
    - Risk-adjusted: Sharpe, Sortino, Calmar, Treynor, Information Ratio
    - Regression vs SPY: alpha, beta, R²
    - Drawdown: max depth, duration (days), recovery (days)
    - Annualized return + volatility
    """
    # Use maximum lookback for all-time metrics but compute for requested window
    long_curve = build_equity_curve(transactions, initial_cash, lookback_days=max(lookback_days, 756))
    dates      = long_curve["dates"]
    raw_nav    = long_curve["portfolio_raw"]
    bench      = long_curve["benchmarks"]

    if len(raw_nav) < 3:
        return _empty_metrics()

    nav_arr = np.array(raw_nav, dtype=float)
    daily_returns = np.diff(nav_arr) / nav_arr[:-1]
    spy_curve = bench.get("SPY", [])

    # Align SPY with portfolio dates (drop None entries)
    spy_aligned: list[float] = []
    port_aligned: list[float] = []
    if len(spy_curve) == len(dates):
        valid = [(daily_returns[i], spy_curve[i+1], spy_curve[i])
                 for i in range(len(daily_returns))
                 if spy_curve[i] is not None and spy_curve[i+1] is not None]
        if valid:
            port_aligned  = [v[0] for v in valid]
            spy_returns   = [(v[1] - v[2]) / v[2] for v in valid]
            spy_aligned   = spy_returns

    rf_annual = _fetch_risk_free_rate()
    rf_daily  = rf_annual / TRADING_DAYS_PER_YEAR

    # --- Core stats on full daily_returns ---
    n = len(daily_returns)
    if n < 2:
        return _empty_metrics()

    ann_return   = float((nav_arr[-1] / nav_arr[0]) ** (TRADING_DAYS_PER_YEAR / n) - 1) if n > 1 else 0.0
    ann_vol      = float(np.std(daily_returns, ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR))
    excess       = daily_returns - rf_daily
    sharpe       = float(np.mean(excess) / np.std(excess, ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR)) if np.std(excess, ddof=1) > 0 else None

    # Sortino: downside deviation uses all N days in denominator (not just down days)
    semi_sq      = np.minimum(daily_returns - rf_daily, 0.0) ** 2
    downside_std = float(np.sqrt(np.mean(semi_sq)) * math.sqrt(TRADING_DAYS_PER_YEAR))
    sortino      = float((ann_return - rf_annual) / downside_std) if downside_std > 0 else None

    # Max drawdown
    cum = np.cumprod(1 + daily_returns)
    peak_arr = np.maximum.accumulate(cum)
    dd_arr   = (cum - peak_arr) / peak_arr
    max_dd   = float(np.min(dd_arr))
    calmar   = float((ann_return - rf_annual) / abs(max_dd)) if max_dd < 0 else None

    dd_start, dd_end, dd_recovery = _drawdown_dates(dates[1:], dd_arr)

    # Beta / Alpha / R² vs SPY
    beta, alpha, r_squared, treynor, info_ratio, tracking_err, win_rate = (
        None, None, None, None, None, None, None
    )
    if len(port_aligned) >= 20 and len(spy_aligned) >= 20:
        pa = np.array(port_aligned)
        sa = np.array(spy_aligned)
        cov_mat = np.cov(pa, sa)
        var_spy = cov_mat[1, 1]
        if var_spy > 0:
            beta    = float(cov_mat[0, 1] / var_spy)
            spy_ann = float((1 + np.mean(sa)) ** TRADING_DAYS_PER_YEAR - 1)
            alpha   = float(ann_return - (rf_annual + beta * (spy_ann - rf_annual)))
            # R² from OLS fit directly (not Jensen's alpha proxy)
            try:
                X_ols = np.column_stack([np.ones(len(pa)), sa])
                ols_coefs, _, _, _ = np.linalg.lstsq(X_ols, pa, rcond=None)
                predicted = X_ols @ ols_coefs
                ss_tot = float(np.sum((pa - np.mean(pa)) ** 2))
                ss_res = float(np.sum((pa - predicted) ** 2))
                r_squared = float(1 - ss_res / ss_tot) if ss_tot > 0 else None
            except Exception:
                r_squared = None
            treynor = float((ann_return - rf_annual) / beta) if beta and beta != 0 else None
            active  = pa - sa
            tracking_err = float(np.std(active, ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR))
            active_ann   = float(np.mean(active) * TRADING_DAYS_PER_YEAR)
            info_ratio   = float(active_ann / tracking_err) if tracking_err > 0 else None
            win_rate     = float(np.mean(pa > sa) * 100)

    # Rolling returns for key windows
    rolling = _rolling_returns(nav_arr, dates, bench)

    return {
        "ann_return_pct":       round(ann_return * 100, 2),
        "ann_volatility_pct":   round(ann_vol * 100, 2),
        "sharpe":               round(sharpe, 3) if sharpe is not None else None,
        "sortino":              round(sortino, 3) if sortino is not None else None,
        "calmar":               round(calmar, 3) if calmar is not None else None,
        "treynor":              round(treynor, 4) if treynor is not None else None,
        "alpha_pct":            round(alpha * 100, 2) if alpha is not None else None,
        "beta":                 round(beta, 3) if beta is not None else None,
        "r_squared":            round(r_squared, 3) if r_squared is not None else None,
        "information_ratio":    round(info_ratio, 3) if info_ratio is not None else None,
        "tracking_error_pct":   round(tracking_err * 100, 2) if tracking_err is not None else None,
        "win_rate_vs_spy_pct":  round(win_rate, 1) if win_rate is not None else None,
        "max_drawdown_pct":     round(max_dd * 100, 2),
        "max_drawdown_start":   dd_start,
        "max_drawdown_end":     dd_end,
        "max_drawdown_recovery_days": dd_recovery,
        "risk_free_rate_pct":   round(rf_annual * 100, 2),
        "rolling":              rolling,
        "data_points":          n,
    }


def _rolling_returns(
    nav_arr: np.ndarray,
    dates: list[str],
    bench: dict[str, list],
) -> list[dict]:
    """Return rolling-window return table comparable to benchmarks."""
    today = date.today()
    windows = [
        ("1d",  1),
        ("1w",  5),
        ("1m",  21),
        ("3m",  63),
        ("6m",  126),
        ("1y",  252),
        ("ytd", None),  # special — from Jan 1
        ("all", None),  # entire series
    ]
    spy_curve  = bench.get("SPY", [])
    qqq_curve  = bench.get("QQQ", [])

    def _ret(arr: list, n: int | None) -> float | None:
        if n is None:
            if len(arr) < 2:
                return None
            v0 = next((v for v in arr if v is not None), None)
            vn = next((v for v in reversed(arr) if v is not None), None)
            return (vn / v0 - 1) * 100 if v0 and vn else None
        if len(arr) < n + 1:
            return None
        v0 = arr[-(n+1)]
        vn = arr[-1]
        return (vn / v0 - 1) * 100 if v0 and vn else None

    def _ytd_ret(arr: list, d_list: list[str]) -> float | None:
        jan1 = str(date(today.year, 1, 1))
        pairs = [(d, v) for d, v in zip(d_list, arr) if v is not None]
        if not pairs:
            return None
        before_jan = [(d, v) for d, v in pairs if d < jan1]
        after_jan  = [(d, v) for d, v in pairs if d >= jan1]
        # Base: last close on or before Dec 31 of prior year
        if before_jan:
            v0 = before_jan[-1][1]
        elif after_jan:
            v0 = after_jan[0][1]
        else:
            return None
        vn = pairs[-1][1]
        return (vn / v0 - 1) * 100 if v0 else None

    rows = []
    nav_list = list(nav_arr)
    for key, n in windows:
        if key == "ytd":
            port_ret = _ytd_ret(nav_list, dates)
            spy_ret  = _ytd_ret(spy_curve, dates) if spy_curve else None
            qqq_ret  = _ytd_ret(qqq_curve, dates) if qqq_curve else None
        elif key == "all":
            port_ret = _ret(nav_list, None)
            spy_ret  = _ret(spy_curve, None) if spy_curve else None
            qqq_ret  = _ret(qqq_curve, None) if qqq_curve else None
        else:
            port_ret = _ret(nav_list, n)
            spy_ret  = _ret(spy_curve, n) if spy_curve else None
            qqq_ret  = _ret(qqq_curve, n) if qqq_curve else None

        rows.append({
            "window":         key,
            "portfolio_pct":  round(port_ret, 2) if port_ret is not None else None,
            "spy_pct":        round(spy_ret, 2) if spy_ret is not None else None,
            "qqq_pct":        round(qqq_ret, 2) if qqq_ret is not None else None,
            "vs_spy_pct":     round(port_ret - spy_ret, 2) if port_ret is not None and spy_ret is not None else None,
        })
    return rows


def _drawdown_dates(dates: list[str], dd_arr: np.ndarray) -> tuple[str | None, str | None, int | None]:
    """Find start/end/recovery dates for the maximum drawdown period."""
    if len(dd_arr) == 0:
        return None, None, None
    trough_idx = int(np.argmin(dd_arr))
    trough_date = dates[trough_idx] if trough_idx < len(dates) else None

    # Find peak before trough: scan backward for last point where drawdown was 0
    peak_idx = trough_idx
    for i in range(trough_idx, -1, -1):
        if dd_arr[i] >= -0.0001:
            peak_idx = i
            break
    peak_date = dates[peak_idx] if peak_idx < len(dates) else None

    # Recovery: first date after trough where dd >= 0
    recovery_days = None
    for i in range(trough_idx + 1, len(dd_arr)):
        if dd_arr[i] >= -0.0001:
            if trough_date and dates[i]:
                from datetime import date as dt
                try:
                    d0 = dt.fromisoformat(trough_date)
                    d1 = dt.fromisoformat(dates[i])
                    recovery_days = (d1 - d0).days
                except Exception:
                    pass
            break

    return peak_date, trough_date, recovery_days


def _apply_txn(txn: dict, holdings: dict, _cash_fn) -> None:
    """Mutate holdings dict in-place for a single transaction."""
    sym   = txn["symbol"].upper()
    ttype = txn.get("trade_type", "")
    qty   = float(txn.get("quantity", 0))
    if ttype == "buy":
        holdings[sym] = holdings.get(sym, 0.0) + qty
    elif ttype == "sell":
        holdings[sym] = max(0.0, holdings.get(sym, 0.0) - qty)
        if holdings.get(sym, 0.0) == 0:
            holdings.pop(sym, None)


def _apply_cash(cash: float, txn: dict) -> float:
    ttype = txn.get("trade_type", "")
    qty   = float(txn.get("quantity", 0))
    price = float(txn.get("price", 0))
    comm  = float(txn.get("commission") or 0)
    if ttype == "buy":
        return cash - qty * price - comm
    if ttype == "sell":
        return cash + qty * price - comm
    if ttype in ("dividend", "deposit"):
        return cash + qty * price
    if ttype == "withdrawal":
        return cash - qty * price
    return cash


def _empty_metrics() -> dict:
    return {
        "ann_return_pct": None, "ann_volatility_pct": None,
        "sharpe": None, "sortino": None, "calmar": None, "treynor": None,
        "alpha_pct": None, "beta": None, "r_squared": None,
        "information_ratio": None, "tracking_error_pct": None,
        "win_rate_vs_spy_pct": None, "max_drawdown_pct": None,
        "max_drawdown_start": None, "max_drawdown_end": None,
        "max_drawdown_recovery_days": None, "risk_free_rate_pct": None,
        "rolling": [], "data_points": 0,
    }
