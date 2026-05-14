"""Cross-asset correlation engine.

The actual "edge" thesis lives here: detect when historically-stable correlations
between assets BREAK. A regime change shows up as a correlation regime change
before it shows up in any single price series.

For each pair (A, B) in the watchlist we compute:
  - recent_corr:    Pearson correlation of daily log-returns over the recent window
  - baseline_corr:  same statistic over a longer baseline window
  - delta:          recent - baseline
  - flipped:        true if signs disagree AND |both| > 0.15 (genuine sign change)
  - magnitude:      |delta|

The "breakdowns" view ranks pairs by magnitude (or sign-flip first).

No third-party stats library — these are simple enough to write directly.
This keeps the dependency surface small and the computation transparent.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Iterable

from ..data.macro_data import SeriesPoint, fetch_arbitrary_ticker
from ..data.watchlist import WatchlistEntry, load_watchlist

log = logging.getLogger(__name__)


# ---------- Math primitives ----------

def _log_returns(values: list[float]) -> list[float]:
    out: list[float] = []
    for prev, cur in zip(values, values[1:]):
        if prev is None or cur is None or prev <= 0 or cur <= 0:
            out.append(float("nan"))
        else:
            out.append(math.log(cur / prev))
    return out


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    """Pearson correlation, NaN-tolerant. Returns None if <10 paired observations."""
    pairs = [(x, y) for x, y in zip(xs, ys) if not (math.isnan(x) or math.isnan(y))]
    if len(pairs) < 10:
        return None
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    num = sum((x - mx) * (y - my) for x, y in pairs)
    dx = math.sqrt(sum((x - mx) ** 2 for x, _ in pairs))
    dy = math.sqrt(sum((y - my) ** 2 for _, y in pairs))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


# ---------- Series prep ----------

def _align_on_dates(
    series_map: dict[str, list[SeriesPoint]],
) -> tuple[list[str], dict[str, list[float]]]:
    """Reduce per-ticker date-indexed series to a shared trading-day grid.

    We use the intersection of dates across all tickers so each correlation pair
    uses the same observation set. For an entirely-yfinance watchlist this is
    typically the SPY trading calendar.
    """
    if not series_map:
        return [], {}

    date_sets = [set(p["date"] for p in pts if p["value"] is not None) for pts in series_map.values()]
    common = sorted(set.intersection(*date_sets)) if date_sets else []

    aligned: dict[str, list[float]] = {}
    for ticker, points in series_map.items():
        lookup = {p["date"]: p["value"] for p in points if p["value"] is not None}
        aligned[ticker] = [lookup[d] for d in common]
    return common, aligned


# ---------- Public API ----------

@dataclass
class PairCorrelation:
    a: str
    b: str
    recent_corr: float | None
    baseline_corr: float | None

    @property
    def delta(self) -> float | None:
        if self.recent_corr is None or self.baseline_corr is None:
            return None
        return self.recent_corr - self.baseline_corr

    @property
    def flipped(self) -> bool:
        if self.recent_corr is None or self.baseline_corr is None:
            return False
        return (
            (self.recent_corr * self.baseline_corr < 0)
            and abs(self.recent_corr) > 0.15
            and abs(self.baseline_corr) > 0.15
        )

    def to_dict(self) -> dict:
        return {
            "a": self.a,
            "b": self.b,
            "recent": _round(self.recent_corr),
            "baseline": _round(self.baseline_corr),
            "delta": _round(self.delta),
            "flipped": self.flipped,
        }


def _round(v: float | None, digits: int = 3) -> float | None:
    return None if v is None else round(v, digits)


def compute_correlations(
    *,
    recent_days: int = 30,
    baseline_days: int = 365,
) -> dict:
    """Build the full correlation report for the active watchlist."""
    entries = load_watchlist()
    tickers = [e.ticker for e in entries]

    # Pull enough history to cover the longest window plus a safety buffer.
    fetch_days = baseline_days + 30
    series_map: dict[str, list[SeriesPoint]] = {
        t: fetch_arbitrary_ticker(t, days=fetch_days) for t in tickers
    }

    dates, aligned = _align_on_dates(series_map)
    if not dates:
        return _empty_report(entries, recent_days, baseline_days)

    returns: dict[str, list[float]] = {t: _log_returns(v) for t, v in aligned.items()}

    # The return series has len = len(dates) - 1
    if returns and len(next(iter(returns.values()))) < 10:
        return _empty_report(entries, recent_days, baseline_days)

    # Slice the trailing-N return windows.
    pairs = _all_pairs(tickers)
    pair_results: list[PairCorrelation] = []
    for a, b in pairs:
        ra_all, rb_all = returns[a], returns[b]
        ra_recent = ra_all[-recent_days:] if len(ra_all) >= recent_days else ra_all
        rb_recent = rb_all[-recent_days:] if len(rb_all) >= recent_days else rb_all
        recent = _pearson(ra_recent, rb_recent)
        baseline = _pearson(ra_all, rb_all)
        pair_results.append(PairCorrelation(a, b, recent, baseline))

    # Sort breakdowns: sign-flips first, then by |delta| desc.
    def _sort_key(p: PairCorrelation):
        d = p.delta if p.delta is not None else -1.0
        return (not p.flipped, -abs(d))

    breakdowns = [p.to_dict() for p in sorted(pair_results, key=_sort_key) if p.delta is not None][:15]

    # Build a square matrix payload — easier for the frontend than a list of pairs.
    matrix = _build_matrix(tickers, pair_results)

    return {
        "tickers": tickers,
        "groups": [
            {
                "name": e.group,
                "ticker": e.ticker,
                "label": e.label,
            }
            for e in entries
        ],
        "recent_days": recent_days,
        "baseline_days": baseline_days,
        "matrix": matrix,
        "breakdowns": breakdowns,
        "dates": {"first": dates[0], "last": dates[-1], "count": len(dates)},
    }


def _empty_report(entries: list[WatchlistEntry], recent: int, baseline: int) -> dict:
    return {
        "tickers": [e.ticker for e in entries],
        "groups": [{"name": e.group, "ticker": e.ticker, "label": e.label} for e in entries],
        "recent_days": recent,
        "baseline_days": baseline,
        "matrix": {"recent": [], "baseline": [], "delta": []},
        "breakdowns": [],
        "dates": {"first": None, "last": None, "count": 0},
    }


def _all_pairs(tickers: list[str]) -> Iterable[tuple[str, str]]:
    for i, a in enumerate(tickers):
        for b in tickers[i + 1:]:
            yield (a, b)


def _build_matrix(tickers: list[str], results: list[PairCorrelation]) -> dict:
    """Build three NxN matrices: recent, baseline, delta. Diagonal = 1.0/0.0/0.0."""
    n = len(tickers)
    idx = {t: i for i, t in enumerate(tickers)}

    def _empty():
        return [[None for _ in range(n)] for _ in range(n)]

    recent_m = _empty()
    baseline_m = _empty()
    delta_m = _empty()

    for i in range(n):
        recent_m[i][i] = 1.0
        baseline_m[i][i] = 1.0
        delta_m[i][i] = 0.0

    for p in results:
        i, j = idx[p.a], idx[p.b]
        recent_m[i][j] = recent_m[j][i] = _round(p.recent_corr)
        baseline_m[i][j] = baseline_m[j][i] = _round(p.baseline_corr)
        delta_m[i][j] = delta_m[j][i] = _round(p.delta)

    return {"recent": recent_m, "baseline": baseline_m, "delta": delta_m}
