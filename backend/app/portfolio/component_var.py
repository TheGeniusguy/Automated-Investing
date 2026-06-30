"""Marginal & Component VaR per holding (Bloomberg `PORT` risk attribution).

Total portfolio Value-at-Risk is a single number, but it hides WHERE the tail
risk lives. This module attributes the portfolio's parametric VaR to each open
position so the user can see which names actually drive the downside - not just
which are biggest by weight.

Method (all in DAILY return space, matching how `risk.py` expresses its headline
`var_95_daily_pct` - a 1-day horizon):

  * Build the open positions + weights via the SHIPPED path
    (crud -> compute_positions -> enrich_positions). Weights are fractions of
    TOTAL portfolio value (so cash dilutes risk and simply contributes zero VaR).
  * Pull each holding's trailing ~252d daily return series via
    `fetch_arbitrary_ticker`, align on common dates, and build the covariance
    matrix Sigma of position returns.
  * Portfolio variance = wᵀ Σ w ; sigma_p = sqrt(variance).
  * Parametric VaR95 (1-day, dollars) = z · sigma_p · portfolio_value, z = 1.645.
  * Marginal VaR_i = z · (Σ w)_i / sigma_p        (sensitivity of VaR to weight i)
  * Component VaR_i = w_i · Marginal VaR_i · portfolio_value  (dollars)
  * THE INVARIANT (Euler homogeneity, VaR is degree-1 homogeneous in weights):
        Σ_i Component VaR_i  ==  Total VaR     (reconciles to rounding)
    because Σ_i w_i (Σ w)_i = wᵀ Σ w = sigma_p² and dividing by sigma_p gives
    sigma_p back. We compute Total VaR FROM the same sigma_p so it reconciles by
    construction, and we verify numerically.
  * beta_to_port_i = (Σ w)_i / variance.

Live path requires >= 2 positions whose return series resolve with enough history.
When no portfolio exists, prices are unavailable, or anything goes wrong, we fall
back to a deterministic md5-seeded SAMPLE whose component VaRs sum exactly to the
total (it runs the identical math engine on synthetic-but-realistic returns) and
tag the payload with data_mode="sample". This function NEVER raises - it always
returns a populated payload carrying data_mode / as_of / source.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger(__name__)

# 95% one-tailed normal quantile (matches the conventional parametric VaR z).
Z_95 = 1.645
# Normal Expected-Shortfall multiplier at 95%: phi(z) / (1 - alpha).
# phi(1.645) = exp(-z^2/2)/sqrt(2*pi) ~= 0.103136 ; / 0.05 ~= 2.06272.
_CVAR_MULT = (math.exp(-(Z_95 ** 2) / 2.0) / math.sqrt(2.0 * math.pi)) / 0.05
TRADING_DAYS = 252
LOOKBACK_DAYS = 252
MIN_POSITIONS = 2
MIN_OVERLAP = 30  # minimum aligned trading days to trust a live covariance


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(symbol: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by symbol + salt."""
    return (_hash(symbol, salt) % 1_000_000) / 1_000_000.0


# ---------------------------------------------------------------------------
# Core attribution engine - shared by the live and sample paths so BOTH
# reconcile by construction (total VaR is derived from the same sigma_p).
# ---------------------------------------------------------------------------

def _attribute(
    symbols: list[str],
    weights: np.ndarray,          # fractions of total portfolio value
    ret_matrix: np.ndarray,       # (n_assets, n_days) aligned daily returns
    portfolio_value: float,
) -> dict | None:
    """Run the marginal/component VaR decomposition. Returns None if degenerate."""
    n = len(symbols)
    if n == 0 or portfolio_value <= 0 or ret_matrix.shape[0] != n:
        return None

    # Covariance of DAILY position returns (sample cov, ddof=1).
    if ret_matrix.shape[1] < 2:
        return None
    sigma = np.cov(ret_matrix, ddof=1)
    sigma = np.atleast_2d(sigma)
    if sigma.shape != (n, n):
        return None

    w = np.asarray(weights, dtype=float)
    sigma_w = sigma @ w                     # (Sigma w)_i
    variance = float(w @ sigma_w)           # wᵀ Σ w  (daily)
    if not np.isfinite(variance) or variance <= 0:
        return None
    sigma_p = math.sqrt(variance)           # daily portfolio vol

    # Total parametric VaR / CVaR (1-day, dollars) - derived FROM sigma_p so the
    # component sum reconciles exactly.
    total_var = Z_95 * sigma_p * portfolio_value
    total_cvar = _CVAR_MULT * sigma_p * portfolio_value

    marginal = Z_95 * sigma_w / sigma_p                 # return-space sensitivity
    component = w * marginal * portfolio_value          # dollars; sums to total_var
    beta_to_port = sigma_w / variance                   # contribution beta
    standalone_vol = np.sqrt(np.clip(np.diag(sigma), 0.0, None)) * math.sqrt(TRADING_DAYS)

    positions: list[dict] = []
    for i, sym in enumerate(symbols):
        comp_i = float(component[i])
        positions.append({
            "symbol": sym,
            "weight": round(float(w[i]) * 100.0, 2),               # % of total value
            "standalone_vol": round(float(standalone_vol[i]) * 100.0, 2),  # annualized %
            "marginal_var": round(float(marginal[i]), 4),
            "component_var": round(comp_i, 2),
            "pct_of_var": round(comp_i / total_var * 100.0, 2) if total_var != 0 else 0.0,
            "beta_to_port": round(float(beta_to_port[i]), 3),
        })

    positions.sort(key=lambda p: p["component_var"], reverse=True)

    comp_sum = float(component.sum())
    reconciles_pct = round(comp_sum / total_var * 100.0, 2) if total_var != 0 else 0.0
    # Diversification ratio: weighted avg standalone vol / portfolio vol (>= 1).
    wavg_vol = float(np.dot(w, standalone_vol))
    port_vol_annual = sigma_p * math.sqrt(TRADING_DAYS)
    diversification_ratio = (
        round(wavg_vol / port_vol_annual, 3) if port_vol_annual > 0 else None
    )

    return {
        "total_var95": round(total_var, 2),
        "total_cvar95": round(total_cvar, 2),
        "portfolio_value": round(float(portfolio_value), 2),
        "positions": positions,
        "summary": {
            "top_risk_contributor": positions[0]["symbol"] if positions else None,
            "diversification_ratio": diversification_ratio,
            "reconciles_pct": reconciles_pct,
        },
    }


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _resolve_portfolio(portfolio_id: int | None) -> dict | None:
    """Return the target portfolio dict, defaulting to the first one."""
    from . import crud as pcrud
    if portfolio_id is not None:
        return pcrud.get_portfolio(portfolio_id)
    portfolios = pcrud.list_portfolios()
    return portfolios[0] if portfolios else None


def _fetch_returns(symbol: str, days: int) -> tuple[list[str], list[float]]:
    """(dates, daily_returns) for a symbol via the canonical price entrypoint."""
    from ..data.macro_data import fetch_arbitrary_ticker
    pts = fetch_arbitrary_ticker(symbol, days=days + 5)
    valid = [(p["date"], float(p["value"])) for p in pts if p.get("value") is not None]
    if len(valid) < 2:
        return [], []
    dates = [valid[i][0] for i in range(1, len(valid))]
    prices = [v[1] for v in valid]
    # Guard against a zero/negative prior price (bad tick) so this never divides
    # by zero; a non-positive prior yields a 0.0 return for that step.
    rets = [
        ((prices[i] - prices[i - 1]) / prices[i - 1]) if prices[i - 1] > 0 else 0.0
        for i in range(1, len(prices))
    ]
    return dates, rets


def _live_payload(portfolio_id: int | None) -> dict | None:
    """Build component VaR from the shipped portfolio path. None -> use sample."""
    from .positions import compute_positions
    from .valuation import enrich_positions
    from . import crud as pcrud

    pf = _resolve_portfolio(portfolio_id)
    if not pf:
        return None

    txns = pcrud.get_transactions(pf["id"])
    positions, _realized, cash_delta = compute_positions(txns)
    if len(positions) < MIN_POSITIONS:
        return None

    current_cash = float(pf.get("cash_balance") or 0.0) + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    if len(enriched) < MIN_POSITIONS:
        return None

    portfolio_value = float(summary.get("total_value") or 0.0)
    if portfolio_value <= 0:
        return None

    # Per-position trailing return series.
    returns_map: dict[str, tuple[list[str], list[float]]] = {}
    for p in enriched:
        returns_map[p["symbol"]] = _fetch_returns(p["symbol"], LOOKBACK_DAYS)

    common = None
    for dates, rets in returns_map.values():
        if not rets:
            continue
        s = set(dates)
        common = s if common is None else (common & s)
    if not common:
        return None
    common_dates = sorted(common)
    if len(common_dates) < MIN_OVERLAP:
        return None

    symbols: list[str] = []
    weights: list[float] = []
    rows: list[np.ndarray] = []
    for p in enriched:
        dates, rets = returns_map.get(p["symbol"], ([], []))
        if not rets:
            continue
        dmap = dict(zip(dates, rets))
        aligned = [dmap.get(d) for d in common_dates]
        if any(a is None for a in aligned):
            continue
        symbols.append(p["symbol"])
        weights.append(float(p["market_value"]) / portfolio_value)
        rows.append(np.asarray(aligned, dtype=float))

    if len(symbols) < MIN_POSITIONS:
        return None

    result = _attribute(symbols, np.asarray(weights), np.stack(rows, axis=0), portfolio_value)
    if result is None:
        return None
    return _assemble(result, pf["id"], data_mode="live", source="yfinance")


# ---------------------------------------------------------------------------
# Sample path (deterministic; reconciles by running the same engine)
# ---------------------------------------------------------------------------

# A realistic concentrated book - a few mega-cap tech names drive the tail.
_SAMPLE_BOOK: list[tuple[str, float, float, float]] = [
    # (symbol, dollar_value, annual_vol, market_beta)  beta drives covariance shape
    ("NVDA", 182000.0, 0.52, 1.75),
    ("TSLA", 96000.0, 0.58, 1.62),
    ("AAPL", 140000.0, 0.27, 1.18),
    ("MSFT", 128000.0, 0.25, 1.06),
    ("AMZN", 88000.0, 0.33, 1.22),
    ("GOOGL", 72000.0, 0.30, 1.10),
    ("JPM", 64000.0, 0.22, 0.95),
    ("XOM", 50000.0, 0.24, 0.74),
    ("UNH", 46000.0, 0.23, 0.62),
]
_SAMPLE_CASH = 84000.0


def _sample_payload() -> dict:
    """Deterministic synthetic returns -> identical engine -> exact reconciliation."""
    symbols = [b[0] for b in _SAMPLE_BOOK]
    dollar = np.array([b[1] for b in _SAMPLE_BOOK], dtype=float)
    annual_vol = np.array([b[2] for b in _SAMPLE_BOOK], dtype=float)
    betas = np.array([b[3] for b in _SAMPLE_BOOK], dtype=float)

    portfolio_value = float(dollar.sum() + _SAMPLE_CASH)
    weights = dollar / portfolio_value

    n_days = TRADING_DAYS
    daily_vol = annual_vol / math.sqrt(TRADING_DAYS)

    # Single common market factor + idiosyncratic noise -> realistic correlations.
    rng = np.random.default_rng(_hash("component_var", "sample-seed") % (2 ** 32))
    market = rng.standard_normal(n_days) * (0.011)  # ~1.1% daily market vol
    rows: list[np.ndarray] = []
    for i in range(len(symbols)):
        sys_vol = betas[i] * 0.011
        idio_var = max(daily_vol[i] ** 2 - sys_vol ** 2, (0.2 * daily_vol[i]) ** 2)
        idio = rng.standard_normal(n_days) * math.sqrt(idio_var)
        rows.append(betas[i] * market + idio)

    result = _attribute(symbols, weights, np.stack(rows, axis=0), portfolio_value)
    if result is None:  # should never happen, but stay honest
        return _hard_fallback()
    return _assemble(result, None, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def _assemble(result: dict, portfolio_id: int | None, *, data_mode: str, source: str) -> dict:
    return {
        "portfolio_id": portfolio_id,
        "total_var95": result["total_var95"],
        "total_cvar95": result["total_cvar95"],
        "portfolio_value": result["portfolio_value"],
        "positions": result["positions"],
        "summary": result["summary"],
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _hard_fallback() -> dict:
    return {
        "portfolio_id": None,
        "total_var95": 0.0,
        "total_cvar95": 0.0,
        "portfolio_value": 0.0,
        "positions": [],
        "summary": {"top_risk_contributor": None, "diversification_ratio": None, "reconciles_pct": 0.0},
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def component_var(portfolio_id: int | None = None) -> dict:
    """Attribute total portfolio VaR/CVaR to each holding. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source. Never raises.
    """
    try:
        live = _live_payload(portfolio_id)
        if live is not None and live.get("positions"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("component_var live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("component_var sample path failed hard: %s", e)
        return _hard_fallback()
