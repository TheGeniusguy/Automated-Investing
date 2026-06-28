"""Single-name CDS pricer (Bloomberg `CDSW`).

A standalone ISDA-style reduced-form credit-default-swap valuation engine. Given a
running spread, recovery assumption, tenor, coupon convention and notional, it
builds a quarterly premium/protection schedule off the credit triangle and reports
the upfront, points-upfront, par spread, risky PV01 (RPV01), default probability
over the tenor and a survival-probability curve.

This module is pure math (numpy only) so the natural `data_mode` is "computed" -
there is no external feed to degrade from. Even so it honors the build contract:
every public function wraps its work in try/except and ALWAYS returns a populated,
deterministic dict; it never raises and never returns an empty body. The reference
names table is a curated, clearly-named SAMPLE constant of well-known single-name
issuers at indicative spreads.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

import numpy as np

log = logging.getLogger(__name__)

# Flat risk-free discounting rate (continuously compounded) used for the
# protection + premium leg discount factors when no curve is supplied.
RISK_FREE = 0.043

# Quarterly premium schedule (standard CDS convention).
ACCRUAL_PER_YEAR = 4
DT = 1.0 / ACCRUAL_PER_YEAR


# ---------------------------------------------------------------------------
# SAMPLE reference single-names at indicative running spreads (5Y).
# spread_bps is the indicative 5Y par spread; recovery is the desk convention
# (40% senior unsecured, 25% for high-yield / subordinated names is common but we
# keep 40% as the standard quoting recovery). Clearly namespaced per the contract.
# ---------------------------------------------------------------------------

SAMPLE_REFERENCE_NAMES: list[dict] = [
    {"name": "Apple Inc.", "ticker": "AAPL", "sector": "Technology", "indicative_spread_bps": 28.0, "rating": "AA+"},
    {"name": "Microsoft Corp.", "ticker": "MSFT", "sector": "Technology", "indicative_spread_bps": 24.0, "rating": "AAA"},
    {"name": "JPMorgan Chase & Co.", "ticker": "JPM", "sector": "Financials", "indicative_spread_bps": 55.0, "rating": "A-"},
    {"name": "Bank of America Corp.", "ticker": "BAC", "sector": "Financials", "indicative_spread_bps": 62.0, "rating": "A-"},
    {"name": "Goldman Sachs Group Inc.", "ticker": "GS", "sector": "Financials", "indicative_spread_bps": 72.0, "rating": "BBB+"},
    {"name": "AT&T Inc.", "ticker": "T", "sector": "Communications", "indicative_spread_bps": 98.0, "rating": "BBB"},
    {"name": "Verizon Communications Inc.", "ticker": "VZ", "sector": "Communications", "indicative_spread_bps": 88.0, "rating": "BBB+"},
    {"name": "Ford Motor Company", "ticker": "F", "sector": "Consumer Cyclical", "indicative_spread_bps": 235.0, "rating": "BB+"},
    {"name": "Boeing Company", "ticker": "BA", "sector": "Industrials", "indicative_spread_bps": 165.0, "rating": "BBB-"},
    {"name": "Carnival Corp.", "ticker": "CCL", "sector": "Consumer Cyclical", "indicative_spread_bps": 420.0, "rating": "B+"},
    {"name": "Occidental Petroleum Corp.", "ticker": "OXY", "sector": "Energy", "indicative_spread_bps": 188.0, "rating": "BB+"},
    {"name": "American Airlines Group Inc.", "ticker": "AAL", "sector": "Industrials", "indicative_spread_bps": 640.0, "rating": "B-"},
    {"name": "Tesla Inc.", "ticker": "TSLA", "sector": "Consumer Cyclical", "indicative_spread_bps": 145.0, "rating": "BBB"},
    {"name": "Walmart Inc.", "ticker": "WMT", "sector": "Consumer Defensive", "indicative_spread_bps": 30.0, "rating": "AA"},
    {"name": "Pfizer Inc.", "ticker": "PFE", "sector": "Health Care", "indicative_spread_bps": 58.0, "rating": "A"},
    {"name": "General Electric Co.", "ticker": "GE", "sector": "Industrials", "indicative_spread_bps": 110.0, "rating": "BBB+"},
]


# ---------------------------------------------------------------------------
# Core math helpers
# ---------------------------------------------------------------------------

def _hazard_from_spread(spread_bps: float, recovery: float) -> float:
    """Continuous credit-triangle approximation: lambda ~= s / (1 - R).

    spread is in decimal (bps / 1e4), recovery in [0, 1). Guarded so a recovery of
    1.0 (or above) does not divide by zero.
    """
    s = max(float(spread_bps), 0.0) / 1e4
    loss = 1.0 - float(recovery)
    if loss <= 1e-9:
        loss = 1e-9
    return s / loss


def _schedule(tenor_years: float) -> np.ndarray:
    """Quarterly accrual times (year fractions) from 0.25 to tenor inclusive."""
    n = max(int(round(float(tenor_years) * ACCRUAL_PER_YEAR)), 1)
    return (np.arange(1, n + 1, dtype=float)) * DT


def _discount(t: np.ndarray, rate: float = RISK_FREE) -> np.ndarray:
    return np.exp(-float(rate) * t)


def _legs(hazard: float, recovery: float, tenor_years: float, rate: float = RISK_FREE) -> dict:
    """Build premium/protection leg PV factors for a 1.0 notional, 1.0 coupon
    (i.e. RPV01 and protection-per-unit-loss). Returns the building blocks the
    pricer multiplies by notional + coupon.
    """
    t = _schedule(tenor_years)
    t_prev = np.concatenate([[0.0], t[:-1]])
    df = _discount(t, rate)
    surv = np.exp(-hazard * t)
    surv_prev = np.exp(-hazard * t_prev)
    dt = t - t_prev  # ~0.25 each, last stub may differ

    # Premium leg (per 1.0 coupon, per 1.0 notional) = risky annuity = RPV01.
    # Includes accrual-on-default: half-period accrual paid on names that default
    # mid-coupon, i.e. dt/2 * DF * (S_prev - S).
    full_coupon = np.sum(dt * df * surv)
    accrual_on_default = np.sum(0.5 * dt * df * (surv_prev - surv))
    rpv01 = float(full_coupon + accrual_on_default)

    # Protection leg (per 1.0 notional) = (1 - R) * sum DF * (S_prev - S).
    prot_unit = float((1.0 - recovery) * np.sum(df * (surv_prev - surv)))

    return {
        "t": t,
        "df": df,
        "surv": surv,
        "rpv01": rpv01,
        "prot_unit": prot_unit,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def price_cds(
    spread_bps: float = 100.0,
    recovery: float = 0.40,
    tenor_years: float = 5.0,
    coupon_bps: float = 100.0,
    notional: float = 10_000_000.0,
    flat_hazard: bool | None = None,
) -> dict:
    """Price a single-name CDS off the credit triangle. Never raises.

    Convention: running-coupon CDS. The buyer of protection pays `coupon_bps`
    running and settles the difference to fair value upfront. The market `spread`
    determines the issuer hazard; the contractual `coupon` determines the running
    cash flows. Upfront = Protection PV - Premium PV (positive => protection buyer
    pays the seller today).
    """
    try:
        return _price_cds(spread_bps, recovery, tenor_years, coupon_bps, notional, flat_hazard)
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("price_cds failed hard, returning defaults: %s", e)
        return _price_cds(100.0, 0.40, 5.0, 100.0, 10_000_000.0, flat_hazard)


def _price_cds(
    spread_bps: float,
    recovery: float,
    tenor_years: float,
    coupon_bps: float,
    notional: float,
    flat_hazard: bool | None,
) -> dict:
    # ---- sanitize inputs (guard NaN / negatives / silly ranges) ----
    spread_bps = _clean(spread_bps, 100.0, lo=0.0, hi=100_000.0)
    recovery = _clean(recovery, 0.40, lo=0.0, hi=0.999)
    tenor_years = _clean(tenor_years, 5.0, lo=0.25, hi=30.0)
    coupon_bps = _clean(coupon_bps, 100.0, lo=0.0, hi=100_000.0)
    notional = _clean(notional, 10_000_000.0, lo=0.0, hi=1e13)

    hazard = _hazard_from_spread(spread_bps, recovery)
    legs = _legs(hazard, recovery, tenor_years)

    rpv01_unit = legs["rpv01"]              # risky annuity per 1.0 notional, per 1.0 coupon
    prot_pv = legs["prot_unit"] * notional  # protection leg $
    coupon = coupon_bps / 1e4
    premium_pv = coupon * rpv01_unit * notional  # premium leg $

    # RPV01 reported per 1bp of running coupon on the full notional (desk convention).
    rpv01 = rpv01_unit * notional * 1e-4

    upfront = prot_pv - premium_pv
    points_upfront_pct = (upfront / notional * 100.0) if notional > 0 else 0.0

    # Par spread = coupon that zeroes the upfront = protection / risky annuity.
    par_spread = (legs["prot_unit"] / rpv01_unit) * 1e4 if rpv01_unit > 1e-12 else 0.0

    # Default probability over the tenor = 1 - S(T).
    survival_T = float(math.exp(-hazard * tenor_years))
    default_prob = 1.0 - survival_T

    # Survival-probability curve (annual marks for a clean chart).
    survival_curve = _survival_curve(hazard, tenor_years)

    return {
        "inputs": {
            "spread_bps": round(spread_bps, 4),
            "recovery": round(recovery, 4),
            "tenor_years": round(tenor_years, 4),
            "coupon_bps": round(coupon_bps, 4),
            "notional": round(notional, 2),
        },
        "par_spread_bps": round(par_spread, 3),
        "upfront": round(upfront, 2),
        "points_upfront_pct": round(points_upfront_pct, 4),
        "protection_pv": round(prot_pv, 2),
        "premium_pv": round(premium_pv, 2),
        "rpv01": round(rpv01, 2),
        "hazard_rate": round(hazard, 6),
        "default_prob": round(default_prob, 6),
        "survival_curve": survival_curve,
        "reference_names": [dict(r) for r in SAMPLE_REFERENCE_NAMES],
        "data_mode": "computed",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "isda-credit-triangle",
    }


def cds_pricer(
    spread_bps: float = 100.0,
    recovery: float = 0.40,
    tenor_years: float = 5.0,
    coupon_bps: float = 100.0,
    notional: float = 10_000_000.0,
) -> dict:
    """Convenience wrapper around `price_cds`. Identical payload, also guarantees a
    populated `reference_names` table (well-known single names at indicative
    spreads) so the panel can offer one-click issuer presets. Never raises.
    """
    try:
        out = price_cds(spread_bps, recovery, tenor_years, coupon_bps, notional)
        if not out.get("reference_names"):
            out["reference_names"] = [dict(r) for r in SAMPLE_REFERENCE_NAMES]
        return out
    except Exception as e:  # absolute safety net
        log.warning("cds_pricer failed hard, returning defaults: %s", e)
        return price_cds(100.0, 0.40, 5.0, 100.0, 10_000_000.0)


# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------

def _survival_curve(hazard: float, tenor_years: float) -> list[dict]:
    """Annual (plus a 0 anchor and the exact tenor endpoint) survival marks."""
    marks: list[float] = [0.0]
    y = 1.0
    while y < tenor_years - 1e-9:
        marks.append(y)
        y += 1.0
    if abs(marks[-1] - tenor_years) > 1e-9:
        marks.append(round(tenor_years, 4))
    out: list[dict] = []
    for yr in marks:
        out.append({"year": round(float(yr), 4), "survival": round(float(math.exp(-hazard * yr)), 6)})
    return out


def _clean(v, default: float, *, lo: float, hi: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float(default)
    if math.isnan(f) or math.isinf(f):
        return float(default)
    return float(min(max(f, lo), hi))
