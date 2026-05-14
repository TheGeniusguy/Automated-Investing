"""Snapshot view of the macro catalog.

For each curated series we compute:
  - latest value + date
  - prior value + date
  - delta (absolute) and pct change
  - 6-month trail of values for the sparkline

Reads from `macro_series_history` (DuckDB) if data is already persisted;
otherwise falls back to a live fetch (which itself persists on success).
This keeps the explorer fast after the first warm-up of each series.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from ..db import engine
from . import fred_catalog, macro_data

log = logging.getLogger(__name__)


def _read_from_db(series_id: str, days: int = 365) -> list[dict]:
    cutoff = (datetime.utcnow().date() - timedelta(days=days)).isoformat()
    rows = engine.fetchall(
        """
        SELECT date, value
        FROM macro_series_history
        WHERE series_id = ? AND date >= ?
        ORDER BY date ASC
        """,
        [series_id, cutoff],
    )
    return [{"date": str(r[0]), "value": r[1]} for r in rows if r[1] is not None]


def _ensure_series(series_id: str, *, days: int = 365) -> list[dict]:
    """DB-first, live-fallback (which persists). Returns points list."""
    points = _read_from_db(series_id, days=days)
    if points:
        return points
    # Trigger a live fetch, which also persists via _persist_macro_series.
    points = macro_data.fetch_series(series_id, days=days)
    return [p for p in points if p.get("value") is not None]


def _delta_pct(latest: float, prior: float) -> float | None:
    if prior is None or prior == 0:
        return None
    return (latest - prior) / abs(prior)


def snapshot_series(series_id: str, *, days: int = 365) -> dict:
    """Compute the snapshot tile payload for one series."""
    meta = fred_catalog.series_by_id(series_id)
    points = _ensure_series(series_id, days=days)
    out: dict = {
        "id":         series_id,
        "label":      meta.label if meta else series_id,
        "unit":       meta.unit if meta else "",
        "frequency":  meta.frequency if meta else "",
        "note":       meta.note if meta else "",
        "category":   _category_of(series_id),
        "latest":     None,
        "latest_date": None,
        "prior":      None,
        "prior_date": None,
        "delta_abs":  None,
        "delta_pct":  None,
        "min_1y":     None,
        "max_1y":     None,
        "trail":      [],
    }
    if not points:
        return out
    latest_p = points[-1]
    prior_p  = points[-2] if len(points) >= 2 else None
    out["latest"]      = latest_p["value"]
    out["latest_date"] = latest_p["date"]
    if prior_p:
        out["prior"]      = prior_p["value"]
        out["prior_date"] = prior_p["date"]
        out["delta_abs"]  = (latest_p["value"] - prior_p["value"]) if (latest_p["value"] is not None and prior_p["value"] is not None) else None
        out["delta_pct"]  = _delta_pct(latest_p["value"], prior_p["value"])

    values = [p["value"] for p in points if p["value"] is not None]
    if values:
        out["min_1y"] = min(values)
        out["max_1y"] = max(values)

    # Trail: downsample to ~50 points so the sparkline stays cheap
    if len(points) > 60:
        step = len(points) // 60
        trail = points[::step]
        if trail[-1] != points[-1]:
            trail.append(points[-1])
    else:
        trail = points
    out["trail"] = trail
    return out


def _category_of(series_id: str) -> str:
    for cat, items in fred_catalog.CATALOG.items():
        for s in items:
            if s.id == series_id:
                return cat
    return ""


def snapshot_category(category: str, *, days: int = 365) -> dict:
    items = fred_catalog.CATALOG.get(category, [])
    tiles = [snapshot_series(s.id, days=days) for s in items]
    return {
        "category":       category,
        "category_label": fred_catalog.CATEGORY_LABEL.get(category, category),
        "tiles":          tiles,
    }


def snapshot_all_highlights(*, days: int = 365, per_cat: int = 3) -> list[dict]:
    """Top-N highlight tiles across every category — for the dashboard hero."""
    out: list[dict] = []
    for cat in fred_catalog.CATEGORY_ORDER:
        items = fred_catalog.CATALOG.get(cat, [])[:per_cat]
        for s in items:
            out.append(snapshot_series(s.id, days=days))
    return out
