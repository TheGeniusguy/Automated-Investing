"""Cross-asset comparison engine.

Dispatches each investment spec to the right asset-class model, then builds a
UNIFIED comparison: a common monthly date axis (the union of every
investment's dates, forward-filled), each investment's equity normalized to
100 at its start, a metrics table aligned across investments, and a ranking by
annualized IRR.

Never raises — investments that error are kept (with their ``error`` field)
but excluded from the unified overlay and ranking.
"""
from __future__ import annotations

from typing import Optional

from . import custom, market, realestate

_DISPATCH = {
    "real_estate": realestate.model_real_estate,
    "market": market.model_market,
    "custom": custom.model_custom,
}


def _normalize_curve(monthly: list[dict]) -> list[tuple[str, float]]:
    """Return [(date, normalized_value)] with the first equity == 100."""
    points: list[tuple[str, float]] = []
    base: Optional[float] = None
    for row in monthly:
        eq = row.get("equity")
        d = row.get("date")
        if eq is None or d is None:
            continue
        if base is None:
            if eq == 0:
                base = 1e-9
            else:
                base = float(eq)
        points.append((d, round(float(eq) / base * 100.0, 4)))
    return points


def _forward_fill(curve: dict[str, float], all_dates: list[str]) -> list[Optional[float]]:
    """Project a {date: value} curve onto ``all_dates`` with forward fill.

    Dates before the curve starts are ``None`` (not yet invested); once a value
    is seen it is carried forward across gaps.
    """
    out: list[Optional[float]] = []
    last: Optional[float] = None
    for d in all_dates:
        if d in curve:
            last = curve[d]
        out.append(last)
    return out


def compare_investments(investments: list[dict]) -> dict:
    """Model and compare a heterogeneous list of investments.

    Each item: ``{"kind": "real_estate"|"market"|"custom", "label"?, "params": {...}}``.
    Returns ``{investments: [...], comparison: {...}}``. Never raises.
    """
    modeled: list[dict] = []

    for spec in investments or []:
        if not isinstance(spec, dict):
            modeled.append({"kind": "unknown", "error": "invalid investment spec"})
            continue
        kind = spec.get("kind")
        fn = _DISPATCH.get(kind)
        if fn is None:
            modeled.append(
                {"kind": kind or "unknown", "label": spec.get("label", "?"), "error": f"unknown kind: {kind}"}
            )
            continue
        params = dict(spec.get("params") or {})
        if "label" not in params and spec.get("label"):
            params["label"] = spec["label"]
        try:
            result = fn(params)
        except Exception as e:  # defensive — models already guard
            result = {"kind": kind, "label": params.get("label", "?"), "error": str(e)}

        # Attach a normalized equity curve for the overlay.
        if "error" not in result:
            result["normalized_curve"] = [
                {"date": d, "value": v} for d, v in _normalize_curve(result.get("monthly", []))
            ]
        modeled.append(result)

    valid = [m for m in modeled if "error" not in m and m.get("monthly")]

    # ── Unified date axis (union of all monthly dates) ──
    date_set: set[str] = set()
    for m in valid:
        for row in m["monthly"]:
            if row.get("date"):
                date_set.add(row["date"])
    all_dates = sorted(date_set)

    # ── Forward-filled normalized series per investment ──
    series: dict[str, list[Optional[float]]] = {}
    for m in valid:
        curve = {pt["date"]: pt["value"] for pt in m.get("normalized_curve", [])}
        label = m.get("label", "?")
        # disambiguate duplicate labels
        if label in series:
            i = 2
            while f"{label} ({i})" in series:
                i += 1
            label = f"{label} ({i})"
        series[label] = _forward_fill(curve, all_dates)

    # ── Metrics table ──
    metrics_table: list[dict] = []
    for m in valid:
        met = m.get("metrics", {})
        metrics_table.append(
            {
                "label": m.get("label", "?"),
                "kind": m.get("kind"),
                "irr_annual": met.get("irr_annual"),
                "cagr": met.get("cagr"),
                "total_return_pct": met.get("total_return_pct"),
                "equity_multiple": met.get("equity_multiple"),
            }
        )

    # ── Ranking by IRR (None sinks to the bottom) ──
    ranking = sorted(
        metrics_table,
        key=lambda r: (r["irr_annual"] is not None, r["irr_annual"] if r["irr_annual"] is not None else float("-inf")),
        reverse=True,
    )
    best_by_irr = ranking[0]["label"] if ranking and ranking[0]["irr_annual"] is not None else None

    return {
        "investments": modeled,
        "comparison": {
            "dates": all_dates,
            "series": series,
            "metrics_table": metrics_table,
            "ranking": [r["label"] for r in ranking],
            "best_by_irr": best_by_irr,
        },
    }
