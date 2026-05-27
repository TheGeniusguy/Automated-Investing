"""Sector flows: pair-spread dashboard + sector ETF options summary.

Two layers:
  1. Pair spreads — sector ETF ratioed against SPY and against a curated
     pair_etf that captures the risk-on/off axis for that sector
     (e.g. XLK/XLU is growth vs defensive; XLY/XLP is cyclical vs staple).
     Ratios normalized to 100 at series start so cross-pair comparisons work.
  2. Options summary — sector ETF chain_summary at 30d and 90d tenors. Term
     structure delta (30d - 90d) flags inversion (front > back = stress).
     P/C ratios, IV skew, implied move all surfaced.

Pure free data — yfinance only. Reuses the existing options.chain_summary
which has built-in cache + graceful failure modes.
"""
from __future__ import annotations

import logging
import math
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import macro_data, options, sector_detail

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 252  # 1y
SPARK_TAIL = 90


# ── Per-sector pair partner ─────────────────────────────────────────────────
# pair_etf is the "other side" of the relevant risk-on/off pair.

SECTOR_PAIRS: dict[str, tuple[str, str]] = {
    "technology":              ("XLU", "growth vs defensive"),
    "semiconductors":          ("XLU", "cycle vs defensive"),
    "consumer_discretionary":  ("XLP", "cyclical vs staple"),
    "consumer_staples":        ("XLY", "defensive vs cyclical"),
    "industrials":             ("XLU", "cycle vs defensive"),
    "materials":               ("XLP", "cyclical vs staple"),
    "financials":              ("XLU", "spread biz vs bond proxy"),
    "real_estate":             ("XLF", "REIT vs bank"),
    "healthcare":              ("XLI", "defensive vs cyclical"),
    "biotech":                 ("XLY", "speculative vs consumer cyclical"),
    "utilities":               ("XLY", "defensive vs cyclical (inverse)"),
    "oil_gas":                 ("XLF", "commodity cycle vs financial cycle"),
    "communication_services":  ("XLU", "growth vs defensive"),
    "clean_energy":            ("XLE", "clean vs traditional energy"),
    "defense_aerospace":       ("XLI", "defense vs broader industrials"),
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _closes_map(symbol: str) -> dict[str, float]:
    pts = macro_data.fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS)
    return {p["date"]: float(p["value"]) for p in pts if p.get("value") is not None}


def _normalized_ratio(
    numer: dict[str, float], denom: dict[str, float]
) -> list[dict]:
    """Aligned (date, sector/denom * 100/initial) series."""
    common = sorted(set(numer) & set(denom))
    if len(common) < 2:
        return []
    first_ratio = None
    out: list[dict] = []
    for d in common:
        nd = numer.get(d)
        dd = denom.get(d)
        if not nd or not dd or dd <= 0:
            continue
        ratio = nd / dd
        if first_ratio is None:
            first_ratio = ratio
        out.append({"date": d, "value": (ratio / first_ratio) * 100.0 if first_ratio else 0})
    return out


def _change_metric(series: list[dict], bars: int) -> Optional[float]:
    valid = [p for p in series if p.get("value") is not None]
    if len(valid) < 2 or bars < 1:
        return None
    end = valid[-1]["value"]
    idx = max(0, len(valid) - 1 - bars)
    start = valid[idx]["value"]
    if not start:
        return None
    return round(float((end - start) / start * 100.0), 2)


def _build_pair(numer_sym: str, denom_sym: str, label: str, denom_map: dict[str, float] | None = None) -> dict:
    numer_map = _closes_map(numer_sym)
    denom_map = denom_map or _closes_map(denom_sym)
    series = _normalized_ratio(numer_map, denom_map)
    out = {
        "label":            label,
        "numer":            numer_sym,
        "denom":            denom_sym,
        "current":          round(series[-1]["value"], 2) if series else None,
        "change_1w_pct":    _change_metric(series, 5),
        "change_1m_pct":    _change_metric(series, 21),
        "change_3m_pct":    _change_metric(series, 63),
        "change_ytd_pct":   _ytd_change(series),
        "spark":            series[-SPARK_TAIL:],
        "n_obs":            len(series),
    }
    return out


def _ytd_change(series: list[dict]) -> Optional[float]:
    if len(series) < 2:
        return None
    last_year = series[-1]["date"][:4]
    boundary_value = None
    for p in series:
        if p["date"][:4] == last_year:
            boundary_value = p["value"]
            break
    if not boundary_value:
        return None
    end = series[-1]["value"]
    return round(((end - boundary_value) / boundary_value) * 100.0, 2)


# ── Options summary with term structure ─────────────────────────────────────

def _term_structure(symbol: str) -> dict:
    """30d + 90d chain_summary in parallel. Compute term structure delta."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        f30 = pool.submit(options.chain_summary, symbol, 30)
        f90 = pool.submit(options.chain_summary, symbol, 90)
        c30 = f30.result()
        c90 = f90.result()

    iv_30 = _avg_iv(c30)
    iv_90 = _avg_iv(c90)

    term_delta = (iv_30 - iv_90) if (iv_30 is not None and iv_90 is not None) else None
    inverted = bool(term_delta is not None and term_delta > 0)

    return {
        "spot":                     c30.get("spot"),
        "expiry_30":                c30.get("expiry"),
        "expiry_90":                c90.get("expiry"),
        "days_to_30":               c30.get("days_to_expiry"),
        "days_to_90":               c90.get("days_to_expiry"),
        "atm_iv_30d":               iv_30,
        "atm_iv_90d":               iv_90,
        "term_structure_delta":     round(term_delta, 4) if term_delta is not None else None,
        "term_inverted":            inverted,
        "iv_skew_30d":              c30.get("iv_skew"),
        "iv_skew_90d":              c90.get("iv_skew"),
        "pc_ratio_oi_30d":          c30.get("pc_ratio_oi"),
        "pc_ratio_vol_30d":         c30.get("pc_ratio_vol"),
        "implied_move_1sigma_30d":  c30.get("implied_move_1sigma"),
        "implied_move_1sigma_90d":  c90.get("implied_move_1sigma"),
        "error_30":                 c30.get("error"),
        "error_90":                 c90.get("error"),
    }


def _avg_iv(c: dict) -> Optional[float]:
    iv_c = c.get("iv_calls")
    iv_p = c.get("iv_puts")
    parts = [v for v in (iv_c, iv_p) if v is not None]
    if not parts:
        return None
    return round(sum(parts) / len(parts), 4)


# ── Realized vol context ────────────────────────────────────────────────────

def _realized_vol_21d(closes_map: dict[str, float]) -> Optional[float]:
    sorted_dates = sorted(closes_map.keys())
    if len(sorted_dates) < 22:
        return None
    series = [closes_map[d] for d in sorted_dates]
    rets = []
    for i in range(1, len(series)):
        prev, curr = series[i - 1], series[i]
        if prev > 0:
            rets.append((curr - prev) / prev)
    last_21 = rets[-21:]
    if len(last_21) < 2:
        return None
    return statistics.pstdev(last_21) * math.sqrt(252)  # decimal, e.g. 0.20 = 20%


# ── Public API ──────────────────────────────────────────────────────────────

def sector_flows(sector_id: str) -> dict:
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")
    sec = sector_detail.SECTORS[sector_id]
    etf = sec["etf"]
    pair_etf, pair_desc = SECTOR_PAIRS.get(sector_id, ("SPY", "vs market"))

    # Build pair spreads.
    sector_map = _closes_map(etf)
    spy_map = _closes_map("SPY")
    pair_map = _closes_map(pair_etf) if pair_etf != "SPY" else spy_map

    pair_vs_spy   = _build_pair(etf, "SPY",   f"{etf} / SPY", denom_map=spy_map)
    pair_vs_pair  = _build_pair(etf, pair_etf, f"{etf} / {pair_etf} — {pair_desc}", denom_map=pair_map)

    # Realized vol on the sector ETF.
    realized_vol = _realized_vol_21d(sector_map)

    # Options term structure.
    term = _term_structure(etf)

    # IV vs realized: simple ratio.
    iv_vs_realized = None
    if term.get("atm_iv_30d") is not None and realized_vol is not None and realized_vol > 0:
        iv_vs_realized = round(term["atm_iv_30d"] / realized_vol, 2)

    return {
        "sector_id":           sector_id,
        "name":                sec["name"],
        "etf":                 etf,
        "pair_partner":        pair_etf,
        "pair_description":    pair_desc,
        "pairs": [
            pair_vs_spy,
            pair_vs_pair,
        ],
        "options": {
            **term,
            "realized_vol_21d_ann":  round(realized_vol, 4) if realized_vol is not None else None,
            "iv_vs_realized_ratio":  iv_vs_realized,
        },
        "available":           pair_vs_spy.get("current") is not None or pair_vs_pair.get("current") is not None,
    }
