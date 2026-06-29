"""Unusual Options Activity Scanner (Bloomberg `OMON`).

Scans a bounded universe of liquid optionable names over the live yfinance
option chain and surfaces the day's most *unusual* contracts. Three signals
drive the unusualness score per contract:

1. **vol/OI ratio** = volume / max(openInterest, 1). A ratio well above 1.0
   (especially > 2-3) means today's traded volume dwarfs the resting open
   interest - i.e. fresh, aggressive positioning rather than existing books.
2. **dollar premium** = volume * lastPrice * 100. Large prints flag size; a
   multi-million-dollar sweep is meaningful regardless of the OI ratio.
3. **call/put premium skew** per underlying = total call premium vs total put
   premium, which tilts the name bullish or bearish.

Live path: for each ticker (within a short wall-clock budget) we pull the
nearest 1-2 expiries' chains via the SAME yfinance access pattern options.py
uses (`yf.Ticker(sym).option_chain(expiry)` -> `.calls` / `.puts` DataFrames
with columns volume, openInterest, lastPrice, strike, impliedVolatility,
contractSymbol). Contracts crossing an unusualness threshold are scored and the
top ~25 kept. When too little resolves live we degrade to a deterministic,
md5-seeded SAMPLE tape (believable NVDA call sweeps, TSLA put buying, SPY
hedging flow, a meme-name call spike) and tag the payload data_mode="sample".
This module NEVER raises - it always returns a populated payload with
data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

# Bounded universe: the most liquid optionable names + a few high-beta / meme
# tickers where unusual flow actually shows up.
UNIVERSE: list[dict] = [
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF"},
    {"symbol": "QQQ", "name": "Invesco QQQ Trust"},
    {"symbol": "NVDA", "name": "NVIDIA Corp."},
    {"symbol": "TSLA", "name": "Tesla Inc."},
    {"symbol": "AAPL", "name": "Apple Inc."},
    {"symbol": "AMD", "name": "Advanced Micro Devices"},
    {"symbol": "META", "name": "Meta Platforms Inc."},
    {"symbol": "AMZN", "name": "Amazon.com Inc."},
    {"symbol": "MSFT", "name": "Microsoft Corp."},
    {"symbol": "GOOGL", "name": "Alphabet Inc."},
    {"symbol": "COIN", "name": "Coinbase Global Inc."},
    {"symbol": "PLTR", "name": "Palantir Technologies"},
    {"symbol": "MU", "name": "Micron Technology"},
    {"symbol": "SMCI", "name": "Super Micro Computer"},
    {"symbol": "NFLX", "name": "Netflix Inc."},
    {"symbol": "GME", "name": "GameStop Corp."},
    {"symbol": "MARA", "name": "MARA Holdings Inc."},
    {"symbol": "BABA", "name": "Alibaba Group"},
]

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 7.0
# Cap how many tickers we ever fetch live (keeps it FAST + never stalls).
LIVE_MAX_TICKERS = 18
# How many near-dated expiries to scan per ticker.
EXPIRIES_PER_TICKER = 2
# Strikes outside +/- this fraction of spot are ignored (deep wings are noisy).
MONEYNESS_BAND = 0.25
# How many top contracts to keep in the tape.
TOP_N = 25

# Unusualness thresholds (a contract qualifies if it crosses EITHER).
MIN_VOL_OI_RATIO = 1.0        # volume exceeds resting open interest
MIN_PREMIUM_USD = 250_000.0   # quarter-million-dollar print
# Below this raw volume a contract is too thin to be meaningful even if the
# vol/OI ratio looks large.
MIN_VOLUME = 50

# Flag bands on the unusual score.
EXTREME_SCORE = 80.0
HOT_SCORE = 55.0


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(symbol: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by symbol + salt."""
    return (_hash(symbol, salt) % 1_000_000) / 1_000_000.0


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Scoring + classification
# ---------------------------------------------------------------------------

def _unusual_score(vol_oi: float, premium: float, volume: float) -> float:
    """Blend the vol/OI spike and the dollar-premium size into 0..100.

    vol/OI contributes up to ~60 pts (log-scaled, saturating around 5x),
    premium contributes up to ~40 pts (log-scaled, saturating near $25M).
    A small volume nudge rewards genuinely large prints over thin ones.
    """
    import math

    r = max(0.0, float(vol_oi))
    p = max(0.0, float(premium))
    v = max(0.0, float(volume))
    # vol/OI: 1x -> ~17, 3x -> ~42, 5x -> ~52, 10x -> ~60 (capped)
    ratio_pts = min(60.0, 25.0 * math.log1p(r))
    # premium: $250k -> ~12, $1M -> ~21, $5M -> ~31, $25M -> ~40 (capped)
    prem_pts = min(40.0, 6.0 * math.log10(max(p, 1.0)) - 24.0) if p > 1.0 else 0.0
    prem_pts = max(0.0, prem_pts)
    vol_pts = min(6.0, math.log10(max(v, 1.0)))
    return round(min(100.0, ratio_pts + prem_pts + vol_pts), 1)


def _flag(score: float) -> str:
    if score >= EXTREME_SCORE:
        return "Extreme"
    if score >= HOT_SCORE:
        return "Hot"
    return "Notable"


def _tilt(call_prem: float, put_prem: float) -> str:
    total = call_prem + put_prem
    if total <= 0:
        return "Neutral"
    call_share = call_prem / total
    if call_share >= 0.62:
        return "Bullish"
    if call_share <= 0.38:
        return "Bearish"
    return "Neutral"


def _moneyness_label(opt_type: str, strike: float, spot: float) -> str:
    """ITM / ATM / OTM relative to spot, by option type."""
    if not spot:
        return "--"
    rel = (strike - spot) / spot
    if abs(rel) <= 0.01:
        return "ATM"
    if opt_type == "call":
        return "ITM" if strike < spot else "OTM"
    return "ITM" if strike > spot else "OTM"


# ---------------------------------------------------------------------------
# Live scan
# ---------------------------------------------------------------------------

def _safe_float(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # reject NaN


def _live_spot(symbol: str) -> float | None:
    """Last close as the spot reference (mirrors options.py's approach)."""
    try:
        from . import options as _options
        yf = _options._yf()
        df = yf.Ticker(symbol).history(period="2d")
        if df is not None and not df.empty:
            return _safe_float(df["Close"].iloc[-1])
    except Exception as e:
        log.debug("unusual_options spot fetch failed for %s: %s", symbol, e)
    return None


def _scan_ticker(symbol: str, name: str) -> tuple[list[dict], dict | None]:
    """Scan the nearest expiries for one ticker.

    Returns (qualifying_contracts, skew_row). Returns ([], None) when nothing
    resolves. Never raises.
    """
    try:
        from . import options as _options
        yf = _options._yf()
        t = yf.Ticker(symbol)
        expirations = list(t.options) if t.options else []
        if not expirations:
            return [], None

        spot = _live_spot(symbol)
        if not spot:
            return [], None

        today = datetime.utcnow().date()
        # Nearest EXPIRIES_PER_TICKER expirations that are still in the future.
        future = []
        for s in expirations:
            try:
                d = datetime.strptime(s, "%Y-%m-%d").date()
            except ValueError:
                continue
            if (d - today).days >= 0:
                future.append(s)
        chosen = future[:EXPIRIES_PER_TICKER]
        if not chosen:
            return [], None

        lo, hi = spot * (1 - MONEYNESS_BAND), spot * (1 + MONEYNESS_BAND)
        contracts: list[dict] = []
        call_prem = 0.0
        put_prem = 0.0

        for expiry in chosen:
            try:
                chain = t.option_chain(expiry)
            except Exception as e:
                log.debug("option_chain failed %s %s: %s", symbol, expiry, e)
                continue
            for opt_type, df in (("call", chain.calls), ("put", chain.puts)):
                if df is None or df.empty:
                    continue
                for _, row in df.iterrows():
                    strike = _safe_float(row.get("strike"))
                    if strike is None or strike < lo or strike > hi:
                        continue
                    volume = _safe_float(row.get("volume")) or 0.0
                    oi = _safe_float(row.get("openInterest")) or 0.0
                    last = _safe_float(row.get("lastPrice")) or 0.0
                    iv = _safe_float(row.get("impliedVolatility"))
                    csym = str(row.get("contractSymbol") or f"{symbol}{expiry}")

                    premium = volume * last * 100.0
                    if opt_type == "call":
                        call_prem += premium
                    else:
                        put_prem += premium

                    vol_oi = volume / max(oi, 1.0)
                    if volume < MIN_VOLUME:
                        continue
                    if vol_oi < MIN_VOL_OI_RATIO and premium < MIN_PREMIUM_USD:
                        continue

                    score = _unusual_score(vol_oi, premium, volume)
                    contracts.append({
                        "symbol": csym,
                        "underlying": symbol,
                        "type": opt_type,
                        "strike": round(strike, 2),
                        "expiry": expiry,
                        "spot": round(spot, 2),
                        "moneyness": _moneyness_label(opt_type, strike, spot),
                        "volume": int(volume),
                        "open_interest": int(oi),
                        "vol_oi_ratio": round(vol_oi, 2),
                        "last_price": round(last, 2),
                        "premium_usd": round(premium, 2),
                        "implied_vol": round(iv, 4) if iv is not None else None,
                        "unusual_score": score,
                        "flag": _flag(score),
                    })

        skew = {
            "underlying": symbol,
            "name": name,
            "call_premium": round(call_prem, 2),
            "put_premium": round(put_prem, 2),
            "tilt": _tilt(call_prem, put_prem),
        }
        return contracts, skew
    except Exception as e:
        log.debug("unusual_options scan failed for %s: %s", symbol, e)
        return [], None


def _live_payload() -> dict | None:
    """Bounded, fast live scan. Returns None when too little data resolves so the
    caller can fall back to sample. Never raises (caller also guards)."""
    started = time.monotonic()
    universe = UNIVERSE[:LIVE_MAX_TICKERS]
    contracts: list[dict] = []
    skew: list[dict] = []
    resolved = 0

    for entry in universe:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        rows, skew_row = _scan_ticker(entry["symbol"], entry["name"])
        if skew_row is None:
            continue
        resolved += 1
        contracts.extend(rows)
        if skew_row["call_premium"] > 0 or skew_row["put_premium"] > 0:
            skew.append(skew_row)

    # Require a meaningful fraction of the universe to have resolved live AND at
    # least a few genuinely unusual contracts, else the tape looks empty.
    if resolved < max(4, len(universe) // 4) or len(contracts) < 5:
        return None

    return _assemble(contracts, skew, data_mode="live", source="yfinance")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic unusual-activity tape)
# ---------------------------------------------------------------------------

# Curated, believable unusual flow. Each tuple:
# (underlying, type, strike_offset_pct, expiry_days, volume, open_interest,
#  last_price, iv). strike_offset_pct is relative to the seeded spot.
_SAMPLE_SPOTS: dict[str, float] = {
    "NVDA": 124.30, "TSLA": 246.80, "SPY": 543.10, "AAPL": 213.55,
    "PLTR": 28.40, "AMD": 162.20, "META": 503.70, "COIN": 232.10,
    "GME": 24.80, "QQQ": 472.40, "SMCI": 41.60, "MARA": 18.30,
}

_SAMPLE_FLOW: list[tuple] = [
    # underlying, type, strike_off%, exp_days, volume, OI, last, iv
    ("NVDA", "call", +0.06, 9, 48200, 6100, 3.85, 0.58),   # big call sweep
    ("NVDA", "call", +0.12, 23, 31500, 9400, 2.10, 0.61),
    ("TSLA", "put", -0.07, 9, 27800, 4200, 5.40, 0.66),    # put buying
    ("TSLA", "put", -0.12, 16, 19400, 7800, 3.20, 0.69),
    ("SPY", "put", -0.03, 7, 41200, 22500, 4.10, 0.18),    # index hedging flow
    ("SPY", "put", -0.05, 30, 28900, 31000, 6.75, 0.19),
    ("GME", "call", +0.18, 16, 36500, 3100, 1.05, 1.04),   # meme-name call spike
    ("PLTR", "call", +0.09, 23, 22400, 5600, 1.35, 0.72),
    ("AMD", "call", +0.05, 9, 18900, 7200, 4.20, 0.54),
    ("COIN", "call", +0.10, 16, 14600, 4800, 7.80, 0.78),
    ("META", "call", +0.04, 9, 9800, 6900, 9.40, 0.42),
    ("SMCI", "call", +0.15, 23, 16800, 2900, 2.65, 0.95),
    ("MARA", "call", +0.20, 30, 24100, 5200, 0.78, 1.18),
    ("AAPL", "put", -0.04, 16, 12400, 15800, 3.05, 0.31),
    ("NVDA", "put", -0.08, 9, 11200, 8300, 1.95, 0.60),    # contra put
    ("QQQ", "put", -0.04, 9, 19800, 18900, 3.45, 0.20),
    ("TSLA", "call", +0.10, 23, 15600, 9100, 4.85, 0.64),  # contra call
    ("AMD", "put", -0.06, 16, 8700, 9400, 3.10, 0.56),
    ("PLTR", "call", +0.16, 44, 13900, 3400, 0.92, 0.75),
    ("COIN", "put", -0.09, 16, 7600, 6100, 6.40, 0.80),
    ("GME", "call", +0.30, 30, 21300, 4100, 0.55, 1.22),
    ("META", "put", -0.05, 16, 6800, 8800, 8.10, 0.40),
    ("SPY", "call", +0.02, 7, 17400, 26800, 3.80, 0.17),
    ("NVDA", "call", +0.20, 44, 18700, 5900, 1.45, 0.63),
    ("SMCI", "put", -0.12, 16, 9200, 3700, 3.90, 0.98),
    ("MARA", "call", +0.10, 16, 14800, 6300, 1.10, 1.10),
    ("AAPL", "call", +0.03, 9, 8100, 12400, 4.50, 0.29),
]


def _sample_payload() -> dict:
    today = datetime.utcnow().date()
    contracts: list[dict] = []
    prem_by_under: dict[str, dict] = {}

    for under, opt_type, off, exp_days, volume, oi, last, iv in _SAMPLE_FLOW:
        spot = _SAMPLE_SPOTS.get(under, 100.0)
        strike = round(spot * (1.0 + off), 2)
        expiry = (today + timedelta(days=exp_days)).strftime("%Y-%m-%d")
        premium = volume * last * 100.0
        vol_oi = volume / max(float(oi), 1.0)
        score = _unusual_score(vol_oi, premium, volume)
        # Build a believable OCC-style contract symbol.
        cp = "C" if opt_type == "call" else "P"
        exp_code = (today + timedelta(days=exp_days)).strftime("%y%m%d")
        csym = f"{under}{exp_code}{cp}{int(round(strike * 1000)):08d}"

        contracts.append({
            "symbol": csym,
            "underlying": under,
            "type": opt_type,
            "strike": strike,
            "expiry": expiry,
            "spot": spot,
            "moneyness": _moneyness_label(opt_type, strike, spot),
            "volume": int(volume),
            "open_interest": int(oi),
            "vol_oi_ratio": round(vol_oi, 2),
            "last_price": round(last, 2),
            "premium_usd": round(premium, 2),
            "implied_vol": round(iv, 4),
            "unusual_score": score,
            "flag": _flag(score),
        })

        slot = prem_by_under.setdefault(
            under, {"underlying": under, "name": under, "call": 0.0, "put": 0.0}
        )
        slot["call" if opt_type == "call" else "put"] += premium

    skew: list[dict] = []
    for under, slot in prem_by_under.items():
        name = next((u["name"] for u in UNIVERSE if u["symbol"] == under), under)
        skew.append({
            "underlying": under,
            "name": name,
            "call_premium": round(slot["call"], 2),
            "put_premium": round(slot["put"], 2),
            "tilt": _tilt(slot["call"], slot["put"]),
        })

    return _assemble(contracts, skew, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Payload assembly
# ---------------------------------------------------------------------------

def _assemble(contracts: list[dict], skew: list[dict], *,
              data_mode: str, source: str) -> dict:
    contracts = sorted(contracts, key=lambda c: c["unusual_score"], reverse=True)[:TOP_N]
    skew = sorted(
        skew,
        key=lambda s: s["call_premium"] + s["put_premium"],
        reverse=True,
    )

    total_premium = round(sum(c["premium_usd"] for c in contracts), 2)
    total_call = sum(s["call_premium"] for s in skew)
    total_put = sum(s["put_premium"] for s in skew)
    call_put_ratio = round(total_call / total_put, 2) if total_put > 0 else None
    bullish = sum(1 for s in skew if s["tilt"] == "Bullish")
    bearish = sum(1 for s in skew if s["tilt"] == "Bearish")
    most_unusual = contracts[0]["underlying"] if contracts else None

    return {
        "contracts": contracts,
        "skew": skew,
        "summary": {
            "most_unusual": most_unusual,
            "total_premium": total_premium,
            "call_put_ratio": call_put_ratio,
            "bullish_count": bullish,
            "bearish_count": bearish,
        },
        "data_mode": data_mode,
        "as_of": _now_iso(),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def unusual_options() -> dict:
    """Scan the universe for unusual options activity. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("contracts"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("unusual_options live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("unusual_options sample path failed hard: %s", e)
        return {
            "contracts": [],
            "skew": [],
            "summary": {
                "most_unusual": None,
                "total_premium": 0.0,
                "call_put_ratio": None,
                "bullish_count": 0,
                "bearish_count": 0,
            },
            "data_mode": "sample",
            "as_of": _now_iso(),
            "source": "sample",
        }
