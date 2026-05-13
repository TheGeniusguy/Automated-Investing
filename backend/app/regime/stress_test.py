"""Portfolio stress-test: how did each position perform within each regime?

Input: a list of {ticker, weight} dicts and a regime history (list of {date, label}).
Output: per-position, per-regime returns over the historical window.

Returns are computed as simple close-to-close % change between the first and last
trading day of each regime segment, using each ticker's own price history. If a
ticker has no data overlapping a segment (didn't exist yet, or yfinance is empty),
we report null for that cell.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..data.macro_data import SeriesPoint, fetch_arbitrary_ticker

log = logging.getLogger(__name__)


@dataclass
class RegimePeriod:
    label: str        # risk_on | risk_off | transition
    start: str        # YYYY-MM-DD
    end: str          # YYYY-MM-DD (inclusive)


def collapse_regime_history(history: list[dict]) -> list[RegimePeriod]:
    """Collapse per-day regime labels into contiguous segments."""
    if not history:
        return []
    segments: list[RegimePeriod] = []
    current_label = history[0]["label"]
    current_start = history[0]["date"]
    current_end = history[0]["date"]
    for entry in history[1:]:
        if entry["label"] == current_label:
            current_end = entry["date"]
        else:
            segments.append(RegimePeriod(current_label, current_start, current_end))
            current_label = entry["label"]
            current_start = entry["date"]
            current_end = entry["date"]
    segments.append(RegimePeriod(current_label, current_start, current_end))
    return segments


def _segment_return(points: list[SeriesPoint], start: str, end: str) -> float | None:
    """Simple % return from the first to last close inside [start, end] inclusive."""
    in_range = [p for p in points if start <= p["date"] <= end and p["value"] is not None]
    if len(in_range) < 2:
        return None
    first, last = in_range[0]["value"], in_range[-1]["value"]
    if first == 0 or first is None or last is None:
        return None
    return (last / first) - 1.0


def stress_test(
    positions: list[dict],
    regime_history: list[dict],
    *,
    days: int,
) -> dict:
    """Build the stress-test table.

    Returns:
      {
        "segments": [{label, start, end, days}],
        "positions": [
          {
            "ticker", "weight",
            "regime_returns": {risk_on: pct, risk_off: pct, transition: pct},
            "per_segment": [{label, start, end, return}],
            "total_return": pct (or null if data missing),
            "data_points": int,
          }
        ],
        "aggregate_by_regime": {risk_on: weighted_pct, ...},
      }
    """
    segments = collapse_regime_history(regime_history)

    per_position: list[dict] = []
    for pos in positions:
        ticker = (pos.get("ticker") or "").strip().upper()
        weight = float(pos.get("weight") or 0.0)
        if not ticker:
            continue

        price_points = fetch_arbitrary_ticker(ticker, days=days)
        seg_returns: list[dict] = []
        regime_buckets: dict[str, list[float]] = {"risk_on": [], "risk_off": [], "transition": []}

        for seg in segments:
            r = _segment_return(price_points, seg.start, seg.end)
            seg_returns.append({
                "label": seg.label,
                "start": seg.start,
                "end": seg.end,
                "return": r,
            })
            if r is not None:
                regime_buckets[seg.label].append(r)

        # Per-regime: compound the segment returns inside each regime.
        regime_returns: dict[str, float | None] = {}
        for label, returns_list in regime_buckets.items():
            if not returns_list:
                regime_returns[label] = None
                continue
            compounded = 1.0
            for r in returns_list:
                compounded *= (1.0 + r)
            regime_returns[label] = compounded - 1.0

        # Total: first non-null to last non-null close across the whole window
        in_range = [p for p in price_points if p["value"] is not None]
        total = None
        if len(in_range) >= 2 and in_range[0]["value"]:
            total = (in_range[-1]["value"] / in_range[0]["value"]) - 1.0

        per_position.append({
            "ticker": ticker,
            "weight": weight,
            "regime_returns": regime_returns,
            "per_segment": seg_returns,
            "total_return": total,
            "data_points": len(in_range),
        })

    # Weighted aggregate per regime — useful "portfolio drawdown by regime" summary.
    weight_total = sum(p["weight"] for p in per_position) or 1.0
    aggregate: dict[str, float | None] = {}
    for label in ("risk_on", "risk_off", "transition"):
        contributions: list[tuple[float, float]] = []
        for p in per_position:
            r = p["regime_returns"].get(label)
            if r is not None:
                contributions.append((p["weight"] / weight_total, r))
        if not contributions:
            aggregate[label] = None
        else:
            aggregate[label] = sum(w * r for w, r in contributions)

    return {
        "segments": [
            {
                "label": s.label,
                "start": s.start,
                "end": s.end,
                "days": _date_span_days(s.start, s.end),
            }
            for s in segments
        ],
        "positions": per_position,
        "aggregate_by_regime": aggregate,
    }


def _date_span_days(start: str, end: str) -> int:
    from datetime import date
    a = date.fromisoformat(start)
    b = date.fromisoformat(end)
    return (b - a).days + 1
