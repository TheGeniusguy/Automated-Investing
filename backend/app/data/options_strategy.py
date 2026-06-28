"""Options Strategy Builder (Bloomberg OSA equivalent) - Feature Wave F.

Constructs multi-leg option strategies on any symbol and returns a full payoff
analysis: priced legs (Black-Scholes), net debit/credit, max profit/loss,
breakevens, a dense expiry payoff curve, and combined position greeks.

Live path: the underlying spot is the last close from
``app.data.macro_data.fetch_arbitrary_ticker(symbol, 30)``. When that is
unavailable we fall back to a deterministic SAMPLE spot seeded off the symbol
(hashlib.md5) so screenshots are stable and fully populated.

Leg pricing uses a small closed-form Black-Scholes pricer implemented inline
(call/put price + delta/gamma/theta/vega) with an assumed IV ~0.28, r ~0.045
and ~37 DTE. Strikes are chosen sensibly around spot per strategy.

This module never raises - every public function wraps all work in try/except
and degrades to deterministic sample output, always tagging the payload with
data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Pricing assumptions.
ASSUMED_IV = 0.28
RISK_FREE = 0.045
EXPIRY_DAYS = 37
CONTRACT_MULT = 100  # one option contract controls 100 shares
_SQRT_2PI = math.sqrt(2.0 * math.pi)


# --------------------------------------------------------------------------- #
# Strategy catalog
# --------------------------------------------------------------------------- #
# Each leg template: (action, type, moneyness, qty). moneyness multiplies spot
# to get the raw strike (None for Stock legs = bought at spot). qty is contracts
# (or 100-share blocks for Stock).

STRATEGY_SPECS: dict[str, dict] = {
    "long_call": {
        "name": "Long Call",
        "description": "Bullish. Unlimited upside, risk capped at the premium paid.",
        "legs_desc": "Buy 1 ATM call",
        "legs": [("Buy", "Call", 1.00, 1)],
    },
    "long_put": {
        "name": "Long Put",
        "description": "Bearish. Profits as the underlying falls, risk capped at the premium paid.",
        "legs_desc": "Buy 1 ATM put",
        "legs": [("Buy", "Put", 1.00, 1)],
    },
    "covered_call": {
        "name": "Covered Call",
        "description": "Income on a long stock position. Caps upside above the short strike.",
        "legs_desc": "Long 100 shares + sell 1 OTM call",
        "legs": [("Buy", "Stock", None, 1), ("Sell", "Call", 1.05, 1)],
    },
    "bull_call_spread": {
        "name": "Bull Call Spread",
        "description": "Bullish, defined risk. Long lower call financed by a short higher call.",
        "legs_desc": "Buy 0.98x call, sell 1.05x call",
        "legs": [("Buy", "Call", 0.98, 1), ("Sell", "Call", 1.05, 1)],
    },
    "bear_put_spread": {
        "name": "Bear Put Spread",
        "description": "Bearish, defined risk. Long higher put financed by a short lower put.",
        "legs_desc": "Buy 1.02x put, sell 0.95x put",
        "legs": [("Buy", "Put", 1.02, 1), ("Sell", "Put", 0.95, 1)],
    },
    "straddle": {
        "name": "Long Straddle",
        "description": "Volatility play. Profits on a large move in either direction.",
        "legs_desc": "Buy ATM call + buy ATM put",
        "legs": [("Buy", "Call", 1.00, 1), ("Buy", "Put", 1.00, 1)],
    },
    "strangle": {
        "name": "Long Strangle",
        "description": "Cheaper volatility play. Needs a bigger move than a straddle to pay.",
        "legs_desc": "Buy 1.05x call + buy 0.95x put",
        "legs": [("Buy", "Call", 1.05, 1), ("Buy", "Put", 0.95, 1)],
    },
    "iron_condor": {
        "name": "Iron Condor",
        "description": "Range-bound, net credit. Profits if price stays inside the short strikes.",
        "legs_desc": "Sell 0.95x put / buy 0.90x put + sell 1.05x call / buy 1.10x call",
        "legs": [
            ("Sell", "Put", 0.95, 1),
            ("Buy", "Put", 0.90, 1),
            ("Sell", "Call", 1.05, 1),
            ("Buy", "Call", 1.10, 1),
        ],
    },
    "butterfly": {
        "name": "Call Butterfly",
        "description": "Pins the underlying near the body strike. Defined, low-cost risk.",
        "legs_desc": "Buy 0.95x call, sell 2 ATM calls, buy 1.05x call",
        "legs": [
            ("Buy", "Call", 0.95, 1),
            ("Sell", "Call", 1.00, 2),
            ("Buy", "Call", 1.05, 1),
        ],
    },
}

STRATEGY_ORDER = [
    "long_call", "long_put", "covered_call", "bull_call_spread", "bear_put_spread",
    "straddle", "strangle", "iron_condor", "butterfly",
]


# --------------------------------------------------------------------------- #
# Black-Scholes (closed form, no scipy)
# --------------------------------------------------------------------------- #

def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def _bs(S: float, K: float, T: float, sigma: float, kind: str, r: float = RISK_FREE) -> dict:
    """Black-Scholes price + greeks for one share.

    vega is per 1 vol point (/100); theta is per calendar day (/365). Degenerate
    inputs collapse to intrinsic value with flat greeks rather than raising.
    """
    is_call = str(kind).lower().startswith("c")
    if not (S > 0 and K > 0) or T <= 0 or sigma <= 0:
        intrinsic = max(0.0, S - K) if is_call else max(0.0, K - S)
        delta = (1.0 if S > K else 0.0) if is_call else (-1.0 if S < K else 0.0)
        return {"price": intrinsic, "delta": delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0}

    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    disc = math.exp(-r * T)
    nd1, nd2 = _norm_cdf(d1), _norm_cdf(d2)
    pdf = _norm_pdf(d1)

    gamma = pdf / (S * sigma * sqrt_t)
    vega = S * pdf * sqrt_t / 100.0
    if is_call:
        price = S * nd1 - K * disc * nd2
        delta = nd1
        theta = (-S * pdf * sigma / (2.0 * sqrt_t) - r * K * disc * nd2) / 365.0
    else:
        price = K * disc * _norm_cdf(-d2) - S * _norm_cdf(-d1)
        delta = nd1 - 1.0
        theta = (-S * pdf * sigma / (2.0 * sqrt_t) + r * K * disc * _norm_cdf(-d2)) / 365.0
    return {"price": price, "delta": delta, "gamma": gamma, "theta": theta, "vega": vega}


# --------------------------------------------------------------------------- #
# Spot resolution
# --------------------------------------------------------------------------- #

def _seed(symbol: str) -> int:
    return int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16)


def _sample_spot(symbol: str) -> float:
    """Deterministic, plausible spot in the ~$30..$430 range, seeded off symbol."""
    h = _seed(symbol)
    return round(30.0 + (h % 40000) / 100.0, 2)


def _live_spot(symbol: str) -> float | None:
    try:
        from .macro_data import fetch_arbitrary_ticker
        bars = fetch_arbitrary_ticker(symbol, 30)
        if not bars:
            return None
        for bar in reversed(bars):
            v = bar.get("value")
            if v is not None and float(v) > 0:
                return float(v)
    except Exception as e:  # pragma: no cover - defensive
        log.warning("options_strategy live spot failed for %s: %s", symbol, e)
    return None


# --------------------------------------------------------------------------- #
# Strike helpers
# --------------------------------------------------------------------------- #

def _strike_step(spot: float) -> float:
    if spot < 25:
        return 0.5
    if spot < 100:
        return 1.0
    if spot < 250:
        return 2.5
    return 5.0


def _round_strike(raw: float, step: float) -> float:
    return round(round(raw / step) * step, 2)


# --------------------------------------------------------------------------- #
# Payoff math (piecewise linear in the underlying)
# --------------------------------------------------------------------------- #

def _leg_intrinsic(leg: dict, price: float) -> float:
    t = leg["type"]
    if t == "Call":
        return max(price - leg["strike"], 0.0)
    if t == "Put":
        return max(leg["strike"] - price, 0.0)
    return price  # Stock: value == price per share


def _leg_pnl(leg: dict, price: float) -> float:
    sign = 1.0 if leg["action"] == "Buy" else -1.0
    return sign * (_leg_intrinsic(leg, price) - leg["premium"]) * leg["qty"] * leg["mult"]


def _total_pnl(legs: list[dict], price: float) -> float:
    return sum(_leg_pnl(l, price) for l in legs)


def _upside_slope(legs: list[dict]) -> float:
    """dPnL/dPrice as price -> +inf (Calls and Stock contribute +1/share)."""
    s = 0.0
    for l in legs:
        sign = 1.0 if l["action"] == "Buy" else -1.0
        coeff = 1.0 if l["type"] in ("Call", "Stock") else 0.0
        s += sign * coeff * l["qty"] * l["mult"]
    return s


def _breakevens(legs: list[dict], kinks: list[float], hi: float) -> list[float]:
    pts = sorted(set([0.0] + kinks + [hi]))
    outs: list[float] = []
    for a, b in zip(pts[:-1], pts[1:]):
        pa, pb = _total_pnl(legs, a), _total_pnl(legs, b)
        if pa == 0.0:
            outs.append(round(a, 2))
        if (pa < 0 < pb) or (pa > 0 > pb):
            # linear interpolation of the zero crossing on this segment
            be = a + (b - a) * (0.0 - pa) / (pb - pa)
            outs.append(round(be, 2))
    # de-dupe within a cent
    uniq: list[float] = []
    for x in outs:
        if all(abs(x - u) > 0.01 for u in uniq):
            uniq.append(x)
    return uniq


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #

def build_strategy(symbol: str, strategy: str = "bull_call_spread") -> dict:
    """Construct ``strategy`` on ``symbol`` and return its full payoff analysis.

    Never raises - degrades to a deterministic sample spot on any failure.
    """
    sym = (symbol or "AAPL").strip().upper() or "AAPL"
    strat = strategy if strategy in STRATEGY_SPECS else "bull_call_spread"
    try:
        return _build(sym, strat)
    except Exception as e:  # absolute safety net
        log.warning("build_strategy failed hard for %s/%s: %s", sym, strat, e)
        try:
            return _build(sym, strat, force_sample=True)
        except Exception:  # pragma: no cover
            return _empty_payload(sym, strat)


def _build(sym: str, strat: str, force_sample: bool = False) -> dict:
    spec = STRATEGY_SPECS[strat]
    spot = None if force_sample else _live_spot(sym)
    if spot is not None and spot > 0:
        data_mode, source = "live", "yfinance"
    else:
        spot = _sample_spot(sym)
        data_mode, source = "sample", "sample"

    T = EXPIRY_DAYS / 365.0
    step = _strike_step(spot)

    legs: list[dict] = []
    for action, typ, moneyness, qty in spec["legs"]:
        if typ == "Stock":
            leg = {
                "action": action, "type": "Stock", "strike": round(spot, 2),
                "premium": round(spot, 2), "qty": qty, "mult": CONTRACT_MULT,
                "iv": None, "delta": 1.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0,
            }
        else:
            strike = _round_strike(spot * moneyness, step)
            g = _bs(spot, strike, T, ASSUMED_IV, typ)
            leg = {
                "action": action, "type": typ, "strike": strike,
                "premium": round(g["price"], 4), "qty": qty, "mult": CONTRACT_MULT,
                "iv": ASSUMED_IV,
                "delta": g["delta"], "gamma": g["gamma"], "theta": g["theta"], "vega": g["vega"],
            }
        legs.append(leg)

    # Net debit (positive) / credit (negative).
    net_debit = sum(
        (1.0 if l["action"] == "Buy" else -1.0) * l["premium"] * l["qty"] * l["mult"]
        for l in legs
    )

    # Combined position greeks (share / dollar equivalents).
    net_delta = sum((1.0 if l["action"] == "Buy" else -1.0) * l["delta"] * l["qty"] * l["mult"] for l in legs)
    net_gamma = sum((1.0 if l["action"] == "Buy" else -1.0) * l["gamma"] * l["qty"] * l["mult"] for l in legs)
    net_theta = sum((1.0 if l["action"] == "Buy" else -1.0) * l["theta"] * l["qty"] * l["mult"] for l in legs)
    net_vega = sum((1.0 if l["action"] == "Buy" else -1.0) * l["vega"] * l["qty"] * l["mult"] for l in legs)

    # Payoff extremes via kink analysis (payoff is piecewise linear).
    kinks = sorted({l["strike"] for l in legs if l["type"] != "Stock"} | {round(spot, 2)})
    hi_probe = spot * 5.0
    eval_pts = sorted(set([0.0] + kinks))
    pnls = [_total_pnl(legs, p) for p in eval_pts]
    up_slope = _upside_slope(legs)

    finite_max = max(pnls)
    finite_min = min(pnls)
    # The far-right boundary matters when the upside is bounded but sloping.
    far = _total_pnl(legs, hi_probe)
    if up_slope == 0:
        finite_max = max(finite_max, far)
        finite_min = min(finite_min, far)

    max_profit = None if up_slope > 0 else round(finite_max, 2)
    max_loss = None if up_slope < 0 else round(finite_min, 2)

    breakevens = _breakevens(legs, kinks, hi_probe)

    # Dense payoff curve spanning +/-25% of spot (41 points).
    lo, hi = spot * 0.75, spot * 1.25
    payoff = []
    for i in range(41):
        px = lo + (hi - lo) * i / 40.0
        payoff.append({"price": round(px, 2), "pnl": round(_total_pnl(legs, px), 2)})

    out_legs = [
        {"action": l["action"], "type": l["type"], "strike": l["strike"],
         "premium": l["premium"], "qty": l["qty"], "iv": l["iv"]}
        for l in legs
    ]

    return {
        "symbol": sym,
        "strategy": strat,
        "strategy_name": spec["name"],
        "description": spec["description"],
        "spot": round(spot, 2),
        "expiry_days": EXPIRY_DAYS,
        "legs": out_legs,
        "net_debit": round(net_debit, 2),
        "max_profit": max_profit,
        "max_loss": max_loss,
        "breakevens": breakevens,
        "payoff": payoff,
        "net_delta": round(net_delta, 2),
        "net_gamma": round(net_gamma, 4),
        "net_theta": round(net_theta, 2),
        "net_vega": round(net_vega, 2),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _empty_payload(sym: str, strat: str) -> dict:
    spec = STRATEGY_SPECS.get(strat, STRATEGY_SPECS["bull_call_spread"])
    spot = _sample_spot(sym)
    return {
        "symbol": sym, "strategy": strat, "strategy_name": spec["name"],
        "description": spec["description"], "spot": spot, "expiry_days": EXPIRY_DAYS,
        "legs": [], "net_debit": 0.0, "max_profit": 0.0, "max_loss": 0.0,
        "breakevens": [], "payoff": [{"price": spot, "pnl": 0.0}],
        "net_delta": 0.0, "net_gamma": 0.0, "net_theta": 0.0, "net_vega": 0.0,
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "sample",
    }


# --------------------------------------------------------------------------- #
# Catalog
# --------------------------------------------------------------------------- #

def list_strategies() -> dict:
    """Return the strategy catalog for the dropdown. Never raises."""
    try:
        strategies = [
            {
                "id": sid,
                "name": STRATEGY_SPECS[sid]["name"],
                "description": STRATEGY_SPECS[sid]["description"],
                "legs_desc": STRATEGY_SPECS[sid]["legs_desc"],
            }
            for sid in STRATEGY_ORDER
        ]
        return {
            "strategies": strategies,
            "data_mode": "live",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "catalog",
        }
    except Exception as e:  # pragma: no cover
        log.warning("list_strategies failed: %s", e)
        return {
            "strategies": [], "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "catalog",
        }
