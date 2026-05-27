"""Technical indicators computed from prices_daily.

All math is pandas-based, formula-correct against industry references
(TradingView, ThinkOrSwim, Wilder). Multi-timeframe support via OHLC
resampling. Volume-based indicators read volume from prices_daily.

No external API keys required.

Indicators implemented:
  Trend:       SMA, EMA, MACD, Parabolic SAR, ADX, Ichimoku Cloud, Donchian,
               Keltner Channels, Bollinger Bands, MA crossovers
  Momentum:    RSI (Wilder), Stochastic %K/%D, Williams %R, CCI, ROC, MFI
  Volume:      OBV, VWAP (rolling daily anchor)
  Volatility:  ATR (Wilder)
  Levels:      Classic + Fibonacci pivot points
"""
from __future__ import annotations

import logging
from typing import Optional

import pandas as pd

from ..db import engine as db_engine

log = logging.getLogger(__name__)

SUPPORTED_INDICATORS = (
    # Trend
    "sma", "ema", "macd", "bollinger", "donchian", "keltner",
    "parabolic_sar", "ichimoku", "crossovers", "adx",
    "supertrend", "aroon", "vortex", "hull_ma", "kama", "vwma", "trix",
    # Momentum
    "rsi", "stochastic", "williams_r", "cci", "roc", "mfi",
    "ultimate_oscillator", "awesome_oscillator",
    # Volume
    "obv", "vwap", "cmf", "chaikin_oscillator", "anchored_vwap",
    # Volatility
    "atr",
    # Levels + structure
    "pivots", "support_resistance",
    # Patterns
    "divergence",
    # Bars
    "heikin_ashi",
    # Composite
    "signal",
)

# Timeframes supported by the resampling helper.
TIMEFRAMES = ("1d", "1w", "1mo")


# ── Data loading + timeframe resampling ─────────────────────────────────────

def _load_ohlcv(symbol: str, days: int) -> pd.DataFrame:
    # DuckDB prices_daily first, with a live yfinance fallback when the store is
    # cold (so indicators/dossier work before the ingest job has run).
    from .ohlcv import load_ohlcv
    return load_ohlcv(symbol, days)


def _resample(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Resample daily bars to weekly/monthly using OHLC rules.

    Rules:
      open   = first
      high   = max
      low    = min
      close  = last
      adj_close = last
      volume = sum
    """
    if timeframe == "1d" or df.empty:
        return df
    rule = {"1w": "W-FRI", "1mo": "ME"}.get(timeframe)
    if not rule:
        return df
    indexed = df.set_index("date")
    agg = indexed.resample(rule).agg({
        "open":      "first",
        "high":      "max",
        "low":       "min",
        "close":     "last",
        "adj_close": "last",
        "volume":    "sum",
    }).dropna(subset=["close"])
    return agg.reset_index()


def _points(df: pd.DataFrame, series: pd.Series) -> list[dict]:
    out: list[dict] = []
    for d, v in zip(df["date"], series):
        if pd.isna(v):
            continue
        out.append({"date": d.strftime("%Y-%m-%d"), "value": float(v)})
    return out


# ── Trend indicators ────────────────────────────────────────────────────────

def sma(df: pd.DataFrame, period: int = 20) -> dict:
    s = df["close"].rolling(window=period, min_periods=period).mean()
    return {"indicator": "sma", "period": period, "points": _points(df, s)}


def ema(df: pd.DataFrame, period: int = 20) -> dict:
    s = df["close"].ewm(span=period, adjust=False, min_periods=period).mean()
    return {"indicator": "ema", "period": period, "points": _points(df, s)}


def macd(df: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    if df.empty or len(df) < slow + signal:
        return {"indicator": "macd", "fast": fast, "slow": slow, "signal": signal,
                "line": [], "signal_line": [], "histogram": []}
    fast_ema = df["close"].ewm(span=fast, adjust=False, min_periods=fast).mean()
    slow_ema = df["close"].ewm(span=slow, adjust=False, min_periods=slow).mean()
    line_ser = fast_ema - slow_ema
    signal_ser = line_ser.ewm(span=signal, adjust=False, min_periods=signal).mean()
    hist_ser = line_ser - signal_ser
    return {
        "indicator":   "macd",
        "fast":        fast,
        "slow":        slow,
        "signal":      signal,
        "line":        _points(df, line_ser),
        "signal_line": _points(df, signal_ser),
        "histogram":   _points(df, hist_ser),
    }


def bollinger(df: pd.DataFrame, period: int = 20, std_dev: float = 2.0) -> dict:
    if df.empty or len(df) < period:
        return {"indicator": "bollinger", "period": period, "std_dev": std_dev,
                "upper": [], "middle": [], "lower": []}
    middle = df["close"].rolling(window=period, min_periods=period).mean()
    std    = df["close"].rolling(window=period, min_periods=period).std(ddof=0)
    upper  = middle + std_dev * std
    lower  = middle - std_dev * std
    return {
        "indicator": "bollinger",
        "period":    period,
        "std_dev":   std_dev,
        "upper":     _points(df, upper),
        "middle":    _points(df, middle),
        "lower":     _points(df, lower),
    }


def donchian(df: pd.DataFrame, period: int = 20) -> dict:
    if df.empty or len(df) < period:
        return {"indicator": "donchian", "period": period, "upper": [], "middle": [], "lower": []}
    upper  = df["high"].rolling(window=period, min_periods=period).max()
    lower  = df["low"].rolling(window=period, min_periods=period).min()
    middle = (upper + lower) / 2.0
    return {
        "indicator": "donchian",
        "period":    period,
        "upper":     _points(df, upper),
        "middle":    _points(df, middle),
        "lower":     _points(df, lower),
    }


def keltner(df: pd.DataFrame, period: int = 20, atr_period: int = 10, multiplier: float = 2.0) -> dict:
    if df.empty or len(df) < max(period, atr_period):
        return {"indicator": "keltner", "period": period, "atr_period": atr_period,
                "multiplier": multiplier, "upper": [], "middle": [], "lower": []}
    middle = df["close"].ewm(span=period, adjust=False, min_periods=period).mean()
    atr_series = _atr_series(df, atr_period)
    upper = middle + multiplier * atr_series
    lower = middle - multiplier * atr_series
    return {
        "indicator":  "keltner",
        "period":     period,
        "atr_period": atr_period,
        "multiplier": multiplier,
        "upper":      _points(df, upper),
        "middle":     _points(df, middle),
        "lower":      _points(df, lower),
    }


def parabolic_sar(df: pd.DataFrame, step: float = 0.02, max_step: float = 0.2) -> dict:
    """Wilder's Parabolic SAR. Iterative computation; first bar bootstraps.

    Returns dots that flip sides on trend reversal — above price in downtrend,
    below in uptrend.
    """
    if df.empty or len(df) < 3:
        return {"indicator": "parabolic_sar", "step": step, "max_step": max_step, "points": []}
    high = df["high"].values
    low  = df["low"].values

    sar = [low[0]]
    trend_up = True
    ep = high[0]                       # extreme price
    af = step                          # acceleration factor

    for i in range(1, len(df)):
        prev_sar = sar[-1]
        new_sar = prev_sar + af * (ep - prev_sar)
        if trend_up:
            new_sar = min(new_sar, low[i - 1], low[max(i - 2, 0)])
            if low[i] < new_sar:
                # Trend flip to down.
                trend_up = False
                new_sar  = ep
                ep       = low[i]
                af       = step
            else:
                if high[i] > ep:
                    ep = high[i]
                    af = min(af + step, max_step)
        else:
            new_sar = max(new_sar, high[i - 1], high[max(i - 2, 0)])
            if high[i] > new_sar:
                # Trend flip to up.
                trend_up = True
                new_sar  = ep
                ep       = high[i]
                af       = step
            else:
                if low[i] < ep:
                    ep = low[i]
                    af = min(af + step, max_step)
        sar.append(new_sar)

    return {
        "indicator": "parabolic_sar",
        "step":      step,
        "max_step":  max_step,
        "points":    _points(df, pd.Series(sar)),
    }


def ichimoku(df: pd.DataFrame, tenkan: int = 9, kijun: int = 26, senkou_b: int = 52,
             chikou_shift: int = 26) -> dict:
    """Ichimoku Kinko Hyo — 5 lines + cloud.

    Tenkan-sen (conversion) = (high_max(9) + low_min(9)) / 2
    Kijun-sen  (base line)  = (high_max(26) + low_min(26)) / 2
    Senkou A   (cloud A)    = (Tenkan + Kijun) / 2, shifted forward 26
    Senkou B   (cloud B)    = (high_max(52) + low_min(52)) / 2, shifted forward 26
    Chikou     (lag line)   = close shifted back 26
    """
    if df.empty or len(df) < senkou_b + chikou_shift:
        return {"indicator": "ichimoku", "tenkan": tenkan, "kijun": kijun, "senkou_b": senkou_b,
                "chikou_shift": chikou_shift,
                "tenkan_sen": [], "kijun_sen": [], "senkou_a": [], "senkou_b_line": [], "chikou_span": []}
    tenkan_sen = (df["high"].rolling(tenkan).max() + df["low"].rolling(tenkan).min()) / 2.0
    kijun_sen  = (df["high"].rolling(kijun).max() + df["low"].rolling(kijun).min()) / 2.0
    senkou_a   = ((tenkan_sen + kijun_sen) / 2.0).shift(chikou_shift)
    senkou_b_line = ((df["high"].rolling(senkou_b).max() + df["low"].rolling(senkou_b).min()) / 2.0).shift(chikou_shift)
    chikou_span = df["close"].shift(-chikou_shift)
    return {
        "indicator":     "ichimoku",
        "tenkan":        tenkan,
        "kijun":         kijun,
        "senkou_b":      senkou_b,
        "chikou_shift":  chikou_shift,
        "tenkan_sen":    _points(df, tenkan_sen),
        "kijun_sen":     _points(df, kijun_sen),
        "senkou_a":      _points(df, senkou_a),
        "senkou_b_line": _points(df, senkou_b_line),
        "chikou_span":   _points(df, chikou_span),
    }


def crossovers(df: pd.DataFrame, fast: int = 50, slow: int = 200) -> dict:
    """Moving average crossover events."""
    if df.empty or len(df) < slow + 1:
        return {"indicator": "crossovers", "fast": fast, "slow": slow, "events": []}
    fast_ma = df["close"].rolling(window=fast, min_periods=fast).mean()
    slow_ma = df["close"].rolling(window=slow, min_periods=slow).mean()
    diff    = fast_ma - slow_ma
    sign    = diff.apply(lambda v: 0 if pd.isna(v) else (1 if v > 0 else (-1 if v < 0 else 0)))
    flips   = sign.diff().fillna(0)
    events: list[dict] = []
    for i, f in enumerate(flips):
        if f == 0:
            continue
        events.append({
            "date":    df["date"].iloc[i].strftime("%Y-%m-%d"),
            "type":    "golden_cross" if f > 0 else "death_cross",
            "fast_ma": float(fast_ma.iloc[i]) if not pd.isna(fast_ma.iloc[i]) else None,
            "slow_ma": float(slow_ma.iloc[i]) if not pd.isna(slow_ma.iloc[i]) else None,
        })
    return {"indicator": "crossovers", "fast": fast, "slow": slow, "events": events}


def adx(df: pd.DataFrame, period: int = 14) -> dict:
    """Average Directional Index — Wilder. Returns ADX, +DI, -DI."""
    if df.empty or len(df) < period * 2 + 1:
        return {"indicator": "adx", "period": period, "adx": [], "plus_di": [], "minus_di": []}
    high = df["high"]
    low  = df["low"]
    close = df["close"]
    prev_close = close.shift(1)

    up_move   = high.diff()
    down_move = -low.diff()

    plus_dm  = ((up_move > down_move)   & (up_move > 0)).astype(float) * up_move.clip(lower=0)
    minus_dm = ((down_move > up_move) & (down_move > 0)).astype(float) * down_move.clip(lower=0)

    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)

    # Wilder smoothing.
    atr_s    = tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    plus_di  = 100 * plus_dm.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()  / atr_s
    minus_di = 100 * minus_dm.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean() / atr_s
    dx       = (plus_di.subtract(minus_di).abs() / plus_di.add(minus_di)) * 100
    adx_s    = dx.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    return {
        "indicator": "adx",
        "period":    period,
        "adx":       _points(df, adx_s),
        "plus_di":   _points(df, plus_di),
        "minus_di":  _points(df, minus_di),
    }


# ── Momentum indicators ────────────────────────────────────────────────────

def rsi(df: pd.DataFrame, period: int = 14) -> dict:
    """RSI with Wilder smoothing."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "rsi", "period": period, "overbought": 70, "oversold": 30, "points": []}
    delta = df["close"].diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, pd.NA)
    rsi_s = 100 - (100 / (1 + rs))
    return {
        "indicator":  "rsi",
        "period":     period,
        "overbought": 70,
        "oversold":   30,
        "points":     _points(df, rsi_s),
    }


def stochastic(df: pd.DataFrame, k_period: int = 14, k_smooth: int = 3, d_period: int = 3) -> dict:
    """Stochastic Oscillator — %K (fast/slow) and %D."""
    if df.empty or len(df) < k_period + k_smooth + d_period:
        return {"indicator": "stochastic", "k_period": k_period, "k_smooth": k_smooth,
                "d_period": d_period, "overbought": 80, "oversold": 20,
                "k_line": [], "d_line": []}
    low_min  = df["low"].rolling(window=k_period, min_periods=k_period).min()
    high_max = df["high"].rolling(window=k_period, min_periods=k_period).max()
    raw_k    = 100 * (df["close"] - low_min) / (high_max - low_min)
    k_line   = raw_k.rolling(window=k_smooth, min_periods=k_smooth).mean()  # slow %K
    d_line   = k_line.rolling(window=d_period, min_periods=d_period).mean()
    return {
        "indicator":  "stochastic",
        "k_period":   k_period,
        "k_smooth":   k_smooth,
        "d_period":   d_period,
        "overbought": 80,
        "oversold":   20,
        "k_line":     _points(df, k_line),
        "d_line":     _points(df, d_line),
    }


def williams_r(df: pd.DataFrame, period: int = 14) -> dict:
    """Williams %R — bounded 0 to -100. Below -80 = oversold, above -20 = overbought."""
    if df.empty or len(df) < period:
        return {"indicator": "williams_r", "period": period, "points": []}
    high_max = df["high"].rolling(window=period, min_periods=period).max()
    low_min  = df["low"].rolling(window=period, min_periods=period).min()
    s = -100 * (high_max - df["close"]) / (high_max - low_min)
    return {"indicator": "williams_r", "period": period, "points": _points(df, s)}


def cci(df: pd.DataFrame, period: int = 20) -> dict:
    """Commodity Channel Index — Lambert. Typical price - SMA(typical) / 0.015 * mean_dev."""
    if df.empty or len(df) < period:
        return {"indicator": "cci", "period": period, "points": []}
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    sma_tp = tp.rolling(window=period, min_periods=period).mean()
    # Mean absolute deviation of typical price from its SMA.
    mad = tp.rolling(window=period, min_periods=period).apply(
        lambda x: (x - x.mean()).abs().mean(), raw=False,
    )
    s = (tp - sma_tp) / (0.015 * mad)
    return {"indicator": "cci", "period": period, "points": _points(df, s)}


def roc(df: pd.DataFrame, period: int = 12) -> dict:
    """Rate of Change — percentage."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "roc", "period": period, "points": []}
    s = (df["close"] - df["close"].shift(period)) / df["close"].shift(period) * 100.0
    return {"indicator": "roc", "period": period, "points": _points(df, s)}


def mfi(df: pd.DataFrame, period: int = 14) -> dict:
    """Money Flow Index — RSI variant weighted by typical price × volume."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "mfi", "period": period, "overbought": 80, "oversold": 20, "points": []}
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    rmf = tp * df["volume"]
    direction = tp.diff().apply(lambda v: 0 if pd.isna(v) else (1 if v > 0 else (-1 if v < 0 else 0)))
    pos_mf = rmf.where(direction > 0, 0.0)
    neg_mf = rmf.where(direction < 0, 0.0)
    pos_sum = pos_mf.rolling(window=period, min_periods=period).sum()
    neg_sum = neg_mf.rolling(window=period, min_periods=period).sum()
    mfr = pos_sum / neg_sum.replace(0.0, pd.NA)
    s = 100 - (100 / (1 + mfr))
    return {"indicator": "mfi", "period": period, "overbought": 80, "oversold": 20,
            "points": _points(df, s)}


# ── Volume indicators ──────────────────────────────────────────────────────

def obv(df: pd.DataFrame) -> dict:
    """On-Balance Volume — cumulative volume signed by close direction."""
    if df.empty:
        return {"indicator": "obv", "points": []}
    direction = df["close"].diff().apply(lambda v: 0 if pd.isna(v) or v == 0 else (1 if v > 0 else -1))
    signed_vol = direction * df["volume"]
    s = signed_vol.cumsum()
    return {"indicator": "obv", "points": _points(df, s)}


def vwap(df: pd.DataFrame, period: Optional[int] = None) -> dict:
    """VWAP. If period given, computes rolling VWAP over `period` bars; otherwise
    anchors at the start of each calendar day (for daily bars this is just the
    cumulative VWAP from the start of the data window)."""
    if df.empty:
        return {"indicator": "vwap", "period": period, "points": []}
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    vol = df["volume"].replace(0.0, pd.NA)
    pv = tp * vol
    if period:
        rolling_pv  = pv.rolling(window=period, min_periods=period).sum()
        rolling_vol = vol.rolling(window=period, min_periods=period).sum()
        s = rolling_pv / rolling_vol
    else:
        s = pv.cumsum() / vol.cumsum()
    return {"indicator": "vwap", "period": period, "points": _points(df, s)}


# ── Volatility indicators ──────────────────────────────────────────────────

def _atr_series(df: pd.DataFrame, period: int) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        (df["high"] - df["low"]).abs(),
        (df["high"] - prev_close).abs(),
        (df["low"]  - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def atr(df: pd.DataFrame, period: int = 14) -> dict:
    """Average True Range — Wilder's smoothing."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "atr", "period": period, "points": []}
    s = _atr_series(df, period)
    return {"indicator": "atr", "period": period, "points": _points(df, s)}


# ── Level indicators ───────────────────────────────────────────────────────

def supertrend(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0) -> dict:
    """SuperTrend — ATR-bounded trailing band that flips with trend."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "supertrend", "period": period, "multiplier": multiplier,
                "points": [], "direction": []}
    atr_s = _atr_series(df, period)
    hl2   = (df["high"] + df["low"]) / 2.0
    upper_basic = hl2 + multiplier * atr_s
    lower_basic = hl2 - multiplier * atr_s

    upper = upper_basic.copy()
    lower = lower_basic.copy()
    for i in range(1, len(df)):
        if not pd.isna(upper_basic.iloc[i]) and not pd.isna(upper.iloc[i - 1]):
            upper.iloc[i] = upper_basic.iloc[i] if (upper_basic.iloc[i] < upper.iloc[i - 1] or df["close"].iloc[i - 1] > upper.iloc[i - 1]) else upper.iloc[i - 1]
        if not pd.isna(lower_basic.iloc[i]) and not pd.isna(lower.iloc[i - 1]):
            lower.iloc[i] = lower_basic.iloc[i] if (lower_basic.iloc[i] > lower.iloc[i - 1] or df["close"].iloc[i - 1] < lower.iloc[i - 1]) else lower.iloc[i - 1]

    direction = [0] * len(df)
    trend = [None] * len(df)
    for i in range(1, len(df)):
        if pd.isna(upper.iloc[i - 1]) or pd.isna(lower.iloc[i - 1]):
            continue
        prev_trend = trend[i - 1]
        if prev_trend is None:
            t = 1 if df["close"].iloc[i] > upper.iloc[i] else -1
        else:
            if prev_trend == 1 and df["close"].iloc[i] < lower.iloc[i]:
                t = -1
            elif prev_trend == -1 and df["close"].iloc[i] > upper.iloc[i]:
                t = 1
            else:
                t = prev_trend
        trend[i] = t
        direction[i] = t

    line = [(lower.iloc[i] if trend[i] == 1 else (upper.iloc[i] if trend[i] == -1 else None)) for i in range(len(df))]
    return {
        "indicator":  "supertrend",
        "period":     period,
        "multiplier": multiplier,
        "points":     [{"date": d.strftime("%Y-%m-%d"), "value": float(v)} for d, v in zip(df["date"], line) if v is not None and not pd.isna(v)],
        "direction":  [{"date": d.strftime("%Y-%m-%d"), "value": int(t)} for d, t in zip(df["date"], trend) if t is not None],
    }


def aroon(df: pd.DataFrame, period: int = 25) -> dict:
    """Aroon Up + Aroon Down + Aroon Oscillator."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "aroon", "period": period, "up": [], "down": [], "oscillator": []}
    def days_since_high(window: pd.Series) -> float:
        idx = window.values.argmax()
        return float(((len(window) - 1) - idx) / period * 100 * -1 + 100)
    def days_since_low(window: pd.Series) -> float:
        idx = window.values.argmin()
        return float(((len(window) - 1) - idx) / period * 100 * -1 + 100)
    up   = df["high"].rolling(window=period + 1, min_periods=period + 1).apply(days_since_high, raw=False)
    down = df["low"].rolling(window=period + 1, min_periods=period + 1).apply(days_since_low, raw=False)
    osc  = up - down
    return {
        "indicator":  "aroon",
        "period":     period,
        "up":         _points(df, up),
        "down":       _points(df, down),
        "oscillator": _points(df, osc),
    }


def vortex(df: pd.DataFrame, period: int = 14) -> dict:
    """Vortex Indicator — VI+ and VI-."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "vortex", "period": period, "vi_plus": [], "vi_minus": []}
    high = df["high"]
    low  = df["low"]
    prev_close = df["close"].shift(1)
    vm_plus  = (high - low.shift(1)).abs()
    vm_minus = (low  - high.shift(1)).abs()
    tr = pd.concat([(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    tr_sum  = tr.rolling(window=period, min_periods=period).sum()
    vi_plus  = vm_plus.rolling(window=period, min_periods=period).sum()  / tr_sum
    vi_minus = vm_minus.rolling(window=period, min_periods=period).sum() / tr_sum
    return {"indicator": "vortex", "period": period,
            "vi_plus":  _points(df, vi_plus),
            "vi_minus": _points(df, vi_minus)}


def hull_ma(df: pd.DataFrame, period: int = 20) -> dict:
    """Hull Moving Average — heavily smoothed, low-lag MA."""
    if df.empty or len(df) < period * 2:
        return {"indicator": "hull_ma", "period": period, "points": []}
    half = period // 2
    sqrt = max(1, int(period ** 0.5))
    wma_half = df["close"].rolling(half).apply(_wma, raw=True)
    wma_full = df["close"].rolling(period).apply(_wma, raw=True)
    diff = 2 * wma_half - wma_full
    hma  = diff.rolling(sqrt).apply(_wma, raw=True)
    return {"indicator": "hull_ma", "period": period, "points": _points(df, hma)}


def _wma(values) -> float:
    n = len(values)
    if n == 0:
        return float("nan")
    weights = pd.Series(range(1, n + 1), dtype=float)
    return float((pd.Series(values) * weights).sum() / weights.sum())


def kama(df: pd.DataFrame, period: int = 10, fast: int = 2, slow: int = 30) -> dict:
    """Kaufman Adaptive Moving Average — adjusts smoothing by efficiency ratio."""
    if df.empty or len(df) < period + 1:
        return {"indicator": "kama", "period": period, "fast": fast, "slow": slow, "points": []}
    close = df["close"]
    change = (close - close.shift(period)).abs()
    volatility = close.diff().abs().rolling(period).sum()
    er = change / volatility.replace(0, pd.NA)
    fast_sc = 2.0 / (fast + 1)
    slow_sc = 2.0 / (slow + 1)
    sc = (er * (fast_sc - slow_sc) + slow_sc) ** 2

    out = [None] * len(close)
    for i in range(len(close)):
        if i < period or pd.isna(sc.iloc[i]) or out[i - 1] is None:
            if i == period and not pd.isna(close.iloc[i]):
                out[i] = float(close.iloc[i])
            continue
        out[i] = float(out[i - 1] + sc.iloc[i] * (close.iloc[i] - out[i - 1]))
    s = pd.Series(out, index=df.index, dtype=float)
    return {"indicator": "kama", "period": period, "fast": fast, "slow": slow, "points": _points(df, s)}


def vwma(df: pd.DataFrame, period: int = 20) -> dict:
    """Volume-Weighted Moving Average."""
    if df.empty or len(df) < period:
        return {"indicator": "vwma", "period": period, "points": []}
    pv = df["close"] * df["volume"]
    s = pv.rolling(window=period, min_periods=period).sum() / df["volume"].rolling(window=period, min_periods=period).sum()
    return {"indicator": "vwma", "period": period, "points": _points(df, s)}


def trix(df: pd.DataFrame, period: int = 15, signal: int = 9) -> dict:
    """TRIX — 1-day ROC of triple-smoothed EMA. Trend-following oscillator."""
    if df.empty or len(df) < period * 3 + signal:
        return {"indicator": "trix", "period": period, "signal": signal, "line": [], "signal_line": []}
    e1 = df["close"].ewm(span=period, adjust=False, min_periods=period).mean()
    e2 = e1.ewm(span=period, adjust=False, min_periods=period).mean()
    e3 = e2.ewm(span=period, adjust=False, min_periods=period).mean()
    trix_line = (e3 - e3.shift(1)) / e3.shift(1) * 10000.0  # basis points
    signal_line = trix_line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return {"indicator": "trix", "period": period, "signal": signal,
            "line": _points(df, trix_line), "signal_line": _points(df, signal_line)}


def ultimate_oscillator(df: pd.DataFrame, fast: int = 7, mid: int = 14, slow: int = 28) -> dict:
    """Williams' Ultimate Oscillator — weighted blend of 3 timeframes."""
    if df.empty or len(df) < slow + 1:
        return {"indicator": "ultimate_oscillator", "fast": fast, "mid": mid, "slow": slow,
                "overbought": 70, "oversold": 30, "points": []}
    close = df["close"]
    high  = df["high"]
    low   = df["low"]
    prev_close = close.shift(1)
    bp = close - pd.concat([low, prev_close], axis=1).min(axis=1)
    tr = pd.concat([(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)

    def avg(w: int) -> pd.Series:
        return bp.rolling(window=w, min_periods=w).sum() / tr.rolling(window=w, min_periods=w).sum()

    ua = avg(fast)
    ub = avg(mid)
    uc = avg(slow)
    uo = 100.0 * (4.0 * ua + 2.0 * ub + uc) / (4.0 + 2.0 + 1.0)
    return {"indicator": "ultimate_oscillator", "fast": fast, "mid": mid, "slow": slow,
            "overbought": 70, "oversold": 30, "points": _points(df, uo)}


def awesome_oscillator(df: pd.DataFrame, fast: int = 5, slow: int = 34) -> dict:
    """Bill Williams' Awesome Oscillator — SMA(5, hl2) - SMA(34, hl2). Histogram."""
    if df.empty or len(df) < slow:
        return {"indicator": "awesome_oscillator", "fast": fast, "slow": slow, "points": []}
    hl2 = (df["high"] + df["low"]) / 2.0
    s = hl2.rolling(window=fast, min_periods=fast).mean() - hl2.rolling(window=slow, min_periods=slow).mean()
    return {"indicator": "awesome_oscillator", "fast": fast, "slow": slow, "points": _points(df, s)}


def cmf(df: pd.DataFrame, period: int = 20) -> dict:
    """Chaikin Money Flow — volume-weighted accumulation/distribution."""
    if df.empty or len(df) < period:
        return {"indicator": "cmf", "period": period, "points": []}
    high = df["high"]
    low  = df["low"]
    close = df["close"]
    rng = (high - low).replace(0, pd.NA)
    money_flow_multiplier = ((close - low) - (high - close)) / rng
    mfv = money_flow_multiplier * df["volume"]
    s = mfv.rolling(window=period, min_periods=period).sum() / df["volume"].rolling(window=period, min_periods=period).sum()
    return {"indicator": "cmf", "period": period, "points": _points(df, s)}


def chaikin_oscillator(df: pd.DataFrame, fast: int = 3, slow: int = 10) -> dict:
    """Chaikin Oscillator — MACD applied to the Accumulation/Distribution line."""
    if df.empty or len(df) < slow + 1:
        return {"indicator": "chaikin_oscillator", "fast": fast, "slow": slow, "points": []}
    high = df["high"]
    low  = df["low"]
    close = df["close"]
    rng = (high - low).replace(0, pd.NA)
    mfm = ((close - low) - (high - close)) / rng
    mfv = mfm * df["volume"]
    ad  = mfv.cumsum()
    s = ad.ewm(span=fast, adjust=False, min_periods=fast).mean() - ad.ewm(span=slow, adjust=False, min_periods=slow).mean()
    return {"indicator": "chaikin_oscillator", "fast": fast, "slow": slow, "points": _points(df, s)}


def anchored_vwap(df: pd.DataFrame, anchor_date: Optional[str] = None) -> dict:
    """Anchored VWAP — cumulative VWAP from a specific bar (drag-anchor in UI).

    If `anchor_date` is None, anchors at the first bar in the loaded window.
    """
    if df.empty:
        return {"indicator": "anchored_vwap", "anchor_date": anchor_date, "points": []}
    anchor_idx = 0
    if anchor_date:
        candidates = df[df["date"] >= pd.to_datetime(anchor_date)]
        if not candidates.empty:
            anchor_idx = int(candidates.index[0])
    sub = df.iloc[anchor_idx:].copy()
    tp = (sub["high"] + sub["low"] + sub["close"]) / 3.0
    vol = sub["volume"].replace(0.0, pd.NA)
    pv = tp * vol
    s = pv.cumsum() / vol.cumsum()
    return {
        "indicator":   "anchored_vwap",
        "anchor_date": str(sub["date"].iloc[0].date()) if not sub.empty else anchor_date,
        "points":      [{"date": d.strftime("%Y-%m-%d"), "value": float(v)}
                        for d, v in zip(sub["date"], s) if not pd.isna(v)],
    }


# ── Structure detection ────────────────────────────────────────────────────

def support_resistance(df: pd.DataFrame, pivot_window: int = 5, max_levels: int = 6,
                      cluster_pct: float = 1.5) -> dict:
    """Detect horizontal support/resistance levels from swing highs/lows.

    A swing high (pivot high) is a bar whose `high` is the local max in a
    window of `pivot_window` bars on each side. Same for swing low. Then we
    cluster pivots within `cluster_pct` percent of each other and keep the
    `max_levels` most-touched levels.
    """
    if df.empty or len(df) < pivot_window * 2 + 1:
        return {"indicator": "support_resistance", "pivot_window": pivot_window, "levels": []}

    high = df["high"].values
    low  = df["low"].values
    pivots_list: list[tuple[str, str, float]] = []  # (date, type, price)
    for i in range(pivot_window, len(df) - pivot_window):
        left  = slice(i - pivot_window, i)
        right = slice(i + 1, i + 1 + pivot_window)
        if high[i] > high[left].max() and high[i] > high[right].max():
            pivots_list.append((df["date"].iloc[i].strftime("%Y-%m-%d"), "resistance", float(high[i])))
        if low[i] < low[left].min() and low[i] < low[right].min():
            pivots_list.append((df["date"].iloc[i].strftime("%Y-%m-%d"), "support", float(low[i])))

    # Cluster by price proximity (within cluster_pct of each other).
    pivots_list.sort(key=lambda p: p[2])
    clusters: list[dict] = []
    for d, t, p in pivots_list:
        if clusters and abs(p - clusters[-1]["price"]) / max(abs(clusters[-1]["price"]), 1e-9) * 100 <= cluster_pct:
            c = clusters[-1]
            c["touches"] += 1
            c["price"] = (c["price"] * (c["touches"] - 1) + p) / c["touches"]  # running mean
            c["last_date"] = d if d > c["last_date"] else c["last_date"]
            if t not in c["types"]:
                c["types"].append(t)
        else:
            clusters.append({"price": p, "touches": 1, "first_date": d, "last_date": d, "types": [t]})

    # Sort by touch count desc, then by recency, take top N.
    clusters.sort(key=lambda c: (-c["touches"], c["last_date"]), reverse=False)
    clusters.sort(key=lambda c: (-c["touches"]))
    return {
        "indicator":    "support_resistance",
        "pivot_window": pivot_window,
        "levels":       clusters[:max_levels],
    }


def divergence(df: pd.DataFrame, kind: str = "rsi", period: int = 14, lookback: int = 30) -> dict:
    """Detect bullish + bearish divergences between price and `kind` indicator.

    Bullish divergence: price makes a lower low, indicator makes a higher low.
    Bearish divergence: price makes a higher high, indicator makes a lower high.
    Compares each swing pivot (within `lookback` bars) against the prior pivot.
    """
    if df.empty or len(df) < period + lookback + 10:
        return {"indicator": "divergence", "kind": kind, "period": period, "events": []}

    if kind == "rsi":
        ind = rsi(df, period=period)["points"]
    elif kind == "macd":
        m = macd(df)
        ind = m["histogram"]  # use histogram as the comparator
    else:
        raise ValueError(f"divergence kind '{kind}' not supported (rsi | macd)")

    if not ind:
        return {"indicator": "divergence", "kind": kind, "period": period, "events": []}

    ind_map = {p["date"]: p["value"] for p in ind}

    # Detect price swing highs + lows.
    high = df["high"]
    low  = df["low"]
    pw = 3  # tighter window for divergence-relevant swings.
    swing_highs: list[tuple[str, float]] = []
    swing_lows:  list[tuple[str, float]] = []
    for i in range(pw, len(df) - pw):
        if high.iloc[i] > high.iloc[i - pw:i].max() and high.iloc[i] > high.iloc[i + 1:i + 1 + pw].max():
            swing_highs.append((df["date"].iloc[i].strftime("%Y-%m-%d"), float(high.iloc[i])))
        if low.iloc[i]  < low.iloc[i - pw:i].min()  and low.iloc[i]  < low.iloc[i + 1:i + 1 + pw].min():
            swing_lows.append((df["date"].iloc[i].strftime("%Y-%m-%d"), float(low.iloc[i])))

    events: list[dict] = []
    # Bearish divergence: consecutive higher highs in price + lower highs in indicator.
    for i in range(1, len(swing_highs)):
        d1, p1 = swing_highs[i - 1]
        d2, p2 = swing_highs[i]
        if d1 not in ind_map or d2 not in ind_map:
            continue
        v1, v2 = ind_map[d1], ind_map[d2]
        if p2 > p1 and v2 < v1:
            events.append({"type": "bearish", "from_date": d1, "to_date": d2,
                           "price_from": p1, "price_to": p2,
                           "indicator_from": v1, "indicator_to": v2})
    # Bullish divergence: lower lows in price + higher lows in indicator.
    for i in range(1, len(swing_lows)):
        d1, p1 = swing_lows[i - 1]
        d2, p2 = swing_lows[i]
        if d1 not in ind_map or d2 not in ind_map:
            continue
        v1, v2 = ind_map[d1], ind_map[d2]
        if p2 < p1 and v2 > v1:
            events.append({"type": "bullish", "from_date": d1, "to_date": d2,
                           "price_from": p1, "price_to": p2,
                           "indicator_from": v1, "indicator_to": v2})

    # Sort by `to_date` desc — most recent first.
    events.sort(key=lambda e: e["to_date"], reverse=True)
    return {"indicator": "divergence", "kind": kind, "period": period, "events": events}


def heikin_ashi(df: pd.DataFrame) -> dict:
    """Heikin Ashi candles — smoothed-trend candle representation.

    HA_close = (O + H + L + C) / 4
    HA_open  = (HA_open[-1] + HA_close[-1]) / 2  (first bar = (O + C) / 2)
    HA_high  = max(H, HA_open, HA_close)
    HA_low   = min(L, HA_open, HA_close)
    """
    if df.empty:
        return {"indicator": "heikin_ashi", "bars": []}
    ha_close = ((df["open"] + df["high"] + df["low"] + df["close"]) / 4.0).tolist()
    ha_open: list[float] = [(df["open"].iloc[0] + df["close"].iloc[0]) / 2.0]
    for i in range(1, len(df)):
        ha_open.append((ha_open[-1] + ha_close[i - 1]) / 2.0)
    ha_high = [max(df["high"].iloc[i], ha_open[i], ha_close[i]) for i in range(len(df))]
    ha_low  = [min(df["low"].iloc[i],  ha_open[i], ha_close[i]) for i in range(len(df))]
    return {
        "indicator": "heikin_ashi",
        "bars": [
            {"date": d.strftime("%Y-%m-%d"), "open": float(o), "high": float(h), "low": float(l), "close": float(c)}
            for d, o, h, l, c in zip(df["date"], ha_open, ha_high, ha_low, ha_close)
        ],
    }


def pivots(df: pd.DataFrame, kind: str = "classic") -> dict:
    """Daily pivot points computed from the prior bar.

    Returns a single row per bar with: P, R1, R2, R3, S1, S2, S3.
    `kind` = "classic" | "fibonacci"
    """
    if df.empty or len(df) < 2:
        return {"indicator": "pivots", "kind": kind, "points": []}
    h = df["high"].shift(1)
    l = df["low"].shift(1)
    c = df["close"].shift(1)
    p = (h + l + c) / 3.0

    if kind == "fibonacci":
        rng = h - l
        r3 = p + 1.000 * rng
        r2 = p + 0.618 * rng
        r1 = p + 0.382 * rng
        s1 = p - 0.382 * rng
        s2 = p - 0.618 * rng
        s3 = p - 1.000 * rng
    else:  # classic
        r1 = 2 * p - l
        s1 = 2 * p - h
        r2 = p + (h - l)
        s2 = p - (h - l)
        r3 = h + 2 * (p - l)
        s3 = l - 2 * (h - p)

    out: list[dict] = []
    for i in range(len(df)):
        if pd.isna(p.iloc[i]):
            continue
        out.append({
            "date": df["date"].iloc[i].strftime("%Y-%m-%d"),
            "p":  float(p.iloc[i]),
            "r1": float(r1.iloc[i]),
            "r2": float(r2.iloc[i]),
            "r3": float(r3.iloc[i]),
            "s1": float(s1.iloc[i]),
            "s2": float(s2.iloc[i]),
            "s3": float(s3.iloc[i]),
        })
    return {"indicator": "pivots", "kind": kind, "points": out}


# ── Composite signal ───────────────────────────────────────────────────────

def signal_strength(df: pd.DataFrame) -> dict:
    """Composite buy/sell/hold signal from multiple indicators.

    Each indicator votes -1 (sell), 0 (neutral), +1 (buy). Aggregated score
    is then bucketed into:
        strong_buy   >=  0.6
        buy          >=  0.2
        neutral     ( -0.2, 0.2 )
        sell         <= -0.2
        strong_sell  <= -0.6
    Returns the votes alongside the bucket so the user can audit reasoning.
    """
    if df.empty or len(df) < 60:
        return {"indicator": "signal_strength", "score": None, "bucket": "insufficient_data", "votes": {}}

    last = df.iloc[-1]
    close_last = float(last["close"])
    votes: dict[str, int] = {}

    # Trend votes ---------------------------------------------------------
    sma50  = df["close"].rolling(50, min_periods=50).mean().iloc[-1]
    sma200 = df["close"].rolling(200, min_periods=min(200, len(df))).mean().iloc[-1] if len(df) >= 200 else None
    if not pd.isna(sma50):
        votes["price_vs_sma50"] = 1 if close_last > sma50 else -1
    if sma200 is not None and not pd.isna(sma200):
        votes["price_vs_sma200"] = 1 if close_last > sma200 else -1
        votes["sma50_vs_sma200"] = 1 if sma50 > sma200 else -1

    # MACD vote -----------------------------------------------------------
    m = macd(df)
    if m["histogram"]:
        last_hist = m["histogram"][-1]["value"]
        votes["macd_histogram"] = 1 if last_hist > 0 else (-1 if last_hist < 0 else 0)

    # RSI vote (mean-reversion oriented) ----------------------------------
    r = rsi(df)
    if r["points"]:
        last_rsi = r["points"][-1]["value"]
        if last_rsi >= 70:
            votes["rsi"] = -1  # overbought
        elif last_rsi <= 30:
            votes["rsi"] = 1   # oversold
        else:
            votes["rsi"] = 1 if last_rsi > 50 else -1

    # ADX trend strength filter -------------------------------------------
    a = adx(df)
    if a["adx"]:
        last_adx = a["adx"][-1]["value"]
        votes["adx_strength"] = 1 if last_adx > 25 else 0

    # Stochastic vote -----------------------------------------------------
    st = stochastic(df)
    if st["k_line"]:
        last_k = st["k_line"][-1]["value"]
        votes["stochastic"] = -1 if last_k >= 80 else (1 if last_k <= 20 else 0)

    # Bollinger position vote (mean-reversion oriented) -------------------
    bb = bollinger(df)
    if bb["upper"] and bb["lower"]:
        u = bb["upper"][-1]["value"]
        l = bb["lower"][-1]["value"]
        if close_last >= u:
            votes["bollinger"] = -1
        elif close_last <= l:
            votes["bollinger"] = 1
        else:
            votes["bollinger"] = 0

    if not votes:
        return {"indicator": "signal_strength", "score": None, "bucket": "insufficient_data", "votes": {}}

    score = sum(votes.values()) / len(votes)
    if score >= 0.6:
        bucket = "strong_buy"
    elif score >= 0.2:
        bucket = "buy"
    elif score <= -0.6:
        bucket = "strong_sell"
    elif score <= -0.2:
        bucket = "sell"
    else:
        bucket = "neutral"

    return {
        "indicator": "signal_strength",
        "score":     round(float(score), 3),
        "bucket":    bucket,
        "votes":     votes,
    }


# ── Public entry points (used by the API route) ────────────────────────────

def _dispatch(name: str, df: pd.DataFrame, **kwargs) -> dict:
    ind = name.lower().strip()
    if ind == "sma":            return sma(df, period=int(kwargs.get("period", 20)))
    if ind == "ema":            return ema(df, period=int(kwargs.get("period", 20)))
    if ind == "macd":           return macd(df, fast=int(kwargs.get("fast", 12)),
                                            slow=int(kwargs.get("slow", 26)),
                                            signal=int(kwargs.get("signal", 9)))
    if ind == "bollinger":      return bollinger(df, period=int(kwargs.get("period", 20)),
                                                 std_dev=float(kwargs.get("std_dev", 2.0)))
    if ind == "donchian":       return donchian(df, period=int(kwargs.get("period", 20)))
    if ind == "keltner":        return keltner(df, period=int(kwargs.get("period", 20)),
                                               atr_period=int(kwargs.get("atr_period", 10)),
                                               multiplier=float(kwargs.get("multiplier", 2.0)))
    if ind == "parabolic_sar":  return parabolic_sar(df, step=float(kwargs.get("step", 0.02)),
                                                    max_step=float(kwargs.get("max_step", 0.2)))
    if ind == "ichimoku":       return ichimoku(df,
                                                tenkan=int(kwargs.get("tenkan", 9)),
                                                kijun=int(kwargs.get("kijun", 26)),
                                                senkou_b=int(kwargs.get("senkou_b", 52)),
                                                chikou_shift=int(kwargs.get("chikou_shift", 26)))
    if ind == "crossovers":     return crossovers(df, fast=int(kwargs.get("fast", 50)),
                                                  slow=int(kwargs.get("slow", 200)))
    if ind == "adx":            return adx(df, period=int(kwargs.get("period", 14)))
    if ind == "rsi":            return rsi(df, period=int(kwargs.get("period", 14)))
    if ind == "stochastic":     return stochastic(df,
                                                  k_period=int(kwargs.get("k_period", 14)),
                                                  k_smooth=int(kwargs.get("k_smooth", 3)),
                                                  d_period=int(kwargs.get("d_period", 3)))
    if ind == "williams_r":     return williams_r(df, period=int(kwargs.get("period", 14)))
    if ind == "cci":            return cci(df, period=int(kwargs.get("period", 20)))
    if ind == "roc":            return roc(df, period=int(kwargs.get("period", 12)))
    if ind == "mfi":            return mfi(df, period=int(kwargs.get("period", 14)))
    if ind == "obv":            return obv(df)
    if ind == "vwap":           p = kwargs.get("period"); return vwap(df, period=int(p) if p else None)
    if ind == "atr":            return atr(df, period=int(kwargs.get("period", 14)))
    if ind == "pivots":         return pivots(df, kind=str(kwargs.get("kind", "classic")))
    if ind == "signal":         return signal_strength(df)
    if ind == "supertrend":     return supertrend(df, period=int(kwargs.get("period", 10)),
                                                  multiplier=float(kwargs.get("multiplier", 3.0)))
    if ind == "aroon":          return aroon(df, period=int(kwargs.get("period", 25)))
    if ind == "vortex":         return vortex(df, period=int(kwargs.get("period", 14)))
    if ind == "hull_ma":        return hull_ma(df, period=int(kwargs.get("period", 20)))
    if ind == "kama":           return kama(df, period=int(kwargs.get("period", 10)),
                                            fast=int(kwargs.get("fast", 2)),
                                            slow=int(kwargs.get("slow", 30)))
    if ind == "vwma":           return vwma(df, period=int(kwargs.get("period", 20)))
    if ind == "trix":           return trix(df, period=int(kwargs.get("period", 15)),
                                            signal=int(kwargs.get("signal", 9)))
    if ind == "ultimate_oscillator": return ultimate_oscillator(
        df, fast=int(kwargs.get("fast", 7)), mid=int(kwargs.get("mid", 14)), slow=int(kwargs.get("slow", 28)),
    )
    if ind == "awesome_oscillator": return awesome_oscillator(
        df, fast=int(kwargs.get("fast", 5)), slow=int(kwargs.get("slow", 34)),
    )
    if ind == "cmf":            return cmf(df, period=int(kwargs.get("period", 20)))
    if ind == "chaikin_oscillator": return chaikin_oscillator(
        df, fast=int(kwargs.get("fast", 3)), slow=int(kwargs.get("slow", 10)),
    )
    if ind == "anchored_vwap":  return anchored_vwap(df, anchor_date=kwargs.get("anchor_date"))
    if ind == "support_resistance": return support_resistance(
        df, pivot_window=int(kwargs.get("pivot_window", 5)),
        max_levels=int(kwargs.get("max_levels", 6)),
        cluster_pct=float(kwargs.get("cluster_pct", 1.5)),
    )
    if ind == "divergence":     return divergence(df, kind=str(kwargs.get("kind", "rsi")),
                                                  period=int(kwargs.get("period", 14)),
                                                  lookback=int(kwargs.get("lookback", 30)))
    if ind == "heikin_ashi":    return heikin_ashi(df)
    raise ValueError(f"unknown indicator: {name}")


def compute(symbol: str, indicator: str, *, timeframe: str = "1d", days: int = 365, **kwargs) -> dict:
    """Compute a single indicator. Resamples the OHLCV to `timeframe` first."""
    if timeframe not in TIMEFRAMES:
        raise ValueError(f"unknown timeframe: {timeframe}")
    # Pull enough daily history to support the requested timeframe's lookbacks.
    days_to_load = days * (5 if timeframe == "1w" else (22 if timeframe == "1mo" else 1))
    df = _resample(_load_ohlcv(symbol, days_to_load), timeframe)
    return _dispatch(indicator, df, **kwargs)


def compute_many(symbol: str, indicators: list[str], *, timeframe: str = "1d", days: int = 365,
                 params: Optional[dict] = None) -> dict:
    """Compute several indicators in one pass — single DB read + resample."""
    if timeframe not in TIMEFRAMES:
        raise ValueError(f"unknown timeframe: {timeframe}")
    days_to_load = days * (5 if timeframe == "1w" else (22 if timeframe == "1mo" else 1))
    df = _resample(_load_ohlcv(symbol, days_to_load), timeframe)
    params = params or {}
    out: dict[str, dict] = {}
    for name in indicators:
        out[name] = _dispatch(name, df, **(params.get(name, {})))
    # Always include OHLCV so the frontend can draw candles + volume without a second call.
    return {
        "symbol":    symbol.upper().strip(),
        "timeframe": timeframe,
        "bars": [
            {
                "date":   d.strftime("%Y-%m-%d"),
                "open":   float(o), "high": float(h), "low": float(l), "close": float(c),
                "adj_close": float(ac), "volume": float(v),
            }
            for d, o, h, l, c, ac, v in zip(
                df["date"], df["open"], df["high"], df["low"], df["close"], df["adj_close"], df["volume"],
            )
        ],
        "indicators": out,
    }
