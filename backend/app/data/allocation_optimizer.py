"""Allocation Optimizer / Risk Parity engine (Bloomberg PORT equivalent).

Given a universe of tickers, this module pulls ~252 daily closes per symbol,
builds a daily-return matrix, an annualized mean-return vector and an annualized
covariance matrix, then computes four long-only weight schemes (all summing to
1): equal weight, minimum variance, maximum Sharpe (tangency), and risk parity.

For the SELECTED method it reports portfolio expected return / volatility /
Sharpe, the per-asset weights, and each asset's share of total portfolio
variance (risk contribution). It also returns a 4-method comparison table, the
asset correlation matrix, and a deterministic efficient frontier point cloud.

Live path: prices via app.data.macro_data.fetch_arbitrary_ticker. When any
symbol is missing or too short, the whole estimate degrades to a deterministic
SAMPLE covariance + return vector (seeded off the joined symbols via
hashlib.md5, using realistic per-asset vols/correlations) and tags
data_mode="sample". This module never raises - it always returns a populated
payload tagged with data_mode / as_of / source for honesty under the hood.
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
RISK_FREE = 0.045  # annualized risk-free rate for Sharpe / tangency

DEFAULT_UNIVERSE = ["SPY", "TLT", "GLD", "QQQ", "IWM", "EFA", "VNQ", "LQD"]

METHODS = ["equal_weight", "min_variance", "max_sharpe", "risk_parity"]
METHOD_LABELS = {
    "equal_weight": "Equal Weight",
    "min_variance": "Min Variance",
    "max_sharpe": "Max Sharpe",
    "risk_parity": "Risk Parity",
}


# ---------------------------------------------------------------------------
# SAMPLE asset profiles. Annualized vols + a plausible correlation block so the
# optimizer produces realistic, differentiated weights when live data is out.
# ann_return / ann_vol are decimal fractions.
# ---------------------------------------------------------------------------

SAMPLE_ASSET_PROFILE: dict[str, dict] = {
    "SPY": {"ann_return": 0.105, "ann_vol": 0.150, "cls": "us_equity"},
    "VOO": {"ann_return": 0.106, "ann_vol": 0.150, "cls": "us_equity"},
    "VTI": {"ann_return": 0.103, "ann_vol": 0.155, "cls": "us_equity"},
    "QQQ": {"ann_return": 0.150, "ann_vol": 0.205, "cls": "growth"},
    "IWM": {"ann_return": 0.082, "ann_vol": 0.215, "cls": "small_cap"},
    "EFA": {"ann_return": 0.072, "ann_vol": 0.165, "cls": "intl_equity"},
    "EEM": {"ann_return": 0.060, "ann_vol": 0.200, "cls": "em_equity"},
    "VNQ": {"ann_return": 0.078, "ann_vol": 0.190, "cls": "reit"},
    "TLT": {"ann_return": 0.030, "ann_vol": 0.155, "cls": "long_bond"},
    "IEF": {"ann_return": 0.028, "ann_vol": 0.075, "cls": "mid_bond"},
    "LQD": {"ann_return": 0.045, "ann_vol": 0.085, "cls": "credit"},
    "HYG": {"ann_return": 0.058, "ann_vol": 0.105, "cls": "high_yield"},
    "AGG": {"ann_return": 0.035, "ann_vol": 0.060, "cls": "agg_bond"},
    "GLD": {"ann_return": 0.090, "ann_vol": 0.135, "cls": "gold"},
    "SLV": {"ann_return": 0.075, "ann_vol": 0.260, "cls": "silver"},
    "DBC": {"ann_return": 0.055, "ann_vol": 0.170, "cls": "commodity"},
    "USO": {"ann_return": 0.040, "ann_vol": 0.330, "cls": "oil"},
    "VEA": {"ann_return": 0.071, "ann_vol": 0.160, "cls": "intl_equity"},
    "SCHD": {"ann_return": 0.080, "ann_vol": 0.140, "cls": "us_equity"},
    "XLK": {"ann_return": 0.165, "ann_vol": 0.220, "cls": "growth"},
}

# Pairwise correlation by asset class. Symmetric lookups; default 0.30.
_CLASS_CORR: dict[tuple[str, str], float] = {
    ("us_equity", "us_equity"): 0.97,
    ("us_equity", "growth"): 0.92,
    ("us_equity", "small_cap"): 0.85,
    ("us_equity", "intl_equity"): 0.78,
    ("us_equity", "em_equity"): 0.70,
    ("us_equity", "reit"): 0.62,
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


def _seed_int(symbols: list[str]) -> int:
    return int(hashlib.md5(",".join(symbols).encode()).hexdigest()[:8], 16)


def _profile(symbol: str, symbols: list[str]) -> dict:
    base = SAMPLE_ASSET_PROFILE.get(symbol)
    if base is not None:
        return base
    # Deterministic synthetic profile for unknown tickers.
    h = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)
    vol = 0.14 + (h % 220) / 1000.0           # 0.14 .. 0.36
    ret = 0.03 + ((h >> 8) % 130) / 1000.0    # 0.03 .. 0.16
    return {"ann_return": round(ret, 4), "ann_vol": round(vol, 4), "cls": "us_equity"}


def _class_corr(a: str, b: str) -> float:
    if a == b:
        return 1.0
    return _CLASS_CORR.get((a, b)) or _CLASS_CORR.get((b, a)) or 0.30


# ---------------------------------------------------------------------------
# Sample covariance + return construction (deterministic)
# ---------------------------------------------------------------------------

def _sample_inputs(symbols: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Return (annualized mean-return vector mu, annualized covariance Sigma)
    built deterministically from per-asset vols + class correlations, with a
    tiny seeded jitter so repeated identical baskets are stable but distinct
    baskets differ."""
    n = len(symbols)
    profs = [_profile(s, symbols) for s in symbols]
    vols = np.array([p["ann_vol"] for p in profs], dtype=float)
    mu = np.array([p["ann_return"] for p in profs], dtype=float)

    rng = np.random.default_rng(_seed_int(symbols))
    corr = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            base = _class_corr(profs[i]["cls"], profs[j]["cls"])
            jit = float(rng.uniform(-0.04, 0.04))
            c = float(np.clip(base + jit, -0.98, 0.98))
            corr[i, j] = corr[j, i] = c

    cov = corr * np.outer(vols, vols)
    cov = _nearest_psd(cov)
    return mu, cov


def _nearest_psd(cov: np.ndarray) -> np.ndarray:
    """Project a symmetric matrix to the nearest PSD matrix by clipping
    eigenvalues, then add a tiny ridge for numerical stability."""
    sym = (cov + cov.T) / 2.0
    vals, vecs = np.linalg.eigh(sym)
    vals = np.clip(vals, 1e-10, None)
    psd = (vecs * vals) @ vecs.T
    psd = (psd + psd.T) / 2.0
    ridge = 1e-8 * float(np.trace(psd)) / max(psd.shape[0], 1)
    return psd + ridge * np.eye(psd.shape[0])


# ---------------------------------------------------------------------------
# Live inputs
# ---------------------------------------------------------------------------

def _fetch_close_series(symbol: str) -> dict[str, float]:
    pts = fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS + 10)
    return {p["date"]: float(p["value"]) for p in (pts or []) if p.get("value") is not None}


def _live_inputs(symbols: list[str]) -> tuple[np.ndarray, np.ndarray] | None:
    """Annualized mu + covariance from real daily closes. Returns None if any
    symbol is missing / too short / the aligned window is inadequate."""
    series = {}
    for s in symbols:
        m = _fetch_close_series(s)
        if len(m) < MIN_POINTS:
            return None
        series[s] = m

    date_sets = [set(series[s]) for s in symbols]
    common = sorted(set.intersection(*date_sets))
    if len(common) < MIN_POINTS:
        return None
    if len(common) > LOOKBACK_DAYS:
        common = common[-LOOKBACK_DAYS:]

    price = np.array([[series[s][d] for d in common] for s in symbols], dtype=float)
    if not np.all(np.isfinite(price)) or np.any(price <= 0):
        return None

    rets = np.diff(price, axis=1) / price[:, :-1]  # (n_assets, n_days)
    if rets.shape[1] < MIN_POINTS - 1:
        return None

    mu = rets.mean(axis=1) * TRADING_DAYS
    cov = np.cov(rets, ddof=1) * TRADING_DAYS
    if cov.ndim == 0:  # single asset edge case
        cov = cov.reshape(1, 1)
    cov = _nearest_psd(cov)
    return mu, cov


# ---------------------------------------------------------------------------
# Weight schemes (numpy only, long-only, sum to 1)
# ---------------------------------------------------------------------------

def _normalize(w: np.ndarray) -> np.ndarray:
    w = np.clip(w, 0.0, None)
    s = float(w.sum())
    if s <= 0:
        return np.ones_like(w) / len(w)
    return w / s


def _w_equal(n: int) -> np.ndarray:
    return np.ones(n) / n


def _w_min_variance(cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    ones = np.ones(n)
    try:
        inv = np.linalg.pinv(cov)
        w = inv @ ones
    except Exception:
        return _w_equal(n)
    return _normalize(w)


def _w_max_sharpe(mu: np.ndarray, cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    excess = mu - RISK_FREE
    try:
        inv = np.linalg.pinv(cov)
        w = inv @ excess
    except Exception:
        return _w_equal(n)
    if np.all(w <= 0):
        # No positive-excess tilt survives; fall back to min-variance shape.
        return _w_min_variance(cov)
    return _normalize(w)


def _w_risk_parity(cov: np.ndarray, iters: int = 300) -> np.ndarray:
    """Long-only equal-risk-contribution weights via a simple multiplicative
    fixed-point iteration. Each asset's risk contribution converges to 1/n of
    total portfolio variance. No scipy required."""
    n = cov.shape[0]
    w = np.ones(n) / n
    target = 1.0 / n
    for _ in range(iters):
        mrc = cov @ w                      # marginal risk contribution
        port_var = float(w @ mrc)
        if port_var <= 0:
            break
        rc = w * mrc / port_var            # fractional risk contribution
        # Nudge each weight toward its target risk share; damp for stability.
        adj = np.where(rc > 1e-12, target / np.maximum(rc, 1e-12), 1.0)
        w = w * np.power(adj, 0.5)
        w = _normalize(w)
    return _normalize(w)


def _weights_for(method: str, mu: np.ndarray, cov: np.ndarray) -> np.ndarray:
    n = cov.shape[0]
    if method == "equal_weight":
        return _w_equal(n)
    if method == "min_variance":
        return _w_min_variance(cov)
    if method == "max_sharpe":
        return _w_max_sharpe(mu, cov)
    return _w_risk_parity(cov)


# ---------------------------------------------------------------------------
# Portfolio statistics
# ---------------------------------------------------------------------------

def _port_stats(w: np.ndarray, mu: np.ndarray, cov: np.ndarray) -> tuple[float, float, float]:
    exp_ret = float(w @ mu)
    var = float(w @ cov @ w)
    vol = float(np.sqrt(max(var, 0.0)))
    sharpe = (exp_ret - RISK_FREE) / vol if vol > 1e-9 else 0.0
    return exp_ret, vol, float(sharpe)


def _risk_contributions(w: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """Each asset's share (0..1) of total portfolio variance."""
    mrc = cov @ w
    contrib = w * mrc
    total = float(contrib.sum())
    if abs(total) < 1e-15:
        return np.ones_like(w) / len(w)
    return contrib / total


def _correlation_from_cov(cov: np.ndarray) -> np.ndarray:
    d = np.sqrt(np.clip(np.diag(cov), 1e-15, None))
    corr = cov / np.outer(d, d)
    return np.clip(corr, -1.0, 1.0)


def _efficient_frontier(mu: np.ndarray, cov: np.ndarray, symbols: list[str], n_pts: int = 25) -> list[dict]:
    """Deterministic random-portfolio cloud bracketing the frontier. Seeded so
    the scatter is stable across calls."""
    n = len(mu)
    rng = np.random.default_rng(_seed_int(symbols) ^ 0x5EED)
    pts: list[dict] = []

    # Anchor points: min-variance and max-sharpe portfolios.
    for w in (_w_min_variance(cov), _w_max_sharpe(mu, cov)):
        r, v, _ = _port_stats(w, mu, cov)
        pts.append({"volatility": round(v * 100, 3), "exp_return": round(r * 100, 3)})

    # Dirichlet-distributed long-only random portfolios fill the cloud.
    while len(pts) < n_pts:
        w = rng.dirichlet(np.ones(n) * 0.7)
        r, v, _ = _port_stats(w, mu, cov)
        pts.append({"volatility": round(v * 100, 3), "exp_return": round(r * 100, 3)})

    pts.sort(key=lambda p: p["volatility"])
    return pts[:n_pts]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def optimize(symbols: list[str] | str | None = None, method: str = "risk_parity") -> dict:
    """Optimize allocation across a universe. Never raises - degrades to
    deterministic SAMPLE inputs and tags the payload with data_mode / as_of /
    source. See module docstring for the full contract."""
    try:
        return _optimize(symbols, method)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("optimize failed hard, returning sample: %s", e)
        try:
            uni = _clean_symbols(symbols)
            return _build(uni, _norm_method(method), *_sample_inputs(uni),
                          data_mode="sample", source="sample")
        except Exception:
            uni = DEFAULT_UNIVERSE
            return _build(uni, "risk_parity", *_sample_inputs(uni),
                          data_mode="sample", source="sample")


def _clean_symbols(symbols: list[str] | str | None) -> list[str]:
    if symbols is None:
        return list(DEFAULT_UNIVERSE)
    if isinstance(symbols, str):
        raw = symbols.split(",")
    else:
        raw = list(symbols)
    out = [s.strip().upper() for s in raw if s and s.strip()]
    out = list(dict.fromkeys(out))  # de-dupe, keep order
    if not out:
        return list(DEFAULT_UNIVERSE)
    return out[:24]  # sane upper bound


def _norm_method(method: str) -> str:
    m = (method or "risk_parity").strip().lower().replace("-", "_").replace(" ", "_")
    return m if m in METHODS else "risk_parity"


def _optimize(symbols: list[str] | str | None, method: str) -> dict:
    universe = _clean_symbols(symbols)
    method = _norm_method(method)

    inputs = None
    if len(universe) >= 2:
        try:
            inputs = _live_inputs(universe)
        except Exception as e:
            log.warning("live inputs failed for %s: %s", universe, e)
            inputs = None

    if inputs is not None:
        mu, cov = inputs
        return _build(universe, method, mu, cov, data_mode="live", source="yfinance")

    mu, cov = _sample_inputs(universe)
    return _build(universe, method, mu, cov, data_mode="sample", source="sample")


def _build(symbols: list[str], method: str, mu: np.ndarray, cov: np.ndarray,
           *, data_mode: str, source: str) -> dict:
    n = len(symbols)

    # All-methods comparison table.
    all_methods = []
    weights_by_method: dict[str, np.ndarray] = {}
    for m in METHODS:
        w = _weights_for(m, mu, cov)
        weights_by_method[m] = w
        r, v, s = _port_stats(w, mu, cov)
        all_methods.append({
            "method": m,
            "label": METHOD_LABELS[m],
            "exp_return": round(r * 100, 3),
            "volatility": round(v * 100, 3),
            "sharpe": round(s, 3),
        })

    w = weights_by_method[method]
    exp_ret, vol, sharpe = _port_stats(w, mu, cov)
    rc = _risk_contributions(w, cov)

    weights = [
        {"symbol": symbols[i], "weight": round(float(w[i]), 6)}
        for i in range(n)
    ]
    risk_contributions = [
        {"symbol": symbols[i], "pct": round(float(rc[i]) * 100, 3)}
        for i in range(n)
    ]

    corr = _correlation_from_cov(cov)
    correlation_matrix = {
        "symbols": symbols,
        "matrix": [[round(float(corr[i][j]), 3) for j in range(n)] for i in range(n)],
    }

    return {
        "universe": symbols,
        "method": method,
        "method_label": METHOD_LABELS[method],
        "weights": weights,
        "exp_return": round(exp_ret * 100, 3),
        "volatility": round(vol * 100, 3),
        "sharpe": round(sharpe, 3),
        "risk_free": round(RISK_FREE * 100, 3),
        "risk_contributions": risk_contributions,
        "all_methods": all_methods,
        "correlation_matrix": correlation_matrix,
        "efficient_frontier": _efficient_frontier(mu, cov, symbols),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
