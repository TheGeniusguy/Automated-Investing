"""Extended portfolio analytics - "other computable metrics".

This module is the home for the second-tier risk and performance statistics
that are derivable from a daily return series (and optionally a benchmark
return series) but that live outside the core `analytics.py` report.

Two public entrypoints:

- `compute_extended_metrics(returns, benchmark_returns=None, ...)` computes a
  flat dict of ~20 risk-adjusted / distribution / drawdown metrics plus a
  rolling Sharpe series. Pure numpy. Every value is a float (or None when not
  computable). It never raises - empty or too-short inputs degrade to a fully
  populated dict of None values.

- `validate_available_metrics()` returns the catalog of every metric the
  system can derive from existing data (portfolio returns, a benchmark series,
  and price histories). This doubles as the machine-readable "what else can be
  calculated" deliverable that backs docs/derivable-metrics.md.

All inputs are plain daily simple returns (e.g. 0.012 for +1.2 percent). No
prices, no DuckDB, no network. The route layer is responsible for building the
return series via fetch_arbitrary_ticker and falling back to sample data.

Conventions (match analytics.py):
- periods_per_year defaults to 252 (trading days).
- Sample standard deviations use ddof=1.
- Sortino / downside deviation use the all-N-days denominator
  sqrt(mean(min(r - rf, 0)**2)), not just the count of down days.
- A risk-free rate is supplied annualized and converted to a per-period rate.
"""
from __future__ import annotations

import logging
import math

import numpy as np

log = logging.getLogger(__name__)

ROLLING_SHARPE_WINDOW = 63   # ~one quarter of trading days


# ----------------------------------------------------------------------------
# Small numeric guards
# ----------------------------------------------------------------------------
def _clean(returns) -> np.ndarray:
    """Coerce an input return series to a finite float ndarray.

    Drops NaN / inf entries. Returns an empty array for anything unusable so
    that downstream guards (len checks) handle the degenerate cases uniformly.
    """
    try:
        arr = np.asarray(returns, dtype=float).ravel()
    except (TypeError, ValueError):
        return np.array([], dtype=float)
    if arr.size == 0:
        return arr
    return arr[np.isfinite(arr)]


def _fnum(value) -> float | None:
    """Return a clean python float, or None if the value is not finite."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


# ----------------------------------------------------------------------------
# Individual metric helpers (each documents its formula and never raises)
# ----------------------------------------------------------------------------
def _cagr(returns: np.ndarray, ppy: int) -> float | None:
    """Compound annual growth rate.

    CAGR = (prod(1 + r))**(ppy / n) - 1
    Geometric annualization of the cumulative growth over n periods.
    """
    n = returns.size
    if n < 1:
        return None
    growth = float(np.prod(1.0 + returns))
    if growth <= 0:
        return None
    return _fnum(growth ** (ppy / n) - 1.0)


def _ann_vol(returns: np.ndarray, ppy: int) -> float | None:
    """Annualized volatility = std(r, ddof=1) * sqrt(ppy)."""
    if returns.size < 2:
        return None
    sd = float(np.std(returns, ddof=1))
    return _fnum(sd * math.sqrt(ppy))


def _drawdown_series(returns: np.ndarray) -> np.ndarray:
    """Drawdown path: (equity - running peak) / running peak, equity base 1.0."""
    equity = np.cumprod(1.0 + returns)
    peak = np.maximum.accumulate(equity)
    return (equity - peak) / peak


def _max_drawdown(returns: np.ndarray) -> float | None:
    """Maximum drawdown = min of the drawdown path (negative number)."""
    if returns.size < 1:
        return None
    return _fnum(float(np.min(_drawdown_series(returns))))


def _max_drawdown_duration(returns: np.ndarray) -> float | None:
    """Longest run (in periods) spent below the prior equity peak.

    Counts the longest consecutive stretch where drawdown < 0. Reported in
    days under the implicit assumption that one return == one trading day.
    """
    if returns.size < 1:
        return None
    dd = _drawdown_series(returns)
    longest = 0
    current = 0
    for x in dd:
        if x < -1e-12:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return float(longest)


def _recovery_days(returns: np.ndarray) -> float | None:
    """Periods from the max-drawdown trough back to a new equity high.

    Returns None if the series never recovers after its deepest trough.
    """
    if returns.size < 1:
        return None
    dd = _drawdown_series(returns)
    trough_idx = int(np.argmin(dd))
    for i in range(trough_idx + 1, dd.size):
        if dd[i] >= -1e-12:
            return float(i - trough_idx)
    return None


def _ulcer_index(returns: np.ndarray) -> float | None:
    """Ulcer Index = sqrt(mean(drawdown_pct**2)).

    Drawdown is expressed in percent (x100) so the index is on a familiar
    scale. Penalizes depth and duration of drawdowns more than volatility.
    """
    if returns.size < 1:
        return None
    dd_pct = _drawdown_series(returns) * 100.0
    return _fnum(math.sqrt(float(np.mean(dd_pct ** 2))))


def _downside_deviation(returns: np.ndarray, rf_period: float, ppy: int) -> float | None:
    """Annualized downside deviation.

    sqrt(mean(min(r - rf, 0)**2)) * sqrt(ppy). All-N-days denominator (matches
    the Sortino convention used in analytics.py).
    """
    if returns.size < 1:
        return None
    semi = np.minimum(returns - rf_period, 0.0) ** 2
    return _fnum(math.sqrt(float(np.mean(semi))) * math.sqrt(ppy))


def _omega_ratio(returns: np.ndarray, threshold_period: float) -> float | None:
    """Omega ratio at a return threshold.

    Omega = sum(max(r - T, 0)) / sum(max(T - r, 0))
    Ratio of probability-weighted gains to losses about threshold T. The spec
    pins the threshold to 0 (per-period). Returns None when there are no
    losses below T (denominator zero -> undefined / infinite).
    """
    if returns.size < 1:
        return None
    gains = float(np.sum(np.maximum(returns - threshold_period, 0.0)))
    losses = float(np.sum(np.maximum(threshold_period - returns, 0.0)))
    if losses <= 0:
        return None
    return _fnum(gains / losses)


def _tail_ratio(returns: np.ndarray) -> float | None:
    """Tail ratio = p95 / |p5|.

    Right-tail magnitude relative to left-tail magnitude. > 1 means upside
    tails dominate downside tails.
    """
    if returns.size < 2:
        return None
    p95 = float(np.percentile(returns, 95))
    p5 = float(np.percentile(returns, 5))
    if abs(p5) < 1e-12:
        return None
    return _fnum(p95 / abs(p5))


def _gain_to_pain(returns: np.ndarray) -> float | None:
    """Gain-to-pain ratio = sum(r) / sum(|r| for r < 0).

    Total return divided by the sum of all losing periods. A robustness ratio
    popularized by Jack Schwager.
    """
    if returns.size < 1:
        return None
    pain = float(np.sum(np.abs(returns[returns < 0])))
    if pain <= 0:
        return None
    return _fnum(float(np.sum(returns)) / pain)


def _common_sense_ratio(returns: np.ndarray) -> float | None:
    """Common sense ratio = tail_ratio * gain_to_pain.

    Combines tail asymmetry with the gain-to-pain robustness measure.
    """
    tr = _tail_ratio(returns)
    gp = _gain_to_pain(returns)
    if tr is None or gp is None:
        return None
    return _fnum(tr * gp)


def _skew(returns: np.ndarray) -> float | None:
    """Sample skewness (Fisher-Pearson, bias-corrected g1 -> G1).

    G1 = (n / ((n-1)(n-2))) * sum(((r - mean)/s)**3), s = std(ddof=1).
    """
    n = returns.size
    if n < 3:
        return None
    mean = float(np.mean(returns))
    s = float(np.std(returns, ddof=1))
    if s <= 0:
        return None
    z = (returns - mean) / s
    g = (n / ((n - 1) * (n - 2))) * float(np.sum(z ** 3))
    return _fnum(g)


def _excess_kurtosis(returns: np.ndarray) -> float | None:
    """Sample excess kurtosis (bias-corrected G2).

    G2 = ((n+1)n / ((n-1)(n-2)(n-3))) * sum(z**4) - 3(n-1)**2/((n-2)(n-3)),
    where z = (r - mean)/std(ddof=1). Excess (normal -> 0).
    """
    n = returns.size
    if n < 4:
        return None
    mean = float(np.mean(returns))
    s = float(np.std(returns, ddof=1))
    if s <= 0:
        return None
    z = (returns - mean) / s
    term1 = ((n + 1) * n) / ((n - 1) * (n - 2) * (n - 3)) * float(np.sum(z ** 4))
    term2 = 3.0 * (n - 1) ** 2 / ((n - 2) * (n - 3))
    return _fnum(term1 - term2)


def _kelly_fraction(returns: np.ndarray) -> float | None:
    """Continuous Kelly fraction = mean(r) / var(r).

    Optimal growth-maximizing leverage for a return series under the Gaussian
    approximation. Uses population variance (ddof=0) of the per-period returns.
    """
    if returns.size < 2:
        return None
    var = float(np.var(returns, ddof=0))
    if var <= 0:
        return None
    return _fnum(float(np.mean(returns)) / var)


def _sharpe(returns: np.ndarray, rf_period: float, ppy: int) -> float | None:
    """Annualized Sharpe = mean(r - rf) / std(r - rf, ddof=1) * sqrt(ppy)."""
    if returns.size < 2:
        return None
    excess = returns - rf_period
    sd = float(np.std(excess, ddof=1))
    if sd <= 0:
        return None
    return _fnum(float(np.mean(excess)) / sd * math.sqrt(ppy))


def _rolling_sharpe(returns: np.ndarray, rf_period: float, ppy: int, window: int) -> list[float | None]:
    """Rolling annualized Sharpe over a trailing window.

    One value per period starting at index `window-1`. Each point uses the
    trailing `window` excess returns. None where a window has zero variance.
    Empty list when the series is shorter than the window.
    """
    n = returns.size
    if n < window or window < 2:
        return []
    excess = returns - rf_period
    out: list[float | None] = []
    for end in range(window, n + 1):
        chunk = excess[end - window:end]
        sd = float(np.std(chunk, ddof=1))
        if sd <= 0:
            out.append(None)
        else:
            out.append(_fnum(float(np.mean(chunk)) / sd * math.sqrt(ppy)))
    return out


# --- Benchmark-relative metrics -------------------------------------------
def _align(returns: np.ndarray, benchmark: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Truncate both series to their common trailing length."""
    m = min(returns.size, benchmark.size)
    if m < 1:
        return np.array([]), np.array([])
    return returns[-m:], benchmark[-m:]


def _information_ratio(returns: np.ndarray, benchmark: np.ndarray, ppy: int) -> float | None:
    """Information ratio = annualized active return / tracking error.

    active = r - benchmark; IR = mean(active)*ppy / (std(active, ddof=1)*sqrt(ppy)).
    """
    r, b = _align(returns, benchmark)
    if r.size < 2:
        return None
    active = r - b
    te = float(np.std(active, ddof=1))
    if te <= 0:
        return None
    active_ann = float(np.mean(active)) * ppy
    te_ann = te * math.sqrt(ppy)
    return _fnum(active_ann / te_ann)


def _beta(returns: np.ndarray, benchmark: np.ndarray) -> float | None:
    """CAPM beta = cov(r, b) / var(b)."""
    r, b = _align(returns, benchmark)
    if r.size < 2:
        return None
    cov = np.cov(r, b)
    var_b = float(cov[1, 1])
    if var_b <= 0:
        return None
    return _fnum(float(cov[0, 1]) / var_b)


def _treynor_ratio(returns: np.ndarray, benchmark: np.ndarray, rf_period: float, ppy: int) -> float | None:
    """Treynor ratio = (annualized excess return) / beta.

    Uses geometric annualized return minus the annualized risk-free rate over
    the systematic risk (beta) rather than total volatility.
    """
    beta = _beta(returns, benchmark)
    if beta is None or beta == 0:
        return None
    ann_ret = _cagr(returns, ppy)
    if ann_ret is None:
        return None
    rf_annual = (1.0 + rf_period) ** ppy - 1.0
    return _fnum((ann_ret - rf_annual) / beta)


def _capture(returns: np.ndarray, benchmark: np.ndarray, side: str) -> float | None:
    """Up/down capture ratio.

    Geometric: capture = (prod(1+r over chosen periods) - 1) /
                         (prod(1+b over chosen periods) - 1)
    `side="up"` selects periods where the benchmark return > 0, `side="down"`
    where benchmark < 0. Expressed as a ratio (1.0 == matches benchmark).
    """
    r, b = _align(returns, benchmark)
    if r.size < 1:
        return None
    if side == "up":
        mask = b > 0
    else:
        mask = b < 0
    if not bool(np.any(mask)):
        return None
    port = float(np.prod(1.0 + r[mask])) - 1.0
    bench = float(np.prod(1.0 + b[mask])) - 1.0
    if abs(bench) < 1e-12:
        return None
    return _fnum(port / bench)


# ----------------------------------------------------------------------------
# Public: compute the full extended metric set
# ----------------------------------------------------------------------------
def compute_extended_metrics(
    returns: list[float],
    benchmark_returns: list[float] | None = None,
    rf_annual: float = 0.0,
    periods_per_year: int = 252,
) -> dict:
    """Compute the extended risk / distribution / drawdown metric set.

    Args:
        returns: daily simple returns of the subject series (e.g. 0.01 == +1%).
        benchmark_returns: optional benchmark daily returns. Benchmark-relative
            metrics (information_ratio, treynor_ratio, up/down capture) return
            None when this is absent or too short.
        rf_annual: annualized risk-free rate as a decimal (0.05 == 5%).
        periods_per_year: annualization factor (252 trading days by default).

    Returns:
        A flat dict. Every scalar is a float or None. `rolling_sharpe` is a
        list of floats/None (may be empty). Never raises.
    """
    ppy = periods_per_year if periods_per_year and periods_per_year > 0 else 252
    try:
        rf_period = (1.0 + rf_annual) ** (1.0 / ppy) - 1.0
    except (TypeError, ValueError, ZeroDivisionError):
        rf_period = 0.0

    r = _clean(returns)
    b = _clean(benchmark_returns) if benchmark_returns is not None else np.array([])

    try:
        metrics: dict = {
            # risk-adjusted
            "information_ratio":  _information_ratio(r, b, ppy) if b.size else None,
            "treynor_ratio":      _treynor_ratio(r, b, rf_period, ppy) if b.size else None,
            "omega_ratio":        _omega_ratio(r, 0.0),
            "ulcer_index":        _ulcer_index(r),
            "martin_ratio":       None,   # filled below (CAGR / ulcer)
            "tail_ratio":         _tail_ratio(r),
            "gain_to_pain":       _gain_to_pain(r),
            "common_sense_ratio": _common_sense_ratio(r),
            "kelly_fraction":     _kelly_fraction(r),
            # distribution shape
            "skew":               _skew(r),
            "kurtosis":           _excess_kurtosis(r),
            "downside_deviation": _downside_deviation(r, rf_period, ppy),
            # benchmark capture
            "upside_capture":     _capture(r, b, "up") if b.size else None,
            "downside_capture":   _capture(r, b, "down") if b.size else None,
            # growth / risk
            "cagr":               _cagr(r, ppy),
            "ann_vol":            _ann_vol(r, ppy),
            # drawdown
            "max_drawdown":             _max_drawdown(r),
            "max_drawdown_duration_days": _max_drawdown_duration(r),
            "recovery_days":            _recovery_days(r),
        }

        # Martin ratio = CAGR / Ulcer Index (a.k.a. Ulcer Performance Index).
        cagr = metrics["cagr"]
        ulcer = metrics["ulcer_index"]
        if cagr is not None and ulcer is not None and ulcer > 0:
            metrics["martin_ratio"] = _fnum((cagr * 100.0) / ulcer)

        metrics["rolling_sharpe"] = _rolling_sharpe(r, rf_period, ppy, ROLLING_SHARPE_WINDOW)
        return metrics
    except Exception as e:   # absolute belt-and-suspenders: never raise
        log.warning("compute_extended_metrics degraded: %s", e)
        return _empty_extended_metrics()


def _empty_extended_metrics() -> dict:
    keys = [
        "information_ratio", "treynor_ratio", "omega_ratio", "ulcer_index",
        "martin_ratio", "tail_ratio", "gain_to_pain", "common_sense_ratio",
        "kelly_fraction", "skew", "kurtosis", "downside_deviation",
        "upside_capture", "downside_capture", "cagr", "ann_vol",
        "max_drawdown", "max_drawdown_duration_days", "recovery_days",
    ]
    out: dict = {k: None for k in keys}
    out["rolling_sharpe"] = []
    return out


# ----------------------------------------------------------------------------
# Public: catalog of every metric derivable from existing data
# ----------------------------------------------------------------------------
def validate_available_metrics() -> list[dict]:
    """Return the catalog of every metric the system can compute today.

    Each entry: {key, name, formula, inputs, category}. This is both an API
    payload (GET /api/analytics/catalog) and the source of truth behind
    docs/derivable-metrics.md. `inputs` lists the upstream data each metric
    needs - all of it is derivable from the existing price/return fetchers
    (fetch_arbitrary_ticker) plus an optional benchmark series.
    """
    return [
        # --- Return / growth -------------------------------------------------
        {
            "key": "cagr",
            "name": "CAGR (Compound Annual Growth Rate)",
            "formula": "prod(1 + r)**(252 / n) - 1",
            "inputs": ["returns"],
            "category": "Return",
        },
        {
            "key": "ann_vol",
            "name": "Annualized Volatility",
            "formula": "std(r, ddof=1) * sqrt(252)",
            "inputs": ["returns"],
            "category": "Return",
        },
        # --- Risk-adjusted ---------------------------------------------------
        {
            "key": "information_ratio",
            "name": "Information Ratio",
            "formula": "mean(r - b) * 252 / (std(r - b, ddof=1) * sqrt(252))",
            "inputs": ["returns", "benchmark_returns"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "treynor_ratio",
            "name": "Treynor Ratio",
            "formula": "(CAGR - rf_annual) / beta",
            "inputs": ["returns", "benchmark_returns", "rf_annual"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "omega_ratio",
            "name": "Omega Ratio (threshold 0)",
            "formula": "sum(max(r - T, 0)) / sum(max(T - r, 0)), T = 0",
            "inputs": ["returns"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "martin_ratio",
            "name": "Martin Ratio (Ulcer Performance Index)",
            "formula": "(CAGR * 100) / ulcer_index",
            "inputs": ["returns"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "gain_to_pain",
            "name": "Gain-to-Pain Ratio",
            "formula": "sum(r) / sum(|r| for r < 0)",
            "inputs": ["returns"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "common_sense_ratio",
            "name": "Common Sense Ratio",
            "formula": "tail_ratio * gain_to_pain",
            "inputs": ["returns"],
            "category": "Risk-Adjusted",
        },
        {
            "key": "kelly_fraction",
            "name": "Kelly Fraction",
            "formula": "mean(r) / var(r)",
            "inputs": ["returns"],
            "category": "Risk-Adjusted",
        },
        # --- Drawdown --------------------------------------------------------
        {
            "key": "ulcer_index",
            "name": "Ulcer Index",
            "formula": "sqrt(mean(drawdown_pct**2))",
            "inputs": ["returns"],
            "category": "Drawdown",
        },
        {
            "key": "max_drawdown",
            "name": "Maximum Drawdown",
            "formula": "min((equity - cummax(equity)) / cummax(equity))",
            "inputs": ["returns"],
            "category": "Drawdown",
        },
        {
            "key": "max_drawdown_duration_days",
            "name": "Max Drawdown Duration (days)",
            "formula": "longest consecutive run with drawdown < 0",
            "inputs": ["returns"],
            "category": "Drawdown",
        },
        {
            "key": "recovery_days",
            "name": "Recovery Days",
            "formula": "periods from max-drawdown trough to a new equity high",
            "inputs": ["returns"],
            "category": "Drawdown",
        },
        # --- Distribution shape ---------------------------------------------
        {
            "key": "skew",
            "name": "Skewness",
            "formula": "n / ((n-1)(n-2)) * sum(((r - mean)/std)**3)",
            "inputs": ["returns"],
            "category": "Distribution",
        },
        {
            "key": "kurtosis",
            "name": "Excess Kurtosis",
            "formula": "(n+1)n / ((n-1)(n-2)(n-3)) * sum(z**4) - 3(n-1)**2/((n-2)(n-3))",
            "inputs": ["returns"],
            "category": "Distribution",
        },
        {
            "key": "tail_ratio",
            "name": "Tail Ratio",
            "formula": "percentile(r, 95) / |percentile(r, 5)|",
            "inputs": ["returns"],
            "category": "Distribution",
        },
        {
            "key": "downside_deviation",
            "name": "Downside Deviation",
            "formula": "sqrt(mean(min(r - rf, 0)**2)) * sqrt(252)",
            "inputs": ["returns", "rf_annual"],
            "category": "Distribution",
        },
        # --- Benchmark capture ----------------------------------------------
        {
            "key": "upside_capture",
            "name": "Upside Capture Ratio",
            "formula": "(prod(1+r | b>0) - 1) / (prod(1+b | b>0) - 1)",
            "inputs": ["returns", "benchmark_returns"],
            "category": "Capture",
        },
        {
            "key": "downside_capture",
            "name": "Downside Capture Ratio",
            "formula": "(prod(1+r | b<0) - 1) / (prod(1+b | b<0) - 1)",
            "inputs": ["returns", "benchmark_returns"],
            "category": "Capture",
        },
        # --- Time series ----------------------------------------------------
        {
            "key": "rolling_sharpe",
            "name": "Rolling Sharpe (63d window)",
            "formula": "per window: mean(r - rf) / std(r - rf, ddof=1) * sqrt(252)",
            "inputs": ["returns", "rf_annual"],
            "category": "Time Series",
        },
    ]
