"""Inflation breakdown — Wave 5.

The inflation panel synthesizes:

  - Headline + core CPI, headline + core PCE, Sticky CPI
  - Multiple momentum windows per series: YoY, MoM annualized, 3m annualized,
    6m annualized (the Fed's preferred "trimmed" view)
  - Market-implied inflation expectations: 5Y, 10Y, 5Y5Y forward breakevens
  - U-Mich + Cleveland Fed 1Y survey-based expectations
  - PPI for upstream price pressure
  - A composite "inflation regime" classification

Everything reads from FRED via `macro_data.fetch_series`.
"""
from __future__ import annotations

import logging
from datetime import datetime

from . import macro_data

log = logging.getLogger(__name__)


PRICE_SERIES = [
    # (FRED ID, label, kind: "index" | "rate")
    ("CPIAUCSL",            "CPI Headline",     "index"),
    ("CPILFESL",            "CPI Core",         "index"),
    ("PCEPI",               "PCE Headline",     "index"),
    ("PCEPILFE",            "PCE Core",         "index"),
    ("STICKCPIM157SFRBATL", "Sticky CPI",       "rate"),   # already YoY
    ("PPIACO",              "PPI All Commod.",  "index"),
    ("PPIFIS",              "PPI Final Demand", "index"),
]


EXPECTATIONS_SERIES = [
    ("T5YIE",     "5Y Breakeven",        "%"),
    ("T10YIE",    "10Y Breakeven",       "%"),
    ("T5YIFR",    "5Y5Y Fwd Inflation",  "%"),
    ("MICH",      "U-Mich 1Y Survey",    "%"),
    ("EXPINF1YR", "Cleveland Fed 1Y",    "%"),
]


def _index_to_yoy(points: list[dict]) -> list[dict]:
    """Index → YoY % change. Aligns by month index (12-period lag)."""
    if len(points) < 13:
        return []
    out: list[dict] = []
    for i in range(12, len(points)):
        p_now = points[i]
        p_prev = points[i - 12]
        if p_now["value"] is None or p_prev["value"] is None or p_prev["value"] == 0:
            continue
        yoy = (p_now["value"] / p_prev["value"] - 1.0) * 100.0
        out.append({"date": p_now["date"], "value": yoy})
    return out


def _index_to_annualized(points: list[dict], months: int) -> list[dict]:
    """Index → annualized % change over `months` trailing months.

    annualized = (1 + delta) ^ (12/months) - 1
    """
    if len(points) < months + 1:
        return []
    out: list[dict] = []
    for i in range(months, len(points)):
        p_now = points[i]
        p_prev = points[i - months]
        if p_now["value"] is None or p_prev["value"] is None or p_prev["value"] <= 0:
            continue
        ratio = p_now["value"] / p_prev["value"]
        ann = (ratio ** (12.0 / months) - 1.0) * 100.0
        out.append({"date": p_now["date"], "value": ann})
    return out


def momentum(series_id: str, *, years: int = 5) -> dict:
    """Multi-window momentum payload for a single price-index series."""
    days = years * 365 + 400
    raw = macro_data.fetch_series(series_id, days=days)
    raw = [p for p in raw if p["value"] is not None]
    raw.sort(key=lambda p: p["date"])

    # Sticky CPI is already a % YoY rate, not an index. Treat differently.
    is_rate = next((kind == "rate" for sid, _, kind in PRICE_SERIES if sid == series_id), False)

    if is_rate:
        yoy = raw[-(years * 12):]  # use the published series directly
        mom_ann = []
        three_m = []
        six_m = []
    else:
        yoy     = _index_to_yoy(raw)
        mom_ann = _index_to_annualized(raw, months=1)
        three_m = _index_to_annualized(raw, months=3)
        six_m   = _index_to_annualized(raw, months=6)

    return {
        "series_id":      series_id,
        "yoy":            yoy[-(years * 12):],
        "mom_annualized": mom_ann[-(years * 12):],
        "three_m_ann":    three_m[-(years * 12):],
        "six_m_ann":      six_m[-(years * 12):],
        "is_rate":        is_rate,
    }


# ----------- Composite "inflation regime" -----------

def _classify_inflation(headline_yoy: float | None, core_yoy: float | None,
                        three_m_ann: float | None) -> dict:
    """Classify the current inflation regime based on Core PCE + momentum."""
    if core_yoy is None or three_m_ann is None:
        return {"label": "unknown", "summary": "Insufficient inflation data."}

    # Pin to Core PCE (Fed's mandate target = 2.0% YoY)
    above_target = core_yoy - 2.0
    accelerating = three_m_ann > core_yoy

    if core_yoy >= 4.0:
        label = "hot_accelerating" if accelerating else "hot_decelerating"
        summary = f"Core inflation hot at {core_yoy:.2f}% YoY ({'rising' if accelerating else 'falling'} momentum)"
    elif core_yoy >= 2.5:
        label = "above_target_accelerating" if accelerating else "above_target_disinflating"
        summary = f"Core inflation above 2% target ({core_yoy:.2f}% YoY, {three_m_ann:.2f}% 3m annualized)"
    elif core_yoy >= 1.5:
        label = "near_target"
        summary = f"Core inflation near 2% target ({core_yoy:.2f}% YoY)"
    elif core_yoy >= 0.5:
        label = "below_target"
        summary = f"Core inflation below target ({core_yoy:.2f}% YoY)"
    else:
        label = "disinflation"
        summary = f"Core inflation very low — disinflation risk ({core_yoy:.2f}% YoY)"

    return {
        "label":           label,
        "summary":         summary,
        "above_target_pp": round(above_target, 2),
        "accelerating":    accelerating,
    }


def _latest_or_none(points: list[dict]) -> float | None:
    for p in reversed(points):
        if p.get("value") is not None:
            return p["value"]
    return None


# ----------- Real-vs-expected (TIPS decomposition) -----------

def real_yield_decomposition(*, days: int = 365 * 5) -> dict:
    """Decompose 10Y nominal into real (TIPS) + breakeven inflation, plot all 3.

    Useful to see whether moves in 10Y come from real growth re-pricing
    or from changing inflation expectations.
    """
    nominal = macro_data.fetch_series("DGS10", days=days)
    real    = macro_data.fetch_series("DFII10", days=days)
    be      = macro_data.fetch_series("T10YIE", days=days)

    return {
        "nominal":   [p for p in nominal if p["value"] is not None],
        "real":      [p for p in real if p["value"] is not None],
        "breakeven": [p for p in be if p["value"] is not None],
    }


# ----------- Inflation curve: term structure of expectations -----------

def inflation_expectations_curve() -> dict:
    """Snapshot of the breakeven curve plus survey-based 1Y expectations."""
    out_points: list[dict] = []
    for sid, label, unit in EXPECTATIONS_SERIES:
        pts = macro_data.fetch_series(sid, days=180)
        v = _latest_or_none(pts)
        latest_date = pts[-1]["date"] if pts else None
        out_points.append({
            "id": sid, "label": label, "unit": unit,
            "value": v, "date": latest_date,
        })
    return {"points": out_points}


# ----------- Top-level dashboard payload -----------

def dashboard() -> dict:
    """Single payload for the Inflation panel."""
    series_momenta = [
        {**momentum(sid, years=5), "label": label, "is_rate": (kind == "rate")}
        for sid, label, kind in PRICE_SERIES
    ]

    # Pull latest Core PCE values for the classification call
    core_pce_mo = next((s for s in series_momenta if s["series_id"] == "PCEPILFE"), None)
    headline_pce = next((s for s in series_momenta if s["series_id"] == "PCEPI"), None)

    core_yoy = _latest_or_none(core_pce_mo["yoy"]) if core_pce_mo else None
    headline_yoy = _latest_or_none(headline_pce["yoy"]) if headline_pce else None
    core_3m = _latest_or_none(core_pce_mo["three_m_ann"]) if core_pce_mo else None

    classification = _classify_inflation(headline_yoy, core_yoy, core_3m)

    return {
        "series":          series_momenta,
        "expectations":    inflation_expectations_curve(),
        "decomposition":   real_yield_decomposition(days=365 * 5),
        "classification":  classification,
        "summary": {
            "core_pce_yoy":     None if core_yoy is None else round(core_yoy, 2),
            "headline_pce_yoy": None if headline_yoy is None else round(headline_yoy, 2),
            "core_pce_3m_ann":  None if core_3m is None else round(core_3m, 2),
            "fed_target":       2.0,
        },
    }
