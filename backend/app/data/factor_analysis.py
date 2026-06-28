"""Factor / style analysis engine (Bloomberg FA / style-box analog).

Given a symbol, runs a multi-factor regression of the symbol's excess daily
returns on a basket of factor-proxy ETFs and derives a style-box position:

  market    SPY    (broad beta)
  momentum  MTUM   (iShares MSCI USA Momentum Factor)
  value     VLUE   (iShares MSCI USA Value Factor)
  quality   QUAL   (iShares MSCI USA Quality Factor)
  size      SIZE   (iShares MSCI USA Size Factor - small-cap tilt)
  low vol   USMV   (iShares MSCI USA Min Vol Factor)

The regression is the same lstsq factor-OLS pattern used in portfolio/risk.py:

  r_symbol - rf = alpha + sum_k beta_k * r_factor_k + eps

solved via numpy.linalg.lstsq on an intercept-augmented design matrix. The
intercept is the (annualized) alpha; the slopes are the factor betas; R2 is
1 - ss_res / ss_tot.

Factor performance is each proxy's total return over the window. The style box
maps the symbol onto two axes in [-1, 1]:

  x : value (-1) <-> growth (+1)   from a VLUE / IWF univariate beta tilt
  y : small (-1) <-> large (+1)    from a SPY vs SIZE univariate beta tilt

Live path: daily prices via app.data.macro_data.fetch_arbitrary_ticker. When
the live source returns too little data we degrade to a deterministic Geometric
Brownian Motion (GBM) walk seeded off each ticker (hashlib) so the panel is
always fully populated and screenshots are stable.

This module never raises - it always returns a populated payload tagged with
data_mode / as_of / source for honesty under the hood.
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
FACTOR_TTL = 60 * 60 * 6  # 6 hours - factor loadings move slowly
MIN_OVERLAP = 40          # min aligned return observations for a usable regression
RF_ANNUAL = 0.04          # risk-free proxy for the "excess return" definition

# (proxy ETF, human-readable factor name). Order is the regression column order.
FACTORS: list[tuple[str, str]] = [
    ("SPY", "Market"),
    ("MTUM", "Momentum"),
    ("VLUE", "Value"),
    ("QUAL", "Quality"),
    ("SIZE", "Size"),
    ("USMV", "Low Vol"),
]
FACTOR_SYMBOLS = [f[0] for f in FACTORS]
GROWTH_PROXY = "IWF"  # iShares Russell 1000 Growth - style-box growth anchor

# Sample GBM drift/vol profile (annualized). A small per-symbol tilt is layered
# on top so different tickers do not all share an identical-looking series.
SAMPLE_ANN_RETURN = 0.09
SAMPLE_ANN_VOL = 0.17


# ---------------------------------------------------------------------------
# Deterministic sample-price synthesis (GBM seeded off the symbol)
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
    """Deterministic GBM price path as a list of {date, value} points.

    A bounded per-symbol drift/vol tilt keeps each ticker's path distinct while
    staying realistic. Seeded off the symbol so output is reproducible.
    """
    n_pts = max(days, MIN_OVERLAP + 5)
    dates = _sample_dates(n_pts)
    rng = np.random.default_rng(_seed(symbol))

    h = hashlib.md5(symbol.encode()).hexdigest()
    tilt_ret = (int(h[8:12], 16) / 0xFFFF - 0.5) * 2.0
    tilt_vol = (int(h[12:16], 16) / 0xFFFF - 0.5) * 2.0

    ann_ret = SAMPLE_ANN_RETURN + tilt_ret * 0.06          # ~3% .. 15%
    ann_vol = max(SAMPLE_ANN_VOL + tilt_vol * 0.07, 0.06)  # floor 6%

    mu = ann_ret / TRADING_DAYS
    sig = ann_vol / np.sqrt(TRADING_DAYS)
    rets = rng.normal(mu, sig, len(dates) - 1)

    base = 100.0
    prices = base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))
    return [{"date": d, "value": round(float(p), 4)} for d, p in zip(dates, prices)]


# ---------------------------------------------------------------------------
# Returns helpers
# ---------------------------------------------------------------------------

def _clean_points(points: list[dict]) -> list[tuple[str, float]]:
    """Sorted (date, price) pairs with usable positive values."""
    out: list[tuple[str, float]] = []
    for p in points or []:
        d = p.get("date")
        v = p.get("value")
        if d and v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv > 0:
                out.append((str(d), fv))
    out.sort(key=lambda x: x[0])
    return out


def _returns(pairs: list[tuple[str, float]]) -> dict[str, float]:
    """Map date -> simple daily return from sorted (date, price) pairs."""
    out: dict[str, float] = {}
    for i in range(1, len(pairs)):
        prev = pairs[i - 1][1]
        d, close = pairs[i]
        if prev > 0:
            out[d] = close / prev - 1.0
    return out


def _series_for(symbol: str, days: int) -> tuple[list[tuple[str, float]], str]:
    """Return (clean (date, price) pairs, mode) for a ticker.

    Tries the live fetcher; falls back to a deterministic sample path. `mode`
    is "live" when the live fetch produced enough data, else "sample".
    """
    points: list[dict] = []
    try:
        points = fetch_arbitrary_ticker(symbol, days=days + 5)
    except Exception as e:
        log.warning("factor fetch failed for %s: %s", symbol, e)
        points = []

    pairs = _clean_points(points)
    if len(pairs) >= MIN_OVERLAP + 1:
        return pairs, "live"
    return _clean_points(_sample_prices(symbol, days)), "sample"


def _univariate_beta(y: np.ndarray, x: np.ndarray) -> float:
    """OLS slope of y on x (cov(x, y) / var(x)); 0.0 when undefined."""
    if x.size < 2:
        return 0.0
    vx = float(np.var(x))
    if vx <= 0:
        return 0.0
    return float(np.cov(x, y, ddof=0)[0, 1] / vx)


def _clamp(v: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def factor_exposures(symbol: str, days: int = 756) -> dict:
    """Run a factor-style analysis for `symbol` over `days` trading days.

    Never raises - degrades to deterministic sample series and tags the payload
    with data_mode / as_of / source.
    """
    try:
        return _factor_exposures(symbol, days)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("factor_exposures failed hard, returning sample: %s", e)
        sym = (symbol or "SPY").strip().upper() or "SPY"
        try:
            return _empty_payload(sym, days)
        except Exception:
            return _empty_payload("SPY", 756)


def _factor_exposures(symbol: str, days: int) -> dict:
    sym = (symbol or "SPY").strip().upper() or "SPY"
    win = days if isinstance(days, int) and days > 0 else 756
    win = min(win, 252 * 10)

    cache_key = f"factor_exposures:{sym}:{win}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # --- Gather price series for the symbol + every proxy + the growth anchor ---
    needed = [sym] + FACTOR_SYMBOLS + [GROWTH_PROXY]
    pairs_map: dict[str, list[tuple[str, float]]] = {}
    modes: list[str] = []
    for tk in needed:
        pairs, mode = _series_for(tk, win)
        pairs_map[tk] = pairs
        modes.append(mode)

    # Live only if the symbol AND every regression proxy came back live.
    sym_mode = modes[0]
    factor_modes = modes[1:1 + len(FACTOR_SYMBOLS)]
    data_mode = "live" if sym_mode == "live" and all(m == "live" for m in factor_modes) else "sample"
    source = "yfinance" if data_mode == "live" else "sample"

    rets_map = {tk: _returns(pairs) for tk, pairs in pairs_map.items()}
    sym_rets = rets_map[sym]

    # --- Common dates across symbol + all regression factors ---
    common = set(sym_rets.keys())
    for fs in FACTOR_SYMBOLS:
        common &= set(rets_map[fs].keys())
    common_dates = sorted(common)

    if len(common_dates) < MIN_OVERLAP:
        # Not enough overlap to regress meaningfully - fall back to sample paths
        # for every leg so the panel still renders a full, stable study.
        pairs_map = {tk: _clean_points(_sample_prices(tk, win)) for tk in needed}
        rets_map = {tk: _returns(pairs) for tk, pairs in pairs_map.items()}
        sym_rets = rets_map[sym]
        common = set(sym_rets.keys())
        for fs in FACTOR_SYMBOLS:
            common &= set(rets_map[fs].keys())
        common_dates = sorted(common)
        data_mode, source = "sample", "sample"

    daily_rf = RF_ANNUAL / TRADING_DAYS
    y = np.array([sym_rets[d] - daily_rf for d in common_dates])  # excess returns
    factor_cols = [np.array([rets_map[fs][d] for d in common_dates]) for fs in FACTOR_SYMBOLS]
    X = np.column_stack(factor_cols)                      # (n_days, n_factors)
    X_int = np.column_stack([np.ones(X.shape[0]), X])     # add intercept

    betas: list[dict] = []
    alpha_pct = 0.0
    r2 = 0.0
    try:
        coefs, _resid, _rank, _sv = np.linalg.lstsq(X_int, y, rcond=None)
        intercept = float(coefs[0])
        slopes = coefs[1:]
        predicted = X_int @ coefs
        ss_res = float(np.sum((y - predicted) ** 2))
        ss_tot = float(np.sum((y - np.mean(y)) ** 2))
        r2 = round(1.0 - ss_res / ss_tot, 4) if ss_tot > 0 else 0.0
        alpha_pct = round(intercept * TRADING_DAYS * 100, 3)  # annualized alpha %
        for (proxy, name), b in zip(FACTORS, slopes):
            betas.append({"factor": proxy, "name": name, "beta": round(float(b), 3)})
    except Exception as e:
        log.warning("factor OLS failed for %s: %s", sym, e)
        for proxy, name in FACTORS:
            betas.append({"factor": proxy, "name": name, "beta": None})

    # --- Factor performance: each proxy's total return over the window ---
    factor_perf: list[dict] = []
    for proxy, name in FACTORS:
        p = pairs_map.get(proxy) or []
        ret_pct = round((p[-1][1] / p[0][1] - 1.0) * 100, 2) if len(p) >= 2 and p[0][1] > 0 else None
        factor_perf.append({"factor": proxy, "name": name, "return_pct": ret_pct})

    # --- Style box (univariate beta tilts on the common dates) ---
    def col(tk: str) -> np.ndarray:
        m = rets_map.get(tk, {})
        return np.array([m.get(d, 0.0) for d in common_dates])

    sym_raw = np.array([sym_rets[d] for d in common_dates])
    b_value = _univariate_beta(sym_raw, col("VLUE"))
    b_growth = _univariate_beta(sym_raw, col(GROWTH_PROXY))
    b_market = _univariate_beta(sym_raw, col("SPY"))
    b_size = _univariate_beta(sym_raw, col("SIZE"))

    # x: value (-1) <-> growth (+1); y: small (-1) <-> large (+1).
    style_x = round(_clamp(float(np.tanh((b_growth - b_value) * 1.5))), 3)
    style_y = round(_clamp(float(np.tanh((b_market - b_size) * 1.5))), 3)

    result = {
        "symbol": sym,
        "betas": betas,
        "r2": r2,
        "alpha_pct": alpha_pct,
        "factor_perf": factor_perf,
        "style_box": {"x": style_x, "y": style_y},
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
    cache.set(cache_key, result, FACTOR_TTL)
    return result


def _empty_payload(symbol: str, days: int) -> dict:
    """Last-resort fully-shaped payload built from deterministic sample series."""
    win = days if isinstance(days, int) and days > 0 else 756
    pairs_map = {tk: _clean_points(_sample_prices(tk, win))
                 for tk in [symbol] + FACTOR_SYMBOLS + [GROWTH_PROXY]}
    rets_map = {tk: _returns(p) for tk, p in pairs_map.items()}
    sym_rets = rets_map[symbol]
    common = set(sym_rets.keys())
    for fs in FACTOR_SYMBOLS:
        common &= set(rets_map[fs].keys())
    common_dates = sorted(common)

    daily_rf = RF_ANNUAL / TRADING_DAYS
    betas: list[dict] = []
    alpha_pct, r2 = 0.0, 0.0
    style_x, style_y = 0.0, 0.0
    if len(common_dates) >= 2:
        y = np.array([sym_rets[d] - daily_rf for d in common_dates])
        X = np.column_stack([np.array([rets_map[fs][d] for d in common_dates])
                             for fs in FACTOR_SYMBOLS])
        X_int = np.column_stack([np.ones(X.shape[0]), X])
        coefs, *_ = np.linalg.lstsq(X_int, y, rcond=None)
        predicted = X_int @ coefs
        ss_res = float(np.sum((y - predicted) ** 2))
        ss_tot = float(np.sum((y - np.mean(y)) ** 2))
        r2 = round(1.0 - ss_res / ss_tot, 4) if ss_tot > 0 else 0.0
        alpha_pct = round(float(coefs[0]) * TRADING_DAYS * 100, 3)
        for (proxy, name), b in zip(FACTORS, coefs[1:]):
            betas.append({"factor": proxy, "name": name, "beta": round(float(b), 3)})
        sym_raw = np.array([sym_rets[d] for d in common_dates])

        def col(tk: str) -> np.ndarray:
            m = rets_map.get(tk, {})
            return np.array([m.get(d, 0.0) for d in common_dates])

        style_x = round(_clamp(float(np.tanh(
            (_univariate_beta(sym_raw, col(GROWTH_PROXY))
             - _univariate_beta(sym_raw, col("VLUE"))) * 1.5))), 3)
        style_y = round(_clamp(float(np.tanh(
            (_univariate_beta(sym_raw, col("SPY"))
             - _univariate_beta(sym_raw, col("SIZE"))) * 1.5))), 3)
    else:
        betas = [{"factor": p, "name": n, "beta": None} for p, n in FACTORS]

    factor_perf = []
    for proxy, name in FACTORS:
        p = pairs_map.get(proxy) or []
        ret_pct = round((p[-1][1] / p[0][1] - 1.0) * 100, 2) if len(p) >= 2 and p[0][1] > 0 else None
        factor_perf.append({"factor": proxy, "name": name, "return_pct": ret_pct})

    return {
        "symbol": symbol,
        "betas": betas,
        "r2": r2,
        "alpha_pct": alpha_pct,
        "factor_perf": factor_perf,
        "style_box": {"x": style_x, "y": style_y},
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
