"""Built-in backtest strategies.

Each strategy is a PURE function over a price series (list[float]) returning a
position signal series of the SAME length, with each element in {-1, 0, 1}
(or a weight in [-1, 1] for vol-target). position[i] is the target position
decided at the close of bar i using only information up to and including bar i,
so the engine applies position(t-1) * return(t) with no look-ahead.

`list_strategies()` returns the catalog the API/frontend reads for the param
form (key, name, params:[{name, default, ...}]).
"""
from __future__ import annotations

import numpy as np

# --- small numeric helpers (pure, no external state) -----------------------


def _arr(prices) -> np.ndarray:
    return np.asarray(prices, dtype=float)


def _sma(prices: np.ndarray, window: int) -> np.ndarray:
    """Trailing simple moving average; NaN until `window` samples exist."""
    n = len(prices)
    out = np.full(n, np.nan)
    if window <= 0:
        return prices.astype(float)
    csum = np.cumsum(np.insert(prices, 0, 0.0))
    for i in range(window - 1, n):
        out[i] = (csum[i + 1] - csum[i + 1 - window]) / window
    return out


def _rolling_std(prices: np.ndarray, window: int) -> np.ndarray:
    n = len(prices)
    out = np.full(n, np.nan)
    for i in range(window - 1, n):
        out[i] = np.std(prices[i - window + 1 : i + 1], ddof=0)
    return out


def _rsi(prices: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder-smoothed RSI; NaN until enough samples exist."""
    n = len(prices)
    out = np.full(n, np.nan)
    if n < period + 1:
        return out
    deltas = np.diff(prices)
    gains = np.clip(deltas, 0.0, None)
    losses = np.clip(-deltas, 0.0, None)
    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))
    for i in range(period, n):
        if i > period:
            avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        if avg_loss == 0:
            out[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - 100.0 / (1.0 + rs)
    return out


# --- strategies (each: prices -> position series of equal length) ----------


def sma_cross(prices, fast: int = 20, slow: int = 50) -> list[float]:
    """Long when the fast SMA is above the slow SMA, else short."""
    p = _arr(prices)
    fast = max(1, int(fast))
    slow = max(fast + 1, int(slow))
    sf = _sma(p, fast)
    ss = _sma(p, slow)
    pos = np.zeros(len(p))
    for i in range(len(p)):
        if np.isnan(sf[i]) or np.isnan(ss[i]):
            pos[i] = 0.0
        else:
            pos[i] = 1.0 if sf[i] > ss[i] else -1.0
    return pos.tolist()


def rsi_meanrev(prices, low: float = 30.0, high: float = 70.0, period: int = 14) -> list[float]:
    """Mean reversion: go long when oversold (RSI < low), short when
    overbought (RSI > high), otherwise hold the prior position."""
    p = _arr(prices)
    rsi = _rsi(p, int(period))
    pos = np.zeros(len(p))
    cur = 0.0
    for i in range(len(p)):
        r = rsi[i]
        if not np.isnan(r):
            if r < low:
                cur = 1.0
            elif r > high:
                cur = -1.0
        pos[i] = cur
    return pos.tolist()


def momentum_12_1(prices, lookback: int = 252, gap: int = 21) -> list[float]:
    """Time-series momentum: long if the 12-month-minus-1-month return is
    positive, short otherwise."""
    p = _arr(prices)
    lookback = max(2, int(lookback))
    gap = max(0, int(gap))
    pos = np.zeros(len(p))
    for i in range(len(p)):
        j0 = i - lookback
        j1 = i - gap
        if j0 < 0 or j1 < 0 or p[j0] <= 0:
            pos[i] = 0.0
            continue
        mom = p[j1] / p[j0] - 1.0
        pos[i] = 1.0 if mom > 0 else -1.0
    return pos.tolist()


def vol_target(prices, target_vol: float = 0.10, window: int = 20) -> list[float]:
    """Long position scaled so trailing realized vol matches target_vol
    (weight clamped to [0, 1]). A volatility-targeting overlay."""
    p = _arr(prices)
    window = max(2, int(window))
    rets = np.zeros(len(p))
    rets[1:] = np.diff(p) / p[:-1]
    pos = np.zeros(len(p))
    for i in range(len(p)):
        if i < window:
            continue
        realized = float(np.std(rets[i - window + 1 : i + 1], ddof=1)) * np.sqrt(252.0)
        if realized <= 1e-9:
            w = 1.0
        else:
            w = target_vol / realized
        pos[i] = float(min(1.0, max(0.0, w)))
    return pos.tolist()


def bollinger_breakout(prices, window: int = 20, k: float = 2.0) -> list[float]:
    """Breakout: long above the upper band, short below the lower band,
    otherwise hold the prior position."""
    p = _arr(prices)
    window = max(2, int(window))
    mid = _sma(p, window)
    sd = _rolling_std(p, window)
    pos = np.zeros(len(p))
    cur = 0.0
    for i in range(len(p)):
        if not np.isnan(mid[i]) and not np.isnan(sd[i]):
            upper = mid[i] + k * sd[i]
            lower = mid[i] - k * sd[i]
            if p[i] > upper:
                cur = 1.0
            elif p[i] < lower:
                cur = -1.0
        pos[i] = cur
    return pos.tolist()


# --- catalog ----------------------------------------------------------------

_CATALOG: list[dict] = [
    {
        "key": "sma_cross",
        "name": "SMA Crossover",
        "description": "Long when fast SMA is above slow SMA, short otherwise.",
        "fn": sma_cross,
        "params": [
            {"name": "fast", "label": "Fast SMA", "type": "int", "default": 20, "min": 2, "max": 100, "step": 1},
            {"name": "slow", "label": "Slow SMA", "type": "int", "default": 50, "min": 5, "max": 300, "step": 1},
        ],
    },
    {
        "key": "rsi_meanrev",
        "name": "RSI Mean Reversion",
        "description": "Buy oversold, sell overbought using RSI thresholds.",
        "fn": rsi_meanrev,
        "params": [
            {"name": "low", "label": "Oversold", "type": "float", "default": 30.0, "min": 5.0, "max": 45.0, "step": 1.0},
            {"name": "high", "label": "Overbought", "type": "float", "default": 70.0, "min": 55.0, "max": 95.0, "step": 1.0},
            {"name": "period", "label": "RSI Period", "type": "int", "default": 14, "min": 2, "max": 50, "step": 1},
        ],
    },
    {
        "key": "momentum_12_1",
        "name": "Momentum (12-1)",
        "description": "Long if 12-month-minus-1-month return is positive, short otherwise.",
        "fn": momentum_12_1,
        "params": [
            {"name": "lookback", "label": "Lookback (days)", "type": "int", "default": 252, "min": 21, "max": 504, "step": 1},
            {"name": "gap", "label": "Skip (days)", "type": "int", "default": 21, "min": 0, "max": 63, "step": 1},
        ],
    },
    {
        "key": "vol_target",
        "name": "Volatility Target",
        "description": "Long overlay scaled so realized vol matches a target.",
        "fn": vol_target,
        "params": [
            {"name": "target_vol", "label": "Target Vol", "type": "float", "default": 0.10, "min": 0.02, "max": 0.40, "step": 0.01},
            {"name": "window", "label": "Vol Window", "type": "int", "default": 20, "min": 5, "max": 120, "step": 1},
        ],
    },
    {
        "key": "bollinger_breakout",
        "name": "Bollinger Breakout",
        "description": "Long on an upper-band breakout, short on a lower-band breakdown.",
        "fn": bollinger_breakout,
        "params": [
            {"name": "window", "label": "Window", "type": "int", "default": 20, "min": 5, "max": 100, "step": 1},
            {"name": "k", "label": "Band Width (sd)", "type": "float", "default": 2.0, "min": 0.5, "max": 4.0, "step": 0.1},
        ],
    },
]

STRATEGIES: dict[str, dict] = {s["key"]: s for s in _CATALOG}


def list_strategies() -> list[dict]:
    """Public catalog: [{key, name, description, params:[{name, default, ...}]}]."""
    return [
        {
            "key": s["key"],
            "name": s["name"],
            "description": s["description"],
            "params": [dict(p) for p in s["params"]],
        }
        for s in _CATALOG
    ]


def get_strategy(key: str) -> dict | None:
    return STRATEGIES.get(key)


def default_params(key: str) -> dict:
    s = STRATEGIES.get(key)
    if not s:
        return {}
    return {p["name"]: p["default"] for p in s["params"]}
