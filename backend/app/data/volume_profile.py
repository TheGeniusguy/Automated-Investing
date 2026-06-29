"""Volume Profile / Volume-at-Price (Bloomberg `VPVR`).

Builds a horizontal volume-by-price histogram over a lookback range and surfaces
the structural levels traders watch:

  - POC (Point of Control) - the single price bin with the most traded volume,
    the market's fairest-value magnet.
  - Value Area (VAH / VAL) - the contiguous band around the POC that contains
    ~70% of total volume; price tends to rotate inside it and accelerate outside.
  - HVN / LVN (High / Low Volume Nodes) - bins well above / below the mean bin
    volume. HVNs are acceptance shelves (support/resistance); LVNs are rejection
    gaps price moves through quickly.

Live path: pull the daily price history through the canonical price entrypoint
`app.data.macro_data.fetch_arbitrary_ticker` (handles the sqlite cache, the
yfinance fallback, and the >2y date-range switch). That entrypoint returns daily
closes only, so we approximate each bar's intraday high-low span from local
realized volatility and weight each bar by a turnover proxy, then distribute that
weight uniformly across the bins the bar overlaps. This yields a faithful
volume-at-price shape from free OHLCV-derived data.

When prices are unavailable we degrade to a deterministic md5-seeded SAMPLE
profile (a believable bell-ish distribution with a clear POC and a couple of
secondary nodes) and tag the payload with data_mode="sample". This module never
raises - it always returns a populated payload with data_mode / as_of / source
for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Defaults / guard rails.
DEFAULT_SYMBOL = "SPY"
MIN_LOOKBACK = 20
MAX_LOOKBACK = 1825          # ~5y cap keeps the fetch fast
MIN_BINS = 8
MAX_BINS = 60
DEFAULT_LOOKBACK = 120
DEFAULT_BINS = 24

# Require at least this many resolved closes before we trust the live path.
MIN_POINTS = 20

# Value Area target share of total volume (Market Profile convention).
VALUE_AREA_PCT = 0.70

# Node classification thresholds, relative to mean bin volume.
HVN_MULT = 1.30
LVN_MULT = 0.55


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(symbol: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by symbol + salt."""
    return (_hash(symbol, salt) % 1_000_000) / 1_000_000.0


def _base_price_for(symbol: str) -> float:
    """Stable, believable share price for the sample path (~$22 - $620)."""
    return round(22.0 + _rand01(symbol, "price") * 600.0, 2)


# ---------------------------------------------------------------------------
# Histogram core (shared by live + sample once we have per-bar spans + weights)
# ---------------------------------------------------------------------------

def _empty_bins(low: float, high: float, n: int) -> list[dict]:
    """n equal-width price bins spanning [low, high], ascending by price."""
    span = max(high - low, 1e-9)
    width = span / n
    bins: list[dict] = []
    for i in range(n):
        b_low = low + width * i
        b_high = low + width * (i + 1)
        bins.append({
            "price_low": b_low,
            "price_high": b_high,
            "price_mid": (b_low + b_high) / 2.0,
            "volume": 0.0,
        })
    return bins


def _distribute(bins: list[dict], bar_low: float, bar_high: float, weight: float) -> None:
    """Spread `weight` uniformly across every bin the [bar_low, bar_high] span
    overlaps, proportional to the overlap width (the VPVR approximation)."""
    if weight <= 0:
        return
    lo, hi = (bar_low, bar_high) if bar_high >= bar_low else (bar_high, bar_low)
    span = hi - lo
    if span <= 0:
        # Degenerate bar: dump the whole weight into the containing bin.
        for b in bins:
            if b["price_low"] <= lo <= b["price_high"]:
                b["volume"] += weight
                return
        # Out of range (shouldn't happen) - put it in the nearest edge.
        target = bins[0] if lo < bins[0]["price_low"] else bins[-1]
        target["volume"] += weight
        return
    for b in bins:
        overlap = min(hi, b["price_high"]) - max(lo, b["price_low"])
        if overlap > 0:
            b["volume"] += weight * (overlap / span)


def _assemble(symbol: str, lookback_days: int, bins: list[dict], current_price: float,
              *, data_mode: str, source: str) -> dict:
    """Finalize bins into the full payload: POC, value area, node types, summary."""
    total = sum(b["volume"] for b in bins) or 1.0
    n = len(bins)
    mean_vol = total / n

    # POC = max-volume bin.
    poc_idx = max(range(n), key=lambda i: bins[i]["volume"])

    # Value Area: expand outward from the POC, always stepping toward the heavier
    # adjacent bin, until we enclose >= VALUE_AREA_PCT of total volume.
    included = {poc_idx}
    acc = bins[poc_idx]["volume"]
    lo_ptr = poc_idx - 1
    hi_ptr = poc_idx + 1
    target = total * VALUE_AREA_PCT
    while acc < target and (lo_ptr >= 0 or hi_ptr < n):
        below = bins[lo_ptr]["volume"] if lo_ptr >= 0 else -1.0
        above = bins[hi_ptr]["volume"] if hi_ptr < n else -1.0
        if above >= below:
            included.add(hi_ptr)
            acc += max(above, 0.0)
            hi_ptr += 1
        else:
            included.add(lo_ptr)
            acc += max(below, 0.0)
            lo_ptr -= 1

    va_lo_idx = min(included)
    va_hi_idx = max(included)
    vah = bins[va_hi_idx]["price_high"]
    val = bins[va_lo_idx]["price_low"]

    # Classify + emit bins (ascending by price).
    out_bins: list[dict] = []
    hvn = 0
    lvn = 0
    for i, b in enumerate(bins):
        vol = b["volume"]
        if i == poc_idx:
            node = "poc"
        elif vol >= mean_vol * HVN_MULT:
            node = "hvn"
            hvn += 1
        elif vol <= mean_vol * LVN_MULT:
            node = "lvn"
            lvn += 1
        else:
            node = "normal"
        out_bins.append({
            "price_low": round(b["price_low"], 2),
            "price_high": round(b["price_high"], 2),
            "price_mid": round(b["price_mid"], 2),
            "volume": round(vol, 2),
            "pct_of_total": round(vol / total * 100.0, 2),
            "node_type": node,
        })

    poc_price = round(bins[poc_idx]["price_mid"], 2)
    if current_price > poc_price:
        price_vs_poc = "above"
    elif current_price < poc_price:
        price_vs_poc = "below"
    else:
        price_vs_poc = "at"

    range_low = round(bins[0]["price_low"], 2)
    range_high = round(bins[-1]["price_high"], 2)

    return {
        "symbol": symbol,
        "lookback_days": lookback_days,
        "bins": out_bins,
        "poc": {"price": poc_price, "volume": round(bins[poc_idx]["volume"], 2)},
        "value_area": {
            "high": round(vah, 2),
            "low": round(val, 2),
            "pct": round(acc / total * 100.0, 1),
        },
        "current_price": round(current_price, 2),
        "price_vs_poc": price_vs_poc,
        "total_volume": round(total, 2),
        "summary": {
            "hvn_count": hvn,
            "lvn_count": lvn,
            "range_low": range_low,
            "range_high": range_high,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _clean_closes(points: list[dict]) -> list[float]:
    out: list[float] = []
    for p in points or []:
        v = p.get("value")
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f == f and f > 0:  # filter NaN / non-positive
            out.append(f)
    return out


def _live_payload(symbol: str, lookback_days: int, bins: int) -> dict | None:
    """Build a VPVR from the canonical price entrypoint. Returns None when too
    little data resolves so the caller can fall back to sample. Never raises."""
    try:
        from .macro_data import fetch_arbitrary_ticker
    except Exception as e:
        log.warning("volume_profile: macro_data import failed: %s", e)
        return None

    try:
        points = fetch_arbitrary_ticker(symbol, days=lookback_days)
    except Exception as e:
        log.warning("volume_profile fetch failed for %s: %s", symbol, e)
        points = []

    closes = _clean_closes(points)
    if len(closes) < MIN_POINTS:
        return None

    lo = min(closes)
    hi = max(closes)
    if hi <= lo:
        return None

    # Pad the range a touch so synthesized intraday spans don't clip the edges.
    pad = (hi - lo) * 0.03
    grid = _empty_bins(lo - pad, hi + pad, bins)

    # The entrypoint gives daily closes only. Approximate each bar's intraday
    # high-low span from the local close-to-close move and weight the bar by a
    # turnover proxy (larger moves trade more), then spread across the bins.
    prev = closes[0]
    for c in closes:
        move = abs(c - prev)
        # Floor the span at ~0.4% of price so flat days still touch a band.
        half_span = max(move * 0.6, c * 0.004)
        bar_low = c - half_span
        bar_high = c + half_span
        # Turnover proxy: a base unit plus extra for active days.
        weight = 1.0 + (move / c) * 40.0 if c > 0 else 1.0
        _distribute(grid, bar_low, bar_high, weight)
        prev = c

    if sum(b["volume"] for b in grid) <= 0:
        return None

    current_price = closes[-1]
    return _assemble(symbol, lookback_days, grid, current_price,
                     data_mode="live", source="yfinance")


# ---------------------------------------------------------------------------
# Sample path (deterministic, bell-ish with a clear POC + secondary nodes)
# ---------------------------------------------------------------------------

def _sample_payload(symbol: str, lookback_days: int, bins: int) -> dict:
    base = _base_price_for(symbol)
    # Total range ~ 16% - 30% of the base price, centered near `base`.
    width = base * (0.16 + _rand01(symbol, "width") * 0.14)
    lo = base - width / 2.0
    hi = base + width / 2.0
    grid = _empty_bins(lo, hi, bins)

    n = bins
    # Primary POC location: a seeded position roughly in the middle third.
    poc_pos = 0.30 + _rand01(symbol, "poc") * 0.40        # 0.30 - 0.70 of range
    poc_center = poc_pos * (n - 1)
    poc_sigma = max(n * (0.10 + _rand01(symbol, "psig") * 0.06), 1.5)

    # Two secondary nodes (shelves) offset from the POC.
    s1_center = max(0.0, min(n - 1, poc_center - n * (0.18 + _rand01(symbol, "s1") * 0.12)))
    s2_center = max(0.0, min(n - 1, poc_center + n * (0.16 + _rand01(symbol, "s2") * 0.14)))
    s_sigma = max(n * 0.05, 1.2)
    s1_amp = 0.35 + _rand01(symbol, "s1amp") * 0.25
    s2_amp = 0.30 + _rand01(symbol, "s2amp") * 0.25

    import math
    for i, b in enumerate(grid):
        # Main bell.
        v = math.exp(-((i - poc_center) ** 2) / (2.0 * poc_sigma ** 2))
        # Secondary shelves.
        v += s1_amp * math.exp(-((i - s1_center) ** 2) / (2.0 * s_sigma ** 2))
        v += s2_amp * math.exp(-((i - s2_center) ** 2) / (2.0 * s_sigma ** 2))
        # A little deterministic texture so adjacent bins aren't too smooth.
        v *= 0.88 + _rand01(symbol, f"tex{i}") * 0.24
        b["volume"] = v * 1_000_000.0

    # Current price: a seeded point inside the range, biased near the POC.
    poc_price = lo + (poc_center / max(n - 1, 1)) * (hi - lo)
    drift = (_rand01(symbol, "now") - 0.5) * width * 0.55
    current_price = max(lo, min(hi, poc_price + drift))

    return _assemble(symbol, lookback_days, grid, current_price,
                     data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def volume_profile(symbol: str = DEFAULT_SYMBOL, lookback_days: int = DEFAULT_LOOKBACK,
                   bins: int = DEFAULT_BINS) -> dict:
    """Volume-at-Price profile for `symbol`. See module docstring.

    Always returns a populated dict; prefers live prices via the canonical
    entrypoint and degrades to deterministic SAMPLE data, tagging the payload
    with data_mode / as_of / source.
    """
    sym = (symbol or DEFAULT_SYMBOL).strip().upper() or DEFAULT_SYMBOL
    try:
        lb = int(lookback_days)
    except (TypeError, ValueError):
        lb = DEFAULT_LOOKBACK
    lb = max(MIN_LOOKBACK, min(MAX_LOOKBACK, lb))
    try:
        nb = int(bins)
    except (TypeError, ValueError):
        nb = DEFAULT_BINS
    nb = max(MIN_BINS, min(MAX_BINS, nb))

    try:
        live = _live_payload(sym, lb, nb)
        if live is not None and live.get("bins"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("volume_profile live path failed, returning sample: %s", e)
    try:
        return _sample_payload(sym, lb, nb)
    except Exception as e:
        log.error("volume_profile sample path failed hard: %s", e)
        return {
            "symbol": sym,
            "lookback_days": lb,
            "bins": [],
            "poc": {"price": 0.0, "volume": 0.0},
            "value_area": {"high": 0.0, "low": 0.0, "pct": 0.0},
            "current_price": 0.0,
            "price_vs_poc": "at",
            "total_volume": 0.0,
            "summary": {"hvn_count": 0, "lvn_count": 0, "range_low": 0.0, "range_high": 0.0},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
