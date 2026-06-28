"""Relative Rotation Graph engine (Bloomberg RRG, Wave F).

Plots the 11 SPDR sector ETFs against a benchmark (default SPY) on the classic
JdK RS-Ratio (x) vs RS-Momentum (y) plane. The (100, 100) origin splits the
plane into four rotation quadrants:

    Leading    (RS-Ratio > 100, RS-Momentum > 100)
    Weakening  (RS-Ratio > 100, RS-Momentum < 100)
    Lagging    (RS-Ratio < 100, RS-Momentum < 100)
    Improving  (RS-Ratio < 100, RS-Momentum > 100)

Sectors rotate clockwise through the quadrants over time. We return a short
weekly TAIL of recent (rs_ratio, rs_momentum) points per ETF so the panel can
draw each trajectory plus an arrowhead at the head.

Live path: weekly closes via app.data.macro_data.fetch_arbitrary_ticker. When a
live source is unavailable or too short we degrade to deterministic md5-seeded
SAMPLE tails spread realistically across all four quadrants. This module never
raises - it always returns a populated payload tagged with data_mode / as_of /
source for under-the-hood honesty.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

import numpy as np

from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

DEFAULT_BENCHMARK = "SPY"

# The 11 SPDR sector ETFs (Select Sector + Real Estate + Communication Services).
SECTOR_NAMES: dict[str, str] = {
    "XLK": "Technology",
    "XLF": "Financials",
    "XLV": "Health Care",
    "XLE": "Energy",
    "XLI": "Industrials",
    "XLY": "Consumer Discretionary",
    "XLP": "Consumer Staples",
    "XLU": "Utilities",
    "XLB": "Materials",
    "XLRE": "Real Estate",
    "XLC": "Communication Services",
}
SECTORS: list[str] = list(SECTOR_NAMES.keys())

# Lookback + smoothing parameters (JdK-style).
LOOKBACK_DAYS = 95           # ~3 months of calendar days
RS_SMOOTH = 5                # weeks of smoothing on raw RS for the ratio
MOM_SMOOTH = 3               # weeks of smoothing on the ratio rate-of-change
TAIL_LEN = 6                 # weekly points retained in each trajectory tail
MIN_WEEKLY = 10              # minimum weekly points to attempt a live read


# ---------------------------------------------------------------------------
# Quadrant helper
# ---------------------------------------------------------------------------

def _quadrant(rs_ratio: float, rs_mom: float) -> str:
    if rs_ratio >= 100 and rs_mom >= 100:
        return "Leading"
    if rs_ratio >= 100 and rs_mom < 100:
        return "Weakening"
    if rs_ratio < 100 and rs_mom < 100:
        return "Lagging"
    return "Improving"


# ---------------------------------------------------------------------------
# JdK RS-Ratio / RS-Momentum math
# ---------------------------------------------------------------------------

def _sma(arr: np.ndarray, window: int) -> np.ndarray:
    """Trailing simple moving average, same length (left edge uses growing
    window so we never produce NaNs)."""
    out = np.empty_like(arr, dtype=float)
    for i in range(len(arr)):
        lo = max(0, i - window + 1)
        out[i] = float(np.mean(arr[lo : i + 1]))
    return out


def _normalize(series: np.ndarray, center: float = 101.0, scale: float = 1.5) -> np.ndarray:
    """Z-score a series and re-center to ~100 (JdK convention). `center` is the
    target mean (slightly above 100 so a leader sits in the Leading quadrant),
    `scale` widens the spread so points are readable on the plane."""
    mu = float(np.mean(series))
    sd = float(np.std(series))
    if sd <= 1e-9:
        return np.full_like(series, center, dtype=float)
    z = (series - mu) / sd
    return center + z * scale


def _rrg_tail(etf_closes: np.ndarray, bench_closes: np.ndarray) -> list[dict] | None:
    """Compute the weekly (rs_ratio, rs_momentum) tail from aligned weekly
    close arrays. Returns the last TAIL_LEN points, or None if too short."""
    n = min(len(etf_closes), len(bench_closes))
    if n < MIN_WEEKLY:
        return None
    etf = etf_closes[-n:]
    bench = bench_closes[-n:]
    if np.any(bench <= 0):
        return None

    # Relative strength line.
    rs = 100.0 * (etf / bench)

    # RS-Ratio: smoothed + normalized RS.
    rs_smooth = _sma(rs, RS_SMOOTH)
    rs_ratio = _normalize(rs_smooth, center=100.6, scale=1.6)

    # RS-Momentum: normalized rate-of-change of the RS-Ratio.
    roc = np.empty_like(rs_ratio)
    roc[0] = 0.0
    roc[1:] = rs_ratio[1:] - rs_ratio[:-1]
    roc_smooth = _sma(roc, MOM_SMOOTH)
    rs_mom = _normalize(roc_smooth, center=100.0, scale=1.6)

    tail = [
        {"rs_ratio": round(float(r), 3), "rs_momentum": round(float(m), 3)}
        for r, m in zip(rs_ratio[-TAIL_LEN:], rs_mom[-TAIL_LEN:])
    ]
    return tail if len(tail) >= 2 else None


def _to_weekly(points: list[dict]) -> np.ndarray:
    """Collapse a daily {date, value} series to weekly closes (every 5th bar,
    keeping the last). Returns a float array of closes."""
    vals = [float(p["value"]) for p in points if p.get("value") is not None]
    if not vals:
        return np.array([], dtype=float)
    arr = np.array(vals, dtype=float)
    # Take every 5th point from the end so the most recent close is included.
    idx = list(range(len(arr) - 1, -1, -5))
    weekly = arr[sorted(idx)]
    return weekly


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _live_points(benchmark: str) -> list[dict] | None:
    """Attempt a full live RRG read. Returns the points list or None on any
    insufficiency (caller falls back to sample)."""
    try:
        bench_raw = fetch_arbitrary_ticker(benchmark, days=LOOKBACK_DAYS + 10)
    except Exception:
        bench_raw = []
    bench_weekly = _to_weekly(bench_raw or [])
    if len(bench_weekly) < MIN_WEEKLY:
        return None

    points: list[dict] = []
    for sym in SECTORS:
        try:
            raw = fetch_arbitrary_ticker(sym, days=LOOKBACK_DAYS + 10)
        except Exception:
            raw = []
        weekly = _to_weekly(raw or [])
        m = min(len(weekly), len(bench_weekly))
        if m < MIN_WEEKLY:
            return None  # incomplete universe -> degrade wholesale for consistency
        tail = _rrg_tail(weekly[-m:], bench_weekly[-m:])
        if not tail:
            return None
        head = tail[-1]
        points.append({
            "symbol": sym,
            "name": SECTOR_NAMES[sym],
            "rs_ratio": head["rs_ratio"],
            "rs_momentum": head["rs_momentum"],
            "quadrant": _quadrant(head["rs_ratio"], head["rs_momentum"]),
            "tail": tail,
        })
    return points or None


# ---------------------------------------------------------------------------
# Sample path (deterministic md5-seeded, spread across all four quadrants)
# ---------------------------------------------------------------------------

# Hand-placed quadrant targets so a screenshot shows a realistic, balanced
# rotation: each sector anchored near a (rs_ratio, rs_momentum) head, with a
# trajectory angle so the tail sweeps in clockwise. Values centered on (100,100).
SAMPLE_ANCHORS: dict[str, tuple[float, float]] = {
    "XLK":  (102.6, 101.4),   # Leading
    "XLC":  (101.8, 100.6),   # Leading
    "XLF":  (101.2, 99.1),    # Weakening
    "XLI":  (100.7, 98.6),    # Weakening
    "XLE":  (98.4, 97.7),     # Lagging
    "XLB":  (98.9, 98.9),     # Lagging
    "XLP":  (97.9, 99.4),     # Lagging (edge)
    "XLU":  (98.6, 101.1),    # Improving
    "XLRE": (99.3, 101.8),    # Improving
    "XLV":  (99.6, 100.7),    # Improving
    "XLY":  (100.9, 100.9),   # Leading (edge)
}


def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_tail(symbol: str, head_x: float, head_y: float) -> list[dict]:
    """Build a TAIL_LEN weekly trajectory ending at (head_x, head_y), curving
    clockwise into the head. Deterministic per symbol."""
    rng = np.random.default_rng(_seed(symbol))
    # Distance the tail trails behind the head, and the arc it sweeps.
    radius = 0.7 + (rng.random() * 0.9)          # 0.7 .. 1.6 units back
    # Angle of the head relative to origin (100,100), then sweep clockwise.
    ang_head = math.atan2(head_y - 100.0, head_x - 100.0)
    sweep = math.radians(28 + rng.random() * 26)  # total arc swept by the tail
    pts: list[dict] = []
    for i in range(TAIL_LEN):
        # t goes 0 (oldest) -> 1 (head). Older points sit further back + rotated
        # counter-clockwise (so motion into the head is clockwise).
        t = i / (TAIL_LEN - 1)
        ang = ang_head + sweep * (1.0 - t)
        # Interpolate the radial distance from origin so the tail spirals.
        base_r = math.hypot(head_x - 100.0, head_y - 100.0)
        r = base_r - radius * (1.0 - t)
        jitter = (rng.random() - 0.5) * 0.12
        x = 100.0 + (r + jitter) * math.cos(ang)
        y = 100.0 + (r + jitter) * math.sin(ang)
        pts.append({"rs_ratio": round(float(x), 3), "rs_momentum": round(float(y), 3)})
    # Force the exact head so the dot sits on the anchor.
    pts[-1] = {"rs_ratio": round(float(head_x), 3), "rs_momentum": round(float(head_y), 3)}
    return pts


def _sample_points() -> list[dict]:
    points: list[dict] = []
    for sym in SECTORS:
        hx, hy = SAMPLE_ANCHORS[sym]
        tail = _sample_tail(sym, hx, hy)
        points.append({
            "symbol": sym,
            "name": SECTOR_NAMES[sym],
            "rs_ratio": round(float(hx), 3),
            "rs_momentum": round(float(hy), 3),
            "quadrant": _quadrant(hx, hy),
            "tail": tail,
        })
    return points


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def rrg(benchmark: str = DEFAULT_BENCHMARK) -> dict:
    """Relative Rotation Graph of the 11 SPDR sector ETFs vs `benchmark`.

    Never raises - degrades to deterministic SAMPLE tails and always returns a
    populated payload tagged with data_mode / as_of / source.
    """
    bench = (benchmark or DEFAULT_BENCHMARK).strip().upper() or DEFAULT_BENCHMARK
    data_mode = "sample"
    source = "sample"
    points: list[dict] | None = None

    try:
        points = _live_points(bench)
        if points:
            data_mode = "live"
            source = "yfinance"
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("rrg live path failed, using sample: %s", e)
        points = None

    if not points:
        points = _sample_points()
        data_mode = "sample"
        source = "sample"

    now = datetime.now(timezone.utc)
    return {
        "benchmark": bench,
        "as_of_date": now.date().isoformat(),
        "points": points,
        "data_mode": data_mode,
        "as_of": now.isoformat(timespec="seconds"),
        "source": source,
    }
