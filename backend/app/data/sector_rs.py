"""Relative strength momentum for sector ETFs vs SPY.

RS ratio = sector_close / spy_close  (the raw pair ratio).

Two rolling momentum series:
  rs_20d[i] = rs_raw[i] / rs_raw[i-20]   -- 20-trading-day window
  rs_60d[i] = rs_raw[i] / rs_raw[i-60]   -- 60-trading-day window

A value above 1.0 = sector outperforming SPY over that window.
A value below 1.0 = underperforming.

We also return the raw RS series (normalized to 1.0 at the first date) so
the frontend can render the full trend alongside the two momentum lines.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from . import macro_data

log = logging.getLogger(__name__)

LOOKBACK = 365  # fetch 1y; enough for 60d windows + history to show


def _align(
    etf_points: list[dict], spy_points: list[dict]
) -> tuple[list[str], list[float], list[float]]:
    """Inner-join ETF and SPY by date, return (dates, etf_closes, spy_closes)."""
    etf_map = {p["date"]: p["value"] for p in etf_points if p.get("value") is not None}
    spy_map = {p["date"]: p["value"] for p in spy_points if p.get("value") is not None}
    common = sorted(set(etf_map) & set(spy_map))
    return (
        common,
        [etf_map[d] for d in common],
        [spy_map[d] for d in common],
    )


def _rolling_rs(
    dates: list[str], rs_raw: list[float], window: int
) -> list[dict]:
    """Return [{date, value}] where value = rs_raw[i] / rs_raw[i-window].

    Points before index `window` are skipped (insufficient history).
    """
    result = []
    for i in range(window, len(rs_raw)):
        base = rs_raw[i - window]
        if base and base > 0:
            result.append({"date": dates[i], "value": round(rs_raw[i] / base, 5)})
    return result


def sector_relative_strength(sector_id: str, etf: str, benchmark: str = "SPY") -> dict:
    """Compute RS series for a sector ETF vs benchmark.

    Returns:
      {
        sector_id, etf, benchmark,
        series: [
          {key, label, color, points: [{date, value}]},   # raw RS (norm 1.0)
          {key, label, color, points: [{date, value}]},   # 20d rolling RS
          {key, label, color, points: [{date, value}]},   # 60d rolling RS
        ],
        current: {rs_raw, rs_20d, rs_60d},     # latest values
        outperforming_20d: bool | None,
        outperforming_60d: bool | None,
      }
    """
    # Fetch in parallel
    with ThreadPoolExecutor(max_workers=2) as pool:
        etf_fut = pool.submit(macro_data.fetch_arbitrary_ticker, etf, LOOKBACK)
        spy_fut = pool.submit(macro_data.fetch_arbitrary_ticker, benchmark, LOOKBACK)
        etf_points = etf_fut.result()
        spy_points = spy_fut.result()

    if not etf_points or not spy_points:
        return {
            "sector_id": sector_id,
            "etf": etf,
            "benchmark": benchmark,
            "error": "Price data unavailable",
            "series": [],
            "current": {},
        }

    dates, etf_closes, spy_closes = _align(etf_points, spy_points)
    if len(dates) < 21:
        return {
            "sector_id": sector_id,
            "etf": etf,
            "benchmark": benchmark,
            "error": "Insufficient price history",
            "series": [],
            "current": {},
        }

    # Raw RS ratio
    rs_raw = [e / s for e, s in zip(etf_closes, spy_closes)]

    # Normalize raw RS to 1.0 at the first date
    base0 = rs_raw[0]
    rs_norm = [{"date": d, "value": round(v / base0, 5)} for d, v in zip(dates, rs_raw)]

    # Rolling momentum
    rs_20d = _rolling_rs(dates, rs_raw, 20)
    rs_60d = _rolling_rs(dates, rs_raw, 60)

    # Current readings
    curr_raw  = rs_norm[-1]["value"]  if rs_norm  else None
    curr_20d  = rs_20d[-1]["value"]   if rs_20d   else None
    curr_60d  = rs_60d[-1]["value"]   if rs_60d   else None

    return {
        "sector_id":  sector_id,
        "etf":        etf,
        "benchmark":  benchmark,
        "series": [
            {
                "key":    "rs_raw",
                "label":  f"{etf}/SPY (norm)",
                "color":  "#6b7280",
                "points": rs_norm,
            },
            {
                "key":    "rs_20d",
                "label":  "20D RS Momentum",
                "color":  "#ffb800",
                "points": rs_20d,
            },
            {
                "key":    "rs_60d",
                "label":  "60D RS Momentum",
                "color":  "#4ade80",
                "points": rs_60d,
            },
        ],
        "current": {
            "rs_raw": curr_raw,
            "rs_20d": curr_20d,
            "rs_60d": curr_60d,
        },
        "outperforming_20d": (curr_20d > 1.0) if curr_20d is not None else None,
        "outperforming_60d": (curr_60d > 1.0) if curr_60d is not None else None,
    }
