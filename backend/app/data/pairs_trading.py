"""Pairs trading / relative-value engine (Wave F).

Bloomberg-style statistical-arbitrage analysis of a symbol pair: log-price
hedge ratio (OLS), spread z-score, daily-return correlation, mean-reversion
half-life (AR(1) fit), and a rough cointegration proxy (ADF-style heuristic,
honestly labeled). Also screens a curated list of classic pairs and ranks them
by absolute z-score.

Live path: trailing closes via app.data.macro_data.fetch_arbitrary_ticker.
When a leg is unavailable or too short we degrade to a deterministic SAMPLE
price series (seeded off the concatenated symbols via hashlib.md5, generated as
a cointegrated-ish pair of geometric walks sharing a common factor) so the
panel is always fully populated for screenshots. This module never raises - it
always returns a populated payload tagged with data_mode / as_of / source.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 250          # ~1y of trailing closes
MIN_POINTS = 30              # below this we cannot trust the stats -> sample
CHART_POINTS = 120           # downsample target for charting series
HALF_LIFE_MIN = 1.0
HALF_LIFE_MAX = 252.0

# Curated classic relative-value pairs (long-correlated, same-sector names).
CURATED_PAIRS: list[tuple[str, str, str]] = [
    ("KO", "PEP", "Beverages"),
    ("V", "MA", "Card Networks"),
    ("HD", "LOW", "Home Improvement"),
    ("GS", "MS", "Investment Banks"),
    ("XOM", "CVX", "Integrated Energy"),
    ("AAPL", "MSFT", "Mega-Cap Tech"),
    ("WMT", "TGT", "Big-Box Retail"),
    ("UPS", "FDX", "Parcel Logistics"),
]

# Per-symbol sample profile: starting price, annual drift, annual vol, and the
# loading on the shared market factor (drives realistic co-movement so a pair
# from the same sector reads as cointegrated). Used only on the sample path.
SAMPLE_PROFILE: dict[str, dict] = {
    "KO": {"px": 62.0, "mu": 0.06, "vol": 0.16, "beta": 0.65},
    "PEP": {"px": 172.0, "mu": 0.06, "vol": 0.17, "beta": 0.68},
    "V": {"px": 280.0, "mu": 0.12, "vol": 0.21, "beta": 1.02},
    "MA": {"px": 470.0, "mu": 0.12, "vol": 0.22, "beta": 1.05},
    "HD": {"px": 360.0, "mu": 0.09, "vol": 0.23, "beta": 1.10},
    "LOW": {"px": 240.0, "mu": 0.09, "vol": 0.24, "beta": 1.12},
    "GS": {"px": 470.0, "mu": 0.11, "vol": 0.27, "beta": 1.25},
    "MS": {"px": 100.0, "mu": 0.11, "vol": 0.28, "beta": 1.28},
    "XOM": {"px": 112.0, "mu": 0.07, "vol": 0.25, "beta": 0.80},
    "CVX": {"px": 158.0, "mu": 0.07, "vol": 0.24, "beta": 0.82},
    "AAPL": {"px": 225.0, "mu": 0.14, "vol": 0.24, "beta": 1.18},
    "MSFT": {"px": 420.0, "mu": 0.15, "vol": 0.22, "beta": 1.15},
    "WMT": {"px": 78.0, "mu": 0.10, "vol": 0.18, "beta": 0.70},
    "TGT": {"px": 150.0, "mu": 0.05, "vol": 0.28, "beta": 0.95},
    "UPS": {"px": 135.0, "mu": 0.04, "vol": 0.26, "beta": 1.05},
    "FDX": {"px": 270.0, "mu": 0.06, "vol": 0.27, "beta": 1.08},
}

_DEFAULT_PROFILE = {"px": 100.0, "mu": 0.08, "vol": 0.22, "beta": 1.00}


# ---------------------------------------------------------------------------
# Sample-data synthesis (deterministic, md5-seeded)
# ---------------------------------------------------------------------------

def _seed(*parts: str) -> int:
    return int(hashlib.md5("".join(parts).encode()).hexdigest()[:8], 16)


def _sample_dates(n: int) -> list[str]:
    """`n` weekday date strings ending today (most recent last)."""
    out: list[str] = []
    d = date.today()
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _profile(symbol: str) -> dict:
    return SAMPLE_PROFILE.get(symbol.upper(), _DEFAULT_PROFILE)


def _sample_pair_prices(sym1: str, sym2: str, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Two cointegrated-ish geometric walks sharing a common market factor.

    The shared factor creates genuine co-movement; per-leg idiosyncratic noise
    plus a slowly mean-reverting spread component keeps the relative value
    interesting (so z-scores wander rather than sit at zero).
    """
    rng = np.random.default_rng(_seed(sym1.upper(), "/", sym2.upper()))
    p1, p2 = _profile(sym1), _profile(sym2)

    # Shared market factor (daily).
    mkt = rng.normal(0.0005, 0.010, n)

    def _leg(prof: dict, idio_seed: int) -> np.ndarray:
        r = np.random.default_rng(idio_seed)
        mu = prof["mu"] / 252.0
        vol = prof["vol"] / np.sqrt(252.0)
        beta = prof["beta"]
        idio = r.normal(0.0, vol * 0.6, n)
        rets = mu + beta * mkt + idio
        return prof["px"] * np.cumprod(1.0 + np.concatenate([[0.0], rets]))[:n]

    a = _leg(p1, _seed(sym1.upper(), "a"))
    b = _leg(p2, _seed(sym2.upper(), "b"))
    return a, b


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def _ols_slope(x: np.ndarray, y: np.ndarray) -> float:
    """OLS slope of y on x (with intercept). Guards against zero variance."""
    xm, ym = float(np.mean(x)), float(np.mean(y))
    denom = float(np.sum((x - xm) ** 2))
    if denom <= 1e-12:
        return 1.0
    return float(np.sum((x - xm) * (y - ym)) / denom)


def _half_life(spread: np.ndarray) -> float:
    """Mean-reversion half-life from an AR(1) fit on the spread.

    Fit  d_spread_t = lambda * spread_{t-1} + c  via OLS; half-life is
    -ln(2)/ln(1+lambda). Clamped to a sane range; returns the cap when the
    series shows no mean reversion (lambda >= 0).
    """
    lag = spread[:-1]
    delta = np.diff(spread)
    lam = _ols_slope(lag, delta)
    if lam >= -1e-6 or lam <= -1.0:
        return HALF_LIFE_MAX
    hl = -np.log(2.0) / np.log(1.0 + lam)
    if not np.isfinite(hl) or hl <= 0:
        return HALF_LIFE_MAX
    return float(min(max(hl, HALF_LIFE_MIN), HALF_LIFE_MAX))


def _adf_proxy(spread: np.ndarray) -> float:
    """Rough ADF-style statistic (heuristic, NOT a real ADF test).

    Regress d_spread on lagged spread; the t-stat on the lag coefficient is a
    crude stationarity signal. A more-negative value implies stronger mean
    reversion / cointegration. Honest label: this is a proxy, not statsmodels.
    """
    lag = spread[:-1]
    delta = np.diff(spread)
    n = len(lag)
    if n < 10:
        return 0.0
    xm = float(np.mean(lag))
    sxx = float(np.sum((lag - xm) ** 2))
    if sxx <= 1e-12:
        return 0.0
    lam = float(np.sum((lag - xm) * (delta - np.mean(delta))) / sxx)
    resid = delta - (np.mean(delta) + lam * (lag - xm))
    dof = max(n - 2, 1)
    sigma2 = float(np.sum(resid ** 2) / dof)
    se = np.sqrt(sigma2 / sxx) if sxx > 0 else 0.0
    if se <= 1e-12:
        return 0.0
    return float(lam / se)


def _signal(z: float, sym1: str, sym2: str) -> str:
    if z >= 2.0:
        return f"Short spread (sell {sym1}/buy {sym2})"
    if z <= -2.0:
        return f"Long spread (buy {sym1}/sell {sym2})"
    return "Neutral"


def _downsample(items: list, target: int) -> list:
    n = len(items)
    if n <= target:
        return items
    step = n / float(target)
    out = [items[min(int(i * step), n - 1)] for i in range(target)]
    if out[-1] is not items[-1]:
        out[-1] = items[-1]
    return out


def _align_live(sym1: str, sym2: str) -> tuple[list[str], np.ndarray, np.ndarray] | None:
    """Try to build aligned close arrays from the live fetcher. None on failure."""
    try:
        bars1 = fetch_arbitrary_ticker(sym1, days=LOOKBACK_DAYS + 10) or []
        bars2 = fetch_arbitrary_ticker(sym2, days=LOOKBACK_DAYS + 10) or []
    except Exception as e:  # pragma: no cover - defensive
        log.warning("pairs live fetch failed %s/%s: %s", sym1, sym2, e)
        return None
    m1 = {b["date"]: float(b["value"]) for b in bars1 if b.get("value") is not None}
    m2 = {b["date"]: float(b["value"]) for b in bars2 if b.get("value") is not None}
    common = sorted(set(m1) & set(m2))
    if len(common) < MIN_POINTS:
        return None
    p1 = np.array([m1[d] for d in common], dtype=float)
    p2 = np.array([m2[d] for d in common], dtype=float)
    if np.any(p1 <= 0) or np.any(p2 <= 0):
        return None
    return common, p1, p2


def _compute(sym1: str, sym2: str, dates: list[str], p1: np.ndarray, p2: np.ndarray) -> dict:
    """Core stat-arb math shared by live + sample paths."""
    lp1, lp2 = np.log(p1), np.log(p2)
    beta = _ols_slope(lp2, lp1)  # slope of sym1 (log) on sym2 (log)
    spread = lp1 - beta * lp2
    s_mean = float(np.mean(spread))
    s_std = float(np.std(spread))
    if s_std <= 1e-12:
        s_std = 1e-12
    z_series = (spread - s_mean) / s_std
    z_now = float(z_series[-1])

    r1 = np.diff(lp1)
    r2 = np.diff(lp2)
    if len(r1) > 1 and np.std(r1) > 0 and np.std(r2) > 0:
        corr = float(np.corrcoef(r1, r2)[0, 1])
    else:
        corr = 0.0

    hl = _half_life(spread)
    coint_stat = _adf_proxy(spread)
    cointegrated = bool(coint_stat <= -2.0)  # rough threshold (heuristic)

    ratio = p1 / p2
    ratio_pts = [{"date": d, "ratio": round(float(r), 4)} for d, r in zip(dates, ratio)]
    z_pts = [{"date": d, "z": round(float(z), 4)} for d, z in zip(dates, z_series)]

    return {
        "sym1": sym1,
        "sym2": sym2,
        "beta": round(beta, 4),
        "correlation": round(corr, 4),
        "half_life_days": round(hl, 1),
        "z_score": round(z_now, 3),
        "coint_stat": round(coint_stat, 3),
        "cointegrated": cointegrated,
        "signal": _signal(z_now, sym1, sym2),
        "ratio_series": _downsample(ratio_pts, CHART_POINTS),
        "zscore_series": _downsample(z_pts, CHART_POINTS),
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def pairs_analysis(sym1: str, sym2: str) -> dict:
    """Full statistical-arbitrage analysis of one pair. Never raises."""
    s1 = (sym1 or "").strip().upper() or "KO"
    s2 = (sym2 or "").strip().upper() or "PEP"
    now = datetime.now(timezone.utc).isoformat()

    try:
        live = _align_live(s1, s2)
        if live is not None:
            dates, p1, p2 = live
            payload = _compute(s1, s2, dates, p1, p2)
            payload.update(data_mode="live", as_of=now, source="yfinance closes")
            return payload
    except Exception as e:  # pragma: no cover - defensive
        log.warning("pairs_analysis live path failed %s/%s: %s", s1, s2, e)

    # Sample fallback - deterministic, fully populated.
    try:
        n = LOOKBACK_DAYS
        dates = _sample_dates(n)
        a, b = _sample_pair_prices(s1, s2, n)
        payload = _compute(s1, s2, dates, a, b)
        payload.update(data_mode="sample", as_of=now, source="sample (deterministic)")
        return payload
    except Exception as e:  # pragma: no cover - last-resort
        log.error("pairs_analysis sample path failed %s/%s: %s", s1, s2, e)
        return {
            "sym1": s1, "sym2": s2, "beta": 1.0, "correlation": 0.0,
            "half_life_days": HALF_LIFE_MAX, "z_score": 0.0, "coint_stat": 0.0,
            "cointegrated": False, "signal": "Neutral",
            "ratio_series": [], "zscore_series": [],
            "data_mode": "sample", "as_of": now, "source": "sample (deterministic)",
        }


def pairs_screen() -> dict:
    """Run the curated pair list and return each with z-score + signal.

    Sorted by abs(z_score) descending. data_mode reflects whether any leg fell
    back to sample data. Never raises.
    """
    now = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    any_sample = False
    any_live = False

    for s1, s2, label in CURATED_PAIRS:
        try:
            res = pairs_analysis(s1, s2)
        except Exception as e:  # pragma: no cover - pairs_analysis never raises
            log.warning("pairs_screen row failed %s/%s: %s", s1, s2, e)
            continue
        if res.get("data_mode") == "sample":
            any_sample = True
        else:
            any_live = True
        rows.append({
            "sym1": s1,
            "sym2": s2,
            "label": label,
            "z_score": res["z_score"],
            "correlation": res["correlation"],
            "half_life_days": res["half_life_days"],
            "signal": res["signal"],
        })

    rows.sort(key=lambda r: abs(r["z_score"]), reverse=True)

    if any_live and not any_sample:
        mode, source = "live", "yfinance closes"
    elif any_live and any_sample:
        mode, source = "live", "yfinance closes (partial sample)"
    else:
        mode, source = "sample", "sample (deterministic)"

    return {"pairs": rows, "data_mode": mode, "as_of": now, "source": source}
