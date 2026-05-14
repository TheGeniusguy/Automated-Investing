"""Options & implied volatility analytics via yfinance.

Two surfaces:

1. **VIX term structure** — ^VIX9D / ^VIX / ^VIX3M / ^VIX6M.
   Their shape tells you the regime: contango (calm now, vol priced higher
   further out) vs backwardation (stress now, expected to ease). The
   front-back spread is one of the cleanest macro signals available for free.

2. **Per-stock option chain summary** — for the nearest expiration ≈ 30
   trading days out, compute ATM IV, average call/put IV, P/C ratio by OI,
   total volume, and the implied move ±1σ over the period.

yfinance's option chain is a real-time snapshot (no history), so we
recompute on every request — 15-min cache TTL keeps it cheap.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

from . import cache

log = logging.getLogger(__name__)

OPTIONS_TTL = 60 * 15  # 15 min — option chains move all day

VIX_TENORS = [
    ("^VIX9D",  "9-day"),
    ("^VIX",   "30-day"),
    ("^VIX3M", "3-month"),
    ("^VIX6M", "6-month"),
]


def _yf():
    import yfinance as yf
    return yf


# ---------- VIX term structure ----------

def vix_term_structure() -> dict:
    """Latest close per VIX tenor + shape classification."""
    cache_key = "vix:term"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    yf = _yf()
    points: list[dict] = []
    spot_30d: float | None = None
    longest_back: float | None = None

    for ticker, label in VIX_TENORS:
        try:
            df = yf.Ticker(ticker).history(period="5d", auto_adjust=False)
            close = float(df["Close"].iloc[-1]) if not df.empty else None
        except Exception as e:
            log.warning("vix fetch failed for %s: %s", ticker, e)
            close = None
        points.append({"ticker": ticker, "label": label, "value": close})
        if ticker == "^VIX":
            spot_30d = close
        if ticker == "^VIX6M":
            longest_back = close

    # Slope: 6M vs 30D. Positive = contango (calm now, vol expected higher);
    # negative = backwardation (stress now, expected to ease).
    slope = None
    structure = "unknown"
    if spot_30d is not None and longest_back is not None:
        slope = longest_back - spot_30d
        if slope >= 1.0:
            structure = "contango"
        elif slope <= -1.0:
            structure = "backwardation"
        else:
            structure = "flat"

    out = {
        "tenors":    points,
        "spot":      spot_30d,
        "back":      longest_back,
        "slope":     slope,
        "structure": structure,
        "fetched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
    cache.set(cache_key, out, OPTIONS_TTL)
    return out


# ---------- Option chain summary ----------

def _pick_expiry(expirations: list[str], target_days: int = 30) -> str | None:
    """Pick the expiry closest to `target_days` from today (and ≥ today)."""
    today = datetime.utcnow().date()
    best: tuple[int, str] | None = None
    for s in expirations:
        try:
            d = datetime.strptime(s, "%Y-%m-%d").date()
        except ValueError:
            continue
        delta = (d - today).days
        if delta < 1:
            continue
        score = abs(delta - target_days)
        if best is None or score < best[0]:
            best = (score, s)
    return best[1] if best else None


def _atm_iv(df, spot: float) -> tuple[float | None, float | None]:
    """Average IV over the 5 strikes nearest the spot, separately for calls/puts."""
    if df is None or df.empty:
        return None, None
    # df has columns: strike, lastPrice, bid, ask, change, percentChange, volume,
    # openInterest, impliedVolatility, inTheMoney, contractSize, currency.
    df = df.dropna(subset=["strike", "impliedVolatility"]).copy()
    if df.empty:
        return None, None
    df["delta"] = (df["strike"] - spot).abs()
    near = df.nsmallest(5, "delta")
    iv = float(near["impliedVolatility"].mean())
    return iv if iv == iv else None, float(near["strike"].mean())


def chain_summary(symbol: str, target_days: int = 30) -> dict:
    """Compute IV / P-C / implied-move summary for a near-dated chain."""
    cache_key = f"chain:{symbol}:{target_days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    yf = _yf()
    symbol = symbol.upper().strip()
    out: dict = {
        "symbol":     symbol,
        "expiry":     None,
        "spot":       None,
        "atm_strike": None,
        "iv_calls":   None,
        "iv_puts":    None,
        "iv_skew":    None,
        "pc_ratio_oi": None,
        "pc_ratio_vol": None,
        "implied_move_1sigma": None,
        "days_to_expiry": None,
        "error":      None,
    }

    try:
        t = yf.Ticker(symbol)
        expirations = list(t.options) if t.options else []
        if not expirations:
            out["error"] = "no listed expirations"
            cache.set(cache_key, out, OPTIONS_TTL)
            return out

        expiry = _pick_expiry(expirations, target_days)
        if expiry is None:
            out["error"] = "no future expirations within tenor"
            cache.set(cache_key, out, OPTIONS_TTL)
            return out

        chain = t.option_chain(expiry)
        # Spot reference: last close
        try:
            spot = float(t.history(period="2d")["Close"].iloc[-1])
        except Exception:
            spot = None
        if spot is None or chain is None:
            out["error"] = "spot/chain unavailable"
            cache.set(cache_key, out, OPTIONS_TTL)
            return out

        days_to_expiry = (datetime.strptime(expiry, "%Y-%m-%d").date() - datetime.utcnow().date()).days
        iv_calls, atm_call_strike = _atm_iv(chain.calls, spot)
        iv_puts,  atm_put_strike  = _atm_iv(chain.puts,  spot)
        atm_strike = atm_call_strike or atm_put_strike

        # P/C ratios over the whole nearest-expiry chain
        def _sum(df, col):
            if df is None or df.empty or col not in df.columns:
                return 0.0
            return float(df[col].fillna(0).sum())

        call_oi  = _sum(chain.calls, "openInterest")
        put_oi   = _sum(chain.puts,  "openInterest")
        call_vol = _sum(chain.calls, "volume")
        put_vol  = _sum(chain.puts,  "volume")
        pc_oi  = (put_oi / call_oi)   if call_oi  else None
        pc_vol = (put_vol / call_vol) if call_vol else None

        # ±1σ implied move over the period: spot * iv * sqrt(t/365)
        iv_avg = None
        if iv_calls is not None and iv_puts is not None:
            iv_avg = (iv_calls + iv_puts) / 2.0
        elif iv_calls is not None:
            iv_avg = iv_calls
        elif iv_puts is not None:
            iv_avg = iv_puts
        implied_move = None
        if iv_avg and spot and days_to_expiry > 0:
            implied_move = spot * iv_avg * math.sqrt(days_to_expiry / 365.0)

        skew = None
        if iv_puts is not None and iv_calls is not None:
            skew = iv_puts - iv_calls   # > 0 = put-skewed (downside priced higher)

        out.update({
            "expiry":     expiry,
            "spot":       round(spot, 2),
            "atm_strike": round(atm_strike, 2) if atm_strike else None,
            "iv_calls":   round(iv_calls, 4) if iv_calls is not None else None,
            "iv_puts":    round(iv_puts, 4)  if iv_puts  is not None else None,
            "iv_skew":    round(skew, 4)     if skew     is not None else None,
            "pc_ratio_oi": round(pc_oi, 2)   if pc_oi    is not None else None,
            "pc_ratio_vol": round(pc_vol, 2) if pc_vol   is not None else None,
            "implied_move_1sigma": round(implied_move, 2) if implied_move else None,
            "days_to_expiry": days_to_expiry,
        })
        cache.set(cache_key, out, OPTIONS_TTL)
        return out
    except Exception as e:
        log.warning("chain_summary failed for %s: %s", symbol, e)
        out["error"] = str(e)
        cache.set(cache_key, out, OPTIONS_TTL)
        return out


def chain_summaries(symbols: list[str], target_days: int = 30) -> dict:
    out = [chain_summary(s, target_days=target_days) for s in symbols if s.strip()]
    return {
        "summaries": out,
        "fetched_at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
    }
