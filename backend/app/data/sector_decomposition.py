"""Sector constituent decomposition.

For each sector's key_stocks list:
  1. Cap-weighted contribution per stock per window (1d, 1w, mtd, 1m, 3m, ytd, 1y).
     contribution_i = weight_i × return_i. Sums across constituents = basket return.
  2. "If removed" simulator: re-normalize weights ex-top-N and recompute basket return,
     showing what the sector would have done without its biggest names.
  3. Concentration: Herfindahl index + top 1/3/5/10 weight share.
  4. Hidden weakness detector: when basket positive but most constituents negative,
     identify the 1-2 names holding it up.

Weights are cap-weighted approximations of the curated key_stocks list, not actual
ETF holdings. The shape is honest about that via response metadata.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Optional

from . import macro_data, sector_detail

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 400  # ~1.5y so YTD always has enough history


# ── Window definitions ───────────────────────────────────────────────────────
# Some windows are calendar-anchored (MTD, YTD) and some are bar-count.

WINDOWS = [
    {"key": "1d",  "label": "1D",  "type": "bars", "days": 1},
    {"key": "1w",  "label": "1W",  "type": "bars", "days": 5},
    {"key": "mtd", "label": "MTD", "type": "calendar"},
    {"key": "1m",  "label": "1M",  "type": "bars", "days": 21},
    {"key": "3m",  "label": "3M",  "type": "bars", "days": 63},
    {"key": "ytd", "label": "YTD", "type": "calendar"},
    {"key": "1y",  "label": "1Y",  "type": "bars", "days": 252},
]


# ── Per-symbol fetch ────────────────────────────────────────────────────────

def _load_closes(symbol: str) -> list[tuple[str, float]]:
    """(date, close) sorted ascending from cached yfinance fetcher."""
    try:
        points = macro_data.fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS)
        return [(p["date"], p["value"]) for p in points if p.get("value") is not None]
    except Exception as exc:
        log.warning("Decomposition close load failed for %s: %s", symbol, exc)
        return []


def _market_cap(symbol: str) -> Optional[float]:
    """Pull market cap from yfinance .info (fast — internally cached by yfinance)."""
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
        mc = info.get("marketCap")
        return float(mc) if mc else None
    except Exception as exc:
        log.warning("Market cap load failed for %s: %s", symbol, exc)
        return None


def _symbol_payload(symbol: str) -> dict:
    """Combined per-symbol fetch for parallel use."""
    closes = _load_closes(symbol)
    mc = _market_cap(symbol)
    return {"symbol": symbol, "closes": closes, "market_cap": mc}


# ── Return computation ──────────────────────────────────────────────────────

def _return_bars(closes: list[tuple[str, float]], bars: int) -> Optional[float]:
    if len(closes) < 2 or bars < 1:
        return None
    end = closes[-1][1]
    idx = max(0, len(closes) - 1 - bars)
    start = closes[idx][1]
    if not start or start <= 0:
        return None
    return float((end - start) / start * 100.0)


def _return_calendar(closes: list[tuple[str, float]], anchor: str) -> Optional[float]:
    """Compute return from the last close before/on `anchor` to today.

    anchor: 'ytd' = first trading day of current year
            'mtd' = first trading day of current month
    """
    if len(closes) < 2:
        return None
    last_date_str = closes[-1][0]
    try:
        last_dt = date.fromisoformat(last_date_str)
    except ValueError:
        return None

    if anchor == "ytd":
        boundary = date(last_dt.year, 1, 1)
    elif anchor == "mtd":
        boundary = date(last_dt.year, last_dt.month, 1)
    else:
        return None

    # First close on or after boundary becomes our basis. Anything before that is
    # the prior-period close (which we don't want for the boundary anchor).
    basis_close: Optional[float] = None
    for d, c in closes:
        if date.fromisoformat(d) >= boundary:
            basis_close = c
            break
    if basis_close is None or basis_close <= 0:
        return None
    end = closes[-1][1]
    return float((end - basis_close) / basis_close * 100.0)


def _return_for_window(closes: list[tuple[str, float]], window: dict) -> Optional[float]:
    if window["type"] == "bars":
        return _return_bars(closes, window["days"])
    return _return_calendar(closes, window["key"])


# ── Decomposition core ──────────────────────────────────────────────────────

def _normalize_weights(market_caps: dict[str, Optional[float]]) -> dict[str, float]:
    """Normalize market caps to weights summing to 1. Symbols missing a cap drop out."""
    valid = {s: mc for s, mc in market_caps.items() if mc and mc > 0}
    total = sum(valid.values())
    if total <= 0:
        return {}
    return {s: mc / total for s, mc in valid.items()}


def _basket_return_excluding(
    weights: dict[str, float],
    returns: dict[str, Optional[float]],
    exclude: set[str],
) -> Optional[float]:
    """Re-normalize weights ex-excluded names and recompute basket return.

    Drops symbols whose return is None from the calculation entirely.
    """
    active = {
        s: w for s, w in weights.items()
        if s not in exclude and returns.get(s) is not None
    }
    total = sum(active.values())
    if total <= 0:
        return None
    return sum((w / total) * returns[s] for s, w in active.items())  # type: ignore[operator]


def _top_n_by_weight(weights: dict[str, float], n: int) -> list[str]:
    return [s for s, _ in sorted(weights.items(), key=lambda kv: kv[1], reverse=True)[:n]]


def _herfindahl(weights: dict[str, float]) -> float:
    """Sum of squared weights. 1.0 = single holding; 1/N = perfectly equal."""
    return float(sum(w * w for w in weights.values()))


def _hidden_weakness(
    weights: dict[str, float],
    returns: dict[str, Optional[float]],
    contributions: dict[str, float],
    basket_return: Optional[float],
) -> Optional[dict]:
    """Detect when basket is positive but breadth is weak.

    Triggers when:
      - basket_return > +0.1% (small positive ignored as noise)
      - >= 50% of constituents have negative returns
    Returns the top-3 positive contributors that are masking the weakness.
    """
    if basket_return is None or basket_return <= 0.1:
        return None
    valid_returns = [r for r in returns.values() if r is not None]
    if not valid_returns:
        return None
    n_neg = sum(1 for r in valid_returns if r < 0)
    pct_neg = (n_neg / len(valid_returns)) * 100.0
    if pct_neg < 50.0:
        return None

    # Names with positive contribution, sorted by contribution descending.
    positive = sorted(
        ((s, c) for s, c in contributions.items() if c > 0),
        key=lambda kv: kv[1],
        reverse=True,
    )
    masking: list[dict] = []
    cumulative = 0.0
    for s, c in positive:
        masking.append({"symbol": s, "contribution_pct": round(c, 3)})
        cumulative += c
        # Once positives cover the basket return, we've identified who's holding it up.
        if cumulative >= basket_return and len(masking) >= 1:
            break
        if len(masking) >= 3:
            break

    return {
        "basket_return_pct":      round(basket_return, 3),
        "pct_constituents_negative": round(pct_neg, 1),
        "n_constituents":         len(valid_returns),
        "n_negative":             n_neg,
        "masking_names":          masking,
    }


# ── Public API ───────────────────────────────────────────────────────────────

def sector_decomposition(sector_id: str) -> dict:
    """Compute constituent decomposition for one sector.

    Response shape:
    {
      "sector_id":..., "etf":..., "windows":[...],
      "constituents": [
        {"symbol", "name", "market_cap", "weight_pct",
         "returns_pct": {window_key: float|null},
         "contributions_pct": {window_key: float|null}}
      ],
      "basket_returns_pct": {window_key: float|null},
      "etf_returns_pct":    {window_key: float|null},
      "concentration": {herfindahl, top1/3/5/10_weight_pct, constituent_count},
      "if_removed": {window_key: [{"label","removed":[...],"return_pct","delta_vs_full_pct"}, ...]},
      "hidden_weakness": {window_key: <detector output> | null},
      "notes": str,
    }
    """
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")

    sec = sector_detail.SECTORS[sector_id]
    etf = sec["etf"]
    symbols = list(sec["key_stocks"])

    # Parallel fetch closes + market caps for every constituent (+ ETF for reference).
    payloads: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_symbol_payload, s): s for s in symbols + [etf]}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                payloads[sym] = fut.result()
            except Exception as exc:
                log.warning("Decomposition payload failed for %s: %s", sym, exc)
                payloads[sym] = {"symbol": sym, "closes": [], "market_cap": None}

    # Build weights from constituent market caps only (not ETF).
    caps = {s: payloads[s].get("market_cap") for s in symbols}
    weights = _normalize_weights(caps)
    if not weights:
        # Fall back to equal-weight when no market caps are available.
        weights = {s: 1.0 / len(symbols) for s in symbols}

    # Returns per window per symbol.
    constituent_returns: dict[str, dict[str, Optional[float]]] = {}
    for s in symbols:
        closes = payloads[s].get("closes", [])
        constituent_returns[s] = {w["key"]: _return_for_window(closes, w) for w in WINDOWS}

    # Contributions per window per symbol = weight × return.
    constituent_contribs: dict[str, dict[str, Optional[float]]] = {}
    for s in symbols:
        wt = weights.get(s)
        if wt is None:
            constituent_contribs[s] = {w["key"]: None for w in WINDOWS}
            continue
        constituent_contribs[s] = {}
        for w in WINDOWS:
            r = constituent_returns[s].get(w["key"])
            constituent_contribs[s][w["key"]] = (wt * r) if r is not None else None

    # Basket return per window = sum of contributions (over symbols with valid return).
    basket_returns: dict[str, Optional[float]] = {}
    for w in WINDOWS:
        key = w["key"]
        # Re-normalize over symbols with valid returns this window.
        valid_pairs = [(s, weights[s], constituent_returns[s][key])
                       for s in symbols
                       if s in weights and constituent_returns[s][key] is not None]
        total_w = sum(wt for _, wt, _ in valid_pairs)
        if total_w <= 0:
            basket_returns[key] = None
        else:
            basket_returns[key] = sum((wt / total_w) * r for _, wt, r in valid_pairs)

    # ETF return per window (the "truth" reference — actual ETF performance).
    etf_closes = payloads.get(etf, {}).get("closes", [])
    etf_returns = {w["key"]: _return_for_window(etf_closes, w) for w in WINDOWS}

    # Concentration.
    sorted_weights = sorted(weights.values(), reverse=True)

    def _top_n_share(n: int) -> float:
        return round(sum(sorted_weights[:n]) * 100.0, 2)

    concentration = {
        "herfindahl":            round(_herfindahl(weights), 4),
        "constituent_count":     len(weights),
        "top1_weight_pct":       _top_n_share(1),
        "top3_weight_pct":       _top_n_share(3),
        "top5_weight_pct":       _top_n_share(5),
        "top10_weight_pct":      _top_n_share(10),
    }

    # "If removed" simulator: full, ex-top-1, ex-top-3, ex-top-5.
    top1 = _top_n_by_weight(weights, 1)
    top3 = _top_n_by_weight(weights, 3)
    top5 = _top_n_by_weight(weights, 5)
    if_removed: dict[str, list[dict]] = {}
    for w in WINDOWS:
        key = w["key"]
        rets = {s: constituent_returns[s][key] for s in symbols}
        full = _basket_return_excluding(weights, rets, set())
        ex1  = _basket_return_excluding(weights, rets, set(top1))
        ex3  = _basket_return_excluding(weights, rets, set(top3))
        ex5  = _basket_return_excluding(weights, rets, set(top5))

        def _row(label: str, removed: list[str], r: Optional[float]) -> dict:
            return {
                "label":             label,
                "removed":           removed,
                "return_pct":        round(r, 3) if r is not None else None,
                "delta_vs_full_pct": round(r - full, 3) if r is not None and full is not None else None,
            }
        if_removed[key] = [
            _row("Full basket", [], full),
            _row(f"ex-top-1 ({_join_names(top1)})", top1, ex1),
            _row(f"ex-top-3 ({_join_names(top3)})", top3, ex3),
            _row(f"ex-top-5 ({_join_names(top5)})", top5, ex5),
        ]

    # Hidden weakness check per window.
    hidden_weakness: dict[str, Optional[dict]] = {}
    for w in WINDOWS:
        key = w["key"]
        rets = {s: constituent_returns[s][key] for s in symbols}
        contribs = {s: c for s, c in
                    ((s, constituent_contribs[s][key]) for s in symbols)
                    if c is not None}
        hidden_weakness[key] = _hidden_weakness(weights, rets, contribs, basket_returns[key])

    # Build per-constituent rows, sorted by weight descending.
    rows: list[dict] = []
    for s in symbols:
        rows.append({
            "symbol":              s,
            "market_cap":          caps.get(s),
            "weight_pct":          round(weights.get(s, 0) * 100.0, 3),
            "returns_pct":         {k: (round(v, 3) if v is not None else None)
                                    for k, v in constituent_returns[s].items()},
            "contributions_pct":   {k: (round(v, 3) if v is not None else None)
                                    for k, v in constituent_contribs[s].items()},
        })
    rows.sort(key=lambda r: r["weight_pct"], reverse=True)

    return {
        "sector_id":          sector_id,
        "name":               sec["name"],
        "etf":                etf,
        "windows":            [{"key": w["key"], "label": w["label"]} for w in WINDOWS],
        "constituents":       rows,
        "basket_returns_pct": {k: (round(v, 3) if v is not None else None)
                               for k, v in basket_returns.items()},
        "etf_returns_pct":    {k: (round(v, 3) if v is not None else None)
                               for k, v in etf_returns.items()},
        "concentration":      concentration,
        "if_removed":         if_removed,
        "hidden_weakness":    hidden_weakness,
        "notes": (
            "Weights are cap-weighted across the sector's curated key_stocks list, "
            "not actual ETF holdings. Basket return may differ from ETF return when "
            "the curated list doesn't match the underlying index."
        ),
    }


def _join_names(symbols: list[str]) -> str:
    return ", ".join(symbols[:3]) + ("..." if len(symbols) > 3 else "")
