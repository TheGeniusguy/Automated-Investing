"""Sector credit + bond market layer.

Pulls credit-conditions data (ICE BofA OAS series from FRED + yfinance bond
ETFs) and combines into one per-sector view. Three blocks:

  1. Universal credit conditions — broad IG/HY OAS and the rating-tier ladder
     (AAA/AA/A/BBB on IG side; BB/B/CCC on HY side). Same for every sector.
  2. Sector-relevant credit — sector-specific FRED ICE BofA indices where they
     exist (e.g. HY Energy), plus bond ETFs that proxy sector funding (LQD/HYG
     broadly; AMLP for energy MLPs; PFF for financial preferreds; etc.).
  3. Credit-equity divergence — rolling 60D correlation of sector ETF daily
     returns vs broad HY OAS daily *changes*. Normally negative (spreads widen,
     stocks fall). When it flips positive vs the sector's 5y baseline that's
     a divergence flag worth watching.

Requires FRED key for OAS series. yfinance bond ETFs render without a key.
"""
from __future__ import annotations

import logging
import math
import statistics
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from ..config import settings
from . import macro_data, sector_detail

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 1825  # ~5y so we can compute 5y divergence baseline


# ── Universal credit blocks ─────────────────────────────────────────────────

UNIVERSAL_CREDIT_BLOCKS: list[dict] = [
    {"label": "Broad spreads (ICE BofA OAS)", "kpis": [
        {"id": "BAMLC0A0CM",   "label": "IG Master OAS", "source": "fred", "unit": "%",
         "desc": "Investment-grade corporate option-adjusted spread"},
        {"id": "BAMLH0A0HYM2", "label": "HY Master OAS", "source": "fred", "unit": "%",
         "desc": "High-yield corporate OAS — primary credit stress gauge"},
        {"id": "BAMLC8A0C15PY","label": "15+y IG OAS",   "source": "fred", "unit": "%",
         "desc": "Long-dated IG spread — duration-sensitive"},
    ]},
    {"label": "IG by rating", "kpis": [
        {"id": "BAMLC0A1CAAA", "label": "AAA OAS", "source": "fred", "unit": "%", "desc": "Tightest-quality tier"},
        {"id": "BAMLC0A2CAA",  "label": "AA OAS",  "source": "fred", "unit": "%", "desc": "AA-rated corporates"},
        {"id": "BAMLC0A3CA",   "label": "A OAS",   "source": "fred", "unit": "%", "desc": "A-rated tier"},
        {"id": "BAMLC0A4CBBB", "label": "BBB OAS", "source": "fred", "unit": "%", "desc": "Triple-B — fallen-angel risk"},
    ]},
    {"label": "HY by rating", "kpis": [
        {"id": "BAMLH0A1HYBB", "label": "BB OAS",  "source": "fred", "unit": "%", "desc": "Top of HY ladder"},
        {"id": "BAMLH0A2HYB",  "label": "B OAS",   "source": "fred", "unit": "%", "desc": "Middle HY tier"},
        {"id": "BAMLH0A3HYC",  "label": "CCC OAS", "source": "fred", "unit": "%", "desc": "Distressed credit signal"},
    ]},
    {"label": "Universal Bond ETFs (yfinance)", "kpis": [
        {"id": "LQD", "label": "iShares IG Corp", "source": "yfinance", "unit": "$",  "desc": "Investment-grade corp bond ETF"},
        {"id": "HYG", "label": "iShares HY Corp", "source": "yfinance", "unit": "$",  "desc": "High-yield corp bond ETF"},
        {"id": "JNK", "label": "SPDR HY Bond",    "source": "yfinance", "unit": "$",  "desc": "Alt HY proxy"},
        {"id": "TLT", "label": "20+ Year Treas",  "source": "yfinance", "unit": "$",  "desc": "Long duration treasuries"},
        {"id": "AGG", "label": "Core US Aggregate","source": "yfinance","unit": "$",  "desc": "Broad bond market"},
    ]},
]


# ── Per-sector credit add-ons ───────────────────────────────────────────────
# Sector-specific FRED sector indices when available + sector-relevant bond ETFs.
# When a FRED series ID is wrong/discontinued the fetch returns [], the tile
# renders as "Unavailable" — same graceful pattern as the operational module.

SECTOR_CREDIT_SPECIFIC: dict[str, dict] = {
    "oil_gas": {
        "fred": [
            {"id": "BAMLHYH0A3HYEY",  "label": "HY Energy YTW", "source": "fred", "unit": "%",
             "desc": "Energy HY yield-to-worst (FRED ICE BofA)"},
        ],
        "etfs": [
            {"id": "AMLP", "label": "MLP ETF",       "source": "yfinance", "unit": "$",
             "desc": "Midstream MLP cash-flow proxy"},
        ],
    },
    "financials": {
        "etfs": [
            {"id": "PFF", "label": "iShares Preferred", "source": "yfinance", "unit": "$",
             "desc": "Bank/insurer preferred stock"},
            {"id": "PGX", "label": "Invesco Preferred", "source": "yfinance", "unit": "$",
             "desc": "Alt preferred stock proxy"},
        ],
    },
    "real_estate": {
        "etfs": [
            {"id": "MBB",  "label": "MBS ETF",         "source": "yfinance", "unit": "$",
             "desc": "Agency MBS — housing finance pulse"},
            {"id": "VMBS", "label": "Vanguard MBS",    "source": "yfinance", "unit": "$",
             "desc": "Alt MBS proxy"},
            {"id": "REM",  "label": "Mortgage REIT ETF","source": "yfinance","unit": "$",
             "desc": "Mortgage REITs — rate spread P&L"},
        ],
    },
    "utilities": {
        "etfs": [
            {"id": "BIV", "label": "Interm Bond ETF",  "source": "yfinance", "unit": "$",
             "desc": "Util-like duration exposure"},
        ],
    },
    "technology": {
        "etfs": [
            {"id": "CWB", "label": "Convertible Bond ETF","source": "yfinance", "unit": "$",
             "desc": "Tech-heavy convertibles funding gauge"},
        ],
    },
    "biotech": {
        "etfs": [
            {"id": "CWB", "label": "Convertible Bond ETF","source": "yfinance", "unit": "$",
             "desc": "Biotech often funds via converts"},
        ],
    },
    "clean_energy": {
        "etfs": [
            {"id": "GRNB","label": "Green Bond ETF",   "source": "yfinance", "unit": "$",
             "desc": "Project-finance green bonds"},
        ],
    },
    "consumer_discretionary": {
        "etfs": [
            {"id": "SHYG","label": "Short HY ETF",     "source": "yfinance", "unit": "$",
             "desc": "Short-duration HY exposure"},
        ],
    },
    "industrials": {
        "etfs": [
            {"id": "IGIB","label": "Interm IG Corp",   "source": "yfinance", "unit": "$",
             "desc": "Industrial-heavy IG corp exposure"},
        ],
    },
}

SPARK_TAIL = 90


# ── Helpers ─────────────────────────────────────────────────────────────────

def _ytd_lookback(points: list[dict]) -> Optional[int]:
    valid = [p for p in points if p.get("value") is not None]
    if not valid:
        return None
    last_date = valid[-1]["date"]
    last_year = last_date[:4]
    for i in range(len(valid) - 1, -1, -1):
        if valid[i]["date"][:4] != last_year:
            return (len(valid) - 1) - i
    return len(valid) - 1


def _pct_change(points: list[dict], lookback: int) -> Optional[float]:
    valid = [p for p in points if p.get("value") is not None]
    if len(valid) < 2 or lookback < 1:
        return None
    last = valid[-1]["value"]
    idx = max(0, len(valid) - 1 - lookback)
    base = valid[idx]["value"]
    if not base or base == 0:
        return None
    return round(float((last - base) / base * 100.0), 2)


def _abs_change(points: list[dict], lookback: int) -> Optional[float]:
    valid = [p for p in points if p.get("value") is not None]
    if len(valid) < 2 or lookback < 1:
        return None
    last = valid[-1]["value"]
    idx = max(0, len(valid) - 1 - lookback)
    base = valid[idx]["value"]
    return round(float(last - base), 4)


def _fetch_kpi(kpi: dict, days: int) -> tuple[str, list[dict]]:
    sid = kpi["id"]
    src = kpi["source"]
    if src == "fred" and not settings.has_fred:
        return sid, []
    try:
        return sid, macro_data.fetch_explicit(sid, source=src, days=days)
    except Exception as exc:
        log.warning("Credit KPI fetch %s failed: %s", sid, exc)
        return sid, []


def _compute_tile(kpi: dict, points: list[dict]) -> dict:
    valid = [p for p in points if p.get("value") is not None]
    last = valid[-1]["value"] if valid else None
    last_date = valid[-1]["date"] if valid else None
    unit = kpi.get("unit", "")
    is_rate = unit in ("%", "bp")
    ytd_lk = _ytd_lookback(points)
    return {
        **kpi,
        "last_value":      float(last) if last is not None else None,
        "last_date":       last_date,
        "change_1d_pct":   _pct_change(points, 1),
        "change_1w_pct":   _pct_change(points, 5),
        "change_1m_pct":   _pct_change(points, 21),
        "change_3m_pct":   _pct_change(points, 63),
        "change_ytd_pct":  _pct_change(points, ytd_lk) if ytd_lk else None,
        "change_1d_abs":   _abs_change(points, 1) if is_rate else None,
        "change_1w_abs":   _abs_change(points, 5) if is_rate else None,
        "change_1m_abs":   _abs_change(points, 21) if is_rate else None,
        "spark": [
            {"date": p["date"], "value": p["value"]}
            for p in points[-SPARK_TAIL:] if p.get("value") is not None
        ],
        "available": last is not None,
    }


def _daily_returns(points: list[dict]) -> tuple[list[str], list[float]]:
    valid = [p for p in points if p.get("value") is not None]
    dates: list[str] = []
    rets: list[float] = []
    for i in range(1, len(valid)):
        prev = valid[i - 1]["value"]
        curr = valid[i]["value"]
        if prev > 0:
            dates.append(valid[i]["date"])
            rets.append((curr - prev) / prev)
    return dates, rets


def _daily_changes(points: list[dict]) -> tuple[list[str], list[float]]:
    """Absolute daily change (for rate/spread series). Same shape as returns."""
    valid = [p for p in points if p.get("value") is not None]
    dates: list[str] = []
    chg: list[float] = []
    for i in range(1, len(valid)):
        dates.append(valid[i]["date"])
        chg.append(valid[i]["value"] - valid[i - 1]["value"])
    return dates, chg


def _pearson(xs: list[float], ys: list[float]) -> Optional[float]:
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _rolling_corr(xs: list[float], ys: list[float], window: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(xs)
    n = min(len(xs), len(ys))
    if n < window:
        return out
    for i in range(window - 1, n):
        x = xs[i - window + 1 : i + 1]
        y = ys[i - window + 1 : i + 1]
        try:
            out[i] = _pearson(x, y)
        except Exception:
            out[i] = None
    return out


def _credit_equity_divergence(
    sector_returns: list[float], sector_dates: list[str],
    hy_changes: list[float],      hy_dates: list[str],
) -> dict:
    """Rolling 60D correlation of sector ETF returns vs HY OAS daily changes.

    Normally negative (spreads widen -> stocks fall). Flag divergence when
    current correlation is >= +0.1 OR more than 1σ above 5y mean.
    """
    if not sector_returns or not hy_changes:
        return {"available": False, "reason": "Missing sector or HY OAS history"}
    sector_map = dict(zip(sector_dates, sector_returns))
    hy_map = dict(zip(hy_dates, hy_changes))
    common = sorted(set(sector_map) & set(hy_map))
    if len(common) < 90:
        return {"available": False, "reason": "Not enough overlapping history"}
    sxs = [sector_map[d] for d in common]
    hxs = [hy_map[d] for d in common]
    rolling = _rolling_corr(sxs, hxs, 60)
    valid = [c for c in rolling if c is not None]
    if not valid:
        return {"available": False, "reason": "Rolling correlation failed"}
    current = valid[-1]
    mean = sum(valid) / len(valid)
    std = statistics.pstdev(valid)
    z = ((current - mean) / std) if std > 0 else None
    flagged = bool(current >= 0.10 or (z is not None and z >= 1.0))
    return {
        "available":       True,
        "current_corr":    round(current, 3),
        "baseline_mean":   round(mean, 3),
        "baseline_std":    round(std, 3),
        "z_score":         round(z, 2) if z is not None else None,
        "flagged":         flagged,
        "window":          60,
        "n_obs":           len(valid),
        "interpretation": _interpret_divergence(current, z, flagged),
    }


def _interpret_divergence(current: float, z: Optional[float], flagged: bool) -> str:
    if flagged:
        if current >= 0.10:
            return ("Divergence — sector stocks and HY spreads moving together. "
                    "Risk-on rally may be ignoring credit stress.")
        return ("Correlation drifting positive vs the sector's 5y baseline — "
                "watch for risk-asset divergence from credit signal.")
    if current <= -0.30:
        return "Strongly negative — stocks and spreads in their normal inverse dance."
    if current <= -0.10:
        return "Normal inverse relationship — credit and equity in sync."
    return "Near zero correlation — credit and equity decoupled but not flagged."


# ── Public API ──────────────────────────────────────────────────────────────

def sector_credit(sector_id: str) -> dict:
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")
    sec = sector_detail.SECTORS[sector_id]
    etf = sec["etf"]

    # Build the full KPI fetch list = universal blocks + sector-specific KPIs.
    sector_specific = SECTOR_CREDIT_SPECIFIC.get(sector_id, {})
    specific_block_kpis = (sector_specific.get("fred") or []) + (sector_specific.get("etfs") or [])

    all_kpis: list[dict] = []
    for block in UNIVERSAL_CREDIT_BLOCKS:
        all_kpis.extend(block["kpis"])
    all_kpis.extend(specific_block_kpis)

    # Parallel fetch.
    fetched: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(_fetch_kpi, k, LOOKBACK_DAYS): k for k in all_kpis}
        # Also fetch sector ETF + HY broad in parallel for the divergence calc
        # (HY is already in all_kpis but having a dedicated fetch with longer
        # lookback keeps the loop simple).
        f_etf = pool.submit(macro_data.fetch_arbitrary_ticker, etf, LOOKBACK_DAYS)
        for fut in as_completed(futs):
            sid, points = fut.result()
            fetched[sid] = points
        etf_points = f_etf.result()

    # Build output buckets.
    out_buckets: list[dict] = []
    any_available = False
    for block in UNIVERSAL_CREDIT_BLOCKS:
        tiles = []
        for kpi in block["kpis"]:
            if kpi["source"] == "fred" and not settings.has_fred:
                tiles.append({
                    **kpi,
                    "last_value": None, "last_date": None,
                    "change_1d_pct": None, "change_1w_pct": None,
                    "change_1m_pct": None, "change_3m_pct": None,
                    "change_ytd_pct": None,
                    "change_1d_abs": None, "change_1w_abs": None, "change_1m_abs": None,
                    "spark": [], "available": False, "reason": "FRED_API_KEY not configured",
                })
                continue
            tile = _compute_tile(kpi, fetched.get(kpi["id"], []))
            if tile["available"]:
                any_available = True
            tiles.append(tile)
        out_buckets.append({"label": block["label"], "kpis": tiles})

    # Sector-specific bucket (if any KPIs are configured for this sector).
    if specific_block_kpis:
        tiles = []
        for kpi in specific_block_kpis:
            if kpi["source"] == "fred" and not settings.has_fred:
                tiles.append({
                    **kpi,
                    "last_value": None, "last_date": None,
                    "change_1d_pct": None, "change_1w_pct": None,
                    "change_1m_pct": None, "change_3m_pct": None,
                    "change_ytd_pct": None,
                    "change_1d_abs": None, "change_1w_abs": None, "change_1m_abs": None,
                    "spark": [], "available": False, "reason": "FRED_API_KEY not configured",
                })
                continue
            tile = _compute_tile(kpi, fetched.get(kpi["id"], []))
            if tile["available"]:
                any_available = True
            tiles.append(tile)
        out_buckets.append({
            "label":         f"{sec['name']}-specific credit",
            "kpis":          tiles,
            "sector_specific": True,
        })

    # Divergence indicator (only computable when HY broad is available).
    hy_points = fetched.get("BAMLH0A0HYM2", [])
    sector_dates, sector_rets = _daily_returns(etf_points)
    hy_dates, hy_chg = _daily_changes(hy_points)
    divergence = _credit_equity_divergence(sector_rets, sector_dates, hy_chg, hy_dates)

    return {
        "sector_id":      sector_id,
        "name":           sec["name"],
        "etf":            etf,
        "fred_available": settings.has_fred,
        "lookback_days":  LOOKBACK_DAYS,
        "spark_tail":     SPARK_TAIL,
        "buckets":        out_buckets,
        "divergence":     divergence,
        "available":      any_available,
    }
