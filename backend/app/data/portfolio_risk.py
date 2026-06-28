"""Portfolio Risk / VaR & Stress engine (Bloomberg PORT risk tab equivalent).

Given a book of holdings (symbols + weights), this module pulls ~252 daily
closes per holding, builds the weighted portfolio daily-return series with
numpy, and derives a full institutional risk profile:

  - annualized volatility, beta vs SPY, Sharpe, max drawdown
  - 1-day and 10-day Value-at-Risk at 95% and 99% via BOTH the historical
    (empirical percentile) and parametric (Gaussian) methods - both reported
  - Expected Shortfall / CVaR at 95% (mean loss beyond the 95% VaR)
  - named historical-style STRESS SCENARIOS (2008 GFC, COVID crash, 2022 rate
    shock, +100bp rates, +20% oil, +5% USD) estimated from each holding's beta
    and asset-class sensitivities
  - per-holding RISK CONTRIBUTION (each name's share of total portfolio
    variance / component VaR)
  - a histogram of daily returns for charting the loss distribution

Live path: prices via app.data.macro_data.fetch_arbitrary_ticker. When any
symbol is missing or too short, the whole book degrades to a deterministic
SAMPLE return series (seeded off the joined symbols via hashlib.md5, using
realistic per-asset vols + a market factor so correlations are plausible) and
tags data_mode="sample". This module never raises - it always returns a
populated payload tagged with data_mode / as_of / source for honesty under the
hood. VaR / ES are reported as POSITIVE percent loss numbers.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

import numpy as np

from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

TRADING_DAYS = 252
LOOKBACK_DAYS = 252
MIN_POINTS = 60
RISK_FREE = 0.045  # annualized risk-free rate for Sharpe
BENCHMARK = "SPY"

# A representative diversified book used as the default request.
DEFAULT_SYMBOLS = ["SPY", "QQQ", "TLT", "GLD", "IWM", "EFA", "VNQ"]
DEFAULT_WEIGHTS = [35.0, 15.0, 15.0, 10.0, 10.0, 10.0, 5.0]


# ---------------------------------------------------------------------------
# SAMPLE asset profiles. Annualized vols + class + beta vs SPY + scenario
# sensitivities, so the engine produces realistic, differentiated risk when
# live data is unavailable. ann_return / ann_vol are decimal fractions.
# ---------------------------------------------------------------------------

SAMPLE_ASSET_PROFILE: dict[str, dict] = {
    "SPY": {"ann_return": 0.105, "ann_vol": 0.150, "beta": 1.00, "cls": "us_equity"},
    "VOO": {"ann_return": 0.106, "ann_vol": 0.150, "beta": 1.00, "cls": "us_equity"},
    "IVV": {"ann_return": 0.106, "ann_vol": 0.150, "beta": 1.00, "cls": "us_equity"},
    "VTI": {"ann_return": 0.103, "ann_vol": 0.155, "beta": 1.02, "cls": "us_equity"},
    "QQQ": {"ann_return": 0.150, "ann_vol": 0.205, "beta": 1.17, "cls": "growth"},
    "XLK": {"ann_return": 0.165, "ann_vol": 0.220, "beta": 1.20, "cls": "growth"},
    "VUG": {"ann_return": 0.140, "ann_vol": 0.195, "beta": 1.12, "cls": "growth"},
    "IWM": {"ann_return": 0.082, "ann_vol": 0.215, "beta": 1.18, "cls": "small_cap"},
    "IJR": {"ann_return": 0.082, "ann_vol": 0.205, "beta": 1.15, "cls": "small_cap"},
    "EFA": {"ann_return": 0.072, "ann_vol": 0.165, "beta": 0.88, "cls": "intl_equity"},
    "VEA": {"ann_return": 0.071, "ann_vol": 0.160, "beta": 0.86, "cls": "intl_equity"},
    "EEM": {"ann_return": 0.060, "ann_vol": 0.200, "beta": 0.95, "cls": "em_equity"},
    "VNQ": {"ann_return": 0.078, "ann_vol": 0.190, "beta": 0.85, "cls": "reit"},
    "TLT": {"ann_return": 0.030, "ann_vol": 0.155, "beta": -0.25, "cls": "long_bond"},
    "IEF": {"ann_return": 0.028, "ann_vol": 0.075, "beta": -0.12, "cls": "mid_bond"},
    "AGG": {"ann_return": 0.035, "ann_vol": 0.060, "beta": -0.05, "cls": "agg_bond"},
    "LQD": {"ann_return": 0.045, "ann_vol": 0.085, "beta": 0.15, "cls": "credit"},
    "HYG": {"ann_return": 0.058, "ann_vol": 0.105, "beta": 0.55, "cls": "high_yield"},
    "GLD": {"ann_return": 0.090, "ann_vol": 0.135, "beta": 0.10, "cls": "gold"},
    "SLV": {"ann_return": 0.075, "ann_vol": 0.260, "beta": 0.22, "cls": "silver"},
    "DBC": {"ann_return": 0.055, "ann_vol": 0.170, "beta": 0.30, "cls": "commodity"},
    "USO": {"ann_return": 0.040, "ann_vol": 0.330, "beta": 0.35, "cls": "oil"},
    "SCHD": {"ann_return": 0.080, "ann_vol": 0.140, "beta": 0.82, "cls": "us_equity"},
    "XLE": {"ann_return": 0.070, "ann_vol": 0.260, "beta": 0.85, "cls": "energy"},
    "XLF": {"ann_return": 0.105, "ann_vol": 0.180, "beta": 1.05, "cls": "us_equity"},
}

# Pairwise correlation by asset class. Symmetric lookups; default 0.30.
_CLASS_CORR: dict[tuple[str, str], float] = {
    ("us_equity", "us_equity"): 0.97,
    ("us_equity", "growth"): 0.92,
    ("us_equity", "small_cap"): 0.85,
    ("us_equity", "intl_equity"): 0.78,
    ("us_equity", "em_equity"): 0.70,
    ("us_equity", "reit"): 0.62,
    ("us_equity", "energy"): 0.58,
    ("us_equity", "long_bond"): -0.30,
    ("us_equity", "mid_bond"): -0.15,
    ("us_equity", "credit"): 0.30,
    ("us_equity", "high_yield"): 0.68,
    ("us_equity", "agg_bond"): -0.05,
    ("us_equity", "gold"): 0.08,
    ("us_equity", "silver"): 0.22,
    ("us_equity", "commodity"): 0.30,
    ("us_equity", "oil"): 0.35,
    ("growth", "growth"): 0.96,
    ("growth", "small_cap"): 0.80,
    ("growth", "intl_equity"): 0.72,
    ("growth", "long_bond"): -0.28,
    ("growth", "gold"): 0.10,
    ("growth", "reit"): 0.55,
    ("small_cap", "small_cap"): 0.96,
    ("small_cap", "intl_equity"): 0.70,
    ("small_cap", "high_yield"): 0.65,
    ("small_cap", "long_bond"): -0.22,
    ("intl_equity", "intl_equity"): 0.95,
    ("intl_equity", "em_equity"): 0.80,
    ("intl_equity", "long_bond"): -0.18,
    ("em_equity", "em_equity"): 0.95,
    ("em_equity", "commodity"): 0.45,
    ("reit", "reit"): 0.95,
    ("reit", "long_bond"): 0.18,
    ("reit", "credit"): 0.42,
    ("energy", "energy"): 0.94,
    ("energy", "oil"): 0.70,
    ("energy", "commodity"): 0.60,
    ("long_bond", "long_bond"): 0.98,
    ("long_bond", "mid_bond"): 0.88,
    ("long_bond", "agg_bond"): 0.90,
    ("long_bond", "credit"): 0.70,
    ("long_bond", "gold"): 0.30,
    ("long_bond", "high_yield"): 0.10,
    ("mid_bond", "mid_bond"): 0.97,
    ("mid_bond", "agg_bond"): 0.92,
    ("mid_bond", "credit"): 0.75,
    ("credit", "credit"): 0.96,
    ("credit", "agg_bond"): 0.85,
    ("credit", "high_yield"): 0.60,
    ("high_yield", "high_yield"): 0.95,
    ("agg_bond", "agg_bond"): 0.98,
    ("gold", "gold"): 0.97,
    ("gold", "silver"): 0.78,
    ("gold", "commodity"): 0.45,
    ("silver", "silver"): 0.96,
    ("silver", "commodity"): 0.50,
    ("commodity", "commodity"): 0.95,
    ("commodity", "oil"): 0.72,
    ("oil", "oil"): 0.96,
}

# ---------------------------------------------------------------------------
# Stress scenarios. Each scenario maps an asset class to a shock (decimal
# return). Equity-like classes are additionally scaled by the holding's beta
# (equity_beta_shock) so a high-beta book takes proportionally more pain.
# ---------------------------------------------------------------------------

STRESS_SCENARIOS: list[dict] = [
    {
        "scenario": "2008 GFC",
        "description": "Global financial crisis - Sep 2008 to Mar 2009 equity collapse, credit seizure, flight to Treasuries.",
        "equity_beta_shock": -0.50,
        "class_shock": {
            "long_bond": 0.22, "mid_bond": 0.10, "agg_bond": 0.06, "credit": -0.08,
            "high_yield": -0.32, "gold": 0.04, "silver": -0.20, "reit": -0.62,
            "commodity": -0.35, "oil": -0.55, "energy": -0.48,
        },
    },
    {
        "scenario": "COVID Crash Mar-2020",
        "description": "Pandemic shock - fastest 30% equity drawdown on record, oil negative, gold and Treasuries bid.",
        "equity_beta_shock": -0.34,
        "class_shock": {
            "long_bond": 0.14, "mid_bond": 0.06, "agg_bond": 0.03, "credit": -0.06,
            "high_yield": -0.20, "gold": 0.03, "silver": -0.18, "reit": -0.40,
            "commodity": -0.30, "oil": -0.55, "energy": -0.45,
        },
    },
    {
        "scenario": "2022 Rate Shock",
        "description": "Fed hiking cycle - bonds and stocks fall together, long duration punished, growth de-rates hardest.",
        "equity_beta_shock": -0.20,
        "class_shock": {
            "long_bond": -0.31, "mid_bond": -0.12, "agg_bond": -0.13, "credit": -0.16,
            "high_yield": -0.11, "gold": -0.01, "silver": -0.03, "reit": -0.26,
            "commodity": 0.16, "oil": 0.20, "energy": 0.45,
        },
    },
    {
        "scenario": "Rates +100bp",
        "description": "Parallel +100bp shift in the curve - duration-driven mark-to-market loss on bonds, mild equity drag.",
        "equity_beta_shock": -0.03,
        "class_shock": {
            "long_bond": -0.17, "mid_bond": -0.075, "agg_bond": -0.06, "credit": -0.075,
            "high_yield": -0.04, "gold": -0.02, "silver": -0.02, "reit": -0.05,
            "commodity": 0.01, "oil": 0.01, "energy": 0.02,
        },
    },
    {
        "scenario": "Oil +20%",
        "description": "Crude spikes 20% - energy and commodities rally, broad equities and rate-sensitive assets soften.",
        "equity_beta_shock": -0.015,
        "class_shock": {
            "long_bond": -0.02, "mid_bond": -0.01, "agg_bond": -0.005, "credit": -0.01,
            "high_yield": -0.01, "gold": 0.03, "silver": 0.04, "reit": -0.01,
            "commodity": 0.12, "oil": 0.20, "energy": 0.13,
        },
    },
    {
        "scenario": "USD +5%",
        "description": "Dollar strengthens 5% - international and EM equities, gold and commodities pressured; US large-cap resilient.",
        "equity_beta_shock": -0.01,
        "class_shock": {
            "intl_equity": -0.05, "em_equity": -0.07, "gold": -0.05, "silver": -0.07,
            "commodity": -0.06, "oil": -0.05, "long_bond": 0.01, "energy": -0.04,
        },
    },
]


# ---------------------------------------------------------------------------
# Helpers: parse, profile, deterministic seed
# ---------------------------------------------------------------------------

def _parse_csv(s: str | None) -> list[str]:
    if not s:
        return []
    return [tok.strip() for tok in s.split(",") if tok and tok.strip()]


def _parse_weights(s: str | None) -> list[float]:
    out: list[float] = []
    for tok in _parse_csv(s):
        try:
            out.append(float(tok))
        except (TypeError, ValueError):
            out.append(0.0)
    return out


def _seed_int(symbols: list[str]) -> int:
    return int(hashlib.md5(",".join(symbols).encode()).hexdigest()[:8], 16)


def _profile(symbol: str) -> dict:
    base = SAMPLE_ASSET_PROFILE.get(symbol.upper())
    if base is not None:
        return base
    # Deterministic synthetic profile for unknown tickers.
    h = int(hashlib.md5(symbol.upper().encode()).hexdigest()[:8], 16)
    vol = 0.14 + (h % 220) / 1000.0          # 0.14 .. 0.36
    ret = 0.03 + ((h >> 8) % 130) / 1000.0   # 0.03 .. 0.16
    beta = 0.6 + ((h >> 16) % 90) / 100.0    # 0.60 .. 1.50
    return {"ann_return": round(ret, 4), "ann_vol": round(vol, 4), "beta": round(beta, 3), "cls": "us_equity"}


def _class_corr(a: str, b: str) -> float:
    if a == b:
        return 1.0
    return _CLASS_CORR.get((a, b)) or _CLASS_CORR.get((b, a)) or 0.30


def _normalize_book(symbols: list[str], weights: list[float]) -> tuple[list[str], np.ndarray]:
    """De-dupe symbols (summing weights of dupes), drop non-positive, normalize
    to sum 1. Falls back to the default diversified book when empty."""
    if not symbols:
        symbols, weights = list(DEFAULT_SYMBOLS), list(DEFAULT_WEIGHTS)
    if not weights or all(w == 0 for w in weights):
        weights = [1.0] * len(symbols)
    if len(weights) < len(symbols):
        weights = weights + [0.0] * (len(symbols) - len(weights))
    weights = weights[: len(symbols)]

    agg: dict[str, float] = {}
    for sym, w in zip(symbols, weights):
        u = sym.upper()
        agg[u] = agg.get(u, 0.0) + max(float(w), 0.0)
    syms = [s for s, w in agg.items() if w > 0]
    if not syms:
        syms = list(DEFAULT_SYMBOLS)
        agg = {s: w for s, w in zip(DEFAULT_SYMBOLS, DEFAULT_WEIGHTS)}
    w_arr = np.array([agg[s] for s in syms], dtype=float)
    total = float(w_arr.sum())
    w_arr = w_arr / total if total > 0 else np.full(len(syms), 1.0 / len(syms))
    return syms, w_arr


# ---------------------------------------------------------------------------
# Return-matrix construction (live + sample). Rows = assets, cols = days.
# ---------------------------------------------------------------------------

def _fetch_close_series(symbol: str) -> dict[str, float]:
    pts = fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS + 10)
    return {p["date"]: float(p["value"]) for p in (pts or []) if p.get("value") is not None}


def _live_returns(symbols: list[str]) -> tuple[np.ndarray, np.ndarray] | None:
    """Return (asset_returns [n_assets, n_days], spy_returns [n_days]) from real
    daily closes. Returns None if any symbol is missing / too short / the
    aligned window is inadequate. SPY is fetched alongside for beta."""
    fetch_set = list(dict.fromkeys([*symbols, BENCHMARK]))
    series: dict[str, dict[str, float]] = {}
    for s in fetch_set:
        m = _fetch_close_series(s)
        if len(m) < MIN_POINTS:
            return None
        series[s] = m

    common = sorted(set.intersection(*[set(series[s]) for s in fetch_set]))
    if len(common) < MIN_POINTS:
        return None
    if len(common) > LOOKBACK_DAYS:
        common = common[-LOOKBACK_DAYS:]

    price = np.array([[series[s][d] for d in common] for s in fetch_set], dtype=float)
    if not np.all(np.isfinite(price)) or np.any(price <= 0):
        return None
    rets = np.diff(price, axis=1) / price[:, :-1]
    if rets.shape[1] < MIN_POINTS - 1:
        return None

    idx = {s: i for i, s in enumerate(fetch_set)}
    asset_rets = np.array([rets[idx[s]] for s in symbols], dtype=float)
    spy_rets = rets[idx[BENCHMARK]]
    return asset_rets, spy_rets


def _sample_returns(symbols: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic per-asset daily-return matrix built off a shared market
    factor plus class-correlated + idiosyncratic noise, seeded from the basket.
    Returns (asset_returns [n_assets, n_days], spy_returns [n_days])."""
    n = len(symbols)
    profs = [_profile(s) for s in symbols]
    vols = np.array([p["ann_vol"] for p in profs], dtype=float)
    mus = np.array([p["ann_return"] for p in profs], dtype=float)
    betas = np.array([p["beta"] for p in profs], dtype=float)

    rng = np.random.default_rng(_seed_int(symbols))
    days = LOOKBACK_DAYS

    # Shared market (SPY) daily series.
    spy_vol_d = 0.150 / np.sqrt(TRADING_DAYS)
    spy_mu_d = 0.105 / TRADING_DAYS
    spy_rets = rng.normal(spy_mu_d, spy_vol_d, days)

    asset_rets = np.zeros((n, days), dtype=float)
    for i in range(n):
        vol_d = vols[i] / np.sqrt(TRADING_DAYS)
        mu_d = mus[i] / TRADING_DAYS
        beta = betas[i]
        # Variance left after the market component, floored so every name keeps
        # some idiosyncratic noise.
        sys_var = (beta * spy_vol_d) ** 2
        idio_var = max(vol_d ** 2 - sys_var, (0.02 / np.sqrt(TRADING_DAYS)) ** 2)
        idio = rng.normal(0.0, np.sqrt(idio_var), days)
        # Alpha so realized drift lands near the target return.
        alpha = mu_d - beta * float(np.mean(spy_rets))
        asset_rets[i] = alpha + beta * spy_rets + idio
    return asset_rets, spy_rets


# ---------------------------------------------------------------------------
# Risk metric computation
# ---------------------------------------------------------------------------

def _beta(port_rets: np.ndarray, spy_rets: np.ndarray) -> float:
    var_m = float(np.var(spy_rets, ddof=1))
    if var_m <= 0:
        return 1.0
    cov = float(np.cov(port_rets, spy_rets, ddof=1)[0, 1])
    return cov / var_m


def _max_drawdown(port_rets: np.ndarray) -> float:
    """Max drawdown (positive fraction) of the cumulative wealth curve."""
    wealth = np.cumprod(1.0 + port_rets)
    peak = np.maximum.accumulate(wealth)
    dd = (wealth - peak) / peak
    return float(-dd.min()) if dd.size else 0.0


def _histogram(port_rets: np.ndarray, buckets: int = 21) -> list[dict]:
    """Histogram of daily returns (percent) for charting the loss distribution."""
    pct = port_rets * 100.0
    lo, hi = float(pct.min()), float(pct.max())
    if hi - lo < 1e-9:
        lo, hi = lo - 1.0, hi + 1.0
    edges = np.linspace(lo, hi, buckets + 1)
    counts, _ = np.histogram(pct, bins=edges)
    out: list[dict] = []
    for i in range(buckets):
        center = (edges[i] + edges[i + 1]) / 2.0
        out.append({"bucket": round(float(center), 3), "count": int(counts[i])})
    return out


def _component_var(weights: np.ndarray, cov_daily: np.ndarray) -> np.ndarray:
    """Each asset's share (0..1) of total portfolio variance via marginal
    contribution: w_i * (Sigma w)_i / (w' Sigma w)."""
    port_var = float(weights @ cov_daily @ weights)
    if port_var <= 0:
        return weights / max(float(weights.sum()), 1e-12)
    contrib = weights * (cov_daily @ weights)
    shares = contrib / port_var
    return shares


def _stress_pnl(symbols: list[str], weights: np.ndarray) -> list[dict]:
    """Estimate portfolio P&L (%) under each named scenario from per-holding
    beta + asset-class shock. Sorted worst-first."""
    profs = [_profile(s) for s in symbols]
    out: list[dict] = []
    for sc in STRESS_SCENARIOS:
        beta_shock = float(sc["equity_beta_shock"])
        class_shock = sc["class_shock"]
        pnl = 0.0
        for w, prof in zip(weights, profs):
            cls = prof["cls"]
            shock = class_shock.get(cls)
            if shock is None:
                # Default: treat as a beta-driven equity-like exposure.
                shock = beta_shock * float(prof["beta"])
            else:
                # Equity-ish classes also pick up the beta-scaled market move.
                if cls in ("us_equity", "growth", "small_cap", "intl_equity", "em_equity"):
                    shock = shock + beta_shock * float(prof["beta"])
            pnl += float(w) * shock
        out.append({
            "scenario": sc["scenario"],
            "pnl_pct": round(pnl * 100.0, 2),
            "description": sc["description"],
        })
    out.sort(key=lambda r: r["pnl_pct"])
    return out


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def portfolio_risk(symbols: str | None = None, weights: str | None = None) -> dict:
    """Portfolio-level risk analytics (VaR / ES / stress / risk contribution).

    `symbols` and `weights` are optional comma-separated strings. Defaults to a
    representative diversified book. Never raises - degrades to deterministic
    SAMPLE data tagged with data_mode / as_of / source.
    """
    try:
        return _portfolio_risk(symbols, weights)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("portfolio_risk failed hard, returning sample: %s", e)
        try:
            return _build(list(DEFAULT_SYMBOLS),
                          np.array(DEFAULT_WEIGHTS) / sum(DEFAULT_WEIGHTS),
                          *_sample_returns(list(DEFAULT_SYMBOLS)),
                          data_mode="sample", source="sample")
        except Exception:
            return _empty_safe()


def _portfolio_risk(symbols: str | None, weights: str | None) -> dict:
    syms, w = _normalize_book(_parse_csv(symbols), _parse_weights(weights))

    live = None
    try:
        live = _live_returns(syms)
    except Exception as e:
        log.warning("portfolio_risk live fetch failed: %s", e)
        live = None

    if live is not None:
        asset_rets, spy_rets = live
        return _build(syms, w, asset_rets, spy_rets, data_mode="live", source="yfinance")

    asset_rets, spy_rets = _sample_returns(syms)
    return _build(syms, w, asset_rets, spy_rets, data_mode="sample", source="sample")


def _build(symbols: list[str], weights: np.ndarray, asset_rets: np.ndarray,
           spy_rets: np.ndarray, *, data_mode: str, source: str) -> dict:
    """Assemble the full risk payload from an asset-return matrix + weights."""
    weights = np.asarray(weights, dtype=float)
    port_rets = weights @ asset_rets  # [n_days]

    # --- core dispersion ---
    vol_daily = float(np.std(port_rets, ddof=1)) if port_rets.size > 1 else 0.0
    volatility = vol_daily * np.sqrt(TRADING_DAYS)
    mean_daily = float(np.mean(port_rets))
    beta = _beta(port_rets, spy_rets)
    sharpe = ((mean_daily * TRADING_DAYS - RISK_FREE) / volatility) if volatility > 0 else 0.0
    mdd = _max_drawdown(port_rets)

    # --- VaR: historical (empirical percentile) + parametric (Gaussian) ---
    # Reported as POSITIVE percent loss numbers.
    hist_var_95 = -float(np.percentile(port_rets, 5)) * 100.0
    hist_var_99 = -float(np.percentile(port_rets, 1)) * 100.0
    z95, z99 = 1.6448536269514722, 2.3263478740408408
    param_var_95 = -(mean_daily - z95 * vol_daily) * 100.0
    param_var_99 = -(mean_daily - z99 * vol_daily) * 100.0
    # 10-day scaling by sqrt(time) on the historical figures.
    sqrt10 = np.sqrt(10.0)
    var_95_10d = max(hist_var_95 * sqrt10, 0.0)
    var_99_10d = max(hist_var_99 * sqrt10, 0.0)

    # --- Expected Shortfall (CVaR) at 95%: mean of losses beyond the 95% VaR ---
    thresh = np.percentile(port_rets, 5)
    tail = port_rets[port_rets <= thresh]
    es_95 = -float(np.mean(tail)) * 100.0 if tail.size else hist_var_95

    # --- risk contribution (share of total variance) ---
    cov_daily = np.cov(asset_rets, ddof=1) if asset_rets.shape[0] > 1 else np.array([[float(np.var(asset_rets[0], ddof=1))]])
    cov_daily = np.atleast_2d(cov_daily)
    shares = _component_var(weights, cov_daily)
    risk_contributions = [
        {"symbol": s, "pct": round(float(max(sh, 0.0)) * 100.0, 2)}
        for s, sh in zip(symbols, shares)
    ]

    holdings = [{"symbol": s, "weight": round(float(w), 4)} for s, w in zip(symbols, weights)]

    return {
        "holdings": holdings,
        "volatility": round(volatility * 100.0, 2),
        "beta": round(beta, 3),
        "var_95_1d": round(max(hist_var_95, 0.0), 2),
        "var_99_1d": round(max(hist_var_99, 0.0), 2),
        "var_95_10d": round(var_95_10d, 2),
        "var_99_10d": round(var_99_10d, 2),
        "var_95_parametric": round(max(param_var_95, 0.0), 2),
        "var_99_parametric": round(max(param_var_99, 0.0), 2),
        "expected_shortfall_95": round(max(es_95, 0.0), 2),
        "max_drawdown": round(mdd * 100.0, 2),
        "sharpe": round(sharpe, 3),
        "stress_scenarios": _stress_pnl(symbols, weights),
        "risk_contributions": risk_contributions,
        "return_distribution": _histogram(port_rets),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_safe() -> dict:
    """Last-resort populated payload if even sample synthesis fails."""
    syms, w = _normalize_book(list(DEFAULT_SYMBOLS), list(DEFAULT_WEIGHTS))
    holdings = [{"symbol": s, "weight": round(float(x), 4)} for s, x in zip(syms, w)]
    return {
        "holdings": holdings,
        "volatility": 11.5, "beta": 0.78,
        "var_95_1d": 1.18, "var_99_1d": 1.67, "var_95_10d": 3.73, "var_99_10d": 5.28,
        "var_95_parametric": 1.16, "var_99_parametric": 1.65, "expected_shortfall_95": 1.49,
        "max_drawdown": 14.2, "sharpe": 0.61,
        "stress_scenarios": _stress_pnl(syms, w),
        "risk_contributions": [{"symbol": s, "pct": round(float(x) * 100, 2)} for s, x in zip(syms, w)],
        "return_distribution": [{"bucket": round(-2.5 + i * 0.25, 3), "count": 0} for i in range(21)],
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
