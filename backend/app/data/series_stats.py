"""Series statistics + transforms — Wave 5.

Every FRED series gets z-score, percentile, YoY/MoM/3m-annualized, and
linear-detrend transforms on demand. Used by the new MacroSeriesDetail
page and the heatmap.
"""
from __future__ import annotations

import logging
import math
from typing import Literal

from . import macro_data, fred_catalog

log = logging.getLogger(__name__)


Transform = Literal["level", "yoy", "mom", "mom_ann", "three_m_ann", "six_m_ann",
                    "log_diff", "z_score", "percentile", "detrend"]


def _values(series: list[dict]) -> list[float]:
    return [p["value"] for p in series if p["value"] is not None]


def _yoy(series: list[dict]) -> list[dict]:
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 13:
        return []
    return [
        {"date": pts[i]["date"], "value": (pts[i]["value"] / pts[i - 12]["value"] - 1.0) * 100.0}
        for i in range(12, len(pts))
        if pts[i - 12]["value"] not in (None, 0)
    ]


def _mom(series: list[dict]) -> list[dict]:
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 2:
        return []
    return [
        {"date": pts[i]["date"], "value": (pts[i]["value"] / pts[i - 1]["value"] - 1.0) * 100.0}
        for i in range(1, len(pts))
        if pts[i - 1]["value"] not in (None, 0)
    ]


def _annualized_window(series: list[dict], months: int) -> list[dict]:
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < months + 1:
        return []
    out = []
    for i in range(months, len(pts)):
        prev = pts[i - months]["value"]
        cur = pts[i]["value"]
        if prev is None or prev <= 0:
            continue
        out.append({"date": pts[i]["date"], "value": ((cur / prev) ** (12.0 / months) - 1.0) * 100.0})
    return out


def _log_diff(series: list[dict]) -> list[dict]:
    pts = [p for p in series if p["value"] is not None and p["value"] > 0]
    pts.sort(key=lambda p: p["date"])
    return [
        {"date": pts[i]["date"], "value": math.log(pts[i]["value"] / pts[i - 1]["value"])}
        for i in range(1, len(pts))
    ]


def _rolling_z(series: list[dict], window: int = 60) -> list[dict]:
    """Rolling Z over `window` observations (default ~5y monthly)."""
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    out: list[dict] = []
    for i in range(window, len(pts)):
        win = [p["value"] for p in pts[i - window:i]]
        mu = sum(win) / window
        var = sum((v - mu) ** 2 for v in win) / window
        sd = math.sqrt(var) if var > 0 else 1.0
        out.append({"date": pts[i]["date"], "value": (pts[i]["value"] - mu) / sd})
    return out


def _percentile_rank(series: list[dict]) -> list[dict]:
    """Per-point percentile rank against the full history."""
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    out: list[dict] = []
    sorted_vals = sorted([p["value"] for p in pts])
    n = len(sorted_vals)
    if n == 0:
        return []
    for p in pts:
        # Position of p.value in sorted_vals via bisect-style; we go simple.
        rank = sum(1 for v in sorted_vals if v <= p["value"])
        out.append({"date": p["date"], "value": rank / n * 100.0})
    return out


def _detrend_linear(series: list[dict]) -> list[dict]:
    """Residuals from an OLS linear fit on time index."""
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    n = len(pts)
    if n < 12:
        return []
    xs = list(range(n))
    ys = [p["value"] for p in pts]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    den = sum((xs[i] - mx) ** 2 for i in range(n))
    if den == 0:
        return []
    slope = num / den
    intercept = my - slope * mx
    return [
        {"date": pts[i]["date"], "value": ys[i] - (slope * xs[i] + intercept)}
        for i in range(n)
    ]


# ----------- Public API -----------

def apply_transform(series: list[dict], transform: Transform) -> list[dict]:
    if transform == "level":
        return [p for p in series if p["value"] is not None]
    if transform == "yoy":
        return _yoy(series)
    if transform == "mom":
        return _mom(series)
    if transform == "mom_ann":
        return _annualized_window(series, months=1)
    if transform == "three_m_ann":
        return _annualized_window(series, months=3)
    if transform == "six_m_ann":
        return _annualized_window(series, months=6)
    if transform == "log_diff":
        return _log_diff(series)
    if transform == "z_score":
        return _rolling_z(series, window=60)
    if transform == "percentile":
        return _percentile_rank(series)
    if transform == "detrend":
        return _detrend_linear(series)
    raise ValueError(f"unknown transform: {transform}")


def descriptive_stats(series: list[dict]) -> dict:
    """Summary statistics: count, min, max, mean, median, std, last, 1y high/low,
    z-score vs trailing 5y."""
    vals = _values(series)
    if not vals:
        return {"count": 0}
    vals_sorted = sorted(vals)
    n = len(vals_sorted)
    mu = sum(vals) / n
    var = sum((v - mu) ** 2 for v in vals) / n
    sd = math.sqrt(var)
    median = vals_sorted[n // 2] if n % 2 == 1 else (vals_sorted[n // 2 - 1] + vals_sorted[n // 2]) / 2

    # Pull 1y high/low if dated points exist
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    last = pts[-1] if pts else None

    # Z vs last 60 (≈5y for monthly)
    z = None
    if n >= 24:
        recent = vals[-min(60, n):]
        rmu = sum(recent) / len(recent)
        rvar = sum((v - rmu) ** 2 for v in recent) / len(recent)
        rsd = math.sqrt(rvar) if rvar > 0 else 1.0
        z = (vals[-1] - rmu) / rsd

    # Percentile of last value vs full history
    last_v = vals[-1]
    rank = sum(1 for v in vals_sorted if v <= last_v)
    pct = rank / n * 100.0

    return {
        "count":      n,
        "min":        vals_sorted[0],
        "max":        vals_sorted[-1],
        "mean":       round(mu, 4),
        "median":     round(median, 4),
        "std":        round(sd, 4),
        "last":       last_v,
        "last_date":  last["date"] if last else None,
        "z_5y":       None if z is None else round(z, 3),
        "percentile": round(pct, 1),
    }


def get_series_with_stats(series_id: str, *, transform: Transform = "level",
                          years: int = 20) -> dict:
    """Fetch a FRED series, apply a transform, return points + stats + meta."""
    days = years * 365 + 60
    raw = macro_data.fetch_series(series_id, days=days)
    points = apply_transform(raw, transform)
    stats = descriptive_stats(points)

    meta = fred_catalog.series_by_id(series_id)
    return {
        "series_id":  series_id,
        "transform":  transform,
        "label":      meta.label if meta else series_id,
        "unit":       meta.unit if meta else "",
        "frequency":  meta.frequency if meta else "",
        "note":       meta.note if meta else "",
        "points":     points,
        "stats":      stats,
    }


# ----------- Catalog-wide heatmap -----------

def heatmap_payload(*, transform: Transform = "z_score") -> dict:
    """For every series in the catalog, return its current value + z-score
    or transform-of-interest. Used by MacroHeatmap.tsx."""
    tiles: list[dict] = []
    for s in fred_catalog.all_series():
        try:
            data = get_series_with_stats(s.id, transform="level", years=10)
            z_pts = apply_transform(data["points"], transform)
            z_latest = None
            if z_pts:
                z_latest = z_pts[-1]["value"]
            tiles.append({
                "id":         s.id,
                "label":      s.label,
                "unit":       s.unit,
                "category":   _category_of(s.id),
                "last":       data["stats"].get("last"),
                "last_date":  data["stats"].get("last_date"),
                "z":          None if z_latest is None else round(z_latest, 3),
                "percentile": data["stats"].get("percentile"),
            })
        except Exception as e:
            log.debug("heatmap tile failed for %s: %s", s.id, e)
            tiles.append({
                "id": s.id, "label": s.label, "category": _category_of(s.id),
                "last": None, "z": None, "percentile": None,
            })
    return {"tiles": tiles, "transform": transform}


def _category_of(series_id: str) -> str:
    for cat, items in fred_catalog.CATALOG.items():
        for s in items:
            if s.id == series_id:
                return cat
    return ""
