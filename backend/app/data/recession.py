"""Recession indicators composite — Wave 5.

Pulls together the canonical recession signals into one panel:

  - Sahm Rule (UNRATE 3m MA − trailing 12m low) — triggers at +0.50
  - NY Fed Estrella-Mishkin 10Y-3M probit (computed in yield_curve.py)
  - Conference Board LEI proxy (ICSA, PERMIT, NEWORDER, SP500, T10Y3M)
  - Initial-claims YoY momentum (rising claims = labor weakness)
  - Real Retail Sales YoY (consumer-spending pulse)
  - Industrial Production YoY (real activity)
  - Composite Z-score that weights each signal

The composite is intentionally simple — equal-weight Z-scores of the
above series — because complex regressions on a single trader's screen
hide the inputs the user actually wants to see. We show the inputs.
"""
from __future__ import annotations

import logging
import math
from typing import Iterable

from . import macro_data, yield_curve

log = logging.getLogger(__name__)


# ----------- Helpers -----------

def _values(series: list[dict]) -> list[float]:
    return [p["value"] for p in series if p.get("value") is not None]


def _moving_average(values: list[float], window: int) -> list[float]:
    out: list[float] = []
    buf: list[float] = []
    for v in values:
        buf.append(v)
        if len(buf) > window:
            buf.pop(0)
        if len(buf) == window:
            out.append(sum(buf) / window)
    return out


def _zscore(latest: float, history: list[float]) -> float | None:
    if len(history) < 24:
        return None
    mu = sum(history) / len(history)
    var = sum((v - mu) ** 2 for v in history) / len(history)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    return (latest - mu) / sd


def _yoy_change(series: list[dict]) -> list[dict]:
    """For monthly series, simple 12-month YoY % change."""
    out: list[dict] = []
    pts = [p for p in series if p["value"] is not None]
    if len(pts) < 13:
        return []
    for i in range(12, len(pts)):
        prev = pts[i - 12]["value"]
        cur = pts[i]["value"]
        if prev is None or prev == 0:
            continue
        out.append({"date": pts[i]["date"], "value": (cur / prev - 1.0) * 100.0})
    return out


# ----------- Individual indicators -----------

def sahm_rule(*, years: int = 30) -> dict:
    """Sahm Rule: (3-month MA of UNRATE) − (trailing 12-month low of that MA)."""
    days = years * 365 + 400
    unrate = macro_data.fetch_series("UNRATE", days=days)
    pts = [p for p in unrate if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 16:
        return {"current": None, "triggered": False, "history": [], "summary": "Insufficient data"}

    mas = _moving_average([p["value"] for p in pts], window=3)
    aligned_dates = [p["date"] for p in pts[2:]]  # MA starts at index 2

    history: list[dict] = []
    for i in range(12, len(mas)):
        ma_now = mas[i]
        trailing_low = min(mas[i - 12:i])
        sahm_val = ma_now - trailing_low
        history.append({
            "date":     aligned_dates[i],
            "value":    sahm_val,
            "triggered": sahm_val >= 0.50,
        })

    if not history:
        return {"current": None, "triggered": False, "history": [], "summary": "Insufficient data"}

    latest = history[-1]
    summary = ("Sahm Rule TRIGGERED — recession threshold breached"
               if latest["triggered"] else
               f"Sahm Rule: {latest['value']:.2f}pp (threshold 0.50)")

    return {
        "current":   latest["value"],
        "triggered": latest["triggered"],
        "history":   history,
        "summary":   summary,
        "threshold": 0.50,
    }


def claims_momentum(*, years: int = 10) -> dict:
    """4-week MA of initial claims, YoY change."""
    days = years * 365 + 60
    raw = macro_data.fetch_series("ICSA", days=days)
    pts = [p for p in raw if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 60:
        return {"current_yoy": None, "history": [], "summary": "Insufficient data"}

    mas = _moving_average([p["value"] for p in pts], window=4)
    aligned = [p["date"] for p in pts[3:]]

    # YoY % change of the smoothed claims
    history: list[dict] = []
    if len(mas) >= 53:
        for i in range(52, len(mas)):
            prev = mas[i - 52]
            cur = mas[i]
            if prev == 0:
                continue
            history.append({
                "date":  aligned[i],
                "ma":    cur,
                "value": (cur / prev - 1.0) * 100.0,
            })
    latest = history[-1] if history else None
    summary = ("—" if latest is None else
               f"Claims YoY: {latest['value']:+.1f}% ({'rising' if latest['value'] > 0 else 'falling'})")
    return {
        "current_yoy": latest["value"] if latest else None,
        "current_ma":  latest["ma"] if latest else None,
        "history":     history,
        "summary":     summary,
        "threshold":   15.0,  # YoY > 15% is historically a warning
    }


def lei_proxy(*, years: int = 30) -> dict:
    """Conference Board LEI proxy — a 5-component composite.

    We can't pull the actual Conference Board LEI (paywall), so we build a
    proxy from public components weighted similarly to the LEI:
      - Initial claims (inverted, weight 1)
      - Building permits (weight 1)
      - Mfg new orders (weight 1) — we use AMTMNO as proxy
      - S&P 500 (weight 1)
      - 10Y-3M spread (weight 1)

    Each is z-scored over 10 years and combined.
    """
    days = years * 365 + 60
    series_map = {
        "claims_inv":    [{"date": p["date"], "value": -p["value"] if p["value"] is not None else None}
                          for p in macro_data.fetch_series("ICSA", days=days)],
        "permits":       macro_data.fetch_series("PERMIT", days=days),
        "new_orders":    macro_data.fetch_series("AMTMNO", days=days),
        "spx":           macro_data.fetch_series("^GSPC", days=days),
        "yc_3m_10y":     yield_curve.spread_series("T10Y3M", days=days)["points"],
    }

    # Align by date (intersection of valid observations)
    date_sets = []
    for s in series_map.values():
        date_sets.append({p["date"] for p in s if p["value"] is not None})
    if not date_sets:
        return {"history": [], "current": None, "summary": "Insufficient data"}
    common = sorted(set.intersection(*date_sets))
    if len(common) < 60:
        # Try monthly downsample: take last day of each month from common
        return {"history": [], "current": None, "summary": "Insufficient overlap across components"}

    # Build per-component z-scores using the full history we have
    def _zify(points: list[dict]) -> dict[str, float]:
        vals = [p["value"] for p in points if p["value"] is not None]
        mu = sum(vals) / len(vals)
        var = sum((v - mu) ** 2 for v in vals) / len(vals)
        sd = math.sqrt(var) if var > 0 else 1.0
        return {p["date"]: (p["value"] - mu) / sd for p in points if p["value"] is not None}

    z_maps = {k: _zify(v) for k, v in series_map.items()}

    composite: list[dict] = []
    for d in common:
        try:
            z = (
                z_maps["claims_inv"][d]
                + z_maps["permits"][d]
                + z_maps["new_orders"][d]
                + z_maps["spx"][d]
                + z_maps["yc_3m_10y"][d]
            ) / 5.0
        except KeyError:
            continue
        composite.append({"date": d, "value": z})

    latest = composite[-1] if composite else None
    summary = ("—" if latest is None else
               f"LEI proxy z-score: {latest['value']:+.2f} ({'expanding' if latest['value'] > 0 else 'contracting'})")
    return {
        "current": latest["value"] if latest else None,
        "history": composite[-(years * 60):],  # ~weekly cadence after intersection
        "summary": summary,
    }


def industrial_production_yoy(*, years: int = 20) -> dict:
    days = years * 365 + 60
    raw = macro_data.fetch_series("INDPRO", days=days)
    yoy = _yoy_change(raw)
    latest = yoy[-1] if yoy else None
    summary = ("—" if latest is None else
               f"IP YoY: {latest['value']:+.2f}%")
    return {"current": latest["value"] if latest else None, "history": yoy, "summary": summary}


def real_retail_yoy(*, years: int = 20) -> dict:
    """Use RSAFS (advance retail sales) deflated by CPIAUCSL."""
    days = years * 365 + 60
    nominal = macro_data.fetch_series("RSAFS", days=days)
    cpi     = macro_data.fetch_series("CPIAUCSL", days=days)
    idx_cpi = {p["date"]: p["value"] for p in cpi if p["value"] is not None}

    # Deflate
    real_series: list[dict] = []
    for p in nominal:
        if p["value"] is None or p["date"] not in idx_cpi:
            continue
        real_series.append({"date": p["date"], "value": p["value"] / idx_cpi[p["date"]]})

    yoy = _yoy_change(real_series)
    latest = yoy[-1] if yoy else None
    summary = ("—" if latest is None else f"Real Retail YoY: {latest['value']:+.2f}%")
    return {"current": latest["value"] if latest else None, "history": yoy, "summary": summary}


# ----------- Composite recession score -----------

def composite_score() -> dict:
    """Equal-weighted score across the 5 indicators.

    Each indicator is converted to a recession-pressure score in [0, 1]:
      - Sahm: max(0, min(1, value / 1.0))  — 1.0 saturates at 0.50 trigger ✕ 2
      - NY Fed: probability itself (already [0,1])
      - LEI proxy: max(0, -z / 2)  — negative z pushes up
      - Claims YoY: max(0, value / 30)
      - IP YoY: max(0, -value / 5)
    """
    sahm   = sahm_rule()
    nyfed  = yield_curve.recession_probability_current()
    lei    = lei_proxy()
    claims = claims_momentum()
    ip     = industrial_production_yoy()
    rrs    = real_retail_yoy()

    def _pressure(label: str, val: float | None, scale: float, invert: bool = False) -> dict:
        if val is None:
            return {"label": label, "value": val, "score": None}
        score = -val / scale if invert else val / scale
        score = max(0.0, min(1.0, score))
        return {"label": label, "value": val, "score": round(score, 3)}

    components = [
        _pressure("Sahm Rule (pp)",         sahm.get("current"),              scale=1.0),
        _pressure("NY Fed 12m prob",        nyfed.get("probability"),         scale=1.0),
        _pressure("LEI proxy z (inverted)", lei.get("current"),               scale=2.0, invert=True),
        _pressure("Claims YoY %",           claims.get("current_yoy"),        scale=30.0),
        _pressure("IP YoY (inverted) %",    ip.get("current"),                scale=5.0,  invert=True),
        _pressure("Real Retail YoY (inv) %",rrs.get("current"),               scale=5.0,  invert=True),
    ]

    scored = [c for c in components if c["score"] is not None]
    if not scored:
        composite = None
    else:
        composite = sum(c["score"] for c in scored) / len(scored)

    bucket = _composite_bucket(composite)

    return {
        "composite":  None if composite is None else round(composite, 3),
        "bucket":     bucket,
        "components": components,
    }


def _composite_bucket(score: float | None) -> str:
    if score is None:
        return "—"
    if score >= 0.70:
        return "Recession likely"
    if score >= 0.50:
        return "Recession risk elevated"
    if score >= 0.30:
        return "Cautionary"
    if score >= 0.15:
        return "Mild pressure"
    return "All clear"


# ----------- Top-level payload -----------

def dashboard() -> dict:
    return {
        "composite": composite_score(),
        "sahm":      sahm_rule(),
        "nyfed":     {
            "current": yield_curve.recession_probability_current(),
            "history": yield_curve.recession_probability_history(days=365 * 30),
        },
        "lei_proxy":      lei_proxy(),
        "claims":         claims_momentum(),
        "industrial":     industrial_production_yoy(),
        "real_retail":    real_retail_yoy(),
    }
