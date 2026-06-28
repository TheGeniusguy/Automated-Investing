"""Weighted / model portfolio tracking.

Given a set of target-weighted holdings, this module builds a normalized growth
curve for the book vs a benchmark, attributes return to each holding, measures
weight drift away from target, computes weighted risk vs the benchmark, and
produces rebalance suggestions (target minus current, plus suggested dollars for
a given notional).

Prices come from app.data.macro_data.fetch_arbitrary_ticker. When live prices are
missing or too sparse, the whole analysis degrades to a self-consistent SAMPLE
book (deterministic synthetic random walks) so panels stay fully populated. This
module never raises.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import logging

import numpy as np

from ..data import macro_data

log = logging.getLogger(__name__)


# A realistic 8-10 name model portfolio. Target weights sum to ~1.00.
SAMPLE_MODEL_BOOK: list[dict] = [
    {"symbol": "AAPL", "target_weight": 0.16},
    {"symbol": "MSFT", "target_weight": 0.15},
    {"symbol": "NVDA", "target_weight": 0.13},
    {"symbol": "AMZN", "target_weight": 0.11},
    {"symbol": "GOOGL", "target_weight": 0.10},
    {"symbol": "META", "target_weight": 0.09},
    {"symbol": "JPM", "target_weight": 0.09},
    {"symbol": "XOM", "target_weight": 0.07},
    {"symbol": "UNH", "target_weight": 0.06},
    {"symbol": "TLT", "target_weight": 0.04},
]

# Per-symbol annualized drift / vol used to shape the sample random walks so the
# synthetic book looks plausible (growthy tech high vol, bonds low vol).
_SAMPLE_PROFILE: dict[str, tuple[float, float]] = {
    "AAPL": (0.22, 0.26),
    "MSFT": (0.20, 0.24),
    "NVDA": (0.55, 0.48),
    "AMZN": (0.18, 0.30),
    "GOOGL": (0.16, 0.27),
    "META": (0.28, 0.34),
    "JPM": (0.12, 0.22),
    "XOM": (0.08, 0.25),
    "UNH": (0.10, 0.21),
    "TLT": (0.02, 0.13),
    "SPY": (0.11, 0.16),
    "QQQ": (0.17, 0.22),
    "IWM": (0.09, 0.21),
    "DIA": (0.09, 0.15),
}


def _today() -> dt.date:
    return dt.date.today()


def _sample_profile(symbol: str) -> tuple[float, float]:
    """Return (annual_drift, annual_vol) for a symbol, deterministic for unknowns."""
    if symbol in _SAMPLE_PROFILE:
        return _SAMPLE_PROFILE[symbol]
    # Deterministic-but-varied profile for arbitrary tickers.
    h = int(hashlib.md5(symbol.encode()).hexdigest(), 16)
    drift = 0.04 + (h % 240) / 1000.0          # 0.04 .. 0.28
    vol = 0.14 + ((h // 240) % 280) / 1000.0   # 0.14 .. 0.42
    return drift, vol


def _sample_prices(symbol: str, days: int) -> list[dict]:
    """Deterministic synthetic price history as [{date, close}], base ~100."""
    n = max(int(days), 30)
    drift, vol = _sample_profile(symbol)
    seed = int(hashlib.md5(symbol.encode()).hexdigest()[:8], 16) % (2**31)
    rng = np.random.default_rng(seed)
    mu = drift / 252.0
    sigma = vol / np.sqrt(252.0)
    shocks = rng.normal(mu, sigma, n)
    path = 100.0 * np.exp(np.cumsum(shocks))
    end = _today()
    out: list[dict] = []
    for i in range(n):
        d = end - dt.timedelta(days=(n - 1 - i))
        out.append({"date": d.isoformat(), "close": round(float(path[i]), 4)})
    return out


def _load_prices(symbol: str, days: int) -> list[dict]:
    """Load live (date, close) prices via fetch_arbitrary_ticker; [] on failure."""
    try:
        points = macro_data.fetch_arbitrary_ticker(symbol, days=max(days * 2, 60))
        return [{"date": p["date"], "close": p["value"]}
                for p in points if p.get("value") is not None]
    except Exception as e:
        log.warning("weighted: failed to load %s: %s", symbol, e)
        return []


def _price_map(prices: list[dict]) -> dict[str, float]:
    return {p["date"]: p["close"] for p in prices if p["close"] and p["close"] > 0}


def _daily_returns_aligned(values: list[float]) -> list[float]:
    out: list[float] = []
    for i in range(1, len(values)):
        prev = values[i - 1]
        cur = values[i]
        if prev and prev > 0:
            out.append((cur - prev) / prev)
        else:
            out.append(0.0)
    return out


def _normalize_to_100(values: list[float]) -> list[float]:
    if not values:
        return []
    base = values[0]
    if not base or base <= 0:
        return [100.0 for _ in values]
    return [round(v / base * 100.0, 4) for v in values]


def _empty_payload(benchmark: str, days: int, source: str) -> dict:
    return {
        "holdings": [],
        "benchmark": benchmark.upper(),
        "days": days,
        "notional": 0.0,
        "curves": {"dates": [], "book": [], "benchmark": []},
        "weighted_total_return_pct": None,
        "benchmark_total_return_pct": None,
        "contributions": [],
        "drift": [],
        "risk": {"weighted_vol_pct": None, "benchmark_vol_pct": None,
                 "correlation_to_benchmark": None, "tracking_error_pct": None},
        "rebalance": [],
        "data_mode": "sample",
        "as_of": _today().isoformat(),
        "source": source,
    }


def analyze_weighted_portfolio(
    holdings: list[dict],
    days: int = 365,
    benchmark: str = "SPY",
    notional: float = 100000.0,
) -> dict:
    """Analyze a target-weighted model book vs a benchmark.

    holdings = [{symbol, target_weight}] (weights sum ~1). Returns normalized
    growth curves (base 100) for the book and benchmark, weighted total return,
    per-holding contribution-to-return, current-weight drift vs target, weighted
    vol + correlation to benchmark, and rebalance deltas (target minus current,
    with suggested dollars for `notional`). Never raises; degrades to a sample
    book when live prices are missing.
    """
    try:
        return _analyze(holdings, days, benchmark, notional)
    except Exception as e:  # absolute backstop - never raise
        log.warning("analyze_weighted_portfolio failed, returning empty: %s", e)
        return _empty_payload(benchmark or "SPY", days, source="sample")


def _clean_holdings(holdings: list[dict] | None) -> list[dict]:
    """Coerce to [{symbol, target_weight}], drop junk, renormalize weights to 1."""
    cleaned: list[dict] = []
    for h in (holdings or []):
        try:
            sym = str(h.get("symbol", "")).strip().upper()
            w = float(h.get("target_weight", 0) or 0)
        except Exception:
            continue
        if sym and w > 0:
            cleaned.append({"symbol": sym, "target_weight": w})
    if not cleaned:
        return [dict(h) for h in SAMPLE_MODEL_BOOK]
    total = sum(h["target_weight"] for h in cleaned)
    if total > 0:
        for h in cleaned:
            h["target_weight"] = h["target_weight"] / total
    return cleaned


def _analyze(holdings: list[dict], days: int, benchmark: str, notional: float) -> dict:
    bench = (benchmark or "SPY").strip().upper() or "SPY"
    notional = float(notional or 0.0)
    book = _clean_holdings(holdings)
    symbols = [h["symbol"] for h in book]

    # Try live prices for every holding + benchmark.
    live_maps: dict[str, dict[str, float]] = {}
    for sym in set(symbols + [bench]):
        live_maps[sym] = _price_map(_load_prices(sym, days))

    # Common dates across all holdings + benchmark.
    have_all = all(len(live_maps.get(s, {})) >= 30 for s in symbols + [bench])
    common: list[str] = []
    if have_all:
        date_sets = [set(live_maps[s].keys()) for s in symbols + [bench]]
        common = sorted(set.intersection(*date_sets)) if date_sets else []

    if have_all and len(common) >= 30:
        data_mode, source = "live", "yfinance"
        maps = live_maps
        dates = common
    else:
        # Degrade the whole book to a self-consistent sample so it is populated.
        data_mode, source = "sample", "sample"
        maps = {s: _price_map(_sample_prices(s, days)) for s in set(symbols + [bench])}
        date_sets = [set(maps[s].keys()) for s in symbols + [bench]]
        dates = sorted(set.intersection(*date_sets)) if date_sets else []

    if len(dates) < 2:
        return _empty_payload(bench, days, source)

    base_date = dates[0]
    last_date = dates[-1]

    # Per-holding aligned series + period return.
    per_symbol_series: dict[str, list[float]] = {}
    holding_returns: dict[str, float] = {}
    for sym in symbols:
        m = maps[sym]
        series = [m[d] for d in dates]
        per_symbol_series[sym] = series
        base_p = series[0]
        holding_returns[sym] = (series[-1] / base_p - 1.0) if base_p > 0 else 0.0

    # Weighted book value curve (each holding rebased to its own start, blended).
    book_values: list[float] = []
    for idx, _d in enumerate(dates):
        val = 0.0
        for h in book:
            sym = h["symbol"]
            base_p = per_symbol_series[sym][0]
            if base_p > 0:
                val += h["target_weight"] * (per_symbol_series[sym][idx] / base_p)
        book_values.append(val)

    # Benchmark curve.
    bench_series = [maps[bench][d] for d in dates]

    book_curve = _normalize_to_100(book_values)
    bench_curve = _normalize_to_100(bench_series)

    weighted_total_return = (book_curve[-1] / book_curve[0] - 1.0) * 100.0 if book_curve[0] else None
    bench_total_return = (bench_curve[-1] / bench_curve[0] - 1.0) * 100.0 if bench_curve[0] else None

    # Contribution to return: target_weight * holding_period_return.
    contributions: list[dict] = []
    for h in book:
        sym = h["symbol"]
        ret = holding_returns[sym]
        contributions.append({
            "symbol": sym,
            "target_weight": round(h["target_weight"], 6),
            "return_pct": round(ret * 100.0, 2),
            "contribution_pct": round(h["target_weight"] * ret * 100.0, 3),
        })

    # Current-weight drift: implied current weight = w*(1+ret) / sum(w*(1+ret)).
    grown = {h["symbol"]: h["target_weight"] * (1.0 + holding_returns[h["symbol"]]) for h in book}
    grown_total = sum(grown.values()) or 1.0
    drift: list[dict] = []
    current_weights: dict[str, float] = {}
    for h in book:
        sym = h["symbol"]
        cur_w = grown[sym] / grown_total
        current_weights[sym] = cur_w
        drift.append({
            "symbol": sym,
            "target_weight": round(h["target_weight"], 6),
            "current_weight": round(cur_w, 6),
            "drift_pct": round((cur_w - h["target_weight"]) * 100.0, 3),
        })

    # Risk: weighted vol, benchmark vol, correlation, tracking error.
    book_rets = _daily_returns_aligned(book_values)
    bench_rets = _daily_returns_aligned(bench_series)
    risk = _risk_block(book_rets, bench_rets)

    # Rebalance: delta = target - current; suggested $ over notional.
    rebalance: list[dict] = []
    for h in book:
        sym = h["symbol"]
        target_w = h["target_weight"]
        cur_w = current_weights[sym]
        delta_w = target_w - cur_w
        rebalance.append({
            "symbol": sym,
            "target_weight": round(target_w, 6),
            "current_weight": round(cur_w, 6),
            "delta_pct": round(delta_w * 100.0, 3),
            "suggested_dollars": round(delta_w * notional, 2),
            "action": "buy" if delta_w > 0 else ("trim" if delta_w < 0 else "hold"),
        })

    as_of = last_date if data_mode == "live" else _today().isoformat()

    return {
        "holdings": [{"symbol": h["symbol"], "target_weight": round(h["target_weight"], 6)} for h in book],
        "benchmark": bench,
        "days": days,
        "notional": round(notional, 2),
        "curves": {
            "dates": dates,
            "book": book_curve,
            "benchmark": bench_curve,
        },
        "weighted_total_return_pct": round(weighted_total_return, 2) if weighted_total_return is not None else None,
        "benchmark_total_return_pct": round(bench_total_return, 2) if bench_total_return is not None else None,
        "contributions": contributions,
        "drift": drift,
        "risk": risk,
        "rebalance": rebalance,
        "data_mode": data_mode,
        "as_of": as_of,
        "source": source,
    }


def _risk_block(book_rets: list[float], bench_rets: list[float]) -> dict:
    """Annualized weighted vol, benchmark vol, correlation, tracking error."""
    weighted_vol = bench_vol = corr = te = None
    try:
        if len(book_rets) >= 2:
            weighted_vol = float(np.std(book_rets, ddof=1) * np.sqrt(252) * 100.0)
        if len(bench_rets) >= 2:
            bench_vol = float(np.std(bench_rets, ddof=1) * np.sqrt(252) * 100.0)
        n = min(len(book_rets), len(bench_rets))
        if n >= 20:
            a = np.array(book_rets[-n:])
            b = np.array(bench_rets[-n:])
            if np.std(a) > 0 and np.std(b) > 0:
                corr = float(np.corrcoef(a, b)[0, 1])
            te = float(np.std(a - b, ddof=1) * np.sqrt(252) * 100.0)
    except Exception as e:
        log.warning("weighted risk block failed: %s", e)
    return {
        "weighted_vol_pct": round(weighted_vol, 2) if weighted_vol is not None else None,
        "benchmark_vol_pct": round(bench_vol, 2) if bench_vol is not None else None,
        "correlation_to_benchmark": round(corr, 3) if corr is not None else None,
        "tracking_error_pct": round(te, 2) if te is not None else None,
    }
