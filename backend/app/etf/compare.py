"""
Professional-grade multi-ETF/ticker comparison engine.
Computes everything an institutional investment manager would want:
performance attribution, risk decomposition, factor exposures.
"""
from __future__ import annotations

import logging
import math
from datetime import date

import numpy as np

from ..data.macro_data import fetch_arbitrary_ticker
from ..portfolio.risk import FACTOR_ETFS

log = logging.getLogger(__name__)

TRADING_DAYS = 252
MIN_POINTS = 20


# ---------------------------------------------------------------------------
# Price + return helpers
# ---------------------------------------------------------------------------

def _fetch_prices(symbol: str, days: int) -> dict[str, float]:
    """Return {date_str: close_price} for a symbol."""
    pts = fetch_arbitrary_ticker(symbol, days=days + 5)
    return {p["date"]: float(p["value"]) for p in pts if p["value"] is not None}


def _risk_free_daily() -> float:
    """Daily risk-free rate. Try DGS3MO; fall back to 0.05/252."""
    try:
        from ..data.macro_data import fetch_series
        pts = fetch_series("DGS3MO", days=30)
        recent = [p["value"] for p in pts if p["value"] is not None]
        if recent:
            return recent[-1] / 100.0 / TRADING_DAYS
    except Exception:
        pass
    return 0.05 / TRADING_DAYS


def _returns_from_prices(dates: list[str], prices: list[float]) -> np.ndarray:
    arr = np.array(prices, dtype=float)
    return np.diff(arr) / arr[:-1]


def _var_cvar(returns: np.ndarray, confidence: float) -> tuple[float, float]:
    threshold = float(np.percentile(returns, (1 - confidence) * 100))
    tail = returns[returns <= threshold]
    cvar = float(np.mean(tail)) if len(tail) else threshold
    return threshold, cvar


def _max_drawdown(prices: np.ndarray, dates: list[str]) -> tuple[float, str | None, str | None]:
    """Return (max_dd_fraction (negative), start_date, end_date)."""
    if len(prices) < 2:
        return 0.0, None, None
    peak = np.maximum.accumulate(prices)
    dd = (prices - peak) / peak
    trough_idx = int(np.argmin(dd))
    max_dd = float(dd[trough_idx])
    # Peak (start) is the most recent index <= trough where dd == 0
    peak_idx = trough_idx
    for i in range(trough_idx, -1, -1):
        if dd[i] >= -1e-9:
            peak_idx = i
            break
    start = dates[peak_idx] if peak_idx < len(dates) else None
    end = dates[trough_idx] if trough_idx < len(dates) else None
    return max_dd, start, end


def _ols_beta_alpha(ticker_rets: np.ndarray, bench_rets: np.ndarray, rf_daily: float):
    """OLS regression of ticker excess returns on benchmark excess returns.
    Returns (beta, alpha_annual_pct, r_squared)."""
    if len(ticker_rets) < MIN_POINTS:
        return None, None, None
    cov = np.cov(ticker_rets, bench_rets)
    var_b = cov[1, 1]
    if var_b <= 0:
        return None, None, None
    beta = float(cov[0, 1] / var_b)
    # Alpha via CAPM: ticker_ann - (rf + beta*(bench_ann - rf))
    rf_ann = rf_daily * TRADING_DAYS
    ticker_ann = float((1 + np.mean(ticker_rets)) ** TRADING_DAYS - 1)
    bench_ann = float((1 + np.mean(bench_rets)) ** TRADING_DAYS - 1)
    alpha = ticker_ann - (rf_ann + beta * (bench_ann - rf_ann))
    # R-squared from the regression line ticker = a + beta*bench
    a = float(np.mean(ticker_rets) - beta * np.mean(bench_rets))
    pred = a + beta * bench_rets
    ss_res = float(np.sum((ticker_rets - pred) ** 2))
    ss_tot = float(np.sum((ticker_rets - np.mean(ticker_rets)) ** 2))
    r2 = float(1 - ss_res / ss_tot) if ss_tot > 0 else None
    return round(beta, 4), round(alpha * 100, 3), round(r2, 4) if r2 is not None else None


def _monthly_returns(dates: list[str], rets: np.ndarray) -> dict[str, float]:
    """Compound daily returns into per-month returns. Keys are YYYY-MM, returns in pct.

    `dates` align with `rets` (both length n; dates[i] is the date of rets[i])."""
    by_month: dict[str, list[float]] = {}
    for d, r in zip(dates, rets):
        ym = d[:7]
        by_month.setdefault(ym, []).append(float(r))
    out: dict[str, float] = {}
    for ym, vals in by_month.items():
        compound = float(np.prod([1 + v for v in vals]) - 1)
        out[ym] = round(compound * 100, 3)
    return dict(sorted(out.items()))


def _rolling_returns(dates: list[str], prices: list[float]) -> dict[str, float | None]:
    """Trailing-window total returns over the price series (pct)."""
    windows = {"1M": 21, "3M": 63, "6M": 126, "1Y": 252}
    out: dict[str, float | None] = {}
    n = len(prices)
    for key, w in windows.items():
        if n >= w + 1 and prices[-(w + 1)]:
            out[key] = round(float(prices[-1] / prices[-(w + 1)] - 1) * 100, 3)
        else:
            out[key] = None
    # YTD
    out["YTD"] = _ytd_return(dates, prices)
    # ALL
    if n >= 2 and prices[0]:
        out["ALL"] = round(float(prices[-1] / prices[0] - 1) * 100, 3)
    else:
        out["ALL"] = None
    return out


def _ytd_return(dates: list[str], prices: list[float]) -> float | None:
    jan1 = str(date(date.today().year, 1, 1))
    ytd = [(d, p) for d, p in zip(dates, prices) if d >= jan1 and p]
    if len(ytd) >= 2 and ytd[0][1]:
        return round(float(ytd[-1][1] / ytd[0][1] - 1) * 100, 3)
    return None


# ---------------------------------------------------------------------------
# ETF metadata
# ---------------------------------------------------------------------------

def _etf_info(symbol: str) -> dict:
    """Pull yfinance .info and map to a normalized metadata dict."""
    info: dict = {}
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("yf.info(%s) failed: %s", symbol, e)
        info = {}

    expense_ratio = (
        info.get("annualReportExpenseRatio")
        or info.get("netExpenseRatio")
    )
    inception = info.get("fundInceptionDate")
    inception_str = None
    if inception:
        try:
            from datetime import datetime, timezone
            inception_str = datetime.fromtimestamp(int(inception), tz=timezone.utc).date().isoformat()
        except Exception:
            inception_str = None

    return {
        "name": info.get("longName") or info.get("shortName") or symbol,
        "category": info.get("category"),
        "expense_ratio": float(expense_ratio) if expense_ratio is not None else None,
        "aum": info.get("totalAssets"),
        "inception_date": inception_str,
        "benchmark_index": info.get("benchmarkIndex") or info.get("indexName"),
        "beta": info.get("beta") or info.get("beta3Year"),
        "pe_ratio": info.get("trailingPE"),
        "dividend_yield": info.get("dividendYield") or info.get("yield"),
        "holdings_count": info.get("holdingsCount"),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compare_tickers(
    symbols: list[str],
    lookback_days: int = 252,
    benchmark: str = "SPY",
) -> dict:
    """Full institutional-quality comparison of any list of tickers/ETFs."""
    symbols = [s.upper() for s in symbols]
    benchmark = benchmark.upper()

    # --- Fetch price histories (sequential). Include benchmark + factor ETFs. ---
    fetch_set = list(dict.fromkeys([*symbols, benchmark, *FACTOR_ETFS]))
    prices_map: dict[str, dict[str, float]] = {}
    for sym in fetch_set:
        prices_map[sym] = _fetch_prices(sym, days=lookback_days)

    # --- Build the set of common dates across the requested symbols + benchmark. ---
    date_sets = [set(prices_map[s]) for s in symbols if prices_map.get(s)]
    if prices_map.get(benchmark):
        date_sets.append(set(prices_map[benchmark]))
    common_dates = sorted(set.intersection(*date_sets)) if date_sets else []
    # Trim to lookback window length (last N trading days).
    if len(common_dates) > lookback_days:
        common_dates = common_dates[-lookback_days:]

    rf_daily = _risk_free_daily()

    # --- Benchmark returns aligned on common dates ---
    bench_prices = [prices_map[benchmark].get(d) for d in common_dates] if prices_map.get(benchmark) else []
    bench_rets = None
    if bench_prices and all(p is not None for p in bench_prices) and len(bench_prices) >= 2:
        bench_rets = _returns_from_prices(common_dates, bench_prices)

    # --- Per-symbol computation ---
    curves_series: dict[str, list[float] | None] = {}
    metrics: dict[str, dict | None] = {}
    monthly_returns: dict[str, dict] = {}
    rolling_returns: dict[str, dict] = {}
    info_map: dict[str, dict] = {}
    aligned_returns: dict[str, np.ndarray] = {}  # for correlation + factor OLS

    for sym in symbols:
        info_map[sym] = _etf_info(sym)

        sym_prices = [prices_map[sym].get(d) for d in common_dates] if prices_map.get(sym) else []
        valid = [p for p in sym_prices if p is not None]

        if len(valid) < MIN_POINTS or any(p is None for p in sym_prices):
            curves_series[sym] = None
            metrics[sym] = None
            monthly_returns[sym] = {}
            rolling_returns[sym] = {}
            continue

        prices_arr = np.array(sym_prices, dtype=float)
        rets = _returns_from_prices(common_dates, sym_prices)
        ret_dates = common_dates[1:]  # rets[i] corresponds to common_dates[i+1]
        aligned_returns[sym] = rets

        # Normalized curve (indexed to 100 at start)
        base = prices_arr[0]
        curves_series[sym] = [round(float(p / base * 100), 4) for p in prices_arr] if base else None

        # --- Core metrics ---
        n = len(rets)
        ann_return = float((prices_arr[-1] / prices_arr[0]) ** (TRADING_DAYS / n) - 1) if n > 0 and prices_arr[0] else 0.0
        ann_vol = float(np.std(rets, ddof=1) * math.sqrt(TRADING_DAYS)) if n > 1 else 0.0
        excess = rets - rf_daily
        sharpe = (
            float(np.mean(excess) / np.std(excess, ddof=1) * math.sqrt(TRADING_DAYS))
            if n > 1 and np.std(excess, ddof=1) > 0 else None
        )
        downside = rets[rets < rf_daily]
        downside_std = (
            float(np.std(downside, ddof=1) * math.sqrt(TRADING_DAYS))
            if len(downside) > 1 else ann_vol
        )
        rf_ann = rf_daily * TRADING_DAYS
        sortino = float((ann_return - rf_ann) / downside_std) if downside_std > 0 else None

        max_dd, dd_start, dd_end = _max_drawdown(prices_arr, common_dates)
        calmar = float((ann_return - rf_ann) / abs(max_dd)) if max_dd < 0 else None

        var_95, cvar_95 = _var_cvar(rets, 0.95)
        var_99, _cvar_99 = _var_cvar(rets, 0.99)

        total_return = float((prices_arr[-1] / prices_arr[0] - 1) * 100) if prices_arr[0] else None
        ytd = _ytd_return(common_dates, list(prices_arr))

        # --- Benchmark-relative metrics ---
        is_benchmark = sym == benchmark
        beta = alpha = r2 = win_rate = up_cap = down_cap = None
        if not is_benchmark and bench_rets is not None and len(bench_rets) == len(rets) >= MIN_POINTS:
            beta, alpha, r2 = _ols_beta_alpha(rets, bench_rets, rf_daily)
            win_rate = round(float(np.mean(rets > bench_rets) * 100), 2)
            # Up / down capture
            up_mask = bench_rets > 0
            down_mask = bench_rets < 0
            if up_mask.sum() > 0:
                bench_up = float(np.mean(bench_rets[up_mask]))
                if bench_up != 0:
                    up_cap = round(float(np.mean(rets[up_mask]) / bench_up * 100), 2)
            if down_mask.sum() > 0:
                bench_down = float(np.mean(bench_rets[down_mask]))
                if bench_down != 0:
                    down_cap = round(float(np.mean(rets[down_mask]) / bench_down * 100), 2)

        metrics[sym] = {
            "ann_return_pct": round(ann_return * 100, 3),
            "ann_volatility_pct": round(ann_vol * 100, 3),
            "sharpe": round(sharpe, 4) if sharpe is not None else None,
            "sortino": round(sortino, 4) if sortino is not None else None,
            "calmar": round(calmar, 4) if calmar is not None else None,
            "max_drawdown_pct": round(max_dd * 100, 3),
            "max_drawdown_start": dd_start,
            "max_drawdown_end": dd_end,
            "beta_vs_benchmark": beta,
            "alpha_vs_benchmark_pct": alpha,
            "r_squared": r2,
            "var_95_daily_pct": round(var_95 * 100, 3),
            "cvar_95_daily_pct": round(cvar_95 * 100, 3),
            "var_99_daily_pct": round(var_99 * 100, 3),
            "total_return_pct": round(total_return, 3) if total_return is not None else None,
            "ytd_return_pct": ytd,
            "win_rate_vs_benchmark_pct": win_rate,
            "up_capture": up_cap,
            "down_capture": down_cap,
        }

        monthly_returns[sym] = _monthly_returns(ret_dates, rets)
        rolling_returns[sym] = _rolling_returns(common_dates, list(prices_arr))

    # --- Correlation matrix between all tickers (on common dates) ---
    valid_syms = [s for s in symbols if s in aligned_returns]
    n_sym = len(symbols)
    corr_matrix: list[list[float | None]] = [[None] * n_sym for _ in range(n_sym)]
    for i, si in enumerate(symbols):
        for j, sj in enumerate(symbols):
            if i == j:
                corr_matrix[i][j] = 1.0
            elif j > i and si in aligned_returns and sj in aligned_returns:
                a = aligned_returns[si]
                b = aligned_returns[sj]
                if len(a) == len(b) >= MIN_POINTS and np.std(a) > 0 and np.std(b) > 0:
                    c = round(float(np.corrcoef(a, b)[0, 1]), 4)
                    corr_matrix[i][j] = c
                    corr_matrix[j][i] = c

    # --- Factor exposures: OLS each ticker vs FACTOR_ETFS ---
    factor_rets: dict[str, np.ndarray] = {}
    for f in FACTOR_ETFS:
        fp = [prices_map[f].get(d) for d in common_dates] if prices_map.get(f) else []
        if fp and all(p is not None for p in fp) and len(fp) >= 2:
            factor_rets[f] = _returns_from_prices(common_dates, fp)

    factor_exposures: dict[str, list[dict]] = {}
    for sym in symbols:
        if sym not in aligned_returns:
            factor_exposures[sym] = []
            continue
        y = aligned_returns[sym]
        usable_factors = [f for f in FACTOR_ETFS if f in factor_rets and len(factor_rets[f]) == len(y)]
        if not usable_factors or len(y) < 30:
            factor_exposures[sym] = []
            continue
        X = np.stack([factor_rets[f] for f in usable_factors], axis=1)  # (n_days, n_factors)
        X_int = np.column_stack([np.ones(X.shape[0]), X])
        try:
            coefs, *_ = np.linalg.lstsq(X_int, y, rcond=None)
            betas = coefs[1:]
            factor_exposures[sym] = [
                {"factor": f, "beta": round(float(b), 4)}
                for f, b in zip(usable_factors, betas)
            ]
        except Exception as e:
            log.warning("factor OLS failed for %s: %s", sym, e)
            factor_exposures[sym] = []

    return {
        "symbols": symbols,
        "benchmark": benchmark,
        "lookback_days": lookback_days,
        "data_points": len(common_dates),
        "curves": {
            "dates": common_dates,
            "series": curves_series,
        },
        "metrics": metrics,
        "correlation_matrix": corr_matrix,
        "correlation_labels": symbols,
        "factor_exposures": factor_exposures,
        "monthly_returns": monthly_returns,
        "rolling_returns": rolling_returns,
        "info": info_map,
    }
