"""Credit & CDS curves layer (Bloomberg Wave D - D4 / CRVD).

Builds an institutional credit view from three pieces:

  1. IG + HY OAS term structures (1/3/5/7/10y). The 5y anchor levels are pulled
     live from FRED ICE BofA indices (BAMLC0A0CM for IG master OAS,
     BAMLH0A0HYM2 for HY master OAS) when a FRED key is configured, then a
     deterministic term shape is layered on top to produce a full curve.
  2. Sample issuer CDS curves spanning the rating ladder (AAA -> B). Each tenor
     carries a CDS-implied cumulative default probability using the standard
     credit-triangle approximation PD(T) = 1 - exp(-(spread/1e4) * T / (1-R))
     with recovery R = 0.4.
  3. A credit-vs-equity divergence read: compares the recent direction of HY
     spreads against equity (SPY) returns to flag risk-on rallies that ignore
     credit stress (or credit stress the equity tape is shrugging off).

Contract: never raises (every failure path falls back to deterministic sample);
every payload carries data_mode ("live"|"sample") + as_of (ISO Z) + source.
Sample values are deterministic, seeded off the issuer name via hashlib so
screenshots are stable. Pure numpy/stdlib, no new pip deps.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

import numpy as np

from . import macro_data

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

RECOVERY = 0.40                       # standard CDS recovery assumption
TENORS = [1, 3, 5, 7, 10]             # years on every curve
IG_FRED_ID = "BAMLC0A0CM"             # ICE BofA US Corporate (IG) Master OAS, %
HY_FRED_ID = "BAMLH0A0HYM2"           # ICE BofA US High Yield Master II OAS, %

# Fallback 5y anchor levels (bps) used when the live FRED pull is unavailable.
SAMPLE_IG_5Y_BPS = 95.0
SAMPLE_HY_5Y_BPS = 335.0

# Term-shape multipliers relative to the 5y point. IG slopes up with duration;
# HY is flatter (carry-rich front end, credit-curve compression further out).
IG_SHAPE = {1: 0.55, 3: 0.80, 5: 1.00, 7: 1.12, 10: 1.22}
HY_SHAPE = {1: 0.80, 3: 0.92, 5: 1.00, 7: 1.05, 10: 1.08}

# Issuer universe spanning the rating ladder. base_5y is the sample 5y CDS in bps.
ISSUERS: list[dict] = [
    {"name": "Microsoft Corp",          "ticker": "MSFT", "rating": "AAA", "sector": "Technology", "base_5y": 33.0},
    {"name": "Johnson & Johnson",       "ticker": "JNJ",  "rating": "AAA", "sector": "Healthcare", "base_5y": 37.0},
    {"name": "Apple Inc",               "ticker": "AAPL", "rating": "AA+", "sector": "Technology", "base_5y": 41.0},
    {"name": "JPMorgan Chase & Co",     "ticker": "JPM",  "rating": "A",   "sector": "Financials", "base_5y": 60.0},
    {"name": "Verizon Communications",  "ticker": "VZ",   "rating": "BBB", "sector": "Telecom",    "base_5y": 98.0},
    {"name": "Ford Motor Co",           "ticker": "F",    "rating": "BB",  "sector": "Autos",      "base_5y": 215.0},
    {"name": "Occidental Petroleum",    "ticker": "OXY",  "rating": "BB",  "sector": "Energy",     "base_5y": 188.0},
    {"name": "Carnival Corp",           "ticker": "CCL",  "rating": "B",   "sector": "Leisure",    "base_5y": 430.0},
]

# Per-rating CDS curve steepness (multiplier on the 5y, by tenor). IG names have
# upward curves; lower-rated names flatten and can invert (front-loaded default).
_IG_RATINGS = {"AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-"}
IG_CDS_SHAPE = {1: 0.45, 3: 0.74, 5: 1.00, 7: 1.18, 10: 1.34}
HY_CDS_SHAPE = {1: 0.88, 3: 0.96, 5: 1.00, 7: 1.00, 10: 0.98}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _seed(name: str) -> int:
    return int(hashlib.md5(name.encode()).hexdigest()[:8], 16)


def _latest_value(points: list[dict]) -> float | None:
    """Most recent non-null value from a fetch_series payload."""
    for p in reversed(points or []):
        v = p.get("value")
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
    return None


def _pd_pct(spread_bps: float, tenor: float, recovery: float = RECOVERY) -> float:
    """CDS-implied cumulative default probability over `tenor` years, in percent.

    PD(T) = 1 - exp(-(spread/1e4) * T / (1-R)).
    """
    hazard = (spread_bps / 1e4) / (1.0 - recovery)
    pd = 1.0 - math.exp(-hazard * tenor)
    return round(pd * 100.0, 2)


def _oas_curve(anchor_5y_bps: float, shape: dict[int, float], seed_key: str) -> list[dict]:
    """Build a tenor curve from a 5y anchor + shape multipliers + tiny seeded
    wiggle (deterministic) so the line isn't unnaturally smooth."""
    rng = np.random.default_rng(_seed(seed_key))
    out: list[dict] = []
    for t in TENORS:
        wiggle = float(rng.uniform(-2.5, 2.5))   # +/- a couple bps, deterministic
        spread = max(1.0, anchor_5y_bps * shape[t] + wiggle)
        out.append({"tenor": t, "spread_bps": round(spread, 1)})
    return out


def _issuer_curve(issuer: dict) -> list[dict]:
    """Full per-issuer CDS curve with spread + PD + survival at each tenor."""
    rating = issuer["rating"]
    shape = IG_CDS_SHAPE if rating in _IG_RATINGS else HY_CDS_SHAPE
    rng = np.random.default_rng(_seed(issuer["name"]))
    base = float(issuer["base_5y"])
    curve: list[dict] = []
    for t in TENORS:
        wiggle = float(rng.uniform(-3.0, 3.0))
        spread = max(2.0, base * shape[t] + wiggle)
        pd = _pd_pct(spread, t)
        curve.append({
            "tenor": t,
            "spread_bps": round(spread, 1),
            "pd_pct": pd,
            "survival_pct": round(100.0 - pd, 2),
        })
    return curve


def _curve_shape(curve: list[dict]) -> str:
    by_tenor = {c["tenor"]: c["spread_bps"] for c in curve}
    front, back = by_tenor.get(1), by_tenor.get(10)
    if front is None or back is None:
        return "flat"
    diff = back - front
    if diff > 0.10 * front:
        return "upward"
    if diff < -0.10 * front:
        return "inverted"
    return "flat"


def _spread_at(curve: list[dict], tenor: int) -> float | None:
    for c in curve:
        if c["tenor"] == tenor:
            return c["spread_bps"]
    return None


# ── Credit-vs-equity divergence ──────────────────────────────────────────────

def _divergence(hy_points: list[dict]) -> dict:
    """Compare the recent direction of HY spreads vs equity (SPY) returns.

    Normal regime: spreads and equity move inversely (spreads widen as stocks
    fall). Divergence = both risk gauges point the same way, e.g. an equity
    rally while credit spreads are still widening (the tape ignoring credit
    stress), or spreads tightening into an equity selloff.
    """
    try:
        spy = macro_data.fetch_arbitrary_ticker("^GSPC", 35)
    except Exception as exc:                              # never raise
        log.warning("divergence SPY fetch failed: %s", exc)
        spy = []

    hy_chg_bps = _window_change_bps(hy_points)
    eq_ret_pct = _window_return_pct(spy)

    if hy_chg_bps is None or eq_ret_pct is None:
        # Deterministic sample read: spreads creeping wider while equity grinds
        # higher -> a classic late-cycle divergence the screenshots can show.
        hy_chg_bps = hy_chg_bps if hy_chg_bps is not None else 18.0
        eq_ret_pct = eq_ret_pct if eq_ret_pct is not None else 2.4
        mode = "sample"
    else:
        mode = "live"

    spreads_widening = hy_chg_bps > 0
    equity_up = eq_ret_pct > 0
    # Diverging when both gauges agree on direction (both risk-on or both risk-off).
    diverging = spreads_widening == equity_up
    if diverging and spreads_widening:
        signal = "diverging"
        interp = ("Equity rallying while HY spreads widen - the stock tape is "
                  "ignoring a credit warning. Late-cycle divergence.")
    elif diverging and not spreads_widening:
        signal = "diverging"
        interp = ("Equity selling off while HY spreads tighten - credit is "
                  "shrugging off the equity drawdown. Watch for mean reversion.")
    elif not equity_up:
        signal = "confirming"
        interp = ("Spreads widening and equity falling together - credit and "
                  "equity confirming a risk-off move.")
    else:
        signal = "confirming"
        interp = ("Spreads tightening and equity rising together - credit and "
                  "equity confirming a risk-on move.")

    return {
        "hy_spread_change_bps_1m": round(hy_chg_bps, 1),
        "equity_return_pct_1m": round(eq_ret_pct, 2),
        "signal": signal,
        "diverging": diverging,
        "interpretation": interp,
        "data_mode": mode,
    }


def _window_change_bps(points: list[dict]) -> float | None:
    """Change in a FRED OAS series (percent) over the window, expressed in bps."""
    valid = [p for p in (points or []) if p.get("value") is not None]
    if len(valid) < 2:
        return None
    try:
        first = float(valid[0]["value"])
        last = float(valid[-1]["value"])
    except (TypeError, ValueError):
        return None
    return (last - first) * 100.0      # percent -> bps


def _window_return_pct(points: list[dict]) -> float | None:
    valid = [p for p in (points or []) if p.get("value") is not None]
    if len(valid) < 2:
        return None
    try:
        first = float(valid[0]["value"])
        last = float(valid[-1]["value"])
    except (TypeError, ValueError):
        return None
    if first <= 0:
        return None
    return (last - first) / first * 100.0


# ── Anchors ──────────────────────────────────────────────────────────────────

def _anchors() -> tuple[float, float, str, list[dict]]:
    """Return (ig_5y_bps, hy_5y_bps, data_mode, hy_points).

    Live anchors come from FRED ICE BofA OAS (values are in percent -> *100 for
    bps). Either leg missing falls back to its sample level; data_mode is "live"
    only when both legs were sourced live.
    """
    ig_pts: list[dict] = []
    hy_pts: list[dict] = []
    try:
        ig_pts = macro_data.fetch_series(IG_FRED_ID, 35)
    except Exception as exc:                              # never raise
        log.warning("IG OAS fetch failed: %s", exc)
    try:
        hy_pts = macro_data.fetch_series(HY_FRED_ID, 35)
    except Exception as exc:
        log.warning("HY OAS fetch failed: %s", exc)

    ig_live = _latest_value(ig_pts)
    hy_live = _latest_value(hy_pts)

    ig_5y = ig_live * 100.0 if ig_live is not None else SAMPLE_IG_5Y_BPS
    hy_5y = hy_live * 100.0 if hy_live is not None else SAMPLE_HY_5Y_BPS
    data_mode = "live" if (ig_live is not None and hy_live is not None) else "sample"
    return round(ig_5y, 1), round(hy_5y, 1), data_mode, hy_pts


# ── Public API ───────────────────────────────────────────────────────────────

def credit_curves() -> dict:
    """IG/HY OAS term structures + sample issuer CDS curves + divergence read."""
    try:
        ig_5y, hy_5y, data_mode, hy_pts = _anchors()

        ig_curve = _oas_curve(ig_5y, IG_SHAPE, "ig_master_oas")
        hy_curve = _oas_curve(hy_5y, HY_SHAPE, "hy_master_oas")

        issuers: list[dict] = []
        for iss in ISSUERS:
            curve = _issuer_curve(iss)
            issuers.append({
                "name": iss["name"],
                "ticker": iss["ticker"],
                "rating": iss["rating"],
                "sector": iss["sector"],
                "spread_5y_bps": _spread_at(curve, 5),
                "pd_5y_pct": next((c["pd_pct"] for c in curve if c["tenor"] == 5), None),
                "cds": curve,
            })

        divergence = _divergence(hy_pts)

        source = "FRED ICE BofA OAS + model" if data_mode == "live" else "sample"
        return {
            "ig_curve": ig_curve,
            "hy_curve": hy_curve,
            "ig_5y_bps": ig_5y,
            "hy_5y_bps": hy_5y,
            "ig_hy_spread_bps": round(hy_5y - ig_5y, 1),
            "recovery_rate": RECOVERY,
            "tenors": TENORS,
            "issuers": issuers,
            "divergence": divergence,
            "data_mode": data_mode,
            "as_of": _now_iso(),
            "source": source,
        }
    except Exception as exc:                              # belt-and-suspenders
        log.warning("credit_curves failed, serving full sample: %s", exc)
        return _credit_curves_sample()


def issuer_credit(issuer: str) -> dict:
    """Per-issuer CDS drill-down. Matches by ticker or name (case-insensitive,
    substring); synthesizes a deterministic sample issuer when unmatched. Never
    raises."""
    try:
        match = _match_issuer(issuer)

        # Curve context for relative-value framing.
        ig_5y, hy_5y, anchor_mode, _ = _anchors()

        curve = _issuer_curve(match)
        spread_5y = _spread_at(curve, 5)
        pd_5y = next((c["pd_pct"] for c in curve if c["tenor"] == 5), None)

        data_mode = anchor_mode  # issuer CDS itself is always model/sample; the
        # relative-value anchors carry the live/sample status.
        source = "FRED ICE BofA OAS + model" if anchor_mode == "live" else "sample"

        return {
            "issuer": match["name"],
            "name": match["name"],
            "ticker": match["ticker"],
            "rating": match["rating"],
            "sector": match["sector"],
            "recovery_rate": RECOVERY,
            "cds": curve,
            "spread_5y_bps": spread_5y,
            "pd_5y_pct": pd_5y,
            "curve_shape": _curve_shape(curve),
            "vs_ig_5y_bps": round(spread_5y - ig_5y, 1) if spread_5y is not None else None,
            "vs_hy_5y_bps": round(spread_5y - hy_5y, 1) if spread_5y is not None else None,
            "interpretation": _issuer_commentary(match, spread_5y, ig_5y, hy_5y),
            "data_mode": data_mode,
            "as_of": _now_iso(),
            "source": source,
        }
    except Exception as exc:                              # never raise
        log.warning("issuer_credit(%s) failed, serving sample: %s", issuer, exc)
        return _issuer_credit_sample(issuer)


# ── Matching + commentary ────────────────────────────────────────────────────

def _match_issuer(issuer: str) -> dict:
    q = (issuer or "").strip().lower()
    if q:
        for iss in ISSUERS:
            if q == iss["ticker"].lower() or q == iss["name"].lower():
                return iss
        for iss in ISSUERS:
            if q in iss["name"].lower() or iss["ticker"].lower() in q:
                return iss
    # Unmatched: synthesize a deterministic sample issuer from the query.
    rng = np.random.default_rng(_seed(q or "unknown"))
    ratings = ["A", "BBB", "BB", "B"]
    rating = ratings[int(rng.integers(0, len(ratings)))]
    base_by_rating = {"A": 65.0, "BBB": 110.0, "BB": 210.0, "B": 410.0}
    label = (issuer or "Sample Issuer").strip().title() or "Sample Issuer"
    return {
        "name": label,
        "ticker": (issuer or "N/A").strip().upper()[:6],
        "rating": rating,
        "sector": "Diversified",
        "base_5y": base_by_rating[rating] + float(rng.uniform(-15, 15)),
    }


def _issuer_commentary(iss: dict, spread_5y: float | None, ig_5y: float, hy_5y: float) -> str:
    if spread_5y is None:
        return "Curve unavailable."
    name = iss["name"]
    if spread_5y <= ig_5y:
        return (f"{name} 5y CDS at {spread_5y:.0f}bps trades inside the IG index "
                f"({ig_5y:.0f}bps) - market treats it as a high-quality credit.")
    if spread_5y >= hy_5y:
        return (f"{name} 5y CDS at {spread_5y:.0f}bps trades wide of the HY index "
                f"({hy_5y:.0f}bps) - elevated default-risk pricing.")
    return (f"{name} 5y CDS at {spread_5y:.0f}bps sits between the IG "
            f"({ig_5y:.0f}bps) and HY ({hy_5y:.0f}bps) indices - crossover credit.")


# ── Deterministic full-sample fallbacks ──────────────────────────────────────

def _credit_curves_sample() -> dict:
    ig_curve = _oas_curve(SAMPLE_IG_5Y_BPS, IG_SHAPE, "ig_master_oas")
    hy_curve = _oas_curve(SAMPLE_HY_5Y_BPS, HY_SHAPE, "hy_master_oas")
    issuers: list[dict] = []
    for iss in ISSUERS:
        curve = _issuer_curve(iss)
        issuers.append({
            "name": iss["name"], "ticker": iss["ticker"], "rating": iss["rating"],
            "sector": iss["sector"], "spread_5y_bps": _spread_at(curve, 5),
            "pd_5y_pct": next((c["pd_pct"] for c in curve if c["tenor"] == 5), None),
            "cds": curve,
        })
    return {
        "ig_curve": ig_curve, "hy_curve": hy_curve,
        "ig_5y_bps": SAMPLE_IG_5Y_BPS, "hy_5y_bps": SAMPLE_HY_5Y_BPS,
        "ig_hy_spread_bps": round(SAMPLE_HY_5Y_BPS - SAMPLE_IG_5Y_BPS, 1),
        "recovery_rate": RECOVERY, "tenors": TENORS, "issuers": issuers,
        "divergence": _divergence([]),
        "data_mode": "sample", "as_of": _now_iso(), "source": "sample",
    }


def _issuer_credit_sample(issuer: str) -> dict:
    match = _match_issuer(issuer)
    curve = _issuer_curve(match)
    spread_5y = _spread_at(curve, 5)
    return {
        "issuer": match["name"], "name": match["name"], "ticker": match["ticker"],
        "rating": match["rating"], "sector": match["sector"], "recovery_rate": RECOVERY,
        "cds": curve, "spread_5y_bps": spread_5y,
        "pd_5y_pct": next((c["pd_pct"] for c in curve if c["tenor"] == 5), None),
        "curve_shape": _curve_shape(curve),
        "vs_ig_5y_bps": round(spread_5y - SAMPLE_IG_5Y_BPS, 1) if spread_5y is not None else None,
        "vs_hy_5y_bps": round(spread_5y - SAMPLE_HY_5Y_BPS, 1) if spread_5y is not None else None,
        "interpretation": _issuer_commentary(match, spread_5y, SAMPLE_IG_5Y_BPS, SAMPLE_HY_5Y_BPS),
        "data_mode": "sample", "as_of": _now_iso(), "source": "sample",
    }
