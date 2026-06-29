"""Implied Forward-Rate Matrix (Bloomberg `FWCM`).

Bootstraps the spot US Treasury curve into a grid of implied forward rates. The
forward rate f(t1, t2) is the rate the market is *today* pricing for the period
between two future dates t1 and t2. Reading a column down the matrix shows the
expected path of a given tenor (e.g. how the 1y rate evolves), while a row shows
the whole forward curve seen from a future start date. Comparing each forward
against the equivalent-tenor spot rate (forward-minus-spot) is the core curve
trade signal: a forward well above spot says the market prices hikes / steepening
into that segment; below spot prices cuts / flattening.

Math: we treat the par/zero Treasury yields as continuously-comparable zero
rates z(t), linearly interpolate them across the term axis, and compute the
standard implied forward:

    f(t1, t2) = (z2 * t2 - z1 * t1) / (t2 - t1)

For a spot-start cell (t1 = 0) this collapses to f = z(t2), so the spot row is a
clean reference.

Live path: pull the 11 canonical DGS* maturities through the SAME FRED fetcher
(`app.data.macro_data.fetch_series`) that yield_curve.py / breakevens.py use, take
the latest level per maturity, and bootstrap the forward grid. When FRED is
unavailable / the curve is too sparse we degrade to a deterministic, realistic
SAMPLE spot curve (slightly inverted front-end rolling up the long end, ~4-5%
levels) and bootstrap the same grid from it. This module never raises - it always
returns a populated payload tagged with data_mode / as_of / source for honesty
under the hood.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from .macro_data import fetch_series

log = logging.getLogger(__name__)

# Spot Treasury maturities, short -> long. (FRED id, label, years on term axis).
# Same DGS* path as yield_curve.py; DGS3 (3Y) added to fill the belly.
MATURITIES: list[tuple[str, str, float]] = [
    ("DGS1MO", "1M",  1 / 12),
    ("DGS3MO", "3M",  3 / 12),
    ("DGS6MO", "6M",  6 / 12),
    ("DGS1",   "1Y",  1.0),
    ("DGS2",   "2Y",  2.0),
    ("DGS3",   "3Y",  3.0),
    ("DGS5",   "5Y",  5.0),
    ("DGS7",   "7Y",  7.0),
    ("DGS10",  "10Y", 10.0),
    ("DGS20",  "20Y", 20.0),
    ("DGS30",  "30Y", 30.0),
]

# Forward grid axes. Rows = start year (0 = spot), cols = tenor length (years).
START_YEARS: list[tuple[float, str]] = [
    (0.0, "Spot"),
    (1.0, "1Y"),
    (2.0, "2Y"),
    (3.0, "3Y"),
    (5.0, "5Y"),
    (7.0, "7Y"),
    (10.0, "10Y"),
]
TENORS: list[tuple[float, str]] = [
    (1.0, "1Y"),
    (2.0, "2Y"),
    (3.0, "3Y"),
    (5.0, "5Y"),
    (10.0, "10Y"),
]

# Headline forwards the desk watches. (start_years, tenor_years, label).
HEADLINE_FORWARDS: list[tuple[float, float, str]] = [
    (1.0, 1.0, "1y1y"),
    (2.0, 1.0, "2y1y"),
    (3.0, 2.0, "3y2y"),
    (5.0, 5.0, "5y5y"),
    (1.0, 9.0, "1y9y"),
]

# Deterministic SAMPLE spot curve: slightly-inverted front end that rolls back up
# the long end, anchored to realistic late-2025/early-2026 ~4-5% levels.
SAMPLE_SPOT: dict[str, float] = {
    "DGS1MO": 4.85,
    "DGS3MO": 4.70,
    "DGS6MO": 4.52,
    "DGS1":   4.32,
    "DGS2":   4.12,
    "DGS3":   4.08,
    "DGS5":   4.14,
    "DGS7":   4.26,
    "DGS10":  4.38,
    "DGS20":  4.66,
    "DGS30":  4.58,
}


# ---------------------------------------------------------------------------
# Zero-curve interpolation + forward bootstrap
# ---------------------------------------------------------------------------

def _interp_zero(curve: list[tuple[float, float]], t: float) -> float:
    """Linear-interpolate the zero rate (percent) at `t` years. `curve` is an
    ascending list of (years, rate). Clamps flat beyond the endpoints."""
    if not curve:
        return 0.0
    if t <= curve[0][0]:
        return curve[0][1]
    if t >= curve[-1][0]:
        return curve[-1][1]
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        if x0 <= t <= x1:
            if x1 == x0:
                return y0
            w = (t - x0) / (x1 - x0)
            return y0 + w * (y1 - y0)
    return curve[-1][1]


def _forward(curve: list[tuple[float, float]], t1: float, t2: float) -> float:
    """Implied forward rate f(t1, t2) from the interpolated zero curve."""
    if t2 <= t1:
        return _interp_zero(curve, t2)
    z1 = _interp_zero(curve, t1)
    z2 = _interp_zero(curve, t2)
    return (z2 * t2 - z1 * t1) / (t2 - t1)


def _spot_rate(curve: list[tuple[float, float]], years: float) -> float:
    """Current spot zero rate at a given tenor length (the comparison leg)."""
    return _interp_zero(curve, years)


# ---------------------------------------------------------------------------
# Live + sample curve assembly
# ---------------------------------------------------------------------------

def _live_spot() -> list[dict] | None:
    """Pull the latest DGS* levels through FRED. Returns spot-curve points, or
    None when too few maturities resolve so the caller falls to sample."""
    points: list[dict] = []
    for fred_id, label, yrs in MATURITIES:
        rate: float | None = None
        try:
            series = fetch_series(fred_id, days=30)
            for p in reversed(series or []):
                v = p.get("value")
                if v is not None:
                    rate = round(float(v), 3)
                    break
        except Exception:
            rate = None
        if rate is not None:
            points.append({"tenor_label": label, "years": yrs, "rate": rate})
    # Require a meaningful chunk of the curve to have resolved live.
    if len(points) < 6:
        return None
    return points


def _sample_spot() -> list[dict]:
    return [
        {"tenor_label": label, "years": yrs, "rate": SAMPLE_SPOT[fred_id]}
        for fred_id, label, yrs in MATURITIES
    ]


def _classify_shape(curve: list[tuple[float, float]]) -> str:
    s2 = _interp_zero(curve, 2.0)
    s10 = _interp_zero(curve, 10.0)
    s3m = _interp_zero(curve, 0.25)
    slope = s10 - s2
    front = s10 - s3m
    if slope < -0.10 or front < -0.10:
        return "inverted"
    if abs(slope) < 0.20 and abs(front) < 0.20:
        return "flat"
    if slope > 1.20 or front > 1.50:
        return "steep"
    return "normal"


def _assemble(spot_points: list[dict], *, data_mode: str, source: str) -> dict:
    # Build the ascending zero curve used for interpolation + bootstrap.
    curve = sorted(
        [(p["years"], p["rate"]) for p in spot_points if p.get("rate") is not None]
    )

    # --- Forward matrix: rows = start year, cols = tenor ---
    forward_matrix: list[dict] = []
    max_cell = {"value": None, "label": ""}
    for start_y, start_label in START_YEARS:
        cells: list[dict] = []
        for tenor_y, tenor_label in TENORS:
            fwd = round(_forward(curve, start_y, start_y + tenor_y), 3)
            spot = _spot_rate(curve, tenor_y)
            vs_spot = round(fwd - spot, 3)
            cells.append({
                "tenor_label": tenor_label,
                "tenor_years": tenor_y,
                "forward_rate": fwd,
                "vs_spot": vs_spot,
            })
            if max_cell["value"] is None or fwd > max_cell["value"]:
                max_cell = {
                    "value": fwd,
                    "label": f"{int(start_y)}y{int(tenor_y)}y" if start_y else f"spot {tenor_label}",
                }
        forward_matrix.append({
            "start_years": start_y,
            "start_label": start_label,
            "cells": cells,
        })

    # --- Headline forwards (with vs-spot deltas for curve-trade signals) ---
    headline_forwards: list[dict] = []
    for start_y, tenor_y, label in HEADLINE_FORWARDS:
        fwd = round(_forward(curve, start_y, start_y + tenor_y), 3)
        spot = round(_spot_rate(curve, tenor_y), 3)
        headline_forwards.append({
            "label": label,
            "forward_rate": fwd,
            "spot_rate": spot,
            "vs_spot": round(fwd - spot, 3),
        })

    # --- Summary: curve shape + max forward + steepest forward segment ---
    # Steepest segment = the consecutive 1y forward step with the largest jump
    # (where the market prices the sharpest move in the short rate).
    steepest = {"segment": None, "change_bps": None}
    steps = [0.0, 1.0, 2.0, 3.0, 5.0, 7.0, 10.0]
    prev_f: float | None = None
    prev_lbl: str | None = None
    for s in steps:
        f = _forward(curve, s, s + 1.0)
        lbl = f"{int(s)}y1y" if s else "spot 1Y"
        if prev_f is not None:
            change = (f - prev_f) * 100.0
            if steepest["change_bps"] is None or abs(change) > abs(steepest["change_bps"]):
                steepest = {
                    "segment": f"{prev_lbl} -> {lbl}",
                    "change_bps": round(change, 1),
                }
        prev_f, prev_lbl = f, lbl

    summary = {
        "curve_shape": _classify_shape(curve),
        "max_forward": {
            "label": max_cell["label"],
            "rate": round(max_cell["value"], 3) if max_cell["value"] is not None else None,
        },
        "steepest_segment": steepest,
    }

    return {
        "spot_curve": spot_points,
        "forward_matrix": forward_matrix,
        "headline_forwards": headline_forwards,
        "summary": summary,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def forward_rates() -> dict:
    """Bootstrap the spot Treasury curve into an implied forward-rate matrix.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        spot = _live_spot()
        if spot:
            return _assemble(spot, data_mode="live", source="FRED")
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("forward_rates live path failed, returning sample: %s", e)
    try:
        return _assemble(_sample_spot(), data_mode="sample", source="sample")
    except Exception as e:
        log.error("forward_rates sample path failed hard: %s", e)
        return {
            "spot_curve": [],
            "forward_matrix": [],
            "headline_forwards": [],
            "summary": {"curve_shape": "unknown", "max_forward": {"label": "", "rate": None},
                        "steepest_segment": {"segment": None, "change_bps": None}},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
