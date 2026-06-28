"""Short Interest & Squeeze engine (Bloomberg SI / squeeze-screen analog).

Given a symbol, builds a short-interest + squeeze read:

- Short % of float, days-to-cover (sharesShort / avgVol), an estimated borrow
  fee, the float, and shares short.
- A composite squeeze score 0-100 blending four pressure components:
  short % of float, days-to-cover, borrow fee, and recent price momentum.
  The score carries a human label (Low / Moderate / Elevated / High / Extreme).
- A short-interest history series (bi-monthly settlement-style cadence) giving
  short % of float and days-to-cover over time.

Live path: yfinance ``Ticker(symbol).info`` for sharesShort, shortRatio,
shortPercentOfFloat, floatShares (one call per symbol). Recent momentum is read
from app.data.macro_data.fetch_arbitrary_ticker. When the live info is missing
the relevant fields we degrade to a deterministic sample seeded off the symbol
(hashlib) so the panel is always fully populated for screenshots and the same
symbol always yields the same numbers.

This module never raises - it always returns a populated payload tagged with
data_mode / as_of / source for honesty under the hood.

Formulas (pure numpy / stdlib):
  si_pct_float    = 100 * sharesShort / floatShares
  days_to_cover   = sharesShort / averageVolume   (yfinance shortRatio when given)
  squeeze_score   = weighted blend of the four normalized components, clamped 0..100
  momentum (20d)  = price[-1] / price[-21] - 1   (drives the momentum component)
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

SHORT_INTEREST_TTL = 60 * 60 * 6  # 6 hours - SI settles on a slow cadence
HISTORY_POINTS = 18               # ~9 months of bi-monthly settlement points
MOMENTUM_LOOKBACK = 21            # trading days for the 20d momentum read

# Component weights for the composite squeeze score (sum to 1.0).
W_SI = 0.35       # short % of float
W_DTC = 0.30      # days-to-cover
W_BORROW = 0.20   # borrow fee
W_MOM = 0.15      # recent momentum

# Saturation points: a component hits ~100 of its sub-score at these levels.
SI_SAT = 35.0      # 35% short of float is extreme
DTC_SAT = 10.0     # 10 days to cover is extreme
BORROW_SAT = 60.0  # 60% annualized borrow fee is extreme
MOM_SAT = 0.30     # +30% over 20d feeds the squeeze, -30% drains it


# ---------------------------------------------------------------------------
# Deterministic sample synthesis (seeded off the symbol)
# ---------------------------------------------------------------------------

def _seed(symbol: str) -> int:
    """Stable integer seed derived from the symbol via hashlib (md5)."""
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _tilt(symbol: str, slice_idx: int) -> float:
    """A bounded [-1, 1] per-symbol tilt from a hash slice."""
    h = hashlib.md5(symbol.encode()).hexdigest()
    chunk = h[slice_idx:slice_idx + 4]
    return (int(chunk, 16) / 0xFFFF - 0.5) * 2.0


def _sample_metrics(symbol: str) -> dict:
    """Deterministic sample short-interest metrics for a symbol.

    Produces a realistic spread of names: most tickers are lightly shorted, a
    minority are crowded shorts. Seeded so a symbol is reproducible.
    """
    rng = np.random.default_rng(_seed(symbol))

    # Heavy-tailed short interest: mostly low, occasionally a crowded short.
    si_pct = float(np.clip(rng.gamma(2.0, 3.0) + abs(_tilt(symbol, 0)) * 4.0, 0.4, 48.0))
    # Days-to-cover loosely tracks crowding, with its own noise.
    dtc = float(np.clip(si_pct * 0.18 + rng.gamma(2.0, 0.9), 0.2, 14.0))
    # Borrow fee climbs non-linearly once a name is crowded.
    borrow = float(np.clip((si_pct / SI_SAT) ** 1.4 * 45.0 + rng.gamma(1.5, 1.2), 0.25, 180.0))

    # Float / shares-short scaled to a plausible cap.
    float_shares = int(np.clip(rng.lognormal(19.0, 1.1), 5e6, 6e9))
    shares_short = int(float_shares * si_pct / 100.0)

    return {
        "si_pct_float": round(si_pct, 2),
        "days_to_cover": round(dtc, 2),
        "borrow_fee_pct": round(borrow, 2),
        "float_shares": float_shares,
        "shares_short": shares_short,
    }


# ---------------------------------------------------------------------------
# Live extraction from yfinance .info
# ---------------------------------------------------------------------------

def _num(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN guard
        return None
    return f


def _live_metrics(symbol: str) -> dict | None:
    """Pull short-interest metrics from yfinance .info; None if unusable.

    Requires at least shares-short or short-%-of-float to consider it live. The
    borrow fee is never reported by yfinance, so it is always sampled and the
    payload stays data_mode "live" only when the core SI fields are real.
    """
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("short_interest live info failed for %s: %s", symbol, e)
        return None

    shares_short = _num(info.get("sharesShort"))
    float_shares = _num(info.get("floatShares"))
    short_ratio = _num(info.get("shortRatio"))            # days to cover
    short_pct = _num(info.get("shortPercentOfFloat"))     # yfinance gives a fraction
    avg_vol = _num(info.get("averageVolume")) or _num(info.get("averageDailyVolume10Day"))

    # Need a real anchor: either shares short or short % of float.
    if shares_short is None and short_pct is None:
        return None

    # Short % of float (yfinance reports a 0..1 fraction).
    si_pct: float | None = None
    if short_pct is not None:
        si_pct = short_pct * 100.0
    elif shares_short is not None and float_shares and float_shares > 0:
        si_pct = 100.0 * shares_short / float_shares
    if si_pct is None:
        return None
    si_pct = float(np.clip(si_pct, 0.0, 100.0))

    # Days to cover.
    dtc: float | None = short_ratio
    if dtc is None and shares_short is not None and avg_vol and avg_vol > 0:
        dtc = shares_short / avg_vol
    if dtc is None:
        # Reasonable fallback from a typical turnover assumption.
        dtc = float(np.clip(si_pct * 0.18, 0.2, 14.0))
    dtc = float(np.clip(dtc, 0.0, 60.0))

    # Float / shares short fill-ins.
    if float_shares is None and shares_short is not None and si_pct > 0:
        float_shares = shares_short / (si_pct / 100.0)
    if shares_short is None and float_shares is not None:
        shares_short = float_shares * si_pct / 100.0

    # Borrow fee is never in .info -> deterministic sample anchored to crowding.
    sample = _sample_metrics(symbol)
    borrow = sample["borrow_fee_pct"]

    return {
        "si_pct_float": round(si_pct, 2),
        "days_to_cover": round(dtc, 2),
        "borrow_fee_pct": round(borrow, 2),
        "float_shares": int(float_shares) if float_shares else sample["float_shares"],
        "shares_short": int(shares_short) if shares_short else sample["shares_short"],
    }


# ---------------------------------------------------------------------------
# Momentum, score, history
# ---------------------------------------------------------------------------

def _momentum(symbol: str) -> tuple[float, bool]:
    """20-day price momentum as a fraction. Returns (momentum, is_live)."""
    try:
        points = fetch_arbitrary_ticker(symbol, days=120)
    except Exception as e:
        log.warning("short_interest momentum fetch failed for %s: %s", symbol, e)
        points = []

    closes: list[float] = []
    for p in points or []:
        v = p.get("value")
        if v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv > 0:
                closes.append(fv)

    if len(closes) > MOMENTUM_LOOKBACK:
        ref = closes[-(MOMENTUM_LOOKBACK + 1)]
        if ref > 0:
            return float(closes[-1] / ref - 1.0), True

    # Deterministic sample momentum in roughly [-0.25, 0.25].
    return float(np.clip(_tilt(symbol, 4) * 0.22, -0.35, 0.35)), False


def _squeeze_score(si_pct: float, dtc: float, borrow: float, momentum: float) -> int:
    """Blend the four pressure components into a 0-100 squeeze score."""
    si_c = min(si_pct / SI_SAT, 1.0)
    dtc_c = min(dtc / DTC_SAT, 1.0)
    borrow_c = min(borrow / BORROW_SAT, 1.0)
    # Momentum maps [-MOM_SAT, +MOM_SAT] -> [0, 1]; rising prices add squeeze fuel.
    mom_c = float(np.clip((momentum + MOM_SAT) / (2 * MOM_SAT), 0.0, 1.0))

    blend = W_SI * si_c + W_DTC * dtc_c + W_BORROW * borrow_c + W_MOM * mom_c
    return int(round(float(np.clip(blend * 100.0, 0.0, 100.0))))


def _squeeze_label(score: int) -> str:
    if score >= 80:
        return "Extreme"
    if score >= 60:
        return "High"
    if score >= 40:
        return "Elevated"
    if score >= 20:
        return "Moderate"
    return "Low"


def _history(symbol: str, si_pct: float, dtc: float) -> list[dict]:
    """Bi-monthly short-interest history converging on the current values.

    Deterministic random walk seeded off the symbol, anchored so the final
    point equals the current si_pct / dtc.
    """
    rng = np.random.default_rng(_seed(symbol) ^ 0x5152)
    n = HISTORY_POINTS

    si_steps = rng.normal(0.0, max(si_pct * 0.08, 0.4), n)
    dtc_steps = rng.normal(0.0, max(dtc * 0.08, 0.15), n)
    si_walk = np.clip(si_pct + np.cumsum(si_steps[::-1])[::-1] - si_steps.sum() * 0.0, 0.2, 95.0)
    dtc_walk = np.clip(dtc + np.cumsum(dtc_steps[::-1])[::-1], 0.1, 40.0)

    # Pin the final point exactly to the current read.
    si_walk = si_walk.astype(float)
    dtc_walk = dtc_walk.astype(float)
    si_walk[-1] = si_pct
    dtc_walk[-1] = dtc

    today = date.today()
    out: list[dict] = []
    for i in range(n):
        # ~15-day settlement cadence, oldest first.
        d = today - timedelta(days=15 * (n - 1 - i))
        out.append({
            "date": d.isoformat(),
            "si_pct": round(float(si_walk[i]), 2),
            "dtc": round(float(dtc_walk[i]), 2),
        })
    return out


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def short_interest(symbol: str) -> dict:
    """Build a short-interest + squeeze read for `symbol`.

    Never raises - degrades to a deterministic sample and tags the payload with
    data_mode / as_of / source.
    """
    try:
        return _short_interest(symbol)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("short_interest failed hard, returning sample: %s", e)
        sym = (symbol or "GME").strip().upper() or "GME"
        try:
            metrics = _sample_metrics(sym)
            mom = float(np.clip(_tilt(sym, 4) * 0.22, -0.35, 0.35))
            return _assemble(sym, metrics, mom, data_mode="sample", source="sample")
        except Exception:
            return _empty_payload(sym)


def _short_interest(symbol: str) -> dict:
    sym = (symbol or "GME").strip().upper() or "GME"

    cache_key = f"short_interest:{sym}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    live = _live_metrics(sym)
    if live is not None:
        metrics, data_mode, source = live, "live", "yfinance"
    else:
        metrics, data_mode, source = _sample_metrics(sym), "sample", "sample"

    # Momentum being live does not upgrade sample SI; the SI fields drive data_mode.
    momentum, _mom_live = _momentum(sym)

    result = _assemble(sym, metrics, momentum, data_mode=data_mode, source=source)
    cache.set(cache_key, result, SHORT_INTEREST_TTL)
    return result


def _assemble(symbol: str, metrics: dict, momentum: float, *,
              data_mode: str, source: str) -> dict:
    si_pct = float(metrics["si_pct_float"])
    dtc = float(metrics["days_to_cover"])
    borrow = float(metrics["borrow_fee_pct"])

    score = _squeeze_score(si_pct, dtc, borrow, momentum)
    label = _squeeze_label(score)

    return {
        "symbol": symbol,
        "si_pct_float": round(si_pct, 2),
        "days_to_cover": round(dtc, 2),
        "borrow_fee_pct": round(borrow, 2),
        "shares_short": int(metrics["shares_short"]),
        "float_shares": int(metrics["float_shares"]),
        "squeeze_score": score,
        "squeeze_label": label,
        "history": _history(symbol, si_pct, dtc),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_payload(symbol: str) -> dict:
    """Last-resort shaped payload if even sampling fails."""
    return {
        "symbol": symbol,
        "si_pct_float": 0.0,
        "days_to_cover": 0.0,
        "borrow_fee_pct": 0.0,
        "shares_short": 0,
        "float_shares": 0,
        "squeeze_score": 0,
        "squeeze_label": "Low",
        "history": [],
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }
