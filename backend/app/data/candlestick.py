"""Candlestick Pattern Recognition (Bloomberg `CNDL`).

A per-ticker scanner that flags classic single- and multi-bar candle
formations from pure OHLC geometry. No new data feed is introduced: the live
path pulls daily OHLC through the same `yf.Ticker(symbol).history(...)` access
the options modules use (the canonical `fetch_arbitrary_ticker` returns close
only, which is insufficient for body/wick math), and every fetch is guarded so
the module degrades to a deterministic, md5-seeded SAMPLE series rather than
raising.

Detectors implemented (all from body / shadow / gap / prior-trend geometry):

  Single bar : Doji, Marubozu (bull/bear), Hammer, Hanging Man,
               Inverted Hammer, Shooting Star
  Two bar    : Bullish/Bearish Engulfing, Bullish/Bearish Harami,
               Piercing Line, Dark Cloud Cover
  Three bar  : Morning Star, Evening Star, Three White Soldiers,
               Three Black Crows

Economic correctness is respected: the hammer / inverted-hammer geometry is a
*bullish* reversal only at the bottom of a downtrend, while the identical
geometry at the top of an uptrend is read as a *bearish* Hanging Man / Shooting
Star. Star, soldier and crow patterns require the appropriate prior trend too.

The public `candlestick(symbol)` function NEVER raises. The returned dict
carries an internal `data_mode` ("live" | "sample"), `as_of`, `source` and
`symbol` for honesty under the hood (no on-screen badge). When the sample path
is used the detections are the *real* output of running the detectors over the
constructed sample bars - the sample OHLC is deliberately built to contain the
patterns, never hand-faked.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

SOURCE_LIVE = "yfinance OHLC"
SOURCE_SAMPLE = "sample"

# Geometry thresholds (fractions of the bar's high-low range unless noted).
DOJI_BODY_MAX = 0.10        # body <= 10% of range -> doji-ish
MARUBOZU_BODY_MIN = 0.90    # body >= 90% of range -> marubozu
MARUBOZU_SHADOW_MAX = 0.06  # each shadow <= 6% of range
LONG_SHADOW_MIN = 0.50      # a "long" shadow is >= 50% of range
SMALL_SHADOW_MAX = 0.15     # a "small" shadow is <= 15% of range
SMALL_BODY_MAX = 0.35       # hammer / star real body <= 35% of range
LONG_BODY_MIN = 0.55        # engulfing / soldier / star real body >= 55% of range
HARAMI_BODY_MAX = 0.55      # inside ("harami") body <= 55% of the prior body

# How many bars to look back when classifying the prior trend.
TREND_LOOKBACK = 4
TREND_PCT = 0.025           # +/-2.5% over the lookback => up / down, else flat

# How many of the most recent bars to scan for the pattern's *final* bar.
SCAN_BARS = 60
HISTORY_BARS = 120          # how many bars we fetch / build
RECENT_OHLC = 20            # mini-candle array length for the panel


# ---------------------------------------------------------------------------
# Determinism helpers
# ---------------------------------------------------------------------------

def _jitter(symbol: str, key: str, lo: float, hi: float) -> float:
    """Stable pseudo-random value in [lo, hi] keyed by symbol+field."""
    h = int(hashlib.md5(f"{symbol}:{key}".encode()).hexdigest()[:8], 16)
    return lo + (h % 10_000) / 10_000.0 * (hi - lo)


def _business_dates(n: int) -> list[str]:
    """`n` ISO dates (oldest first) ending at the most recent weekday, skipping
    weekends. Deterministic given the current UTC date."""
    out: list[str] = []
    d = datetime.now(timezone.utc).date()
    while len(out) < n:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


# ---------------------------------------------------------------------------
# Bar geometry primitives
# ---------------------------------------------------------------------------

def _geo(b: dict) -> dict:
    """Derive body / shadow geometry for a single OHLC bar."""
    o, h, l, c = b["o"], b["h"], b["l"], b["c"]
    rng = h - l
    body = abs(c - o)
    upper = h - max(o, c)
    lower = min(o, c) - l
    return {
        "rng": rng,
        "body": body,
        "upper": upper,
        "lower": lower,
        "bull": c > o,
        "bear": c < o,
        "mid": (o + c) / 2.0,
        "body_pct": (body / rng) if rng > 0 else 0.0,
        "upper_pct": (upper / rng) if rng > 0 else 0.0,
        "lower_pct": (lower / rng) if rng > 0 else 0.0,
    }


def _clamp(x: float, lo: float = 1.0, hi: float = 100.0) -> int:
    return int(max(lo, min(hi, round(x))))


def _trend(bars: list[dict], before_idx: int, lookback: int = TREND_LOOKBACK) -> str:
    """Classify the trend over the `lookback` closes ending just before
    `before_idx` (the first bar of the pattern). Returns up / down / flat."""
    start = before_idx - lookback
    if start < 0:
        return "flat"
    first = bars[start]["c"]
    last = bars[before_idx - 1]["c"]
    if first <= 0:
        return "flat"
    pct = (last - first) / first
    if pct >= TREND_PCT:
        return "up"
    if pct <= -TREND_PCT:
        return "down"
    return "flat"


# ---------------------------------------------------------------------------
# Single-bar detectors (priority: marubozu -> hammer family -> doji)
# ---------------------------------------------------------------------------

def _single(bars: list[dict], i: int) -> dict | None:
    b = bars[i]
    g = _geo(b)
    if g["rng"] <= 0:
        return None
    trend = _trend(bars, i)

    # Marubozu: body fills the range, almost no shadows.
    if g["body_pct"] >= MARUBOZU_BODY_MIN and \
       g["upper_pct"] <= MARUBOZU_SHADOW_MAX and g["lower_pct"] <= MARUBOZU_SHADOW_MAX:
        if g["bull"]:
            s = _clamp(60 + (g["body_pct"] - MARUBOZU_BODY_MIN) * 300)
            return _det(bars, i, "Marubozu", "bullish", s)
        if g["bear"]:
            s = _clamp(60 + (g["body_pct"] - MARUBOZU_BODY_MIN) * 300)
            return _det(bars, i, "Marubozu", "bearish", s)

    # Hammer-shape: long lower shadow, tiny upper shadow, modest body.
    if g["lower_pct"] >= LONG_SHADOW_MIN and g["upper_pct"] <= SMALL_SHADOW_MAX \
       and g["body_pct"] <= SMALL_BODY_MAX:
        s = _clamp(40 + g["lower_pct"] * 50)
        if trend == "down":
            return _det(bars, i, "Hammer", "bullish", s)
        if trend == "up":
            return _det(bars, i, "Hanging Man", "bearish", s)

    # Inverted-shape: long upper shadow, tiny lower shadow, modest body.
    if g["upper_pct"] >= LONG_SHADOW_MIN and g["lower_pct"] <= SMALL_SHADOW_MAX \
       and g["body_pct"] <= SMALL_BODY_MAX:
        s = _clamp(40 + g["upper_pct"] * 50)
        if trend == "up":
            return _det(bars, i, "Shooting Star", "bearish", s)
        if trend == "down":
            return _det(bars, i, "Inverted Hammer", "bullish", s)

    # Doji: tiny body, both shadows present (not a one-sided hammer shape).
    if g["body_pct"] <= DOJI_BODY_MAX and g["upper_pct"] >= 0.1 and g["lower_pct"] >= 0.1:
        s = _clamp(35 + (DOJI_BODY_MAX - g["body_pct"]) * 300)
        return _det(bars, i, "Doji", "neutral", s)

    return None


# ---------------------------------------------------------------------------
# Two-bar detectors
# ---------------------------------------------------------------------------

def _two_bar(bars: list[dict], i: int) -> list[dict]:
    if i < 1:
        return []
    out: list[dict] = []
    p, c = bars[i - 1], bars[i]
    gp, gc = _geo(p), _geo(c)
    if gp["rng"] <= 0 or gc["rng"] <= 0:
        return out
    trend = _trend(bars, i - 1)

    # Engulfing: opposite colours, current real body fully covers the prior one.
    if gp["bear"] and gc["bull"] and c["o"] <= p["c"] and c["c"] >= p["o"] \
       and gc["body"] > gp["body"]:
        s = _clamp(50 + (gc["body"] / max(gp["body"], 1e-9) - 1) * 30)
        out.append(_det(bars, i, "Bullish Engulfing", "bullish", s))
    elif gp["bull"] and gc["bear"] and c["o"] >= p["c"] and c["c"] <= p["o"] \
            and gc["body"] > gp["body"]:
        s = _clamp(50 + (gc["body"] / max(gp["body"], 1e-9) - 1) * 30)
        out.append(_det(bars, i, "Bearish Engulfing", "bearish", s))

    # Harami: large prior body, small current body wholly inside it.
    inside = max(c["o"], c["c"]) <= max(p["o"], p["c"]) and \
        min(c["o"], c["c"]) >= min(p["o"], p["c"])
    if inside and gp["body_pct"] >= LONG_BODY_MIN and gc["body"] <= HARAMI_BODY_MAX * gp["body"]:
        s = _clamp(45 + (1 - gc["body"] / max(gp["body"], 1e-9)) * 30)
        if gp["bear"] and gc["bull"] and trend == "down":
            out.append(_det(bars, i, "Bullish Harami", "bullish", s))
        elif gp["bull"] and gc["bear"] and trend == "up":
            out.append(_det(bars, i, "Bearish Harami", "bearish", s))

    # Piercing Line: downtrend, gap-down open, close back above the prior midpoint
    # but not above the prior open (a full cover would be an engulfing instead).
    if gp["bear"] and gc["bull"] and gp["body_pct"] >= LONG_BODY_MIN \
       and c["o"] < p["l"] and gp["mid"] < c["c"] < p["o"]:
        depth = (c["c"] - gp["mid"]) / max(gp["body"], 1e-9)
        if trend == "down":
            out.append(_det(bars, i, "Piercing Line", "bullish", _clamp(50 + depth * 60)))

    # Dark Cloud Cover: uptrend, gap-up open, close back below the prior midpoint
    # but not below the prior open.
    if gp["bull"] and gc["bear"] and gp["body_pct"] >= LONG_BODY_MIN \
       and c["o"] > p["h"] and p["o"] < c["c"] < gp["mid"]:
        depth = (gp["mid"] - c["c"]) / max(gp["body"], 1e-9)
        if trend == "up":
            out.append(_det(bars, i, "Dark Cloud Cover", "bearish", _clamp(50 + depth * 60)))

    return out


# ---------------------------------------------------------------------------
# Three-bar detectors
# ---------------------------------------------------------------------------

def _three_bar(bars: list[dict], i: int) -> list[dict]:
    if i < 2:
        return []
    out: list[dict] = []
    b1, b2, b3 = bars[i - 2], bars[i - 1], bars[i]
    g1, g2, g3 = _geo(b1), _geo(b2), _geo(b3)
    if min(g1["rng"], g2["rng"], g3["rng"]) <= 0:
        return out
    trend = _trend(bars, i - 2)

    # Morning Star: long bearish, small body gapping below, long bullish that
    # closes back above the midpoint of bar 1.
    if g1["bear"] and g1["body_pct"] >= LONG_BODY_MIN \
       and g2["body_pct"] <= SMALL_BODY_MAX and max(b2["o"], b2["c"]) < b1["c"] \
       and g3["bull"] and g3["body_pct"] >= LONG_BODY_MIN and b3["c"] > g1["mid"]:
        if trend == "down":
            s = _clamp(60 + (b3["c"] - g1["mid"]) / max(g1["body"], 1e-9) * 40)
            out.append(_det(bars, i, "Morning Star", "bullish", s))

    # Evening Star: long bullish, small body gapping above, long bearish that
    # closes back below the midpoint of bar 1.
    if g1["bull"] and g1["body_pct"] >= LONG_BODY_MIN \
       and g2["body_pct"] <= SMALL_BODY_MAX and min(b2["o"], b2["c"]) > b1["c"] \
       and g3["bear"] and g3["body_pct"] >= LONG_BODY_MIN and b3["c"] < g1["mid"]:
        if trend == "up":
            s = _clamp(60 + (g1["mid"] - b3["c"]) / max(g1["body"], 1e-9) * 40)
            out.append(_det(bars, i, "Evening Star", "bearish", s))

    # Three White Soldiers: three long bullish bars, each opening within the
    # prior real body and closing progressively higher.
    if g1["bull"] and g2["bull"] and g3["bull"] \
       and g1["body_pct"] >= LONG_BODY_MIN and g2["body_pct"] >= LONG_BODY_MIN \
       and g3["body_pct"] >= LONG_BODY_MIN \
       and b1["o"] < b2["o"] < b1["c"] and b2["o"] < b3["o"] < b2["c"] \
       and b1["c"] < b2["c"] < b3["c"]:
        out.append(_det(bars, i, "Three White Soldiers", "bullish", 75))

    # Three Black Crows: three long bearish bars, each opening within the prior
    # real body and closing progressively lower.
    if g1["bear"] and g2["bear"] and g3["bear"] \
       and g1["body_pct"] >= LONG_BODY_MIN and g2["body_pct"] >= LONG_BODY_MIN \
       and g3["body_pct"] >= LONG_BODY_MIN \
       and b1["c"] < b2["o"] < b1["o"] and b2["c"] < b3["o"] < b2["o"] \
       and b1["c"] > b2["c"] > b3["c"]:
        out.append(_det(bars, i, "Three Black Crows", "bearish", 75))

    return out


# ---------------------------------------------------------------------------
# Detection record + scan
# ---------------------------------------------------------------------------

def _det(bars: list[dict], i: int, pattern: str, direction: str, strength: int) -> dict:
    return {
        "date": bars[i]["date"],
        "pattern": pattern,
        "direction": direction,
        "strength": int(strength),
        "bar_index": i,
    }


def _scan(bars: list[dict]) -> list[dict]:
    """Run every detector over the most recent SCAN_BARS bars. Returns the
    detections newest-first, de-duplicated on (pattern, bar_index)."""
    n = len(bars)
    start = max(0, n - SCAN_BARS)
    found: list[dict] = []
    seen: set[tuple[str, int]] = set()

    def add(d: dict | None):
        if not d:
            return
        key = (d["pattern"], d["bar_index"])
        if key in seen:
            return
        seen.add(key)
        found.append(d)

    for i in range(start, n):
        add(_single(bars, i))
        for d in _two_bar(bars, i):
            add(d)
        for d in _three_bar(bars, i):
            add(d)

    found.sort(key=lambda d: (d["bar_index"], d["pattern"]), reverse=True)
    return found


# ---------------------------------------------------------------------------
# Live OHLC (direct yfinance history - the OHLC access pattern used by the
# options modules; the cached close-only fetch_arbitrary_ticker is insufficient)
# ---------------------------------------------------------------------------

def _live_ohlc(symbol: str, lookback: int = HISTORY_BARS) -> list[dict] | None:
    try:
        import yfinance as yf
        period_days = max(lookback + 30, 160)
        df = yf.Ticker(symbol).history(period=f"{period_days}d", auto_adjust=False)
        if df is None or getattr(df, "empty", True):
            return None
        bars: list[dict] = []
        for idx, row in df.tail(lookback).iterrows():
            try:
                o = float(row["Open"]); h = float(row["High"])
                l = float(row["Low"]); c = float(row["Close"])
                v = float(row.get("Volume", 0) or 0)
            except Exception:
                continue
            if any(math.isnan(x) or math.isinf(x) for x in (o, h, l, c)):
                continue
            if h < l or rng_invalid(o, h, l, c):
                continue
            bars.append({
                "date": idx.strftime("%Y-%m-%d"),
                "o": round(o, 4), "h": round(h, 4),
                "l": round(l, 4), "c": round(c, 4), "v": round(v, 0),
            })
        if len(bars) < TREND_LOOKBACK + 3:
            return None
        return bars
    except Exception as e:
        log.warning("candlestick live OHLC fetch failed for %s: %s", symbol, e)
        return None


def rng_invalid(o: float, h: float, l: float, c: float) -> bool:
    hi = max(o, h, l, c)
    lo = min(o, h, l, c)
    return h < hi - 1e-6 or l > lo + 1e-6


# ---------------------------------------------------------------------------
# Sample OHLC - deliberately constructed to contain real patterns
# ---------------------------------------------------------------------------

def _sample_bars(symbol: str) -> list[dict]:
    """Build a deterministic OHLC series (seeded by symbol) whose geometry the
    detectors genuinely fire on. Each "scene" lays down a short trend then a
    pattern; the scanner reads them back out as real detections."""
    sym = (symbol or "AAPL").upper()
    p = _jitter(sym, "p0", 60.0, 260.0)   # base price
    s = max(p * 0.012, 0.5)               # per-bar step
    bars: list[dict] = []

    def push(o, h, l, c):
        nonlocal p
        bars.append({"o": o, "h": h, "l": l, "c": c})
        p = c

    def trend(direction: int, n: int = 4):
        """n monotonic long bars; opens at prior close so no spurious pattern.
        Step is proportional to the *current* price so the trend classifier
        fires regardless of how far price has drifted across the series."""
        for _ in range(n):
            o = p
            step = p * 0.018
            c = p + direction * step
            push(o, max(o, c) + 0.2 * step, min(o, c) - 0.2 * step, c)

    # Long bars carry a 0.12s wick so body_pct ~0.8 (long enough for the
    # engulfing/star/soldier tests, but NOT a marubozu - keeps the table clean).
    #
    # Scenes are ordered so the showcase (last 10) lands inside the SCAN_BARS
    # window; the earlier four are history/context that scrolls out of view.

    # --- warmup history (scrolls out of the scan window) ---
    trend(1, 10)
    trend(-1, 10)
    trend(1, 6)

    # ===== early scenes (history context; outside the scan window) =====
    # Bearish Engulfing
    trend(1); b = p
    push(b, b + 0.92 * s, b - 0.12 * s, b + 0.8 * s)       # long bullish
    push(b + 0.9 * s, b + 1.0 * s, b - 0.12 * s, b - 0.1 * s)  # bearish engulf
    # Bullish Harami
    trend(-1); b = p
    push(b, b + 0.12 * s, b - 1.12 * s, b - 1.0 * s)       # long bearish
    push(b - 0.7 * s, b - 0.25 * s, b - 0.75 * s, b - 0.3 * s)  # small bullish inside
    # Bearish Harami
    trend(1); b = p
    push(b, b + 1.12 * s, b - 0.12 * s, b + 1.0 * s)       # long bullish
    push(b + 0.7 * s, b + 0.75 * s, b + 0.25 * s, b + 0.3 * s)  # small bearish inside
    # Dark Cloud Cover
    trend(1); b = p
    push(b, b + 1.1 * s, b - 0.12 * s, b + 1.0 * s)        # long bullish (high +1.1s)
    push(b + 1.2 * s, b + 1.25 * s, b + 0.18 * s, b + 0.2 * s)  # gap-up, close < mid

    # ===== showcase scenes (inside the scan window) =====
    # Bullish Engulfing (down -> bullish)
    trend(-1); b = p
    push(b, b + 0.12 * s, b - 0.92 * s, b - 0.8 * s)       # long bearish
    push(b - 0.9 * s, b + 0.12 * s, b - 1.0 * s, b + 0.1 * s)  # bullish engulf

    # Piercing Line (down -> bullish)
    trend(-1); b = p
    push(b, b + 0.12 * s, b - 1.1 * s, b - 1.0 * s)        # long bearish (low -1.1s)
    push(b - 1.2 * s, b - 0.18 * s, b - 1.25 * s, b - 0.2 * s)  # gap-down, close > mid

    # Marubozu (bullish, single bar)
    trend(1); b = p
    push(b, b + 1.5 * s + 0.01 * s, b - 0.01 * s, b + 1.5 * s)

    # Hammer (down -> bullish)
    trend(-1); b = p
    push(b, b + 0.1 * s, b - 2.5 * s, b + 0.1 * s)

    # Shooting Star (up -> bearish)
    trend(1); b = p
    push(b, b + 2.5 * s, b - 0.2 * s, b - 0.1 * s)

    # Doji (neutral)
    trend(1); b = p
    push(b, b + 0.8 * s, b - 0.8 * s, b + 0.02 * s)

    # Three White Soldiers (bullish)
    trend(1); b = p
    push(b, b + 1.15 * s, b - 0.15 * s, b + 1.0 * s)
    push(b + 0.5 * s, b + 1.65 * s, b + 0.35 * s, b + 1.5 * s)
    push(b + 1.0 * s, b + 2.15 * s, b + 0.85 * s, b + 2.0 * s)

    # Three Black Crows (bearish)
    trend(-1); b = p
    push(b, b + 0.15 * s, b - 1.15 * s, b - 1.0 * s)
    push(b - 0.5 * s, b - 0.35 * s, b - 1.65 * s, b - 1.5 * s)
    push(b - 1.0 * s, b - 0.85 * s, b - 2.15 * s, b - 2.0 * s)

    # Evening Star (up -> bearish)
    trend(1); b = p
    push(b, b + 1.12 * s, b - 0.12 * s, b + 1.0 * s)       # long bullish
    push(b + 1.2 * s, b + 1.3 * s, b + 1.15 * s, b + 1.25 * s)  # small gap-up
    push(b + 1.1 * s, b + 1.2 * s, b + 0.2 * s, b + 0.3 * s)    # long bearish

    # Morning Star (down -> bullish)  <-- freshest notable signal
    trend(-1); b = p
    push(b, b + 0.12 * s, b - 1.12 * s, b - 1.0 * s)       # long bearish
    push(b - 1.25 * s, b - 1.15 * s, b - 1.3 * s, b - 1.2 * s)  # small gap-down
    push(b - 1.1 * s, b - 0.1 * s, b - 1.2 * s, b - 0.2 * s)    # long bullish

    # Assign dates + a deterministic volume; round prices.
    dates = _business_dates(len(bars))
    out: list[dict] = []
    for k, b in enumerate(bars):
        vol = 1_000_000 * (1.0 + _jitter(sym, f"v{k}", -0.4, 0.8))
        out.append({
            "date": dates[k],
            "o": round(b["o"], 4), "h": round(b["h"], 4),
            "l": round(b["l"], 4), "c": round(b["c"], 4),
            "v": round(vol, 0),
        })
    return out


# ---------------------------------------------------------------------------
# Plain-English read
# ---------------------------------------------------------------------------

_READS = {
    "Hammer": "a long lower wick rejecting lower prices into a downtrend - a classic bullish reversal cue",
    "Hanging Man": "a long lower wick after a rally warns buyers are losing control - a bearish reversal cue",
    "Inverted Hammer": "a long upper wick at the bottom of a slide hints sellers are exhausting - a bullish reversal cue",
    "Shooting Star": "a long upper wick at the top of a rally shows rejected highs - a bearish reversal cue",
    "Doji": "open and close nearly equal signals indecision and a possible turn",
    "Marubozu": "a full-bodied candle with no wicks shows one side in complete control",
    "Bullish Engulfing": "today's green body swallows yesterday's red one - momentum is flipping up",
    "Bearish Engulfing": "today's red body swallows yesterday's green one - momentum is flipping down",
    "Bullish Harami": "a small green body coils inside a large red one as the downtrend stalls",
    "Bearish Harami": "a small red body coils inside a large green one as the uptrend stalls",
    "Piercing Line": "a gap-down open that closes back above the prior midpoint - bulls are stepping in",
    "Dark Cloud Cover": "a gap-up open that closes back below the prior midpoint - bears are stepping in",
    "Morning Star": "a three-bar bottoming sequence (down, pause, up) - a strong bullish reversal",
    "Evening Star": "a three-bar topping sequence (up, pause, down) - a strong bearish reversal",
    "Three White Soldiers": "three strong green bars in a row - decisive bullish follow-through",
    "Three Black Crows": "three strong red bars in a row - decisive bearish follow-through",
}


def _read(det: dict, symbol: str) -> str:
    base = _READS.get(det["pattern"], "a notable candle formation")
    return f"{symbol}: {det['pattern']} on {det['date']} - {base}."


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def candlestick(symbol: str) -> dict:
    """Candlestick pattern scan for a single equity. Never raises."""
    sym = (symbol or "AAPL").strip().upper() or "AAPL"
    try:
        bars = _live_ohlc(sym)
        data_mode = "live"
        source = SOURCE_LIVE
        if not bars:
            bars = _sample_bars(sym)
            data_mode = "sample"
            source = SOURCE_SAMPLE
        return _build(sym, bars, data_mode, source)
    except Exception as e:  # absolute safety net
        log.warning("candlestick hard-failed for %s: %s", sym, e)
        try:
            return _build(sym, _sample_bars(sym), "sample", SOURCE_SAMPLE)
        except Exception:
            return {
                "symbol": sym,
                "detections": [],
                "summary": {"bullish": 0, "bearish": 0, "neutral": 0, "total": 0},
                "latest": None,
                "recent_ohlc": [],
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": SOURCE_SAMPLE,
            }


def _build(sym: str, bars: list[dict], data_mode: str, source: str) -> dict:
    detections = _scan(bars)

    summary = {"bullish": 0, "bearish": 0, "neutral": 0, "total": len(detections)}
    for d in detections:
        summary[d["direction"]] = summary.get(d["direction"], 0) + 1

    # Most recent notable signal = freshest non-neutral detection if any,
    # otherwise the freshest detection.
    latest = None
    notable = [d for d in detections if d["direction"] != "neutral"]
    pick = notable[0] if notable else (detections[0] if detections else None)
    if pick:
        latest = {**pick, "read": _read(pick, sym)}

    recent = [
        {"date": b["date"], "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"]}
        for b in bars[-RECENT_OHLC:]
    ]

    return {
        "symbol": sym,
        "detections": detections,
        "summary": summary,
        "latest": latest,
        "recent_ohlc": recent,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
