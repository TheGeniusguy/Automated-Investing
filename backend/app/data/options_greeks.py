"""Options greeks, vol surface, dealer gamma exposure (GEX) and max-pain.

Closed-form Black-Scholes greeks plus four terminal-style surfaces:

1. greeks_ladder(symbol) - per-strike call/put greeks for the nearest tenor.
2. build_surface(symbol)  - IV grid across 5 expiries x a 0.8S..1.2S strike
   ladder, plus an ATM term-structure row and a 25-delta skew row.
3. gamma_exposure(symbol) - per-strike dealer GEX, total GEX, and the
   zero-gamma flip level (cumulative-GEX zero crossing).
4. max_pain(symbol)       - the strike that minimizes total ITM payout to
   option holders, plus the full payout curve.

Live path: pull the real option chain via yfinance (reusing options.py's
expiry picker) when it is available. Otherwise synthesize a deterministic
smile seeded off the symbol so screenshots are stable and fully populated.

Math (r from the 3M T-bill DGS3MO, fallback 0.045; q = 0):
    d1 = (ln(S/K) + (r - q + sigma^2/2) T) / (sigma sqrt(T))
    d2 = d1 - sigma sqrt(T)
    price_call = S e^{-qT} N(d1) - K e^{-rT} N(d2)
    price_put  = K e^{-rT} N(-d2) - S e^{-qT} N(-d1)
    delta, gamma, vega (per 1 vol pt), theta (per day), rho (per 1 pct rate)

Never raises. Every payload carries data_mode / as_of / source.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

from . import cache
from . import options as _options
from .macro_data import fetch_arbitrary_ticker, fetch_series

log = logging.getLogger(__name__)

GREEKS_TTL = 60 * 15  # 15 min - mirrors the live option-chain cache window

# Sample smile expiries (days). Live mode picks the 5 listed expiries nearest
# these targets.
SAMPLE_EXPIRY_DAYS = [7, 30, 60, 90, 180]

# Moneyness ladder for the surface / ladder grids: 0.8S .. 1.2S.
_LADDER_MONEYNESS = [round(0.80 + 0.02 * i, 2) for i in range(21)]  # 0.80..1.20

_DEFAULT_R = 0.045
_DEFAULT_Q = 0.0

_SQRT_2PI = math.sqrt(2.0 * math.pi)


# --------------------------------------------------------------------------- #
# Normal distribution helpers (no scipy dependency)
# --------------------------------------------------------------------------- #

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / _SQRT_2PI


# --------------------------------------------------------------------------- #
# Black-Scholes greeks (closed form)
# --------------------------------------------------------------------------- #

def bs_greeks(
    S: float,
    K: float,
    T: float,
    sigma: float,
    r: float = _DEFAULT_R,
    q: float = _DEFAULT_Q,
    kind: str = "call",
) -> dict:
    """Closed-form Black-Scholes price + greeks.

    Returns {price, delta, gamma, vega, theta, rho} where:
      - vega  is per 1 volatility point (divided by 100)
      - theta is per calendar day (divided by 365)
      - rho   is per 1 percentage point of rate (divided by 100)

    Degenerate inputs (T <= 0, sigma <= 0, non-positive S/K) degrade to the
    intrinsic value with zero greeks rather than raising.
    """
    is_call = str(kind).lower().startswith("c")
    try:
        S = float(S)
        K = float(K)
        T = float(T)
        sigma = float(sigma)
        r = float(r)
        q = float(q)
    except (TypeError, ValueError):
        return {"price": 0.0, "delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0, "rho": 0.0}

    # Degenerate: collapse to discounted intrinsic, flat greeks.
    if not (S > 0 and K > 0) or T <= 0 or sigma <= 0:
        if is_call:
            intrinsic = max(0.0, S - K)
            delta = 1.0 if S > K else 0.0
        else:
            intrinsic = max(0.0, K - S)
            delta = -1.0 if S < K else 0.0
        return {
            "price": round(intrinsic, 6),
            "delta": round(delta, 6),
            "gamma": 0.0,
            "vega": 0.0,
            "theta": 0.0,
            "rho": 0.0,
        }

    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t

    disc_q = math.exp(-q * T)
    disc_r = math.exp(-r * T)
    nd1 = _norm_cdf(d1)
    nd2 = _norm_cdf(d2)
    n_d1 = _norm_pdf(d1)

    # gamma and vega are kind-independent.
    gamma = disc_q * n_d1 / (S * sigma * sqrt_t)
    vega = S * disc_q * n_d1 * sqrt_t / 100.0  # per 1 vol pt

    if is_call:
        price = S * disc_q * nd1 - K * disc_r * nd2
        delta = disc_q * nd1
        theta = (
            -S * disc_q * n_d1 * sigma / (2.0 * sqrt_t)
            - r * K * disc_r * nd2
            + q * S * disc_q * nd1
        ) / 365.0
        rho = K * T * disc_r * nd2 / 100.0
    else:
        price = K * disc_r * _norm_cdf(-d2) - S * disc_q * _norm_cdf(-d1)
        delta = disc_q * (nd1 - 1.0)
        theta = (
            -S * disc_q * n_d1 * sigma / (2.0 * sqrt_t)
            + r * K * disc_r * _norm_cdf(-d2)
            - q * S * disc_q * _norm_cdf(-d1)
        ) / 365.0
        rho = -K * T * disc_r * _norm_cdf(-d2) / 100.0

    return {
        "price": round(price, 6),
        "delta": round(delta, 6),
        "gamma": round(gamma, 8),
        "vega": round(vega, 6),
        "theta": round(theta, 6),
        "rho": round(rho, 6),
    }


def _raw_vega(S: float, K: float, T: float, sigma: float, r: float, q: float) -> float:
    """Vega per 1.0 of sigma (not /100) for the IV solver."""
    if sigma <= 0 or T <= 0 or S <= 0 or K <= 0:
        return 0.0
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    return S * math.exp(-q * T) * _norm_pdf(d1) * sqrt_t


def implied_vol_newton(
    price: float,
    S: float,
    K: float,
    T: float,
    r: float = _DEFAULT_R,
    kind: str = "call",
    q: float = _DEFAULT_Q,
) -> float | None:
    """Invert Black-Scholes for implied vol.

    Newton on vega (50 iters, sigma clamped to [1e-4, 5.0]); on failure or a
    vanishing vega, fall back to bisection. Returns None when the target price
    is below intrinsic or the solve cannot converge.
    """
    try:
        price = float(price)
        S = float(S)
        K = float(K)
        T = float(T)
        r = float(r)
        q = float(q)
    except (TypeError, ValueError):
        return None

    if price <= 0 or S <= 0 or K <= 0 or T <= 0:
        return None

    is_call = str(kind).lower().startswith("c")
    # Below intrinsic -> no real IV.
    intrinsic = max(0.0, (S - K) if is_call else (K - S)) * math.exp(-r * T)
    if price < intrinsic - 1e-8:
        return None

    lo, hi = 1e-4, 5.0

    def _price(sig: float) -> float:
        return bs_greeks(S, K, T, sig, r=r, q=q, kind=kind)["price"]

    # Newton.
    sigma = 0.25
    for _ in range(50):
        diff = _price(sigma) - price
        if abs(diff) < 1e-6:
            return round(min(max(sigma, lo), hi), 6)
        v = _raw_vega(S, K, T, sigma, r, q)
        if v < 1e-8:
            break
        sigma -= diff / v
        if not math.isfinite(sigma) or sigma <= lo or sigma >= hi:
            break

    # Bisection fallback.
    f_lo = _price(lo) - price
    f_hi = _price(hi) - price
    if f_lo * f_hi > 0:
        return None
    a, b = lo, hi
    for _ in range(100):
        mid = 0.5 * (a + b)
        f_mid = _price(mid) - price
        if abs(f_mid) < 1e-6:
            return round(mid, 6)
        if f_lo * f_mid < 0:
            b = mid
            f_hi = f_mid
        else:
            a = mid
            f_lo = f_mid
    return round(0.5 * (a + b), 6)


# --------------------------------------------------------------------------- #
# Shared inputs: spot, risk-free rate
# --------------------------------------------------------------------------- #

def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.upper().encode()).hexdigest(), 16)


def _risk_free_rate() -> float:
    """3M T-bill (DGS3MO, percent) as a decimal. Fallback 0.045."""
    try:
        pts = fetch_series("DGS3MO", days=10)
        for p in reversed(pts or []):
            v = p.get("value")
            if v is not None and v == v:
                return float(v) / 100.0
    except Exception as e:
        log.debug("risk-free fetch failed: %s", e)
    return _DEFAULT_R


def _live_spot(symbol: str) -> float | None:
    try:
        pts = fetch_arbitrary_ticker(symbol, 5)
        for p in reversed(pts or []):
            v = p.get("value")
            if v is not None and v == v and v > 0:
                return float(v)
    except Exception as e:
        log.debug("spot fetch failed for %s: %s", symbol, e)
    return None


def _sample_spot(symbol: str) -> float:
    """Deterministic synthetic spot (50..550) when no live price exists."""
    return round(50.0 + (_seed(symbol) % 50000) / 100.0, 2)


def _vix_base_iv() -> float:
    """Base ATM IV scaled off ^VIX (fallback ~0.18)."""
    try:
        pts = fetch_arbitrary_ticker("^VIX", 5)
        for p in reversed(pts or []):
            v = p.get("value")
            if v is not None and v == v and v > 0:
                return max(0.06, min(1.5, float(v) / 100.0))
    except Exception as e:
        log.debug("vix fetch failed: %s", e)
    return 0.18


def _round_strike(x: float) -> float:
    """Snap to a sensible strike increment for the given price level."""
    if x >= 200:
        step = 5.0
    elif x >= 50:
        step = 1.0
    elif x >= 10:
        step = 0.5
    else:
        step = 0.5
    return round(round(x / step) * step, 2)


# --------------------------------------------------------------------------- #
# Sample smile generator
# --------------------------------------------------------------------------- #

def _smile_iv(moneyness: float, T: float, base: float) -> float:
    """IV(K,T) = base(T) + skew*(m-1)^2 - slope*(m-1).

    Convex in moneyness (smile) with a downside (put) skew. Slight term
    structure: longer expiries carry marginally higher base vol (contango).
    """
    m = moneyness
    base_t = base * (0.92 + 0.18 * math.sqrt(max(T, 1e-4) / 0.5))
    skew = 0.18          # convexity / wing richness
    slope = 0.12         # put skew: lower strikes -> higher IV
    iv = base_t + skew * (m - 1.0) ** 2 - slope * (m - 1.0)
    return float(max(0.02, min(3.0, iv)))


def _sample_chain(symbol: str, spot: float) -> list[dict]:
    """Build a deterministic per-expiry chain seeded off the symbol.

    Each expiry: {label, days, T, calls[], puts[]} where each contract row is
    {strike, iv, oi, price}. OI is peaked near ATM.
    """
    import random as _random

    rng = _random.Random(_seed(symbol))
    base = _vix_base_iv()
    today = datetime.now(tz=timezone.utc).date()
    r = _risk_free_rate()

    strikes = sorted({_round_strike(spot * m) for m in _LADDER_MONEYNESS})
    expiries: list[dict] = []

    for days in SAMPLE_EXPIRY_DAYS:
        T = days / 365.0
        # nearer expiries carry more open interest
        peak_oi = 3000 + int(20000 * math.exp(-days / 90.0)) + rng.randint(0, 2500)
        label = _date_offset(today, days)
        calls, puts = [], []
        for K in strikes:
            m = K / spot
            iv = _smile_iv(m, T, base)
            # OI bell-curve around ATM, with seeded jitter; round strikes fatter
            oi_base = peak_oi * math.exp(-((m - 1.0) / 0.06) ** 2)
            jitter = 0.7 + 0.6 * rng.random()
            oi = int(max(0, oi_base * jitter))
            call_iv = max(0.02, iv - 0.01)   # call wing slightly softer
            put_iv = iv + 0.01               # put wing slightly richer
            calls.append({
                "strike": K,
                "iv": round(call_iv, 4),
                "oi": oi,
                "price": bs_greeks(spot, K, T, call_iv, r=r, kind="call")["price"],
            })
            puts.append({
                "strike": K,
                "iv": round(put_iv, 4),
                "oi": oi,
                "price": bs_greeks(spot, K, T, put_iv, r=r, kind="put")["price"],
            })
        expiries.append({
            "label": label,
            "days": days,
            "T": round(T, 6),
            "calls": calls,
            "puts": puts,
        })
    return expiries


def _date_offset(base_date, days: int) -> str:
    from datetime import timedelta
    return (base_date + timedelta(days=days)).strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- #
# Live chain (best-effort) -> normalized structure
# --------------------------------------------------------------------------- #

def _live_chain(symbol: str, spot: float) -> list[dict] | None:
    """Pull up to 5 real expiries near the sample targets via yfinance.

    Returns the same normalized shape as _sample_chain, or None if the live
    chain is unavailable.
    """
    try:
        yf = _options._yf()
        t = yf.Ticker(symbol)
        expirations = list(t.options) if t.options else []
        if not expirations:
            return None

        chosen: list[str] = []
        for target in SAMPLE_EXPIRY_DAYS:
            pick = _options._pick_expiry(expirations, target_days=target)
            if pick and pick not in chosen:
                chosen.append(pick)
        if not chosen:
            return None

        today = datetime.utcnow().date()
        lo, hi = spot * 0.80, spot * 1.20
        expiries: list[dict] = []
        for exp in chosen:
            try:
                ch = t.option_chain(exp)
            except Exception as e:
                log.debug("option_chain failed %s %s: %s", symbol, exp, e)
                continue
            days = (datetime.strptime(exp, "%Y-%m-%d").date() - today).days
            if days < 1:
                continue
            T = days / 365.0

            def _rows(df) -> list[dict]:
                out: list[dict] = []
                if df is None or df.empty:
                    return out
                for _, row in df.iterrows():
                    try:
                        K = float(row.get("strike"))
                    except (TypeError, ValueError):
                        continue
                    if K != K or K < lo or K > hi:
                        continue
                    iv = row.get("impliedVolatility")
                    iv = float(iv) if iv is not None and iv == iv and iv > 0 else None
                    oi = row.get("openInterest")
                    oi = int(oi) if oi is not None and oi == oi else 0
                    price = row.get("lastPrice")
                    price = float(price) if price is not None and price == price else None
                    out.append({"strike": round(K, 2), "iv": iv, "oi": oi, "price": price})
                return out

            calls = _rows(ch.calls)
            puts = _rows(ch.puts)
            if not calls and not puts:
                continue
            expiries.append({
                "label": exp,
                "days": days,
                "T": round(T, 6),
                "calls": calls,
                "puts": puts,
            })
        return expiries or None
    except Exception as e:
        log.debug("live chain failed for %s: %s", symbol, e)
        return None


def _get_chain(symbol: str) -> dict:
    """Resolve a normalized chain payload for `symbol`.

    Returns {symbol, spot, r, data_mode, source, as_of, expiries[]}. Caches the
    result so all four entrypoints share one fetch per symbol. Never raises.
    """
    symbol = (symbol or "SPY").upper().strip()
    cache_key = f"greeks:chain:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    r = _risk_free_rate()
    spot = _live_spot(symbol)
    data_mode = "live"
    source = "yfinance"
    expiries = None

    if spot is not None:
        expiries = _live_chain(symbol, spot)

    if not expiries:
        data_mode = "sample"
        source = "smile-sample"
        if spot is None:
            spot = _sample_spot(symbol)
        expiries = _sample_chain(symbol, spot)

    out = {
        "symbol": symbol,
        "spot": round(float(spot), 2),
        "r": round(r, 6),
        "data_mode": data_mode,
        "source": source,
        "as_of": _now_iso(),
        "expiries": expiries,
    }
    cache.set(cache_key, out, GREEKS_TTL)
    return out


def _ladder_strikes(spot: float) -> list[float]:
    return sorted({_round_strike(spot * m) for m in _LADDER_MONEYNESS})


def _interp_iv(rows: list[dict], K: float) -> float | None:
    """Linear-interpolate IV at strike K from a list of {strike, iv} rows."""
    pts = sorted(
        ((r["strike"], r["iv"]) for r in rows if r.get("iv") is not None),
        key=lambda x: x[0],
    )
    if not pts:
        return None
    if K <= pts[0][0]:
        return pts[0][1]
    if K >= pts[-1][0]:
        return pts[-1][1]
    for i in range(1, len(pts)):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        if x0 <= K <= x1:
            if x1 == x0:
                return y0
            w = (K - x0) / (x1 - x0)
            return y0 + w * (y1 - y0)
    return pts[-1][1]


def _strike_nearest_delta(rows: list[dict], spot: float, T: float, r: float,
                          target_delta: float, kind: str) -> float | None:
    """IV at the strike whose |delta| is closest to target_delta (e.g. 0.25)."""
    best = None
    best_err = None
    for row in rows:
        iv = row.get("iv")
        K = row.get("strike")
        if iv is None or K is None:
            continue
        d = bs_greeks(spot, K, T, iv, r=r, kind=kind)["delta"]
        err = abs(abs(d) - target_delta)
        if best_err is None or err < best_err:
            best_err = err
            best = iv
    return best


# --------------------------------------------------------------------------- #
# Entrypoint 1: greeks ladder (nearest tenor)
# --------------------------------------------------------------------------- #

def greeks_ladder(symbol: str) -> dict:
    """Per-strike call/put greeks for the nearest-dated expiry.

    Returns:
      {symbol, spot, r, expiry, days_to_expiry, T,
       rows: [{strike, moneyness,
               call: {iv, price, delta, gamma, vega, theta, rho, oi},
               put:  {iv, price, delta, gamma, vega, theta, rho, oi}}],
       data_mode, as_of, source}
    """
    try:
        chain = _get_chain(symbol)
        spot = chain["spot"]
        r = chain["r"]
        expiries = chain["expiries"]
        if not expiries:
            raise ValueError("no expiries")
        near = min(expiries, key=lambda e: e["days"])
        T = near["T"]

        call_by_k = {c["strike"]: c for c in near["calls"]}
        put_by_k = {p["strike"]: p for p in near["puts"]}
        strikes = sorted(set(call_by_k) | set(put_by_k))

        rows: list[dict] = []
        for K in strikes:
            c = call_by_k.get(K)
            p = put_by_k.get(K)
            c_iv = (c or {}).get("iv")
            p_iv = (p or {}).get("iv")
            if c_iv is None and p_iv is not None:
                c_iv = p_iv
            if p_iv is None and c_iv is not None:
                p_iv = c_iv
            if c_iv is None and p_iv is None:
                continue
            cg = bs_greeks(spot, K, T, c_iv, r=r, kind="call")
            pg = bs_greeks(spot, K, T, p_iv, r=r, kind="put")
            rows.append({
                "strike": K,
                "moneyness": round(K / spot, 4) if spot else None,
                "call": {
                    "iv": round(c_iv, 4),
                    "price": round((c or {}).get("price") or cg["price"], 4),
                    "delta": cg["delta"], "gamma": cg["gamma"], "vega": cg["vega"],
                    "theta": cg["theta"], "rho": cg["rho"],
                    "oi": int((c or {}).get("oi") or 0),
                },
                "put": {
                    "iv": round(p_iv, 4),
                    "price": round((p or {}).get("price") or pg["price"], 4),
                    "delta": pg["delta"], "gamma": pg["gamma"], "vega": pg["vega"],
                    "theta": pg["theta"], "rho": pg["rho"],
                    "oi": int((p or {}).get("oi") or 0),
                },
            })
        return {
            "symbol": chain["symbol"],
            "spot": spot,
            "r": r,
            "expiry": near["label"],
            "days_to_expiry": near["days"],
            "T": T,
            "rows": rows,
            "data_mode": chain["data_mode"],
            "as_of": chain["as_of"],
            "source": chain["source"],
        }
    except Exception as e:
        log.warning("greeks_ladder failed for %s: %s", symbol, e)
        return {
            "symbol": (symbol or "").upper().strip(), "spot": None, "r": _DEFAULT_R,
            "expiry": None, "days_to_expiry": None, "T": None, "rows": [],
            "data_mode": "sample", "as_of": _now_iso(), "source": "error-fallback",
        }


# --------------------------------------------------------------------------- #
# Entrypoint 2: vol surface
# --------------------------------------------------------------------------- #

def build_surface(symbol: str) -> dict:
    """IV surface across 5 expiries x a 0.8S..1.2S strike ladder.

    Returns:
      {symbol, spot, r,
       strikes: [float],          # canonical ladder (rows of the grid)
       expiries: [{label, days, T}],
       moneyness: [float],
       iv_grid: [[iv ...]],       # rows = strikes, cols = expiries (pct, e.g. 18.4)
       term_structure: [{label, days, atm_iv}],
       skew: [{label, days, put_25d_iv, call_25d_iv, skew_25d}],
       data_mode, as_of, source}
    """
    try:
        chain = _get_chain(symbol)
        spot = chain["spot"]
        r = chain["r"]
        expiries = chain["expiries"]
        if not expiries:
            raise ValueError("no expiries")
        expiries = sorted(expiries, key=lambda e: e["days"])
        strikes = _ladder_strikes(spot)
        base = _vix_base_iv()

        iv_grid: list[list[float | None]] = []
        for K in strikes:
            row: list[float | None] = []
            m = K / spot if spot else 1.0
            for exp in expiries:
                # blend call/put rows for a mid IV at this strike
                combined = (exp["calls"] or []) + (exp["puts"] or [])
                iv = _interp_iv(combined, K)
                if iv is None:
                    iv = _smile_iv(m, exp["T"], base)
                row.append(round(iv * 100.0, 2))  # percent for the heatmap
            iv_grid.append(row)

        term_structure: list[dict] = []
        skew: list[dict] = []
        for exp in expiries:
            T = exp["T"]
            combined = (exp["calls"] or []) + (exp["puts"] or [])
            atm_iv = _interp_iv(combined, spot)
            if atm_iv is None:
                atm_iv = _smile_iv(1.0, T, base)
            term_structure.append({
                "label": exp["label"], "days": exp["days"],
                "atm_iv": round(atm_iv * 100.0, 2),
            })
            put_25 = _strike_nearest_delta(exp["puts"] or [], spot, T, r, 0.25, "put")
            call_25 = _strike_nearest_delta(exp["calls"] or [], spot, T, r, 0.25, "call")
            if put_25 is None:
                put_25 = _smile_iv(0.90, T, base)
            if call_25 is None:
                call_25 = _smile_iv(1.10, T, base)
            skew.append({
                "label": exp["label"], "days": exp["days"],
                "put_25d_iv": round(put_25 * 100.0, 2),
                "call_25d_iv": round(call_25 * 100.0, 2),
                "skew_25d": round((put_25 - call_25) * 100.0, 2),
            })

        return {
            "symbol": chain["symbol"],
            "spot": spot,
            "r": r,
            "strikes": strikes,
            "expiries": [{"label": e["label"], "days": e["days"], "T": e["T"]} for e in expiries],
            "moneyness": [round(K / spot, 4) if spot else None for K in strikes],
            "iv_grid": iv_grid,
            "term_structure": term_structure,
            "skew": skew,
            "data_mode": chain["data_mode"],
            "as_of": chain["as_of"],
            "source": chain["source"],
        }
    except Exception as e:
        log.warning("build_surface failed for %s: %s", symbol, e)
        return {
            "symbol": (symbol or "").upper().strip(), "spot": None, "r": _DEFAULT_R,
            "strikes": [], "expiries": [], "moneyness": [], "iv_grid": [],
            "term_structure": [], "skew": [],
            "data_mode": "sample", "as_of": _now_iso(), "source": "error-fallback",
        }


# --------------------------------------------------------------------------- #
# Entrypoint 3: gamma exposure (GEX)
# --------------------------------------------------------------------------- #

def gamma_exposure(symbol: str) -> dict:
    """Per-strike dealer gamma exposure, total GEX, and zero-gamma flip level.

    GEX_strike = sum over contracts of gamma * OI * 100 * S^2 * 0.01,
    signed + for calls and - for puts (dealer-short-puts convention).
    The flip level is where cumulative GEX (by ascending strike) crosses zero.

    Returns:
      {symbol, spot, r,
       levels: [{strike, call_gex, put_gex, net_gex, cumulative_gex}],
       total_gex, call_gex, put_gex, zero_gamma, gex_unit,
       data_mode, as_of, source}
    """
    try:
        chain = _get_chain(symbol)
        spot = chain["spot"]
        r = chain["r"]
        expiries = chain["expiries"]
        if not expiries or not spot:
            raise ValueError("no expiries/spot")

        s2 = spot * spot
        # aggregate by strike across all expiries
        by_strike: dict[float, dict] = {}
        for exp in expiries:
            T = exp["T"]
            for c in exp["calls"] or []:
                K, iv, oi = c.get("strike"), c.get("iv"), c.get("oi") or 0
                if K is None or iv is None or oi <= 0:
                    continue
                g = bs_greeks(spot, K, T, iv, r=r, kind="call")["gamma"]
                gex = g * oi * 100.0 * s2 * 0.01
                by_strike.setdefault(K, {"call": 0.0, "put": 0.0})["call"] += gex
            for p in exp["puts"] or []:
                K, iv, oi = p.get("strike"), p.get("iv"), p.get("oi") or 0
                if K is None or iv is None or oi <= 0:
                    continue
                g = bs_greeks(spot, K, T, iv, r=r, kind="put")["gamma"]
                gex = g * oi * 100.0 * s2 * 0.01
                by_strike.setdefault(K, {"call": 0.0, "put": 0.0})["put"] += gex

        strikes = sorted(by_strike)
        levels: list[dict] = []
        cumulative = 0.0
        total_call = 0.0
        total_put = 0.0
        prev = None  # (strike, cumulative) for zero-cross interpolation
        zero_gamma = None
        for K in strikes:
            call_gex = by_strike[K]["call"]
            put_gex = -by_strike[K]["put"]  # dealers short puts -> negative gamma
            net = call_gex + put_gex
            cumulative += net
            total_call += call_gex
            total_put += put_gex
            if prev is not None:
                pk, pc = prev
                if (pc < 0 <= cumulative) or (pc > 0 >= cumulative):
                    if cumulative != pc:
                        w = (0.0 - pc) / (cumulative - pc)
                        zero_gamma = round(pk + w * (K - pk), 2)
            prev = (K, cumulative)
            levels.append({
                "strike": K,
                "call_gex": round(call_gex, 2),
                "put_gex": round(put_gex, 2),
                "net_gex": round(net, 2),
                "cumulative_gex": round(cumulative, 2),
            })

        total = total_call + total_put
        return {
            "symbol": chain["symbol"],
            "spot": spot,
            "r": r,
            "levels": levels,
            "total_gex": round(total, 2),
            "call_gex": round(total_call, 2),
            "put_gex": round(total_put, 2),
            "zero_gamma": zero_gamma,
            "gex_unit": "dollar gamma per 1 pct move",
            "data_mode": chain["data_mode"],
            "as_of": chain["as_of"],
            "source": chain["source"],
        }
    except Exception as e:
        log.warning("gamma_exposure failed for %s: %s", symbol, e)
        return {
            "symbol": (symbol or "").upper().strip(), "spot": None, "r": _DEFAULT_R,
            "levels": [], "total_gex": 0.0, "call_gex": 0.0, "put_gex": 0.0,
            "zero_gamma": None, "gex_unit": "dollar gamma per 1 pct move",
            "data_mode": "sample", "as_of": _now_iso(), "source": "error-fallback",
        }


# --------------------------------------------------------------------------- #
# Entrypoint 4: max pain
# --------------------------------------------------------------------------- #

def max_pain(symbol: str) -> dict:
    """Max-pain strike (min total ITM payout to holders) + payout curve.

    For each candidate settlement strike K:
      payout(K) = sum_calls OI*max(0, K-strike) + sum_puts OI*max(0, strike-K)
    The K minimizing payout is max pain. OI is aggregated across all expiries.

    Returns:
      {symbol, spot, r, max_pain, max_pain_distance_pct,
       payout_curve: [{strike, payout, call_payout, put_payout}],
       total_call_oi, total_put_oi, pc_ratio_oi,
       data_mode, as_of, source}
    """
    try:
        chain = _get_chain(symbol)
        spot = chain["spot"]
        expiries = chain["expiries"]
        if not expiries or not spot:
            raise ValueError("no expiries/spot")

        # aggregate OI by strike across all expiries
        call_oi: dict[float, float] = {}
        put_oi: dict[float, float] = {}
        for exp in expiries:
            for c in exp["calls"] or []:
                K, oi = c.get("strike"), c.get("oi") or 0
                if K is None or oi <= 0:
                    continue
                call_oi[K] = call_oi.get(K, 0.0) + oi
            for p in exp["puts"] or []:
                K, oi = p.get("strike"), p.get("oi") or 0
                if K is None or oi <= 0:
                    continue
                put_oi[K] = put_oi.get(K, 0.0) + oi

        candidate_strikes = sorted(set(call_oi) | set(put_oi))
        if not candidate_strikes:
            raise ValueError("no open interest")

        payout_curve: list[dict] = []
        best_K = None
        best_payout = None
        for K in candidate_strikes:
            call_pay = sum(oi * max(0.0, K - sk) for sk, oi in call_oi.items())
            put_pay = sum(oi * max(0.0, sk - K) for sk, oi in put_oi.items())
            total = call_pay + put_pay
            payout_curve.append({
                "strike": K,
                "payout": round(total, 2),
                "call_payout": round(call_pay, 2),
                "put_payout": round(put_pay, 2),
            })
            if best_payout is None or total < best_payout:
                best_payout = total
                best_K = K

        tco = sum(call_oi.values())
        tpo = sum(put_oi.values())
        return {
            "symbol": chain["symbol"],
            "spot": spot,
            "r": chain["r"],
            "max_pain": best_K,
            "max_pain_distance_pct": round((best_K - spot) / spot * 100.0, 2) if best_K and spot else None,
            "payout_curve": payout_curve,
            "total_call_oi": int(tco),
            "total_put_oi": int(tpo),
            "pc_ratio_oi": round(tpo / tco, 3) if tco else None,
            "data_mode": chain["data_mode"],
            "as_of": chain["as_of"],
            "source": chain["source"],
        }
    except Exception as e:
        log.warning("max_pain failed for %s: %s", symbol, e)
        return {
            "symbol": (symbol or "").upper().strip(), "spot": None, "r": _DEFAULT_R,
            "max_pain": None, "max_pain_distance_pct": None, "payout_curve": [],
            "total_call_oi": 0, "total_put_oi": 0, "pc_ratio_oi": None,
            "data_mode": "sample", "as_of": _now_iso(), "source": "error-fallback",
        }
