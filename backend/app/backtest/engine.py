"""Backtest engine (Bloomberg BT analog).

`run_backtest(symbol, strategy, params, start, end, capital=100000)` fetches a
price series (sample fallback), runs a pure strategy function to get a position
signal in {-1, 0, 1}, then computes:

    asset_return(t)  = price(t) / price(t-1) - 1
    strat_return(t)  = position(t-1) * asset_return(t) - COST * |position(t) - position(t-1)|
    equity(t)        = capital * cumprod(1 + strat_return)
    benchmark(t)     = capital * price(t) / price(0)              # buy & hold

Risk-adjusted metrics (CAGR/Sharpe/Sortino/Calmar/maxDD/win-rate) mirror the
formulas in `portfolio/analytics.py`. That module's `compute_performance_metrics`
is transaction-log based, so for a synthetic return series we reuse its lower
level primitives (`_fetch_risk_free_rate`, `_drawdown_dates`,
`TRADING_DAYS_PER_YEAR`) and apply the same math.

Never raises. Degrades to a deterministic sample price path.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

import numpy as np

from ..portfolio.analytics import (
    TRADING_DAYS_PER_YEAR,
    _drawdown_dates,
    _fetch_risk_free_rate,
)
from . import strategies as strat_mod
from .sample_data import sample_price_series

log = logging.getLogger(__name__)

COST_PER_TURNOVER = 0.0005  # 5 bps per unit of position change


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_date(value, fallback: date) -> date:
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
            try:
                return datetime.strptime(value.strip()[:10], fmt).date()
            except ValueError:
                continue
    return fallback


def _load_prices(symbol: str, start: date, end: date) -> tuple[list[str], list[float], str]:
    """Return (dates, prices, source). Live where possible, sample otherwise."""
    try:
        from ..data.macro_data import fetch_arbitrary_ticker

        span_days = (date.today() - start).days + 10
        span_days = max(span_days, (end - start).days + 10, 30)
        pts = fetch_arbitrary_ticker(symbol, days=span_days)
        rows = [
            (p["date"], float(p["value"]))
            for p in (pts or [])
            if p.get("value") is not None
            and start.isoformat() <= str(p.get("date")) <= end.isoformat()
        ]
        rows.sort(key=lambda r: r[0])
        if len(rows) >= 30:
            return [r[0] for r in rows], [r[1] for r in rows], "live"
    except Exception as e:  # never raise
        log.warning("backtest live price load failed for %s: %s", symbol, e)

    # Sample fallback: deterministic GBM over the requested window.
    n = max(60, (end - start).days * 5 // 7)
    pts = sample_price_series(symbol, n_days=n, end=end)
    return [p["date"] for p in pts], [float(p["value"]) for p in pts], "sample"


def _safe_params(strategy: str, params: dict | None) -> dict:
    """Coerce supplied params to the catalog schema; ignore unknown keys."""
    spec = strat_mod.get_strategy(strategy)
    if not spec:
        return {}
    out = strat_mod.default_params(strategy)
    if isinstance(params, dict):
        by_name = {p["name"]: p for p in spec["params"]}
        for name, meta in by_name.items():
            if name not in params or params[name] is None:
                continue
            try:
                val = float(params[name])
                if meta.get("type") == "int":
                    val = int(round(val))
                lo, hi = meta.get("min"), meta.get("max")
                if lo is not None:
                    val = max(lo, val)
                if hi is not None:
                    val = min(hi, val)
                out[name] = val
            except (TypeError, ValueError):
                continue
    return out


def _build_trades(dates: list[str], prices: list[float], positions: list[float]) -> list[dict]:
    """One row per position change."""
    trades: list[dict] = []
    prev = 0.0
    for i in range(len(positions)):
        cur = positions[i]
        if abs(cur - prev) < 1e-9:
            continue
        if cur > prev:
            action = "cover/buy" if prev < 0 else "buy"
        else:
            action = "sell/short" if cur < 0 else "sell"
        trades.append({
            "date": dates[i],
            "action": action,
            "from_position": round(prev, 4),
            "to_position": round(cur, 4),
            "price": round(prices[i], 4),
        })
        prev = cur
    return trades


def _monthly_heatmap(dates: list[str], strat_returns: np.ndarray) -> list[dict]:
    """Compound daily strategy returns into [{year, month, return_pct}]."""
    buckets: dict[tuple[int, int], float] = {}
    # strat_returns[i] corresponds to dates[i+1] (return earned on that day).
    for i, r in enumerate(strat_returns):
        d = dates[i + 1]
        try:
            y, m = int(d[:4]), int(d[5:7])
        except (ValueError, IndexError):
            continue
        key = (y, m)
        buckets[key] = (1.0 + buckets.get(key, 0.0)) * (1.0 + float(r)) - 1.0
    out = [
        {"year": y, "month": m, "return_pct": round(v * 100, 2)}
        for (y, m), v in sorted(buckets.items())
    ]
    return out


def _compute_metrics(
    strat_returns: np.ndarray,
    equity: np.ndarray,
    dates: list[str],
    positions: np.ndarray,
    asset_returns: np.ndarray,
    rf_annual: float,
) -> dict:
    """Mirror of portfolio/analytics.compute_performance_metrics for a return
    series. Returns CAGR, Sharpe, Sortino, Calmar, maxDD (+dates), win rate,
    exposure, turnover and benchmark comparison."""
    n = len(strat_returns)
    if n < 2:
        return _empty_metrics()

    rf_daily = rf_annual / TRADING_DAYS_PER_YEAR

    total_return = float(equity[-1] / equity[0] - 1.0)
    cagr = float((equity[-1] / equity[0]) ** (TRADING_DAYS_PER_YEAR / n) - 1.0)
    ann_vol = float(np.std(strat_returns, ddof=1) * np.sqrt(TRADING_DAYS_PER_YEAR))

    excess = strat_returns - rf_daily
    sd_excess = float(np.std(excess, ddof=1))
    sharpe = float(np.mean(excess) / sd_excess * np.sqrt(TRADING_DAYS_PER_YEAR)) if sd_excess > 0 else None

    semi_sq = np.minimum(strat_returns - rf_daily, 0.0) ** 2
    downside_std = float(np.sqrt(np.mean(semi_sq)) * np.sqrt(TRADING_DAYS_PER_YEAR))
    sortino = float((cagr - rf_annual) / downside_std) if downside_std > 0 else None

    cum = np.cumprod(1.0 + strat_returns)
    peak = np.maximum.accumulate(cum)
    dd_arr = (cum - peak) / peak
    max_dd = float(np.min(dd_arr))
    calmar = float((cagr - rf_annual) / abs(max_dd)) if max_dd < 0 else None
    dd_start, dd_end, dd_recovery = _drawdown_dates(dates[1:], dd_arr)

    active = strat_returns[strat_returns != 0.0]
    win_rate = float(np.mean(strat_returns > 0) * 100)
    win_rate_active = float(np.mean(active > 0) * 100) if len(active) else None

    exposure = float(np.mean(np.abs(positions)) * 100)
    turnover = float(np.sum(np.abs(np.diff(np.concatenate([[0.0], positions])))))
    time_in_market = float(np.mean(positions != 0.0) * 100)

    # Buy & hold benchmark on the same window.
    bench_total = float(np.prod(1.0 + asset_returns) - 1.0)
    bench_cagr = float((1.0 + bench_total) ** (TRADING_DAYS_PER_YEAR / n) - 1.0) if bench_total > -1 else None

    return {
        "total_return_pct": round(total_return * 100, 2),
        "cagr_pct": round(cagr * 100, 2),
        "ann_volatility_pct": round(ann_vol * 100, 2),
        "sharpe": round(sharpe, 3) if sharpe is not None else None,
        "sortino": round(sortino, 3) if sortino is not None else None,
        "calmar": round(calmar, 3) if calmar is not None else None,
        "max_drawdown_pct": round(max_dd * 100, 2),
        "max_drawdown_start": dd_start,
        "max_drawdown_end": dd_end,
        "max_drawdown_recovery_days": dd_recovery,
        "win_rate_pct": round(win_rate, 1),
        "win_rate_active_pct": round(win_rate_active, 1) if win_rate_active is not None else None,
        "exposure_pct": round(exposure, 1),
        "time_in_market_pct": round(time_in_market, 1),
        "turnover": round(turnover, 2),
        "benchmark_total_return_pct": round(bench_total * 100, 2),
        "benchmark_cagr_pct": round(bench_cagr * 100, 2) if bench_cagr is not None else None,
        "excess_return_pct": round((total_return - bench_total) * 100, 2),
        "risk_free_rate_pct": round(rf_annual * 100, 2),
        "data_points": n + 1,
    }


def _empty_metrics() -> dict:
    return {
        "total_return_pct": None, "cagr_pct": None, "ann_volatility_pct": None,
        "sharpe": None, "sortino": None, "calmar": None,
        "max_drawdown_pct": None, "max_drawdown_start": None, "max_drawdown_end": None,
        "max_drawdown_recovery_days": None, "win_rate_pct": None,
        "win_rate_active_pct": None, "exposure_pct": None, "time_in_market_pct": None,
        "turnover": None, "benchmark_total_return_pct": None, "benchmark_cagr_pct": None,
        "excess_return_pct": None, "risk_free_rate_pct": None, "data_points": 0,
    }


def run_backtest(
    symbol: str,
    strategy: str,
    params: dict | None = None,
    start: str | date | None = None,
    end: str | date | None = None,
    capital: float = 100_000.0,
) -> dict:
    """Run a single-symbol rule-based backtest. Never raises."""
    as_of = _utc_now()
    symbol = (symbol or "SPY").upper().strip()
    today = date.today()
    end_d = _parse_date(end, today)
    start_d = _parse_date(start, end_d.replace(year=end_d.year - 3) if end_d.year > 1 else end_d)
    if start_d >= end_d:
        start_d = end_d.replace(year=end_d.year - 3) if end_d.year > 1 else end_d
    try:
        capital = float(capital) if capital and float(capital) > 0 else 100_000.0
    except (TypeError, ValueError):
        capital = 100_000.0

    spec = strat_mod.get_strategy(strategy)
    if not spec:
        strategy = "sma_cross"
        spec = strat_mod.get_strategy(strategy)
    use_params = _safe_params(strategy, params)

    try:
        dates, prices, source = _load_prices(symbol, start_d, end_d)
    except Exception as e:
        log.warning("backtest price load failed: %s", e)
        dates, prices, source = [], [], "sample"

    if len(prices) < 3:
        pts = sample_price_series(symbol, n_days=120, end=end_d)
        dates = [p["date"] for p in pts]
        prices = [float(p["value"]) for p in pts]
        source = "sample"

    data_mode = "live" if source == "live" else "sample"

    # Position signal series (same length as prices).
    try:
        positions = spec["fn"](prices, **use_params)
    except Exception as e:
        log.warning("strategy %s failed: %s", strategy, e)
        positions = [0.0] * len(prices)
    if len(positions) != len(prices):
        positions = (list(positions) + [0.0] * len(prices))[: len(prices)]

    p = np.asarray(prices, dtype=float)
    pos = np.asarray(positions, dtype=float)
    pos = np.clip(np.nan_to_num(pos, nan=0.0), -1.0, 1.0)

    asset_returns = p[1:] / p[:-1] - 1.0          # length n-1, aligned to dates[1:]
    dpos = np.abs(np.diff(pos))                    # length n-1
    strat_returns = pos[:-1] * asset_returns - COST_PER_TURNOVER * dpos

    equity = np.empty(len(p))
    equity[0] = capital
    if len(strat_returns):
        equity[1:] = capital * np.cumprod(1.0 + strat_returns)
    benchmark = capital * p / p[0]

    equity_curve = [
        {"date": d, "value": round(float(v), 2)} for d, v in zip(dates, equity)
    ]
    benchmark_curve = [
        {"date": d, "value": round(float(v), 2)} for d, v in zip(dates, benchmark)
    ]

    rf_annual = 0.045
    try:
        rf_annual = _fetch_risk_free_rate()
    except Exception:
        pass

    metrics = _compute_metrics(strat_returns, equity, dates, pos, asset_returns, rf_annual)
    trades = _build_trades(dates, prices, pos.tolist())
    heatmap = _monthly_heatmap(dates, strat_returns)

    return {
        "symbol": symbol,
        "strategy": strategy,
        "strategy_name": spec["name"],
        "params": use_params,
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "capital": round(capital, 2),
        "equity_curve": equity_curve,
        "benchmark_curve": benchmark_curve,
        "trades": trades,
        "metrics": metrics,
        "monthly_returns_heatmap": heatmap,
        "data_mode": data_mode,
        "as_of": as_of,
        "source": "yfinance" if source == "live" else "backtest-sample",
    }
