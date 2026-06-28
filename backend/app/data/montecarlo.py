"""Monte Carlo risk simulation (Bloomberg MCAR analog).

Given a symbol, estimates a daily drift + volatility from its historical price
series, then runs a Geometric Brownian Motion (GBM) Monte Carlo over a forward
horizon to produce:

- a percentile fan (p5/p25/p50/p75/p95) of portfolio value over time,
- a terminal-value histogram,
- VaR / CVaR at 95% and 99% on the terminal return distribution,
- the probability of finishing up >= 10% and the probability of touching a
  -20% drawdown at any point along a path,
- the expected (mean) terminal value.

Live path: daily prices via app.data.macro_data.fetch_arbitrary_ticker, from
which mu (mean daily log return) and sigma (std of daily log returns) are
estimated. When the live source returns nothing we degrade to a deterministic
drift/vol profile seeded off the symbol so the panel is always fully populated.

The simulation RNG is ALWAYS seeded deterministically off the symbol (via
hashlib) so the percentile fan and histogram are byte-stable across runs -
stable screenshots. This module never raises: it always returns a populated,
shaped payload tagged with data_mode / as_of / source.

Formulas (pure numpy / stdlib):
  daily log return r_t   = ln(P_t / P_{t-1})
  mu                     = mean(r_t)         (drift, per trading day)
  sigma                  = std(r_t, ddof=1)  (vol,   per trading day)
  GBM step               = exp((mu - sigma^2/2) + sigma * Z),  Z ~ N(0,1)
  path value V_t         = start_value * cumprod(GBM steps)
  VaR_c (terminal)       = -percentile(terminal_return, (1-c)*100)
  CVaR_c (terminal)      = -mean(terminal_return <= -VaR_c threshold)
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

TRADING_DAYS = 252
MC_TTL = 60 * 60 * 6  # 6 hours - drift/vol estimates move slowly
MIN_POINTS = 40       # need a couple of months before the live estimate is useful
NUM_BUCKETS = 25      # terminal histogram resolution

# Bounds to keep both live-estimated and sample profiles sane / realistic.
MAX_SIMS = 20000
MAX_HORIZON = 252 * 5
MIN_SIMS = 50
MIN_HORIZON = 5

# Sample (deterministic) annualized drift/vol profile when no live data exists.
SAMPLE_ANN_RETURN = 0.09
SAMPLE_ANN_VOL = 0.20


# ---------------------------------------------------------------------------
# Deterministic seeding + sample-price synthesis (seeded off the symbol)
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    """Stable integer seed derived from the symbol via hashlib (md5)."""
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    """`days`+1 trading-day date strings (weekdays only) ending today."""
    out: list[str] = []
    d = date.today()
    while len(out) < days + 1:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_prices(symbol: str, days: int) -> list[dict]:
    """Deterministic GBM price history as a list of {date, value} points.

    A per-symbol drift/vol tilt (bounded) keeps each symbol's profile distinct
    while staying realistic. Seeded off the symbol so output is reproducible.
    """
    n_pts = max(days, MIN_POINTS + 5)
    dates = _sample_dates(n_pts)
    rng = np.random.default_rng(_seed(symbol))

    h = hashlib.md5(symbol.encode()).hexdigest()
    tilt_ret = (int(h[8:12], 16) / 0xFFFF - 0.5) * 2.0
    tilt_vol = (int(h[12:16], 16) / 0xFFFF - 0.5) * 2.0

    ann_ret = SAMPLE_ANN_RETURN + tilt_ret * 0.06          # ~3% .. 15%
    ann_vol = max(SAMPLE_ANN_VOL + tilt_vol * 0.08, 0.07)  # floor 7%

    mu = ann_ret / TRADING_DAYS
    sig = ann_vol / np.sqrt(TRADING_DAYS)
    rets = rng.normal(mu, sig, len(dates) - 1)

    base = 100.0
    prices = base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))
    return [{"date": d, "value": round(float(p), 4)} for d, p in zip(dates, prices)]


# ---------------------------------------------------------------------------
# Drift / vol estimation
# ---------------------------------------------------------------------------

def _clean_prices(points: list[dict]) -> np.ndarray:
    """Sorted positive price array from {date, value} points."""
    rows: list[tuple[str, float]] = []
    for p in points or []:
        d = p.get("date")
        v = p.get("value")
        if d and v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv > 0:
                rows.append((str(d), fv))
    rows.sort(key=lambda x: x[0])
    return np.array([r[1] for r in rows], dtype=float)


def _estimate_drift_vol(prices: np.ndarray) -> tuple[float, float]:
    """Estimate (mu, sigma) of daily log returns. Falls back to a sane profile.

    Sigma is floored to avoid a degenerate zero-vol fan; both are clamped to
    keep pathological inputs (e.g. a single huge gap) from blowing up the sim.
    """
    if prices.size >= 2:
        log_rets = np.diff(np.log(prices))
        log_rets = log_rets[np.isfinite(log_rets)]
    else:
        log_rets = np.array([], dtype=float)

    if log_rets.size >= 2:
        mu = float(np.mean(log_rets))
        sigma = float(np.std(log_rets, ddof=1))
    else:
        mu = SAMPLE_ANN_RETURN / TRADING_DAYS
        sigma = SAMPLE_ANN_VOL / np.sqrt(TRADING_DAYS)

    # Floor vol so the fan never collapses; clamp drift to a sane daily band.
    sigma = max(sigma, 0.001)
    sigma = min(sigma, 0.20)            # ~317% annualized ceiling
    mu = float(np.clip(mu, -0.02, 0.02))
    return mu, sigma


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def _simulate(symbol: str, mu: float, sigma: float, horizon_days: int,
              sims: int, start_value: float) -> np.ndarray:
    """Run GBM Monte Carlo. Returns a (sims, horizon_days+1) value matrix.

    Column 0 is start_value for every path. RNG seeded off the symbol so the
    output is deterministic across runs (stable screenshots).
    """
    rng = np.random.default_rng(_seed(symbol) ^ 0x4D43)  # 'MC' tweak, still stable
    z = rng.standard_normal((sims, horizon_days))
    drift = mu - 0.5 * sigma * sigma
    log_steps = drift + sigma * z                       # (sims, horizon_days)
    log_paths = np.cumsum(log_steps, axis=1)
    values = start_value * np.exp(log_paths)            # (sims, horizon_days)
    start_col = np.full((sims, 1), float(start_value))
    return np.concatenate([start_col, values], axis=1)  # (sims, horizon_days+1)


def _percentile_fan(paths: np.ndarray) -> list[dict]:
    """Per-day p5/p25/p50/p75/p95 of value across all paths (incl. day 0)."""
    pct = np.percentile(paths, [5, 25, 50, 75, 95], axis=0)  # (5, n_days)
    fan: list[dict] = []
    for day in range(paths.shape[1]):
        fan.append({
            "day": day,
            "p5": round(float(pct[0, day]), 2),
            "p25": round(float(pct[1, day]), 2),
            "p50": round(float(pct[2, day]), 2),
            "p75": round(float(pct[3, day]), 2),
            "p95": round(float(pct[4, day]), 2),
        })
    return fan


def _terminal_hist(terminal: np.ndarray) -> list[dict]:
    """Histogram of terminal values into NUM_BUCKETS evenly spaced buckets."""
    lo = float(np.min(terminal))
    hi = float(np.max(terminal))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        # Degenerate spread: dump everything into one labelled bucket.
        center = round(lo if np.isfinite(lo) else 0.0, 2)
        return [{"bucket": center, "count": int(terminal.size)}]
    counts, edges = np.histogram(terminal, bins=NUM_BUCKETS, range=(lo, hi))
    out: list[dict] = []
    for i in range(len(counts)):
        center = (edges[i] + edges[i + 1]) / 2.0
        out.append({"bucket": round(float(center), 2), "count": int(counts[i])})
    return out


def _var_cvar(terminal_returns: np.ndarray, confidence: float) -> tuple[float, float]:
    """VaR + CVaR (as positive loss fractions) on the terminal-return dist.

    VaR_c  = -percentile(returns, (1-c)*100)  (positive => a loss)
    CVaR_c = -mean(returns <= that percentile threshold)
    """
    threshold = np.percentile(terminal_returns, (1.0 - confidence) * 100.0)
    tail = terminal_returns[terminal_returns <= threshold]
    var = -float(threshold)
    cvar = -float(np.mean(tail)) if tail.size else var
    return var, cvar


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def monte_carlo(symbol: str, horizon_days: int = 252, sims: int = 2000,
                start_value: float = 10000) -> dict:
    """Run a GBM Monte Carlo risk simulation for `symbol`.

    Never raises - degrades to a deterministic sample drift/vol profile and
    tags the payload with data_mode / as_of / source.
    """
    try:
        return _monte_carlo(symbol, horizon_days, sims, start_value)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("monte_carlo failed hard, returning sample: %s", e)
        sym = _norm_symbol(symbol)
        h, n, sv = _norm_params(horizon_days, sims, start_value)
        try:
            prices = _clean_prices(_sample_prices(sym, max(h, MIN_POINTS + 5)))
            return _build(sym, prices, h, n, sv,
                          data_mode="sample", source="sample")
        except Exception:
            return _empty_payload(sym, h, sv)


def _norm_symbol(symbol: str) -> str:
    return (symbol or "SPY").strip().upper() or "SPY"


def _norm_params(horizon_days: int, sims: int, start_value: float) -> tuple[int, int, float]:
    h = horizon_days if isinstance(horizon_days, int) else 252
    n = sims if isinstance(sims, int) else 2000
    h = int(np.clip(h, MIN_HORIZON, MAX_HORIZON))
    n = int(np.clip(n, MIN_SIMS, MAX_SIMS))
    try:
        sv = float(start_value)
    except (TypeError, ValueError):
        sv = 10000.0
    if not np.isfinite(sv) or sv <= 0:
        sv = 10000.0
    return h, n, sv


def _monte_carlo(symbol: str, horizon_days: int, sims: int,
                 start_value: float) -> dict:
    sym = _norm_symbol(symbol)
    h, n, sv = _norm_params(horizon_days, sims, start_value)

    cache_key = f"montecarlo:{sym}:{h}:{n}:{int(sv)}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    points: list[dict] = []
    try:
        points = fetch_arbitrary_ticker(sym, days=max(h, 365) + 5)
    except Exception as e:
        log.warning("monte_carlo fetch failed for %s: %s", sym, e)
        points = []

    prices = _clean_prices(points)
    if prices.size >= MIN_POINTS:
        result = _build(sym, prices, h, n, sv, data_mode="live", source="yfinance")
    else:
        prices = _clean_prices(_sample_prices(sym, max(h, MIN_POINTS + 5)))
        result = _build(sym, prices, h, n, sv, data_mode="sample", source="sample")

    cache.set(cache_key, result, MC_TTL)
    return result


def _build(symbol: str, prices: np.ndarray, horizon_days: int, sims: int,
           start_value: float, *, data_mode: str, source: str) -> dict:
    mu, sigma = _estimate_drift_vol(prices)
    paths = _simulate(symbol, mu, sigma, horizon_days, sims, start_value)

    terminal = paths[:, -1]
    terminal_returns = terminal / start_value - 1.0

    fan = _percentile_fan(paths)
    hist = _terminal_hist(terminal)

    var95, cvar95 = _var_cvar(terminal_returns, 0.95)
    var99, cvar99 = _var_cvar(terminal_returns, 0.99)

    prob_up_10pct = float(np.mean(terminal >= start_value * 1.10))
    # Drawdown breach: running max along each path, worst peak-to-trough hit.
    running_max = np.maximum.accumulate(paths, axis=1)
    drawdowns = paths / running_max - 1.0
    min_dd = np.min(drawdowns, axis=1)           # most negative per path
    prob_dd_20pct = float(np.mean(min_dd <= -0.20))

    expected_value = round(float(np.mean(terminal)), 2)

    return {
        "symbol": symbol,
        "horizon_days": horizon_days,
        "sims": sims,
        "start_value": round(float(start_value), 2),
        "drift_daily": round(mu, 6),
        "vol_daily": round(sigma, 6),
        "drift_annual_pct": round(mu * TRADING_DAYS * 100, 3),
        "vol_annual_pct": round(sigma * np.sqrt(TRADING_DAYS) * 100, 3),
        "fan": fan,
        "terminal_hist": hist,
        "var95": round(var95 * 100, 3),
        "var99": round(var99 * 100, 3),
        "cvar95": round(cvar95 * 100, 3),
        "cvar99": round(cvar99 * 100, 3),
        "prob_up_10pct": round(prob_up_10pct * 100, 2),
        "prob_dd_20pct": round(prob_dd_20pct * 100, 2),
        "expected_value": expected_value,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_payload(symbol: str, horizon_days: int, start_value: float) -> dict:
    """Last-resort shaped payload if even the sample path fails."""
    fan = [{
        "day": d, "p5": round(start_value, 2), "p25": round(start_value, 2),
        "p50": round(start_value, 2), "p75": round(start_value, 2),
        "p95": round(start_value, 2),
    } for d in range(horizon_days + 1)]
    return {
        "symbol": symbol,
        "horizon_days": horizon_days,
        "sims": 0,
        "start_value": round(float(start_value), 2),
        "drift_daily": 0.0,
        "vol_daily": 0.0,
        "drift_annual_pct": 0.0,
        "vol_annual_pct": 0.0,
        "fan": fan,
        "terminal_hist": [{"bucket": round(float(start_value), 2), "count": 0}],
        "var95": None,
        "var99": None,
        "cvar95": None,
        "cvar99": None,
        "prob_up_10pct": None,
        "prob_dd_20pct": None,
        "expected_value": round(float(start_value), 2),
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
