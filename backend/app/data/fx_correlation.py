"""FX correlation matrix & rolling regime (Bloomberg ``CORR``).

A rolling pairwise correlation heatmap across the FX majors plus a few key
crosses / EM, anchored on the Dollar Index (DXY) as the risk proxy. We surface:

- the full NxN Pearson correlation matrix of daily log-returns over a rolling
  window (the same machinery the shipped correlation detector uses);
- each pair's correlation-to-DXY (a single-factor "USD beta" read);
- a risk-on / risk-off regime label + a 1-line plain-English read derived from
  the recent DXY drift plus how tightly the complex is moving as one factor;
- a clustering of pairs into "moves with USD" vs "moves against USD";
- the most-correlated and most-anticorrelated pairs in the complex.

Live path: daily history per symbol via ``macro_data.fetch_arbitrary_ticker``
(yfinance ``<PAIR>=X`` symbols, DXY = ``DX-Y.NYB``). The rolling-correlation math
is REUSED from ``correlations.correlation_model`` (``_log_returns`` /
``_align_on_dates`` / ``_pearson``) — this module does not reimplement it.

Graceful degradation: if too few pairs resolve (or the fetch comes back empty)
we return a RICH, deterministic SAMPLE matrix with a plausible FX correlation
structure (EUR/GBP high positive, USDJPY vs the risk pairs negative, DXY ~ -EUR).
This module never raises. Every payload carries an internal data_mode / as_of /
source / window (no on-screen badge).
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

from . import cache
from .macro_data import SeriesPoint, fetch_arbitrary_ticker
from ..correlations.correlation_model import _align_on_dates, _log_returns, _pearson

log = logging.getLogger(__name__)

_TTL = 60 * 30  # 30 min — FX correlations move slowly relative to a screenshot

DXY = "DXY"
DXY_SYMBOL = "DX-Y.NYB"

# (display key, yfinance symbol). Ordered: DXY anchor, majors, then crosses / EM.
# DXY leads so it anchors the matrix top-left and the corr-to-DXY column reads
# off a known row.
UNIVERSE: list[tuple[str, str]] = [
    (DXY, DXY_SYMBOL),
    ("EURUSD", "EURUSD=X"),
    ("GBPUSD", "GBPUSD=X"),
    ("USDJPY", "USDJPY=X"),
    ("AUDUSD", "AUDUSD=X"),
    ("USDCAD", "USDCAD=X"),
    ("USDCHF", "USDCHF=X"),
    ("NZDUSD", "NZDUSD=X"),
    ("EURJPY", "EURJPY=X"),
    ("EURGBP", "EURGBP=X"),
    ("USDMXN", "USDMXN=X"),
    ("USDCNH", "USDCNH=X"),
]

WINDOWS = (30, 60, 90)
_MIN_PAIRS = 5          # need at least this many resolved symbols for a live matrix
_MIN_OBS = 12           # _pearson itself needs >=10 paired observations

# Each symbol's loading on the latent "USD-strength" factor (DXY = +1.0). The
# sample correlation between two symbols is loadings' product (plus a small
# deterministic idiosyncratic wobble), which reproduces the real structure:
# EUR/GBP strongly positive, the USDxxx pairs positive with each other and with
# DXY, and the EURUSD-style pairs negative against DXY and against the USDxxx
# block. The crosses (EURJPY / EURGBP) carry a low USD beta on purpose.
_USD_LOADING: dict[str, float] = {
    DXY: 1.00,
    "EURUSD": -0.95,
    "GBPUSD": -0.88,
    "USDJPY": 0.70,
    "AUDUSD": -0.82,
    "USDCAD": 0.74,
    "USDCHF": 0.86,
    "NZDUSD": -0.80,
    "EURJPY": -0.22,
    "EURGBP": -0.12,
    "USDMXN": 0.62,
    "USDCNH": 0.58,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fx_correlation(window: int = 60) -> dict:
    """Rolling FX correlation matrix + corr-to-DXY + risk regime.

    ``window`` is the trailing trading-day window for the correlation estimate
    (snapped to 30 / 60 / 90). Never raises — degrades to a deterministic SAMPLE
    matrix.
    """
    win = _snap_window(window)
    try:
        return _fx_correlation(win)
    except Exception as e:  # absolute safety net — the contract forbids raising
        log.warning("fx_correlation failed hard, returning sample: %s", e)
        return _sample_payload(win)


def _snap_window(window: int) -> int:
    try:
        w = int(window)
    except (TypeError, ValueError):
        return 60
    # Snap to the nearest supported window so the cache + UI stay aligned.
    return min(WINDOWS, key=lambda c: abs(c - w))


def _fx_correlation(win: int) -> dict:
    cache_key = f"fx:corr:{win}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # Pull enough history to cover the window plus a returns/holiday buffer.
    fetch_days = win + 45
    series_map: dict[str, list[SeriesPoint]] = {}
    for key, symbol in UNIVERSE:
        try:
            pts = fetch_arbitrary_ticker(symbol, days=fetch_days)
            if pts:
                series_map[key] = pts
        except Exception as e:
            log.warning("fx_correlation fetch(%s) failed: %s", symbol, e)

    payload = _build_live(series_map, win)
    if payload is None:
        payload = _sample_payload(win)
    cache.set(cache_key, payload, _TTL)
    return payload


def _build_live(series_map: dict[str, list[SeriesPoint]], win: int) -> dict | None:
    """Compute the live matrix, or return None to signal a sample fallback."""
    if len(series_map) < _MIN_PAIRS:
        return None

    # Align on a shared trading-day grid, then trailing-window log returns. Reuse
    # the shipped alignment + returns + Pearson machinery (correlation_model).
    dates, aligned = _align_on_dates(series_map)
    if len(dates) < win // 2:
        return None

    returns: dict[str, list[float]] = {}
    for key, vals in aligned.items():
        r = _log_returns(vals)
        returns[key] = r[-win:] if len(r) >= win else r

    # Keep symbols that have a usable return series (DXY included if present).
    symbols = [k for k, _ in UNIVERSE if k in returns and len(returns[k]) >= _MIN_OBS]
    if len(symbols) < _MIN_PAIRS:
        return None

    matrix = _full_matrix(symbols, returns)
    full = len(dates) >= win  # did we get the full requested window?
    data_mode = "live" if full else "mixed"
    return _assemble(symbols, matrix, win, data_mode,
                     source="yfinance" if full else "yfinance (short window)")


def _full_matrix(symbols: list[str], returns: dict[str, list[float]]) -> list[list[float | None]]:
    """NxN Pearson matrix, diagonal 1.0, symmetric, via correlation_model._pearson."""
    n = len(symbols)
    m: list[list[float | None]] = [[None] * n for _ in range(n)]
    for i in range(n):
        m[i][i] = 1.0
    for i in range(n):
        for j in range(i + 1, n):
            c = _pearson(returns[symbols[i]], returns[symbols[j]])
            cr = _round(c)
            m[i][j] = cr
            m[j][i] = cr
    return m


# ---------------------------------------------------------------------------
# Sample fallback (deterministic, plausible FX structure)
# ---------------------------------------------------------------------------

def _sample_payload(win: int) -> dict:
    symbols = [k for k, _ in UNIVERSE]
    matrix = _sample_matrix(symbols)
    return _assemble(symbols, matrix, win, "sample", source="sample")


def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _sample_matrix(symbols: list[str]) -> list[list[float | None]]:
    """Single-factor correlation built from USD loadings + a small deterministic
    idiosyncratic wobble, clamped to [-0.99, 0.99]. Symmetric, diagonal 1.0."""
    n = len(symbols)
    m: list[list[float | None]] = [[None] * n for _ in range(n)]
    for i in range(n):
        m[i][i] = 1.0
    for i in range(n):
        a = symbols[i]
        for j in range(i + 1, n):
            b = symbols[j]
            base = _USD_LOADING.get(a, 0.0) * _USD_LOADING.get(b, 0.0)
            # Deterministic wobble in ~[-0.06, 0.06], symmetric in (a, b).
            wob = ((_seed(a + b) % 1200) / 10000.0) - 0.06
            c = max(-0.99, min(0.99, base + wob))
            cr = round(c, 3)
            m[i][j] = cr
            m[j][i] = cr
    return m


# ---------------------------------------------------------------------------
# Assembly: corr-to-DXY, clustering, extremes, regime read
# ---------------------------------------------------------------------------

def _assemble(symbols: list[str], matrix: list[list[float | None]], win: int,
              data_mode: str, source: str) -> dict:
    idx = {s: i for i, s in enumerate(symbols)}
    has_dxy = DXY in idx
    dxy_i = idx.get(DXY)

    # Per-pair correlation-to-DXY (the DXY row), excluding DXY itself.
    corr_to_dxy: list[dict] = []
    for s in symbols:
        if s == DXY:
            continue
        c = matrix[dxy_i][idx[s]] if has_dxy else None
        corr_to_dxy.append({
            "symbol": s,
            "corr": c,
            "cluster": _cluster_of(c),
        })
    corr_to_dxy.sort(key=lambda r: (r["corr"] is None, -(r["corr"] or 0.0)))

    # Clusters: pairs that move with the dollar vs against it.
    with_usd = [r["symbol"] for r in corr_to_dxy if r["cluster"] == "with_usd"]
    against_usd = [r["symbol"] for r in corr_to_dxy if r["cluster"] == "against_usd"]

    # Most-correlated / most-anticorrelated off-diagonal pairs (exclude the DXY
    # row so the callouts are genuine cross-pair relationships, not USD identity).
    most_corr, most_anti = _extremes(symbols, matrix, idx)

    regime, read = _regime(corr_to_dxy, matrix, symbols, idx, data_mode)

    return {
        "symbols": symbols,
        "matrix": matrix,
        "corr_to_dxy": corr_to_dxy,
        "clusters": {"with_usd": with_usd, "against_usd": against_usd},
        "most_correlated": most_corr,
        "most_anticorrelated": most_anti,
        "regime": regime,
        "regime_read": read,
        "window": win,
        "anchor": DXY,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _cluster_of(c: float | None) -> str:
    if c is None:
        return "neutral"
    if c >= 0.15:
        return "with_usd"
    if c <= -0.15:
        return "against_usd"
    return "neutral"


def _extremes(symbols: list[str], matrix: list[list[float | None]],
              idx: dict[str, int]) -> tuple[dict | None, dict | None]:
    """Highest-positive and lowest (most-negative) off-diagonal correlation,
    excluding any pairing with DXY (the anchor) so callouts read as cross-pairs."""
    most_corr: dict | None = None
    most_anti: dict | None = None
    n = len(symbols)
    for i in range(n):
        if symbols[i] == DXY:
            continue
        for j in range(i + 1, n):
            if symbols[j] == DXY:
                continue
            c = matrix[i][j]
            if c is None:
                continue
            entry = {"a": symbols[i], "b": symbols[j], "corr": c}
            if most_corr is None or c > most_corr["corr"]:
                most_corr = entry
            if most_anti is None or c < most_anti["corr"]:
                most_anti = entry
    return most_corr, most_anti


def _regime(corr_to_dxy: list[dict], matrix: list[list[float | None]],
            symbols: list[str], idx: dict[str, int], data_mode: str) -> tuple[str, str]:
    """Classify a risk-on / risk-off / mixed regime and write a 1-line read.

    Two signals:
      - tightness: mean |corr-to-DXY| across pairs. High => the complex is trading
        as one USD factor (a true risk-on/off regime); low => idiosyncratic.
      - direction: the commodity / risk bloc (AUD, NZD) vs DXY. When those move
        hard against the dollar the tape is being driven by the risk trade.
    """
    vals = [r["corr"] for r in corr_to_dxy if r["corr"] is not None]
    if not vals:
        return "indeterminate", "Not enough cross-history to read the FX correlation regime."

    tightness = sum(abs(v) for v in vals) / len(vals)

    # Risk-bloc loading against the dollar (more negative = stronger risk-on tone).
    risk_pairs = [p for p in ("AUDUSD", "NZDUSD", "EURUSD") if p in idx and DXY in idx]
    risk_load = None
    if risk_pairs:
        rv = [matrix[idx[DXY]][idx[p]] for p in risk_pairs if matrix[idx[DXY]][idx[p]] is not None]
        if rv:
            risk_load = sum(rv) / len(rv)

    if tightness < 0.35:
        label = "idiosyncratic"
        read = (
            f"Cross-pair correlations are loose (mean |corr-to-DXY| {tightness:.2f}); "
            "FX is trading on local stories, not a single risk factor."
        )
    elif risk_load is not None and risk_load <= -0.55:
        label = "risk-on (USD soft)"
        read = (
            f"Tight single-factor tape (mean |corr-to-DXY| {tightness:.2f}) with the "
            f"risk bloc {risk_load:.2f} to the dollar — pro-risk, USD on the back foot."
        )
    elif risk_load is not None and risk_load >= -0.30:
        label = "risk-off (USD bid)"
        read = (
            f"Tight single-factor tape (mean |corr-to-DXY| {tightness:.2f}) with the risk "
            "bloc decoupling from its usual short-USD beta — defensive, dollar bid."
        )
    else:
        label = "risk-driven (USD-led)"
        read = (
            f"High clustering (mean |corr-to-DXY| {tightness:.2f}): the dollar is the "
            "dominant axis and the majors are moving as one bloc around it."
        )
    return label, read


def _round(v: float | None, digits: int = 3) -> float | None:
    return None if v is None else round(v, digits)
