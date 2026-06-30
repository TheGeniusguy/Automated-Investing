"""Renko & Kagi Charts (Bloomberg-style time-independent price charts).

A per-ticker module that derives two classic *time-agnostic* chart types from a
single daily OHLC series, alongside the existing Heikin-Ashi candle smoother:

  RENKO : fixed-magnitude "bricks". A new brick is printed only when price moves
          at least one box size from the close of the last brick - small chop is
          discarded entirely, so the surviving brick run is the trend. The box
          size is anchored to ATR(14) (volatility-scaled) and rounded to a
          sensible tick. Each brick is {direction, open, close, date_approx}.

  KAGI  : a continuous reversal line that only changes direction when price
          reverses by at least a threshold (ATR-derived). The line thickness
          encodes demand/supply: it turns *yang* (thick) when it rises above the
          prior shoulder and *yin* (thin) when it falls below the prior waist.
          Each segment is {price, direction, thickness ("yang"|"yin"),
          date_approx}.

Both are built by the SAME deterministic walkers used in live and sample mode,
so the output is always a real construction over a real (or coherent synthetic)
close path - never hand-faked.

The live path pulls daily OHLC through the same `yf.Ticker(symbol).history(...)`
access the candlestick / options modules use (the cached `fetch_arbitrary_ticker`
returns close only, which is insufficient for the ATR box sizing). Every fetch is
guarded so the module degrades to a deterministic md5-seeded SAMPLE close path
rather than raising.

The public `renko_kagi(symbol)` function NEVER raises. The returned dict carries
an internal `data_mode` ("live" | "sample"), `as_of`, `source` and `symbol` for
honesty under the hood (no on-screen badge).
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

SOURCE_LIVE = "yfinance OHLC"
SOURCE_SAMPLE = "sample"

HISTORY_BARS = 380          # ~1.5y of trading days fetched / built
ATR_PERIOD = 14
ATR_BOX_MULT = 1.0          # renko box  = round(ATR * this)
ATR_REVERSAL_MULT = 2.0     # kagi reversal = round(ATR * this)
MAX_BRICKS = 70             # cap the rendered brick run
MAX_KAGI = 60               # cap the rendered kagi vertices
MIN_BARS = ATR_PERIOD + 5


# ---------------------------------------------------------------------------
# Determinism helpers
# ---------------------------------------------------------------------------

def _jitter(symbol: str, key: str, lo: float, hi: float) -> float:
    """Stable pseudo-random value in [lo, hi] keyed by symbol+field."""
    h = int(hashlib.md5(f"{symbol}:{key}".encode()).hexdigest()[:8], 16)
    return lo + (h % 10_000) / 10_000.0 * (hi - lo)


def _business_dates(n: int) -> list[str]:
    """`n` ISO dates (oldest first) ending at the most recent weekday."""
    out: list[str] = []
    d = datetime.now(timezone.utc).date()
    while len(out) < n:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _round_sig(x: float, sig: int = 2) -> float:
    """Round to `sig` significant figures (for a clean box / reversal size)."""
    if x <= 0 or math.isnan(x) or math.isinf(x):
        return 0.0
    digits = sig - int(math.floor(math.log10(x))) - 1
    return round(x, digits)


# ---------------------------------------------------------------------------
# ATR + box / reversal sizing
# ---------------------------------------------------------------------------

def _atr(bars: list[dict], period: int = ATR_PERIOD) -> float:
    """Wilder true-range average over the most recent `period` bars."""
    if len(bars) < 2:
        return 0.0
    trs: list[float] = []
    for i in range(1, len(bars)):
        h = bars[i]["h"]; l = bars[i]["l"]; pc = bars[i - 1]["c"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return 0.0
    window = trs[-period:]
    return sum(window) / len(window)


def _box_size(atr: float, price: float) -> float:
    """A sensible, tick-rounded renko box derived from ATR with a price floor."""
    raw = max(atr * ATR_BOX_MULT, price * 0.005)
    box = _round_sig(raw, 2)
    return box if box > 0 else round(max(price * 0.01, 0.01), 4)


def _reversal_size(atr: float, price: float) -> float:
    """A tick-rounded kagi reversal threshold derived from ATR with a floor."""
    raw = max(atr * ATR_REVERSAL_MULT, price * 0.01)
    rev = _round_sig(raw, 2)
    return rev if rev > 0 else round(max(price * 0.02, 0.01), 4)


# ---------------------------------------------------------------------------
# RENKO walker - new brick only on a full box move from the last brick close
# ---------------------------------------------------------------------------

def _build_renko(closes: list[float], dates: list[str], box: float) -> list[dict]:
    if box <= 0 or len(closes) < 2:
        return []
    bricks: list[dict] = []
    base = closes[0]                     # close anchor of the last brick
    for i in range(1, len(closes)):
        p = closes[i]
        # Up bricks while price has run a full box above the anchor.
        while p >= base + box:
            top = base + box
            bricks.append({
                "direction": "up",
                "open": round(base, 4),
                "close": round(top, 4),
                "date_approx": dates[i],
            })
            base = top
        # Down bricks while price has run a full box below the anchor.
        while p <= base - box:
            bot = base - box
            bricks.append({
                "direction": "down",
                "open": round(base, 4),
                "close": round(bot, 4),
                "date_approx": dates[i],
            })
            base = bot
    return bricks[-MAX_BRICKS:]


def _renko_run(bricks: list[dict]) -> int:
    """Length of the trailing same-direction brick run."""
    if not bricks:
        return 0
    d = bricks[-1]["direction"]
    n = 0
    for b in reversed(bricks):
        if b["direction"] == d:
            n += 1
        else:
            break
    return n


# ---------------------------------------------------------------------------
# KAGI walker - reversal line + yang/yin thickness from shoulders/waists
# ---------------------------------------------------------------------------

def _build_kagi(closes: list[float], dates: list[str], reversal: float) -> list[dict]:
    if reversal <= 0 or len(closes) < 2:
        return []

    start = closes[0]
    # Raw turning vertices: each carries the kind of extreme it represents.
    # kind "peak" = local max (line had been rising), "trough" = local min.
    verts: list[dict] = [{"price": start, "date": dates[0], "kind": "start"}]
    direction = 0          # +1 rising, -1 falling, 0 undecided
    extreme = start        # running extreme of the current leg
    ext_date = dates[0]

    for i in range(1, len(closes)):
        p = closes[i]
        if direction == 0:
            if p >= start + reversal:
                direction = 1; extreme = p; ext_date = dates[i]
            elif p <= start - reversal:
                direction = -1; extreme = p; ext_date = dates[i]
        elif direction == 1:
            if p > extreme:
                extreme = p; ext_date = dates[i]
            elif extreme - p >= reversal:
                verts.append({"price": extreme, "date": ext_date, "kind": "peak"})
                direction = -1; extreme = p; ext_date = dates[i]
        else:  # direction == -1
            if p < extreme:
                extreme = p; ext_date = dates[i]
            elif p - extreme >= reversal:
                verts.append({"price": extreme, "date": ext_date, "kind": "trough"})
                direction = 1; extreme = p; ext_date = dates[i]

    # Close the final leg at the running extreme.
    final_kind = "peak" if direction == 1 else "trough" if direction == -1 else "start"
    verts.append({"price": extreme, "date": ext_date, "kind": final_kind})

    # Assign yang/yin per segment: the line is yang once it rises above the prior
    # shoulder (last peak) and yin once it falls below the prior waist (last
    # trough). Thickness carries forward until the opposite break occurs.
    prev_shoulder: float | None = None
    prev_waist: float | None = None
    thickness = "yin"
    out: list[dict] = []
    for k, v in enumerate(verts):
        price = v["price"]
        kind = v["kind"]
        if kind == "peak":
            if prev_shoulder is not None and price > prev_shoulder:
                thickness = "yang"
            prev_shoulder = price
        elif kind == "trough":
            if prev_waist is not None and price < prev_waist:
                thickness = "yin"
            prev_waist = price
        # direction of the segment leading INTO this vertex
        if k == 0:
            seg_dir = "flat"
        else:
            seg_dir = "up" if price >= verts[k - 1]["price"] else "down"
        out.append({
            "price": round(price, 4),
            "direction": seg_dir,
            "thickness": thickness,
            "date_approx": v["date"],
        })
    return out[-MAX_KAGI:]


# ---------------------------------------------------------------------------
# Live OHLC (direct yfinance history; cached close-only fetch is insufficient)
# ---------------------------------------------------------------------------

def _live_ohlc(symbol: str, lookback: int = HISTORY_BARS) -> list[dict] | None:
    try:
        import yfinance as yf
        period_days = max(int(lookback * 1.5) + 30, 220)
        df = yf.Ticker(symbol).history(period=f"{period_days}d", auto_adjust=False)
        if df is None or getattr(df, "empty", True):
            return None
        bars: list[dict] = []
        for idx, row in df.tail(lookback).iterrows():
            try:
                o = float(row["Open"]); h = float(row["High"])
                l = float(row["Low"]); c = float(row["Close"])
            except Exception:
                continue
            if any(math.isnan(x) or math.isinf(x) for x in (o, h, l, c)):
                continue
            if h < l or h <= 0 or c <= 0:
                continue
            bars.append({
                "date": idx.strftime("%Y-%m-%d"),
                "o": round(o, 4), "h": round(h, 4),
                "l": round(l, 4), "c": round(c, 4),
            })
        if len(bars) < MIN_BARS:
            return None
        return bars
    except Exception as e:
        log.warning("renko_kagi live OHLC fetch failed for %s: %s", symbol, e)
        return None


# ---------------------------------------------------------------------------
# Sample OHLC - a coherent synthetic close path the SAME walkers run on
# ---------------------------------------------------------------------------

def _sample_bars(symbol: str) -> list[dict]:
    """Deterministic OHLC path (seeded by symbol) with a few trend regimes so the
    renko brick run and the kagi yang/yin transitions are genuinely present."""
    sym = (symbol or "AAPL").upper()
    n = HISTORY_BARS
    price = _jitter(sym, "p0", 40.0, 320.0)
    vol = price * (0.018 + _jitter(sym, "vol", 0.0, 0.016))   # per-bar sigma
    # Several short drift regimes with alternating bias (bull / chop / bear /
    # recovery), so the path trends *and* reverses - both walkers stay rich.
    seg_n = 8
    drifts = [
        _jitter(sym, f"drift{k}", -0.0045, 0.0055) * (1 if k % 2 == 0 else -1)
        for k in range(seg_n)
    ]
    bounds = [int(n * (k + 1) / seg_n) for k in range(seg_n)]

    bars: list[dict] = []
    seg = 0
    for i in range(n):
        while seg < seg_n - 1 and i >= bounds[seg]:
            seg += 1
        drift = drifts[seg]
        shock = (_jitter(sym, f"n{i}", -1.0, 1.0)) * vol
        price = max(price * (1.0 + drift) + shock, 1.0)
        # Build an intrabar range around the close.
        rng = max(vol * (0.8 + _jitter(sym, f"r{i}", 0.0, 1.2)), price * 0.002)
        o = max(price - rng * _jitter(sym, f"o{i}", -0.5, 0.5), 0.5)
        c = price
        h = max(o, c) + rng * _jitter(sym, f"h{i}", 0.1, 0.6)
        l = min(o, c) - rng * _jitter(sym, f"l{i}", 0.1, 0.6)
        l = max(l, 0.1)
        bars.append({"o": o, "h": h, "l": l, "c": c})

    dates = _business_dates(len(bars))
    return [
        {
            "date": dates[k],
            "o": round(b["o"], 4), "h": round(b["h"], 4),
            "l": round(b["l"], 4), "c": round(b["c"], 4),
        }
        for k, b in enumerate(bars)
    ]


# ---------------------------------------------------------------------------
# Plain-English trend read
# ---------------------------------------------------------------------------

def _summary(sym: str, renko_dir: str, run: int, kagi_thick: str, kagi_dir: str,
             price: float) -> str:
    rk = (
        f"Renko is printing {run} {renko_dir} brick{'s' if run != 1 else ''} in a row"
        if renko_dir else "Renko has no completed bricks yet"
    )
    if kagi_thick == "yang":
        kg = "the Kagi line is yang (thick) - demand has the upper hand"
    elif kagi_thick == "yin":
        kg = "the Kagi line is yin (thin) - supply has the upper hand"
    else:
        kg = "the Kagi line is undecided"
    aligned = (renko_dir == "up" and kagi_thick == "yang") or \
              (renko_dir == "down" and kagi_thick == "yin")
    tail = " - both read the same way, a cleaner trend signal." if aligned \
        else " - the two disagree, so treat the trend as unconfirmed."
    return f"{sym} at {price:g}: {rk} and {kg}{tail}"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def renko_kagi(symbol: str) -> dict:
    """Renko brick + Kagi reversal-line construction for one equity. Never raises."""
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
        log.warning("renko_kagi hard-failed for %s: %s", sym, e)
        try:
            return _build(sym, _sample_bars(sym), "sample", SOURCE_SAMPLE)
        except Exception:
            return {
                "symbol": sym,
                "renko": [],
                "kagi": [],
                "box_size": None,
                "reversal_threshold": None,
                "atr": None,
                "latest_price": None,
                "renko_trend": {"direction": None, "run": 0},
                "kagi_trend": {"direction": None, "thickness": None},
                "summary": f"{sym}: no data available.",
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": SOURCE_SAMPLE,
            }


def _build(sym: str, bars: list[dict], data_mode: str, source: str) -> dict:
    closes = [b["c"] for b in bars]
    dates = [b["date"] for b in bars]
    price = closes[-1] if closes else 0.0

    atr = _atr(bars)
    box = _box_size(atr, price)
    reversal = _reversal_size(atr, price)

    renko = _build_renko(closes, dates, box)
    kagi = _build_kagi(closes, dates, reversal)

    renko_dir = renko[-1]["direction"] if renko else None
    run = _renko_run(renko)
    kagi_thick = kagi[-1]["thickness"] if kagi else None
    kagi_dir = kagi[-1]["direction"] if kagi else None

    summary = _summary(sym, renko_dir or "", run, kagi_thick or "", kagi_dir or "", price)

    return {
        "symbol": sym,
        "renko": renko,
        "kagi": kagi,
        "box_size": round(box, 4),
        "reversal_threshold": round(reversal, 4),
        "atr": round(atr, 4),
        "latest_price": round(price, 4),
        "renko_trend": {"direction": renko_dir, "run": run, "bricks": len(renko)},
        "kagi_trend": {"direction": kagi_dir, "thickness": kagi_thick, "segments": len(kagi)},
        "summary": summary,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
