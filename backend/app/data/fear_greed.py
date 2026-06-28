"""Market-Wide Fear & Greed Index engine (Wave F feature).

Builds the famous CNN-style 0-100 sentiment gauge (0 = Extreme Fear,
100 = Extreme Greed) as a composite of ~7 market-derived sub-indicators,
each normalized to 0-100 and then averaged:

  1. Market Momentum     - SPY vs its 125-day moving average
  2. Stock Price Strength - SPY 20-day return percentile vs its trailing year
  3. Market Volatility   - VIX level (inverted) and vs its 50-day average
  4. Safe-Haven Demand   - SPY 20-day return minus TLT 20-day return
  5. Junk-Bond Demand    - HYG vs LQD 20-day relative strength
  6. Put/Call Options    - VIX-derived implied put/call proxy (inverted)
  7. Market Breadth      - RSP (equal weight) vs SPY 20-day relative strength

Live path: prices via app.data.macro_data.fetch_arbitrary_ticker (guarded).
When a live source is unavailable, individual sub-indicators are dropped or
filled from a deterministic md5-seeded synthetic series; if too little data is
available we degrade to a fully-populated md5-seeded SAMPLE snapshot tagged
data_mode="sample". This module NEVER raises - it always returns a populated
payload tagged with data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

TRADING_DAYS = 252
HISTORY_DAYS = 252          # ~1y of composite history for the chart
MA_WINDOW = 125             # market-momentum moving average
RET_WINDOW = 20             # standard relative-strength lookback
VIX_AVG_WINDOW = 50

# Symbols pulled for the sub-indicators. SPY is the spine (required for history).
SPY = "SPY"
VIX = "^VIX"
SAMPLE_SYMBOLS = [SPY, VIX, "TLT", "HYG", "LQD", "RSP"]

# Deterministic synthetic-walk profile per symbol: (ann_return, ann_vol, base).
SAMPLE_WALK: dict[str, tuple[float, float, float]] = {
    SPY:   (0.105, 0.150, 540.0),
    VIX:   (0.000, 0.650, 16.0),
    "TLT": (0.020, 0.155, 92.0),
    "HYG": (0.045, 0.075, 79.0),
    "LQD": (0.035, 0.080, 110.0),
    "RSP": (0.090, 0.165, 175.0),
}

# Classification bands shared by the composite and each sub-indicator.
BANDS = [
    (0, 24, "Extreme Fear"),
    (25, 44, "Fear"),
    (45, 55, "Neutral"),
    (56, 74, "Greed"),
    (75, 100, "Extreme Greed"),
]


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _linmap(value: float, lo: float, hi: float) -> float:
    """Map value from [lo, hi] onto [0, 100], clamped. Works when hi < lo
    (descending), which we use for inverted indicators like VIX."""
    if hi == lo:
        return 50.0
    t = (value - lo) / (hi - lo)
    return _clamp(t * 100.0)


def classify(score: float) -> str:
    s = int(round(score))
    for lo, hi, label in BANDS:
        if lo <= s <= hi:
            return label
    return "Neutral"


# ---------------------------------------------------------------------------
# Deterministic sample-series synthesis (md5-seeded, stable across calls)
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_dates(days: int) -> list[str]:
    out: list[str] = []
    d = date.today()
    while len(out) < days:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_series(symbol: str, n: int) -> np.ndarray:
    """Deterministic geometric walk for one symbol. For ^VIX we build a
    mean-reverting positive level instead of a drifting price."""
    ann_ret, ann_vol, base = SAMPLE_WALK.get(symbol, (0.08, 0.18, 100.0))
    rng = np.random.default_rng(_seed(symbol))
    if symbol == VIX:
        # Ornstein-Uhlenbeck-ish mean reversion around the base level.
        level = base
        out = np.empty(n)
        for i in range(n):
            shock = rng.normal(0.0, 1.6)
            level = max(9.5, level + 0.05 * (base - level) + shock)
            out[i] = level
        return out
    mu = ann_ret / TRADING_DAYS
    sig = ann_vol / np.sqrt(TRADING_DAYS)
    rets = rng.normal(mu, sig, n)
    return base * np.cumprod(1.0 + np.concatenate([[0.0], rets]))[1:]


# ---------------------------------------------------------------------------
# Live-series extraction
# ---------------------------------------------------------------------------

def _vals(points) -> list[float]:
    if not points:
        return []
    return [float(p["value"]) for p in points if p.get("value") is not None]


def _ret(arr, window: int) -> float | None:
    if arr is None or len(arr) < window + 1:
        return None
    base = arr[-(window + 1)]
    if not base:
        return None
    return float(arr[-1] / base - 1.0)


# ---------------------------------------------------------------------------
# Sub-indicator construction
# ---------------------------------------------------------------------------

def _component(name: str, value: float, note: str) -> dict:
    v = round(float(value), 1)
    return {"name": name, "value": v, "label": classify(v), "note": note}


def _build_components(series: dict[str, np.ndarray]) -> list[dict]:
    """Build whichever sub-indicators the available series support."""
    spy = series.get(SPY)
    vix = series.get(VIX)
    tlt = series.get("TLT")
    hyg = series.get("HYG")
    lqd = series.get("LQD")
    rsp = series.get("RSP")
    out: list[dict] = []

    # 1. Market Momentum - SPY vs 125-day moving average.
    if spy is not None and len(spy) >= MA_WINDOW + 1:
        ma = float(np.mean(spy[-MA_WINDOW:]))
        ratio = float(spy[-1] / ma) if ma else 1.0
        gap = (ratio - 1.0) * 100.0
        out.append(_component(
            "Market Momentum",
            _linmap(ratio, 0.90, 1.10),
            f"S&P 500 is {gap:+.1f}% vs its 125-day average",
        ))

    # 2. Stock Price Strength - 20-day return percentile vs trailing year.
    if spy is not None and len(spy) >= RET_WINDOW + 40:
        window = spy[-(HISTORY_DAYS + RET_WINDOW):]
        r20 = (window[RET_WINDOW:] / window[:-RET_WINDOW]) - 1.0
        cur = float(r20[-1])
        pct = float((r20 < cur).mean() * 100.0)
        out.append(_component(
            "Stock Price Strength",
            pct,
            f"20-day return ranks in the {pct:.0f}th percentile of the past year",
        ))

    # 3. Market Volatility - VIX level inverted, blended with VIX vs 50-day avg.
    if vix is not None and len(vix) >= 1:
        level = float(vix[-1])
        level_score = _linmap(level, 38.0, 12.0)
        if len(vix) >= VIX_AVG_WINDOW:
            avg = float(np.mean(vix[-VIX_AVG_WINDOW:]))
            rel = level / avg if avg else 1.0
            rel_score = _linmap(rel, 1.25, 0.80)
            value = (level_score + rel_score) / 2.0
            note = f"VIX {level:.1f}, {(rel - 1) * 100:+.0f}% vs its 50-day average"
        else:
            value = level_score
            note = f"VIX at {level:.1f}"
        out.append(_component("Market Volatility", value, note))

    # 4. Safe-Haven Demand - 20-day stock return minus 20-day bond return.
    s20, t20 = _ret(spy, RET_WINDOW), _ret(tlt, RET_WINDOW)
    if s20 is not None and t20 is not None:
        diff = s20 - t20
        out.append(_component(
            "Safe-Haven Demand",
            _linmap(diff, -0.06, 0.06),
            f"Stocks vs 20Y bonds spread {diff * 100:+.1f}% over 20 days",
        ))

    # 5. Junk-Bond Demand - HYG vs LQD relative strength (tighter spreads = greed).
    h20, l20 = _ret(hyg, RET_WINDOW), _ret(lqd, RET_WINDOW)
    if h20 is not None and l20 is not None:
        diff = h20 - l20
        out.append(_component(
            "Junk Bond Demand",
            _linmap(diff, -0.03, 0.03),
            f"High-yield vs investment-grade spread {diff * 100:+.1f}% over 20 days",
        ))

    # 6. Put/Call Options - VIX-derived implied put/call proxy (inverted).
    if vix is not None and len(vix) >= 1:
        level = float(vix[-1])
        pc = 0.62 + max(0.0, level - 12.0) * 0.017
        out.append(_component(
            "Put/Call Options",
            _linmap(pc, 1.05, 0.65),
            f"Implied put/call proxy {pc:.2f}",
        ))

    # 7. Market Breadth - RSP (equal weight) vs SPY relative strength.
    r20, sp20 = _ret(rsp, RET_WINDOW), _ret(spy, RET_WINDOW)
    if r20 is not None and sp20 is not None:
        diff = r20 - sp20
        out.append(_component(
            "Market Breadth",
            _linmap(diff, -0.04, 0.04),
            f"Equal-weight vs cap-weight spread {diff * 100:+.1f}% over 20 days",
        ))

    return out


# ---------------------------------------------------------------------------
# Composite history (derived from SPY: momentum + strength + inverse vol)
# ---------------------------------------------------------------------------

def _build_history(spy: np.ndarray, dates: list[str]) -> list[dict]:
    n = len(spy)
    rets = np.diff(spy) / spy[:-1]
    start = max(MA_WINDOW + 1, RET_WINDOW + 1)
    pts: list[dict] = []
    for i in range(start, n):
        ma = float(np.mean(spy[i - MA_WINDOW:i]))
        mom = _linmap(float(spy[i] / ma) if ma else 1.0, 0.90, 1.10)
        base = spy[i - RET_WINDOW]
        r20 = float(spy[i] / base - 1.0) if base else 0.0
        strength = _linmap(r20, -0.10, 0.10)
        win = rets[max(0, i - RET_WINDOW):i]
        rv = float(np.std(win) * np.sqrt(TRADING_DAYS)) if len(win) > 2 else 0.15
        vol = _linmap(rv, 0.35, 0.07)
        score = round((mom + strength + vol) / 3.0, 1)
        pts.append({"date": dates[i], "score": score})
    return pts[-HISTORY_DAYS:]


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _at(history: list[dict], back: int) -> float | None:
    """Score `back` trading days before the latest point, if available."""
    idx = len(history) - 1 - back
    if 0 <= idx < len(history):
        return history[idx]["score"]
    return None


def _summary(score: float, label: str) -> str:
    if score >= 75:
        return "Investors are euphoric and chasing risk; sentiment is stretched to the upside."
    if score >= 56:
        return "Risk appetite is firm; buyers are in control across the market."
    if score >= 45:
        return "Sentiment is balanced; the market is neither fearful nor greedy."
    if score >= 25:
        return "Caution dominates; investors are de-risking and demanding safety."
    return "Investors are gripped by fear; selling pressure and hedging are extreme."


def _assemble(series: dict[str, np.ndarray], dates: list[str], *, data_mode: str, source: str) -> dict:
    components = _build_components(series)
    spy = series[SPY]
    history = _build_history(spy, dates)

    if components:
        composite = float(np.mean([c["value"] for c in components]))
    elif history:
        composite = history[-1]["score"]
    else:
        composite = 50.0
    score = int(round(composite))

    # Pin the last history point to the composite so the chart ends on the gauge.
    if history:
        history[-1] = {"date": history[-1]["date"], "score": float(score)}

    label = classify(score)
    comparison = {
        "previous_close": _at(history, 1),
        "week_ago": _at(history, 5),
        "month_ago": _at(history, 21),
        "year_ago": history[0]["score"] if history else None,
    }

    return {
        "score": score,
        "label": label,
        "summary": _summary(score, label),
        "components": components,
        "history": history,
        "comparison": comparison,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def fear_greed() -> dict:
    """Composite market-wide Fear & Greed index. Never raises - degrades to a
    deterministic SAMPLE snapshot tagged data_mode='sample'."""
    try:
        return _fear_greed_live()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("fear_greed failed hard, returning sample: %s", e)
        try:
            return _fear_greed_sample()
        except Exception:
            return {
                "score": 50, "label": "Neutral",
                "summary": _summary(50, "Neutral"),
                "components": [], "history": [],
                "comparison": {"previous_close": None, "week_ago": None,
                               "month_ago": None, "year_ago": None},
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": "sample",
            }


def _fear_greed_live() -> dict:
    need = HISTORY_DAYS + MA_WINDOW + 10  # enough for the 125d MA + 1y history
    series: dict[str, np.ndarray] = {}
    dates: list[str] = []

    for sym in SAMPLE_SYMBOLS:
        try:
            pts = fetch_arbitrary_ticker(sym, days=need)
        except Exception:
            pts = []
        vals = _vals(pts)
        if vals:
            series[sym] = np.asarray(vals, dtype=float)
            if sym == SPY:
                dates = [p["date"] for p in pts if p.get("value") is not None]

    spy = series.get(SPY)
    components = _build_components(series) if spy is not None else []

    # Degrade to sample if the spine is missing or almost nothing resolved.
    if spy is None or len(spy) < MA_WINDOW + RET_WINDOW + 1 or len(components) < 3:
        return _fear_greed_sample()

    return _assemble(series, dates, data_mode="live", source="yfinance + cboe")


def _fear_greed_sample() -> dict:
    need = HISTORY_DAYS + MA_WINDOW + 10
    dates = _sample_dates(need)
    n = len(dates)
    series = {sym: _sample_series(sym, n) for sym in SAMPLE_SYMBOLS}
    return _assemble(series, dates, data_mode="sample", source="sample")
