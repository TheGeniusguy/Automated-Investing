"""
Regime-Based Sector Playbook
Uses the 5-state regime history stored in DuckDB (or falls back to the
live regime model) and aligns it with sector ETF + SPY daily returns.

For each regime state compute:
  - avg daily return (annualised)
  - beat rate vs SPY  (pct of days sector outperformed SPY)
  - sample size (trading days in that regime)
  - best single-day return  / worst single-day return

Highlight the current regime.
"""
from __future__ import annotations

import statistics
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import yfinance as yf

from .cache import get, set as cache_set
from . import macro_data as macro_data_mod
from ..regime import regime_model as regime_mod

_TTL = 7200  # 2 h — regime playbook is slow; cache longer

REGIME_LABELS = {
    "risk_on": "Risk-On",
    "early_cycle": "Early Cycle",
    "late_cycle": "Late Cycle",
    "risk_off": "Risk-Off",
    "recession": "Recession",
    # fallback for older 3-state labels
    "transition": "Transition",
}

REGIME_ORDER = ["risk_on", "early_cycle", "late_cycle", "risk_off", "recession", "transition"]


def _fetch_price_series(symbol: str, period: str = "5y") -> dict[str, float]:
    """Return {date_str: close} for a symbol."""
    cache_key = f"playbook_prices:{symbol}:{period}"
    raw = get(cache_key)
    if raw is not None:
        return raw
    try:
        hist = yf.Ticker(symbol).history(period=period)
        if hist is None or hist.empty:
            return {}
        result = {
            str(idx.date()): float(row["Close"])
            for idx, row in hist.iterrows()
            if not str(idx.date()).startswith("NaT")
        }
        cache_set(cache_key, result, _TTL)
        return result
    except Exception:
        return {}


def _daily_returns(prices: dict[str, float]) -> dict[str, float]:
    """Return {date: pct_return} from sorted price dict."""
    dates = sorted(prices)
    returns: dict[str, float] = {}
    for i in range(1, len(dates)):
        prev = prices[dates[i - 1]]
        curr = prices[dates[i]]
        if prev and prev != 0:
            returns[dates[i]] = (curr / prev - 1) * 100
    return returns


def _regime_history_live(days: int = 1825) -> dict[str, str]:
    """Compute regime history from VIX + yield-curve data.

    Uses the same regime_model as the /api/regime/history endpoint.
    Returns {date_str: regime_label}.
    """
    cache_key = f"regime_hist_for_playbook:{days}"
    cached = get(cache_key)
    if cached is not None:
        return cached
    try:
        vix = macro_data_mod.fetch_series("^VIX", days=days)
        y2 = macro_data_mod.fetch_series("DGS2", days=days)
        y10 = macro_data_mod.fetch_series("DGS10", days=days)
        history = regime_mod.regime_history(vix, y2, y10)
        result = {h["date"]: h["label"] for h in history}
        cache_set(cache_key, result, 3600)
        return result
    except Exception:
        return {}


def sector_regime_playbook(
    sector_id: str, etf: str, current_regime: str
) -> dict[str, Any]:
    cache_key = f"regime_playbook:{sector_id}:{etf}"
    cached = get(cache_key)
    if cached is not None:
        # always refresh current_regime label in case regime changed
        cached["current_regime"] = current_regime
        return cached

    # Fetch prices in parallel
    with ThreadPoolExecutor(max_workers=2) as pool:
        etf_fut = pool.submit(_fetch_price_series, etf)
        spy_fut = pool.submit(_fetch_price_series, "SPY")

    etf_prices = etf_fut.result()
    spy_prices = spy_fut.result()

    if not etf_prices or not spy_prices:
        return {
            "sector_id": sector_id,
            "etf": etf,
            "current_regime": current_regime,
            "regimes": [],
            "error": "insufficient price data",
        }

    etf_returns = _daily_returns(etf_prices)
    spy_returns = _daily_returns(spy_prices)

    # Load regime history
    regime_map = _regime_history_live()

    # Align: we need date present in all three dicts
    common_dates = sorted(
        set(etf_returns) & set(spy_returns) & set(regime_map)
    )

    if len(common_dates) < 20:
        # DB probably empty — skip regime breakdown
        return {
            "sector_id": sector_id,
            "etf": etf,
            "current_regime": current_regime,
            "regimes": [],
            "error": "regime history not available (run regime model first)",
        }

    # Group returns by regime
    by_regime: dict[str, dict[str, list[float]]] = {}
    for date in common_dates:
        state = regime_map[date]
        if state not in by_regime:
            by_regime[state] = {"etf": [], "spy": [], "excess": []}
        er = etf_returns[date]
        sr = spy_returns[date]
        by_regime[state]["etf"].append(er)
        by_regime[state]["spy"].append(sr)
        by_regime[state]["excess"].append(er - sr)

    rows: list[dict[str, Any]] = []
    for state in REGIME_ORDER:
        if state not in by_regime:
            continue
        g = by_regime[state]
        n = len(g["etf"])
        etf_avg = statistics.mean(g["etf"])
        spy_avg = statistics.mean(g["spy"])
        beat_rate = sum(1 for x in g["excess"] if x > 0) / n * 100
        avg_excess = statistics.mean(g["excess"])

        rows.append({
            "regime": state,
            "label": REGIME_LABELS.get(state, state),
            "is_current": state == current_regime,
            "days": n,
            "etf_avg_daily_pct": round(etf_avg, 3),
            "etf_annualized_pct": round(etf_avg * 252, 1),
            "spy_avg_daily_pct": round(spy_avg, 3),
            "spy_annualized_pct": round(spy_avg * 252, 1),
            "avg_excess_daily_pct": round(avg_excess, 3),
            "avg_excess_annualized_pct": round(avg_excess * 252, 1),
            "beat_rate_pct": round(beat_rate, 1),
            "best_day_pct": round(max(g["etf"]), 2),
            "worst_day_pct": round(min(g["etf"]), 2),
        })

    result = {
        "sector_id": sector_id,
        "etf": etf,
        "current_regime": current_regime,
        "total_days": len(common_dates),
        "regimes": rows,
    }
    cache_set(cache_key, result, _TTL)
    return result
