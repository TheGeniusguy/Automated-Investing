"""Yield curve analytics — Wave 5.

The US Treasury curve is *the* macro signal. This module wraps the 11
canonical maturities (1mo through 30yr) plus the most-watched derived
spreads, and produces:

  - the current full curve (and an arbitrary historical curve)
  - all key spreads (T10Y2Y, T10Y3M, FF-10Y, etc.) over time
  - butterflies (2-5-10, 5-10-30) for cheapness/richness reads
  - the NY Fed / Estrella-Mishkin recession probability model
  - a term-premium proxy from the 10Y-vs-TIPS decomposition

All data flows through the existing FRED fetcher with stale-fallback.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime
from typing import Iterable

from . import macro_data

log = logging.getLogger(__name__)


# Ordered short → long; the order is meaningful for curve charts.
MATURITIES: list[tuple[str, str, float]] = [
    # (FRED ID, label, years for term-axis plotting)
    ("DGS1MO", "1M",  1 / 12),
    ("DGS3MO", "3M",  3 / 12),
    ("DGS6MO", "6M",  6 / 12),
    ("DGS1",   "1Y",  1.0),
    ("DGS2",   "2Y",  2.0),
    ("DGS5",   "5Y",  5.0),
    ("DGS7",   "7Y",  7.0),
    ("DGS10",  "10Y", 10.0),
    ("DGS20",  "20Y", 20.0),
    ("DGS30",  "30Y", 30.0),
]

# Real-yield (TIPS) maturities — used for inflation-adjusted curve and term
# premium proxy. Note FRED's `DFII*` series have shorter histories than DGSx.
REAL_MATURITIES: list[tuple[str, str, float]] = [
    ("DFII5",  "5Y",  5.0),
    ("DFII7",  "7Y",  7.0),
    ("DFII10", "10Y", 10.0),
    ("DFII20", "20Y", 20.0),
    ("DFII30", "30Y", 30.0),
]


# Most-watched spreads. (a, b) → spread = a - b.
SPREADS: list[tuple[str, str, str, str]] = [
    # id,              numerator, denominator, description
    ("T10Y2Y",         "DGS10",   "DGS2",      "10Y-2Y — classic recession curve"),
    ("T10Y3M",         "DGS10",   "DGS3MO",    "10Y-3M — NY Fed recession model"),
    ("T5Y2Y",          "DGS5",    "DGS2",      "5Y-2Y — belly slope"),
    ("T30Y10Y",        "DGS30",   "DGS10",     "30Y-10Y — long-end slope"),
    ("T30Y5Y",         "DGS30",   "DGS5",      "30Y-5Y — wing slope"),
    ("T10YFF",         "DGS10",   "DFF",       "10Y-Fed Funds — broad slope"),
    ("T2YFF",          "DGS2",    "DFF",       "2Y-Fed Funds — front-end pricing"),
]


# Butterfly: belly − (2 * wings_midpoint). Positive = belly cheap.
BUTTERFLIES: list[tuple[str, str, str, str, str]] = [
    # id,        wing1,   belly,   wing2,    description
    ("BF_2_5_10","DGS2",  "DGS5",  "DGS10",  "2-5-10 butterfly (belly = 5Y)"),
    ("BF_5_10_30","DGS5", "DGS10", "DGS30",  "5-10-30 butterfly (belly = 10Y)"),
]


# ----------- Snapshot a single curve -----------

def current_curve(*, real: bool = False, days: int = 30) -> dict:
    """Latest available curve, with prior-day shift per maturity.

    Returns: {"date", "prior_date", "points": [{maturity, years, yield, prior, delta}], "kind"}
    """
    mats = REAL_MATURITIES if real else MATURITIES
    pulled = {m_id: macro_data.fetch_series(m_id, days=days) for m_id, _, _ in mats}

    # Find the latest common date across all maturities; fall back to most
    # recent per-series if the intersection is empty.
    all_dates = [{p["date"] for p in pts if p["value"] is not None} for pts in pulled.values()]
    common = sorted(set.intersection(*all_dates)) if all(all_dates) else []
    if common:
        latest_date = common[-1]
        prior_date = common[-2] if len(common) > 1 else None
    else:
        latest_date = None
        prior_date = None

    points: list[dict] = []
    for m_id, label, yrs in mats:
        series = pulled.get(m_id, [])
        lookup = {p["date"]: p["value"] for p in series if p["value"] is not None}
        y_now = lookup.get(latest_date) if latest_date else (
            macro_data.latest_value(series) if series else None
        )
        y_prior = lookup.get(prior_date) if prior_date else None
        delta = (y_now - y_prior) if (y_now is not None and y_prior is not None) else None
        points.append({
            "maturity": label,
            "years":    yrs,
            "yield":    y_now,
            "prior":    y_prior,
            "delta_bps": (delta * 100.0) if delta is not None else None,
            "fred_id":  m_id,
        })

    return {
        "date":       latest_date,
        "prior_date": prior_date,
        "kind":       "real" if real else "nominal",
        "points":     points,
    }


# ----------- Historical curves: snapshot at any date -----------

def historical_curve(target_date: str, *, real: bool = False, days: int = 365 * 3) -> dict:
    """Curve as of `target_date` (YYYY-MM-DD). Picks the closest available date."""
    mats = REAL_MATURITIES if real else MATURITIES
    target = datetime.strptime(target_date, "%Y-%m-%d").date()

    points: list[dict] = []
    actual_date: str | None = None
    for m_id, label, yrs in mats:
        series = macro_data.fetch_series(m_id, days=days)
        # Pick the latest observation on-or-before the target.
        chosen = None
        for p in series:
            if p["value"] is None:
                continue
            d = datetime.strptime(p["date"], "%Y-%m-%d").date()
            if d <= target:
                chosen = p
            else:
                break
        if chosen:
            actual_date = max(actual_date or "", chosen["date"])
            points.append({"maturity": label, "years": yrs, "yield": chosen["value"], "fred_id": m_id})
        else:
            points.append({"maturity": label, "years": yrs, "yield": None, "fred_id": m_id})

    return {"date": actual_date, "kind": "real" if real else "nominal", "points": points}


# ----------- Spreads (single series, derived) -----------

def spread_series(spread_id: str, *, days: int = 365) -> dict:
    """Compute a derived spread series by date-aligning the two FRED series."""
    meta = next((s for s in SPREADS if s[0] == spread_id), None)
    if not meta:
        raise ValueError(f"unknown spread: {spread_id}")
    _, num_id, den_id, desc = meta
    num = macro_data.fetch_series(num_id, days=days)
    den = macro_data.fetch_series(den_id, days=days)

    return _align_diff(num, den, label=spread_id, description=desc)


def butterfly_series(bf_id: str, *, days: int = 365) -> dict:
    """Butterfly = belly − (wing1 + wing2)/2 in % (multiply by 100 for bps in UI)."""
    meta = next((b for b in BUTTERFLIES if b[0] == bf_id), None)
    if not meta:
        raise ValueError(f"unknown butterfly: {bf_id}")
    _, w1_id, belly_id, w2_id, desc = meta
    w1 = macro_data.fetch_series(w1_id, days=days)
    belly = macro_data.fetch_series(belly_id, days=days)
    w2 = macro_data.fetch_series(w2_id, days=days)

    idx_w1 = {p["date"]: p["value"] for p in w1 if p["value"] is not None}
    idx_be = {p["date"]: p["value"] for p in belly if p["value"] is not None}
    idx_w2 = {p["date"]: p["value"] for p in w2 if p["value"] is not None}

    common = sorted(set(idx_w1) & set(idx_be) & set(idx_w2))
    points: list[dict] = []
    for d in common:
        v = idx_be[d] - 0.5 * (idx_w1[d] + idx_w2[d])
        points.append({"date": d, "value": v})

    return {"id": bf_id, "description": desc, "points": points}


def _align_diff(num: list[dict], den: list[dict], *, label: str, description: str) -> dict:
    idx_n = {p["date"]: p["value"] for p in num if p["value"] is not None}
    idx_d = {p["date"]: p["value"] for p in den if p["value"] is not None}
    common = sorted(set(idx_n) & set(idx_d))
    points = [{"date": d, "value": idx_n[d] - idx_d[d]} for d in common]
    return {"id": label, "description": description, "points": points}


# ----------- NY Fed Estrella-Mishkin recession probability -----------

# Probit coefficients from the published NY Fed model (10Y minus 3M spread):
#   prob_recession = N(-0.5454 + (-0.5934) * spread)
# Reference: https://www.newyorkfed.org/research/capital_markets/ycfaq
# We approximate the standard normal CDF via erf.
_NYFED_INTERCEPT = -0.5454
_NYFED_SLOPE = -0.5934


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


def recession_probability_history(*, days: int = 365 * 30) -> list[dict]:
    """NY Fed recession probability as a daily series.

    The model uses the *monthly average* of the 10Y-3M spread; we approximate
    by smoothing the daily spread over a trailing 21-day window.
    """
    series = spread_series("T10Y3M", days=days)["points"]
    window = 21
    out: list[dict] = []
    buf: list[float] = []
    for p in series:
        buf.append(p["value"])
        if len(buf) > window:
            buf.pop(0)
        if len(buf) == window:
            avg = sum(buf) / window
            prob = _norm_cdf(_NYFED_INTERCEPT + _NYFED_SLOPE * avg)
            out.append({"date": p["date"], "spread": avg, "probability": prob})
    return out


def recession_probability_current() -> dict:
    hist = recession_probability_history(days=180)
    if not hist:
        return {"date": None, "spread": None, "probability": None, "summary": "Insufficient data"}
    latest = hist[-1]
    prob = latest["probability"]
    summary = _prob_summary(prob)
    return {**latest, "summary": summary, "model": "NY Fed Estrella-Mishkin (10Y-3M probit)"}


def _prob_summary(p: float | None) -> str:
    if p is None:
        return "—"
    if p >= 0.70:
        return "Recession highly likely within 12 months"
    if p >= 0.40:
        return "Material recession risk within 12 months"
    if p >= 0.20:
        return "Elevated recession risk"
    if p >= 0.10:
        return "Slightly elevated recession risk"
    return "Recession risk subdued by curve model"


# ----------- Curve shape summary -----------

def shape_summary(curve: dict) -> dict:
    """Classify the curve as normal / flat / inverted / steep, with metrics."""
    pts = {p["maturity"]: p["yield"] for p in curve["points"]}
    y2 = pts.get("2Y")
    y10 = pts.get("10Y")
    y30 = pts.get("30Y")
    y3m = pts.get("3M")

    spread_2_10 = (y10 - y2) if (y2 is not None and y10 is not None) else None
    spread_3m_10y = (y10 - y3m) if (y3m is not None and y10 is not None) else None
    spread_10_30 = (y30 - y10) if (y10 is not None and y30 is not None) else None

    classification = _classify_curve(spread_2_10, spread_3m_10y)

    return {
        "spread_2_10_bps":  None if spread_2_10 is None else round(spread_2_10 * 100, 1),
        "spread_3m_10y_bps": None if spread_3m_10y is None else round(spread_3m_10y * 100, 1),
        "spread_10_30_bps":  None if spread_10_30 is None else round(spread_10_30 * 100, 1),
        "classification": classification,
    }


def _classify_curve(s_2_10: float | None, s_3m_10y: float | None) -> str:
    if s_2_10 is None or s_3m_10y is None:
        return "unknown"
    if s_2_10 < -0.10 or s_3m_10y < -0.10:
        return "deeply inverted"
    if s_2_10 < 0 or s_3m_10y < 0:
        return "inverted"
    if s_2_10 < 0.20 and s_3m_10y < 0.20:
        return "flat"
    if s_2_10 > 1.5 or s_3m_10y > 2.0:
        return "steep"
    return "normal"


# ----------- Term premium proxy: 10Y nominal - 10Y TIPS - 10Y breakeven -----------
# In theory: nominal = real + expected inflation + term premium
# Practical proxy: term_premium ≈ nominal - real - market_inflation_expectations
# where market_inflation_expectations = breakeven (T10YIE).

def term_premium_proxy(*, days: int = 365 * 5) -> dict:
    """Compute a 10Y term-premium proxy: DGS10 − DFII10 − T10YIE.

    When breakevens correctly price expected inflation, the residual is the
    term premium investors demand for holding duration. This is a *proxy* —
    the rigorous ACM model needs full curve regressions; we settle for
    transparency.
    """
    nominal = macro_data.fetch_series("DGS10", days=days)
    real    = macro_data.fetch_series("DFII10", days=days)
    becp    = macro_data.fetch_series("T10YIE", days=days)

    idx_n = {p["date"]: p["value"] for p in nominal if p["value"] is not None}
    idx_r = {p["date"]: p["value"] for p in real if p["value"] is not None}
    idx_b = {p["date"]: p["value"] for p in becp if p["value"] is not None}
    common = sorted(set(idx_n) & set(idx_r) & set(idx_b))

    points: list[dict] = []
    for d in common:
        # term premium = nominal − real − breakeven inflation
        tp = idx_n[d] - idx_r[d] - idx_b[d]
        points.append({"date": d, "value": tp})

    summary = None
    if points:
        latest = points[-1]["value"]
        if latest > 0.30:
            summary = "Elevated term premium — duration investors demand extra compensation"
        elif latest > 0.10:
            summary = "Modest positive term premium"
        elif latest > -0.10:
            summary = "Term premium near zero"
        else:
            summary = "Negative term premium — duration richly priced vs real + inflation"

    return {
        "points":  points,
        "summary": summary,
        "method":  "DGS10 − DFII10 − T10YIE",
    }


# ----------- Top-level dashboard payload -----------

def dashboard() -> dict:
    """Single endpoint payload for the Yield Curve panel."""
    curve = current_curve()
    shape = shape_summary(curve)
    spreads = {sid: spread_series(sid, days=365 * 5)["points"][-260:]
               for sid, *_ in SPREADS if sid not in ("T10YFF", "T2YFF") or True}
    bf = {bid: butterfly_series(bid, days=365 * 2)["points"][-260:]
          for bid, *_ in BUTTERFLIES}
    rp = recession_probability_current()
    rh = recession_probability_history(days=365 * 30)
    tp = term_premium_proxy(days=365 * 5)

    return {
        "curve":      curve,
        "real_curve": current_curve(real=True),
        "shape":      shape,
        "spreads":    [
            {"id": sid, "label": sid, "description": desc, "points": spreads.get(sid, [])}
            for sid, _, _, desc in SPREADS
        ],
        "butterflies": [
            {"id": bid, "description": desc, "points": bf.get(bid, [])}
            for bid, _, _, _, desc in BUTTERFLIES
        ],
        "recession": {
            "current": rp,
            "history": rh[-(365 * 10):],  # last 10 years for the dial chart
        },
        "term_premium": tp,
        "maturities": [{"id": m, "label": l, "years": y} for m, l, y in MATURITIES],
    }


# Convenience: list known IDs
def all_spread_ids() -> list[str]:
    return [s[0] for s in SPREADS]


def all_butterfly_ids() -> list[str]:
    return [b[0] for b in BUTTERFLIES]
