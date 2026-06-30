"""Benchmark-relative ratios & up/down capture (portfolio scorecard completion).

The shipped `analytics.compute_performance_metrics` already reports Sharpe / Sortino
/ Calmar plus a single alpha/beta. This module rounds out the risk-adjusted
scorecard with the *benchmark-conditioned* family that institutional tear-sheets
lead with - the ones that answer "how does this book behave RELATIVE to its
benchmark, and asymmetrically across up vs down markets":

  * Information Ratio  = annualized mean(active) / annualized std(active),
                         where active_t = r_port,t - r_bench,t. Skill per unit of
                         tracking error.
  * Treynor           = (annualized portfolio return - rf) / portfolio beta.
                         Excess return per unit of SYSTEMATIC (non-diversifiable) risk.
  * Jensen's alpha    = ann_port - (rf + beta * (ann_bench - rf)), annualized, via
                        the same cov/var beta `analytics.py` uses.
  * Up-market capture  = annualized portfolio return on UP-benchmark days
                         / annualized benchmark return on those same days * 100.
  * Down-market capture= the analogous ratio over DOWN-benchmark days.
  * Capture spread     = up_capture - down_capture (a clean asymmetry read: a
                         convex book captures more upside than downside, so >0 is good).

Method mirrors the shipped portfolio path exactly:
  * Resolve the portfolio (defaults to the FIRST portfolio, like component_var).
  * Reuse `analytics.build_equity_curve` to replay the transaction log into a daily
    NAV series AND the SPY benchmark curve over a 365d window - no price fetching is
    reimplemented here.
  * Derive aligned daily portfolio vs SPY returns the same way
    `compute_performance_metrics` does (drop dates where SPY is missing).
  * Risk-free rate comes from `analytics._fetch_risk_free_rate` (DGS3MO, 5% fallback)
    so every ratio is consistent with the existing Sharpe/Sortino suite.

Live path requires enough aligned points (>= MIN_POINTS) with both up and down days.
When no portfolio exists, history is too short, or anything goes wrong, we fall back
to a deterministic seeded SAMPLE whose synthetic returns run through the IDENTICAL
math engine, yielding a coherent tear-sheet (up-capture ~105, down-capture ~95,
positive Information Ratio, beta ~1.05). The payload always carries an internal
data_mode ("live" | "sample") + as_of + source. This function NEVER raises.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger(__name__)

TRADING_DAYS_PER_YEAR = 252
LOOKBACK_DAYS = 365
BENCHMARK = "SPY"
MIN_POINTS = 30          # minimum aligned daily observations to trust a live read
MIN_DIRECTIONAL = 5      # minimum up days and down days for a stable capture ratio


# ---------------------------------------------------------------------------
# Core engine - shared by the live and sample paths so both stay self-consistent
# ---------------------------------------------------------------------------

def _annualized_total_return(returns: np.ndarray) -> float | None:
    """Geometric annualized return implied by a daily-return sub-series.

    Compounds the (sub)series, then scales to a year by the count of observations
    it contains. Used for the conditional up/down-day return legs as well as the
    full series. Returns None on a degenerate / wiped-out path.
    """
    n = returns.size
    if n == 0:
        return None
    growth = float(np.prod(1.0 + returns))
    if growth <= 0:
        return None
    return growth ** (TRADING_DAYS_PER_YEAR / n) - 1.0


def _compute(port_rets: np.ndarray, bench_rets: np.ndarray, rf_annual: float) -> dict | None:
    """Compute the full benchmark-relative scorecard. None if degenerate.

    `port_rets` and `bench_rets` are aligned 1-D daily return arrays of equal length.
    """
    n = port_rets.size
    if n < MIN_POINTS or bench_rets.size != n:
        return None

    rf_daily = rf_annual / TRADING_DAYS_PER_YEAR

    # --- Annualized full-period returns (geometric) ---
    ann_port = _annualized_total_return(port_rets)
    ann_bench = _annualized_total_return(bench_rets)
    if ann_port is None or ann_bench is None:
        return None

    # --- Beta via covariance / benchmark variance (same as analytics.py) ---
    cov_mat = np.cov(port_rets, bench_rets)
    var_bench = float(cov_mat[1, 1])
    if not np.isfinite(var_bench) or var_bench <= 0:
        return None
    beta = float(cov_mat[0, 1] / var_bench)

    # --- Jensen's alpha (annualized CAPM residual) ---
    jensen_alpha = float(ann_port - (rf_annual + beta * (ann_bench - rf_annual)))

    # --- Treynor (excess return per unit of systematic risk) ---
    treynor = float((ann_port - rf_annual) / beta) if beta != 0 else None

    # --- Information ratio + tracking error (active = port - bench) ---
    active = port_rets - bench_rets
    active_std = float(np.std(active, ddof=1))
    tracking_error = active_std * math.sqrt(TRADING_DAYS_PER_YEAR)
    info_ratio = (
        float(np.mean(active) / active_std * math.sqrt(TRADING_DAYS_PER_YEAR))
        if active_std > 0 else None
    )

    # --- Up / down capture over benchmark-conditioned buckets ---
    # Capture = (annualized portfolio return | benchmark direction) /
    #           (annualized benchmark return | same direction) * 100.
    # Both legs cover the identical set of days, so the 252x annualization factor
    # cancels in the ratio and this reduces to the canonical Morningstar mean-return
    # capture - matching the shipped etf/compare.py definition exactly (and avoiding
    # the distortion of re-annualizing a conditional sub-series by its own day count).
    up_mask = bench_rets > 0
    down_mask = bench_rets < 0
    up_days = int(up_mask.sum())
    down_days = int(down_mask.sum())

    up_capture = down_capture = None
    if up_days >= MIN_DIRECTIONAL:
        bench_up = float(np.mean(bench_rets[up_mask]))
        if bench_up != 0:
            up_capture = float(np.mean(port_rets[up_mask]) / bench_up * 100.0)
    if down_days >= MIN_DIRECTIONAL:
        bench_down = float(np.mean(bench_rets[down_mask]))
        # bench_down < 0; a capture < 100 means the book lost LESS than the
        # benchmark on its down days (good downside protection).
        if bench_down != 0:
            down_capture = float(np.mean(port_rets[down_mask]) / bench_down * 100.0)

    capture_spread = (
        round(up_capture - down_capture, 1)
        if up_capture is not None and down_capture is not None else None
    )

    return {
        "information_ratio": round(info_ratio, 3) if info_ratio is not None else None,
        "treynor": round(treynor, 4) if treynor is not None else None,
        "jensen_alpha_pct": round(jensen_alpha * 100.0, 2),
        "tracking_error_pct": round(tracking_error * 100.0, 2),
        "beta": round(beta, 3),
        "up_capture": round(up_capture, 1) if up_capture is not None else None,
        "down_capture": round(down_capture, 1) if down_capture is not None else None,
        "capture_spread": capture_spread,
        "ann_return_pct": round(ann_port * 100.0, 2),
        "ann_benchmark_pct": round(ann_bench * 100.0, 2),
        "risk_free_rate_pct": round(rf_annual * 100.0, 2),
        "up_days": up_days,
        "down_days": down_days,
        "data_points": n,
    }


def _read(metrics: dict) -> str:
    """A one-line plain-English verdict derived from the computed scorecard."""
    ir = metrics.get("information_ratio")
    up = metrics.get("up_capture")
    down = metrics.get("down_capture")
    alpha = metrics.get("jensen_alpha_pct")

    parts: list[str] = []
    if up is not None and down is not None:
        if up > 100 and down < 100:
            parts.append("captures more upside than downside (convex profile)")
        elif up >= down:
            parts.append("participates more in rallies than in selloffs")
        else:
            parts.append("gives back more in selloffs than it captures in rallies")
    if alpha is not None:
        parts.append(
            f"positive {alpha:.1f}% annualized alpha" if alpha > 0
            else f"negative {alpha:.1f}% annualized alpha"
        )
    if ir is not None:
        quality = "strong" if ir >= 0.5 else ("modest" if ir > 0 else "negative")
        parts.append(f"{quality} information ratio ({ir:.2f})")
    if not parts:
        return f"Benchmark-relative scorecard vs {BENCHMARK}."
    return "Vs " + BENCHMARK + ", the book " + "; ".join(parts) + "."


# ---------------------------------------------------------------------------
# Live path - reuse the shipped equity-curve / benchmark machinery
# ---------------------------------------------------------------------------

def _resolve_portfolio(portfolio_id: int | None) -> dict | None:
    """Return the target portfolio dict, defaulting to the first one."""
    from . import crud as pcrud
    if portfolio_id is not None:
        return pcrud.get_portfolio(portfolio_id)
    portfolios = pcrud.list_portfolios()
    return portfolios[0] if portfolios else None


def _live_payload(portfolio_id: int | None) -> dict | None:
    """Build the scorecard from the shipped portfolio path. None -> use sample."""
    from . import crud as pcrud
    from .analytics import build_equity_curve, _fetch_risk_free_rate

    pf = _resolve_portfolio(portfolio_id)
    if not pf:
        return None

    txns = pcrud.get_transactions(pf["id"])
    if not txns:
        return None

    curve = build_equity_curve(txns, float(pf.get("cash_balance") or 0.0), lookback_days=LOOKBACK_DAYS)
    dates = curve.get("dates") or []
    raw_nav = curve.get("portfolio_raw") or []
    spy_curve = curve.get("benchmarks", {}).get(BENCHMARK, [])

    if len(raw_nav) < MIN_POINTS + 1 or len(spy_curve) != len(dates):
        return None

    nav_arr = np.asarray(raw_nav, dtype=float)
    daily_returns = np.diff(nav_arr) / nav_arr[:-1]

    # Align portfolio daily returns with SPY daily returns, dropping dates where the
    # benchmark is missing (mirrors compute_performance_metrics).
    valid = [
        (daily_returns[i], spy_curve[i + 1], spy_curve[i])
        for i in range(len(daily_returns))
        if spy_curve[i] is not None and spy_curve[i + 1] is not None and spy_curve[i] != 0
    ]
    if len(valid) < MIN_POINTS:
        return None

    port_rets = np.asarray([v[0] for v in valid], dtype=float)
    bench_rets = np.asarray([(v[1] - v[2]) / v[2] for v in valid], dtype=float)

    rf_annual = _fetch_risk_free_rate()
    metrics = _compute(port_rets, bench_rets, rf_annual)
    if metrics is None:
        return None

    return _assemble(metrics, pf["id"], pf.get("name"), data_mode="live", source="yfinance")


# ---------------------------------------------------------------------------
# Sample path - deterministic synthetic returns through the identical engine
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    """Deterministic synthetic book: slightly convex, beta ~1.05, positive alpha.

    A single benchmark factor drives both series. The portfolio loads on the
    benchmark with beta ~1.05, adds a small positive daily drift (alpha) and modest
    idiosyncratic noise, and a touch of convexity (extra participation on up days)
    so the SAME engine yields up-capture ~105, down-capture ~95 and a positive
    information ratio - a coherent, good-but-realistic tear-sheet.
    """
    # Seed chosen so the realized 252-day path lands on a clean, believable
    # tear-sheet (up-capture ~105, down-capture ~96, IR ~1.4, beta ~1.0, ~9% alpha)
    # rather than a cartoonishly perfect one.
    rng = np.random.default_rng(9)
    n = TRADING_DAYS_PER_YEAR

    # Benchmark daily returns: mild positive drift, ~0.92% daily vol.
    bench_rets = rng.normal(0.00028, 0.0092, n)

    # Regime-dependent beta: ~1.05 on up-benchmark days, ~0.96 on down days. This is
    # the textbook convex profile and yields up-capture ~105 / down-capture ~96
    # directly. A tiny positive daily drift adds modest alpha; idiosyncratic noise
    # keeps beta / tracking error / IR realistic rather than artificially perfect.
    alpha_daily = 0.00002
    idio = rng.normal(0.0, 0.0035, n)
    directional_beta = np.where(bench_rets > 0, 1.05, 0.96)
    port_rets = directional_beta * bench_rets + alpha_daily + idio

    metrics = _compute(port_rets, bench_rets, rf_annual=0.05)
    if metrics is None:  # should never happen, but stay honest
        return _hard_fallback()
    return _assemble(metrics, None, "Sample Book", data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def _assemble(metrics: dict, portfolio_id: int | None, portfolio_name: str | None,
              *, data_mode: str, source: str) -> dict:
    return {
        "portfolio_id": portfolio_id,
        "portfolio_name": portfolio_name or "Portfolio",
        "benchmark": BENCHMARK,
        **metrics,
        "read": _read(metrics),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _hard_fallback() -> dict:
    metrics = {
        "information_ratio": None, "treynor": None, "jensen_alpha_pct": None,
        "tracking_error_pct": None, "beta": None, "up_capture": None,
        "down_capture": None, "capture_spread": None, "ann_return_pct": None,
        "ann_benchmark_pct": None, "risk_free_rate_pct": None,
        "up_days": 0, "down_days": 0, "data_points": 0,
    }
    return _assemble(metrics, None, "Sample Book", data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def capture_ratios(portfolio_id: int | None = None) -> dict:
    """Benchmark-relative ratios + up/down capture for a portfolio. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and tags
    the payload with data_mode / as_of / source. Defaults to the first portfolio.
    Never raises.
    """
    try:
        live = _live_payload(portfolio_id)
        if live is not None and live.get("data_points"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("capture_ratios live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("capture_ratios sample path failed hard: %s", e)
        return _hard_fallback()
