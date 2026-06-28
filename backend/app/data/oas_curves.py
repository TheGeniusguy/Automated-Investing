"""Corporate OAS Term-Structure by Rating (Bloomberg `SPRD`).

Builds an institutional credit-spread view across the full rating ladder
(AAA -> CCC) plus the IG and HY aggregate option-adjusted spreads, sourced from
the ICE BofA index family on FRED:

  AAA  BAMLC0A1CAAA      AA   BAMLC0A2CAA       A    BAMLC0A3CA
  BBB  BAMLC0A4CBBB      BB   BAMLH0A1HYBB      B    BAMLH0A2HYB
  CCC  BAMLH0A3HYC       IG   BAMLC0A0CM        HY   BAMLH0A0HYM2

FRED reports these series in percent; we multiply by 100 to express basis
points. For each rating we compute the current OAS, the daily change, the
trailing 1y high/low, a percentile rank and z-score vs roughly five years of
history, and the underlying history series. We also derive the IG-vs-HY gap,
the full AAA->CCC credit curve snapshot, and the BBB-BB "crossover" gap that
straddles the investment-grade / high-yield boundary.

Contract: this module NEVER raises. Any failure (no FRED key, network error,
short series) degrades to deterministic, md5-seeded SAMPLE series with realistic
levels (AAA ~50bps rising to CCC ~900bps) and sets data_mode="sample". Every
payload carries data_mode / as_of / source for honesty under the hood.
Pure numpy + stdlib, no new pip deps.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timedelta, timezone

import numpy as np

from .macro_data import fetch_series

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

HISTORY_DAYS = 365 * 5 + 5          # ~5y of history for percentile / z-score
ONE_YEAR_DAYS = 252                 # trailing-1y window (trading days)

# Rating ladder ordered AAA -> CCC, paired to its FRED ICE BofA series id.
RATING_SERIES: list[tuple[str, str]] = [
    ("AAA", "BAMLC0A1CAAA"),
    ("AA", "BAMLC0A2CAA"),
    ("A", "BAMLC0A3CA"),
    ("BBB", "BAMLC0A4CBBB"),
    ("BB", "BAMLH0A1HYBB"),
    ("B", "BAMLH0A2HYB"),
    ("CCC", "BAMLH0A3HYC"),
]

IG_SERIES = "BAMLC0A0CM"            # ICE BofA US Corporate (IG) Master OAS, %
HY_SERIES = "BAMLH0A0HYM2"          # ICE BofA US High Yield Master II OAS, %

# Investment-grade ratings (used to split IG vs HY in the ladder).
IG_RATINGS = {"AAA", "AA", "A", "BBB"}

# ── SAMPLE data (deterministic fallback) ──────────────────────────────────────
# Realistic mid-cycle OAS anchor levels (bps) and annualized vol of the spread
# (also in bps) used to drive the synthetic md5-seeded history walk. Levels rise
# monotonically down the credit ladder, AAA ~50 to CCC ~900.
SAMPLE_OAS_ANCHORS: dict[str, dict] = {
    "AAA": {"level": 52.0, "vol": 14.0},
    "AA": {"level": 64.0, "vol": 16.0},
    "A": {"level": 88.0, "vol": 20.0},
    "BBB": {"level": 128.0, "vol": 28.0},
    "BB": {"level": 232.0, "vol": 55.0},
    "B": {"level": 392.0, "vol": 95.0},
    "CCC": {"level": 902.0, "vol": 240.0},
}

SAMPLE_IG_LEVEL = 96.0              # IG master OAS anchor (bps)
SAMPLE_HY_LEVEL = 324.0            # HY master OAS anchor (bps)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _seed(label: str) -> np.random.Generator:
    """Deterministic numpy Generator seeded off an md5 of the label so synthetic
    series are stable across calls (per the build contract)."""
    h = hashlib.md5(label.encode("utf-8")).hexdigest()
    return np.random.default_rng(int(h[:16], 16))


def _sample_history(rating: str, level: float, vol: float, n: int = 1300) -> list[dict]:
    """Build a deterministic ~5y daily OAS history (bps) that mean-reverts
    toward `level`. Realistic regime: spreads grind tighter, occasionally widen."""
    rng = _seed(f"oas:{rating}")
    daily_vol = vol / np.sqrt(252.0)
    end = datetime.now(timezone.utc).date()

    # Ornstein-Uhlenbeck style mean reversion around the anchor level.
    series = np.empty(n)
    x = level * 1.15  # start a touch wide, compress in
    kappa = 0.015
    for i in range(n):
        shock = rng.normal(0.0, daily_vol)
        # mild multiplicative scaling so wider ratings breathe more in stress
        x = x + kappa * (level - x) + shock + (daily_vol * 0.15 * abs(rng.normal()))
        x = max(x, level * 0.35)
        series[i] = x

    out: list[dict] = []
    for i in range(n):
        d = end - timedelta(days=(n - 1 - i))
        out.append({"date": d.isoformat(), "value": round(float(series[i]), 1)})
    return out


def _clean(points: list[dict]) -> list[dict]:
    """Drop None values, sort ascending by date, convert percent -> bps."""
    rows = []
    for p in points or []:
        v = p.get("value")
        if v is None:
            continue
        rows.append({"date": p["date"], "value": round(float(v) * 100.0, 1)})
    rows.sort(key=lambda r: r["date"])
    return rows


def _stats(history: list[dict]) -> dict:
    """Compute current / change / 1y hi-lo / percentile / z-score from a bps
    history series (already cleaned + ascending)."""
    vals = np.array([h["value"] for h in history], dtype=float)
    current = float(vals[-1])
    prev = float(vals[-2]) if len(vals) >= 2 else current
    change = round(current - prev, 1)

    window_1y = vals[-ONE_YEAR_DAYS:] if len(vals) >= ONE_YEAR_DAYS else vals
    hi_1y = round(float(window_1y.max()), 1)
    lo_1y = round(float(window_1y.min()), 1)

    pct_rank = round(float((vals <= current).mean()) * 100.0, 1)
    mu = float(vals.mean())
    sd = float(vals.std())
    z = round((current - mu) / sd, 2) if sd > 1e-9 else 0.0

    return {
        "oas_bps": round(current, 1),
        "change_bps": change,
        "pct_rank": pct_rank,
        "z_score": z,
        "hi_1y": hi_1y,
        "lo_1y": lo_1y,
    }


def _thin(history: list[dict], keep: int = 260) -> list[dict]:
    """Downsample a long history to at most `keep` points for transport,
    preserving the most recent observation."""
    if len(history) <= keep:
        return history
    step = len(history) / keep
    idx = sorted({int(i * step) for i in range(keep)} | {len(history) - 1})
    return [history[i] for i in idx]


# ── Public API ───────────────────────────────────────────────────────────────

def oas_curves() -> dict:
    """Return the corporate OAS term-structure-by-rating payload.

    Never raises. Falls back to deterministic SAMPLE series on any failure.

    Top-level keys: ratings, curve, ig_oas, hy_oas, ig_hy_gap, crossover_gap,
    data_mode, as_of, source.
    """
    as_of = datetime.now(timezone.utc).isoformat()
    try:
        return _build_live(as_of)
    except Exception as e:  # pragma: no cover - safety net, never raises
        log.warning("oas_curves() failed, using sample: %s", e)
        return _build_sample(as_of)


def _build_live(as_of: str) -> dict:
    """Attempt the FRED-backed build; raise to trigger the sample fallback if
    any series comes back empty/too short."""
    histories: dict[str, list[dict]] = {}
    for rating, series_id in RATING_SERIES:
        cleaned = _clean(fetch_series(series_id, days=HISTORY_DAYS))
        if len(cleaned) < ONE_YEAR_DAYS:
            raise RuntimeError(f"insufficient history for {rating} ({series_id})")
        histories[rating] = cleaned

    ig_hist = _clean(fetch_series(IG_SERIES, days=HISTORY_DAYS))
    hy_hist = _clean(fetch_series(HY_SERIES, days=HISTORY_DAYS))
    if len(ig_hist) < ONE_YEAR_DAYS or len(hy_hist) < ONE_YEAR_DAYS:
        raise RuntimeError("insufficient IG/HY aggregate history")

    return _assemble(histories, ig_hist, hy_hist, "live", as_of, "FRED ICE BofA OAS")


def _build_sample(as_of: str) -> dict:
    """Deterministic, screenshot-ready fallback."""
    histories: dict[str, list[dict]] = {}
    for rating, _ in RATING_SERIES:
        a = SAMPLE_OAS_ANCHORS[rating]
        histories[rating] = _sample_history(rating, a["level"], a["vol"])

    ig_hist = _sample_history("IG_MASTER", SAMPLE_IG_LEVEL, 24.0)
    hy_hist = _sample_history("HY_MASTER", SAMPLE_HY_LEVEL, 70.0)

    return _assemble(histories, ig_hist, hy_hist, "sample", as_of, "deterministic sample")


def _assemble(
    histories: dict[str, list[dict]],
    ig_hist: list[dict],
    hy_hist: list[dict],
    data_mode: str,
    as_of: str,
    source: str,
) -> dict:
    ratings: list[dict] = []
    curve: list[dict] = []
    by_rating: dict[str, float] = {}

    for rating, _ in RATING_SERIES:
        hist = histories[rating]
        s = _stats(hist)
        by_rating[rating] = s["oas_bps"]
        curve.append({"rating": rating, "oas_bps": s["oas_bps"]})
        ratings.append({
            "rating": rating,
            "oas_bps": s["oas_bps"],
            "change_bps": s["change_bps"],
            "pct_rank": s["pct_rank"],
            "z_score": s["z_score"],
            "hi_1y": s["hi_1y"],
            "lo_1y": s["lo_1y"],
            "history": _thin(hist),
        })

    ig_stats = _stats(ig_hist)
    hy_stats = _stats(hy_hist)
    ig_oas = ig_stats["oas_bps"]
    hy_oas = hy_stats["oas_bps"]

    ig_hy_gap = round(hy_oas - ig_oas, 1)
    # Crossover gap: BB (highest-rated HY) minus BBB (lowest-rated IG).
    crossover_gap = round(by_rating.get("BB", 0.0) - by_rating.get("BBB", 0.0), 1)

    return {
        "ratings": ratings,
        "curve": curve,
        "ig_oas": ig_oas,
        "ig_oas_change_bps": ig_stats["change_bps"],
        "ig_oas_history": _thin(ig_hist),
        "hy_oas": hy_oas,
        "hy_oas_change_bps": hy_stats["change_bps"],
        "hy_oas_history": _thin(hy_hist),
        "ig_hy_gap": ig_hy_gap,
        "crossover_gap": crossover_gap,
        "data_mode": data_mode,
        "as_of": as_of,
        "source": source,
    }
