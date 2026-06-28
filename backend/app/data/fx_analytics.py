"""FX carry, covered-interest-parity forwards, and volatility cones (FXFA).

Two cross-asset surfaces for the major USD currency pairs:

- `fx_carry_table()` ranks the majors by annualized carry (interest-rate
  differential between the two legs) and prints a covered-interest-parity
  forward curve per pair: F = S*(1 + r_quote*T)/(1 + r_base*T) for the
  1M/3M/6M/1Y tenors.
- `fx_vol_cone(pair)` returns realized volatility by tenor plus a sample
  implied-vol cone (min/p25/median/p75/max per tenor) built from the rolling
  realized-vol distribution.

Live path: spot via `macro_data.fetch_arbitrary_ticker` (yfinance FX symbols
like `EURUSD=X`), the USD 3M leg via `macro_data.fetch_series("DGS3MO")` (FRED).
Foreign-currency policy rates are realistic SAMPLE constants (no clean live
proxy). When live data is unavailable we degrade to fully-populated, deterministic
SAMPLE values seeded off the pair via hashlib, exactly like etf_tracking.py.

This module never raises. Every payload carries data_mode / as_of / source.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker, fetch_series

log = logging.getLogger(__name__)

_TTL = 60 * 30  # 30 min - rates + spot move slowly relative to a screenshot
TRADING_DAYS = 252

# (pair key, yfinance symbol, base currency, quote currency, spot precision).
# Spot is quote-per-base; CIP uses r_quote on the numerator, r_base on the denom.
PAIRS: list[tuple[str, str, str, str, int]] = [
    ("EURUSD", "EURUSD=X", "EUR", "USD", 4),
    ("USDJPY", "USDJPY=X", "USD", "JPY", 2),
    ("GBPUSD", "GBPUSD=X", "GBP", "USD", 4),
    ("AUDUSD", "AUDUSD=X", "AUD", "USD", 4),
    ("USDCAD", "USDCAD=X", "USD", "CAD", 4),
    ("USDCHF", "USDCHF=X", "USD", "CHF", 4),
    ("NZDUSD", "NZDUSD=X", "NZD", "USD", 4),
]

# Forward tenors expressed in fractions of a year.
TENORS_T: dict[str, float] = {"1M": 1 / 12, "3M": 0.25, "6M": 0.5, "1Y": 1.0}

# Realistic 3M policy/deposit rates as decimal fractions (e.g. 0.0530 = 5.30%).
# USD is overridden with DGS3MO when FRED is reachable; the rest are SAMPLE.
SAMPLE_3M_RATES: dict[str, float] = {
    "USD": 0.0530,
    "EUR": 0.0340,
    "JPY": 0.0025,
    "GBP": 0.0475,
    "AUD": 0.0435,
    "CAD": 0.0450,
    "CHF": 0.0110,
    "NZD": 0.0525,
}

# Deterministic SAMPLE spot levels (quote per base).
SAMPLE_SPOT: dict[str, float] = {
    "EURUSD": 1.0850,
    "USDJPY": 157.50,
    "GBPUSD": 1.2700,
    "AUDUSD": 0.6650,
    "USDCAD": 1.3700,
    "USDCHF": 0.8950,
    "NZDUSD": 0.6100,
}

# Baseline annualized realized vol per pair (decimal fraction) for the SAMPLE
# walk that feeds the vol cone when live history is unavailable.
SAMPLE_VOL: dict[str, float] = {
    "EURUSD": 0.070,
    "USDJPY": 0.095,
    "GBPUSD": 0.080,
    "AUDUSD": 0.105,
    "USDCAD": 0.060,
    "USDCHF": 0.072,
    "NZDUSD": 0.110,
}

# Rolling realized-vol windows (trading days) for the cone tenors.
VOL_TENORS: list[tuple[str, int]] = [
    ("1W", 5),
    ("1M", 21),
    ("3M", 63),
    ("6M", 126),
    ("1Y", 252),
]


def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


# ---------------------------------------------------------------------------
# D1a. Carry + CIP forwards
# ---------------------------------------------------------------------------

def fx_carry_table() -> dict:
    """Major-pair carry ranking + covered-interest-parity forward curves.

    Never raises - degrades to deterministic SAMPLE values.
    """
    try:
        return _fx_carry_table()
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("fx_carry_table failed hard, returning sample: %s", e)
        return _carry_payload(usd_rate=SAMPLE_3M_RATES["USD"], spots={},
                              data_mode="sample", source="sample")


def _fx_carry_table() -> dict:
    cache_key = "fx:carry"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # USD 3M leg from FRED (DGS3MO is reported in percent), else sample.
    usd_rate = SAMPLE_3M_RATES["USD"]
    usd_live = False
    try:
        pts = fetch_series("DGS3MO", days=20)
        vals = [p["value"] for p in pts if p.get("value") is not None]
        if vals:
            usd_rate = float(vals[-1]) / 100.0
            usd_live = True
    except Exception as e:
        log.warning("fx carry DGS3MO fetch failed: %s", e)

    # Live spot per pair (best effort).
    spots: dict[str, float] = {}
    for key, symbol, _base, _quote, _prec in PAIRS:
        try:
            pts = fetch_arbitrary_ticker(symbol, days=10)
            vals = [p["value"] for p in pts if p.get("value") is not None]
            if vals:
                spots[key] = float(vals[-1])
        except Exception as e:
            log.warning("fx carry spot(%s) failed: %s", symbol, e)

    live = bool(spots) or usd_live
    payload = _carry_payload(
        usd_rate=usd_rate,
        spots=spots,
        data_mode="live" if live else "sample",
        source="yfinance/fred" if live else "sample",
    )
    cache.set(cache_key, payload, _TTL)
    return payload


def _carry_payload(*, usd_rate: float, spots: dict[str, float],
                   data_mode: str, source: str) -> dict:
    """Build the ranked carry table from a USD rate + whatever live spots
    resolved. Missing spots fall back to SAMPLE_SPOT; foreign rates are always
    SAMPLE. Deterministic and never-raising by construction."""
    rates = dict(SAMPLE_3M_RATES)
    rates["USD"] = usd_rate

    rows: list[dict] = []
    for key, _symbol, base, quote, prec in PAIRS:
        spot = spots.get(key)
        if spot is None or spot <= 0:
            spot = SAMPLE_SPOT[key]
        r_base = rates[base]
        r_quote = rates[quote]

        fwd: dict[str, float] = {}
        for tenor, T in TENORS_T.items():
            f = spot * (1.0 + r_quote * T) / (1.0 + r_base * T)
            fwd[tenor] = round(float(f), prec)

        # Carry of holding the pair long: earn the base leg, fund the quote leg.
        carry_pct = round((r_base - r_quote) * 100.0, 3)
        rows.append({
            "pair": key,
            "spot": round(float(spot), prec),
            "fwd": fwd,
            "carry_pct": carry_pct,
            "base_rate": round(r_base * 100.0, 3),
            "quote_rate": round(r_quote * 100.0, 3),
        })

    rows.sort(key=lambda r: r["carry_pct"], reverse=True)

    return {
        "pairs": rows,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# D1b. Realized vol + implied-vol cone
# ---------------------------------------------------------------------------

def fx_vol_cone(pair: str) -> dict:
    """Realized vol by tenor + a sample implied-vol cone for one pair.

    Never raises - degrades to a deterministic SAMPLE cone.
    """
    key = _normalize_pair(pair)
    try:
        return _fx_vol_cone(key)
    except Exception as e:  # absolute safety net
        log.warning("fx_vol_cone(%s) failed hard, returning sample: %s", key, e)
        return _vol_payload(key, _sample_returns(key), data_mode="sample", source="sample")


def _normalize_pair(pair: str) -> str:
    raw = (pair or "").strip().upper().replace("/", "").replace("=X", "")
    valid = {k for k, *_ in PAIRS}
    return raw if raw in valid else "EURUSD"


def _fx_vol_cone(key: str) -> dict:
    cache_key = f"fx:volcone:{key}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    symbol = next(s for k, s, *_ in PAIRS if k == key)
    returns: np.ndarray | None = None
    try:
        pts = fetch_arbitrary_ticker(symbol, days=900)
        vals = [float(p["value"]) for p in pts if p.get("value") is not None and p["value"] > 0]
        if len(vals) >= VOL_TENORS[-1][1] + 30:
            prices = np.asarray(vals, dtype=float)
            returns = np.diff(np.log(prices))
    except Exception as e:
        log.warning("fx_vol_cone live fetch(%s) failed: %s", symbol, e)

    if returns is not None and len(returns) >= VOL_TENORS[-1][1] + 5:
        payload = _vol_payload(key, returns, data_mode="live", source="yfinance")
    else:
        payload = _vol_payload(key, _sample_returns(key), data_mode="sample", source="sample")

    cache.set(cache_key, payload, _TTL)
    return payload


def _sample_returns(key: str, n: int = 760) -> np.ndarray:
    """Deterministic daily log-return walk whose annualized vol matches the
    pair's sample profile, with a slow vol-of-vol drift so the cone has width."""
    base_vol = SAMPLE_VOL.get(key, 0.085)
    rng = np.random.default_rng(_seed(key))
    daily = base_vol / np.sqrt(TRADING_DAYS)
    # Regime-style vol drift between ~0.7x and ~1.4x the base level.
    drift = 1.0 + 0.35 * np.sin(np.linspace(0.0, 6.0, n) + (_seed(key) % 7))
    drift = np.clip(drift, 0.7, 1.4)
    return rng.normal(0.0, daily, n) * drift


def _vol_payload(key: str, returns: np.ndarray, *, data_mode: str, source: str) -> dict:
    tenors: list[dict] = []
    for tenor, w in VOL_TENORS:
        if len(returns) < w + 1:
            continue
        # Rolling annualized realized vol distribution for this window.
        rolling = [
            float(np.std(returns[i - w:i], ddof=1) * np.sqrt(TRADING_DAYS) * 100.0)
            for i in range(w, len(returns) + 1)
        ]
        rolling = [v for v in rolling if np.isfinite(v)]
        if not rolling:
            continue
        arr = np.asarray(rolling, dtype=float)
        tenors.append({
            "tenor": tenor,
            "realized_vol": round(float(arr[-1]), 2),
            "iv_min": round(float(np.min(arr)), 2),
            "iv_p25": round(float(np.percentile(arr, 25)), 2),
            "iv_median": round(float(np.percentile(arr, 50)), 2),
            "iv_p75": round(float(np.percentile(arr, 75)), 2),
            "iv_max": round(float(np.max(arr)), 2),
        })

    return {
        "pair": key,
        "tenors": tenors,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
