"""ETF Net-Flow Dashboard (estimated creation/redemption rotation).

Estimates where money is rotating across ETFs by approximating each fund's net
dollar flow, then ranks and aggregates by asset class and sector. Extends the
shipped ETF tracker (which shows AUM / performance / holdings) with a flow lens.

HONEST METHODOLOGY NOTE (carried in the payload as `method`):
True ETF net flow = (delta shares-outstanding) x NAV, i.e. creation/redemption
activity. A single yfinance `.info` snapshot exposes only the CURRENT
sharesOutstanding, not a historical series, and yfinance does NOT cleanly expose
prior shares-outstanding observations. So the LIVE path does NOT claim exact
creation/redemption data. Instead it estimates net flow from recent price/volume
action as a money-flow proxy:

    est_daily_flow ~= avg_daily_dollar_volume x net_pressure

where `net_pressure` is a bounded signed fraction derived from the fund's recent
price trend (a directional money-flow sign, clamped). Weekly flow scales the
daily estimate across the trailing week. This is a PROXY for rotation, not
settled fund-flow data, and the payload's `method` field says so. If two
sharesOutstanding observations were ever available the same shape would carry the
true delta-shares x NAV figure; the contract is method-tagged so the estimate is
never misrepresented as exact.

Live path reuses the SAME yfinance access pattern as `etf_tracking.py`
(yf.Ticker(...).info for sharesOutstanding / price / totalAssets, plus a short
history pull for volume + trend), bounded by a wall-clock budget and a capped
universe. When too little resolves we degrade to deterministic md5-seeded SAMPLE
flows (realistic rotation: inflows to SPY/QQQ/XLK/TLT, outflows from XLE) with
per-ETF + aggregated group flows. This module never raises - it always returns a
populated payload tagged with data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

METHOD_LIVE = "volume_moneyflow_proxy"
METHOD_SAMPLE = "modeled_rotation_sample"

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 7.0
# Cap how many ETFs we ever touch live (keeps it FAST + never stalls).
LIVE_MAX = 28
# Trailing window (calendar-ish days) pulled for volume + trend.
HIST_DAYS = 30
# Fraction of dollar volume treated as "net" at full directional conviction.
MAX_NET_PRESSURE = 0.22
# Sensitivity mapping a trailing return into net pressure before clamping.
TREND_SCALE = 6.0

# ---------------------------------------------------------------------------
# Bounded ETF universe, grouped by asset class / sector.
# `name` cosmetic; `asset_class` drives aggregation; `sector` is the rotation key
# for sector funds (and mirrors the asset class for broad / non-sector funds).
# ---------------------------------------------------------------------------
UNIVERSE: list[dict] = [
    # Broad equity
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "asset_class": "Broad Equity", "sector": "US Large Cap"},
    {"symbol": "QQQ", "name": "Invesco QQQ Trust", "asset_class": "Broad Equity", "sector": "US Large Cap"},
    {"symbol": "IWM", "name": "iShares Russell 2000 ETF", "asset_class": "Broad Equity", "sector": "US Small Cap"},
    {"symbol": "VTI", "name": "Vanguard Total Stock Market ETF", "asset_class": "Broad Equity", "sector": "US Total Market"},
    # Sectors (GICS-ish via Select Sector SPDRs)
    {"symbol": "XLK", "name": "Technology Select Sector SPDR", "asset_class": "Sector", "sector": "Technology"},
    {"symbol": "XLF", "name": "Financial Select Sector SPDR", "asset_class": "Sector", "sector": "Financials"},
    {"symbol": "XLE", "name": "Energy Select Sector SPDR", "asset_class": "Sector", "sector": "Energy"},
    {"symbol": "XLV", "name": "Health Care Select Sector SPDR", "asset_class": "Sector", "sector": "Health Care"},
    {"symbol": "XLI", "name": "Industrial Select Sector SPDR", "asset_class": "Sector", "sector": "Industrials"},
    {"symbol": "XLY", "name": "Consumer Discretionary Select Sector SPDR", "asset_class": "Sector", "sector": "Consumer Discretionary"},
    {"symbol": "XLP", "name": "Consumer Staples Select Sector SPDR", "asset_class": "Sector", "sector": "Consumer Staples"},
    {"symbol": "XLU", "name": "Utilities Select Sector SPDR", "asset_class": "Sector", "sector": "Utilities"},
    {"symbol": "XLB", "name": "Materials Select Sector SPDR", "asset_class": "Sector", "sector": "Materials"},
    {"symbol": "XLRE", "name": "Real Estate Select Sector SPDR", "asset_class": "Sector", "sector": "Real Estate"},
    {"symbol": "XLC", "name": "Communication Services Select Sector SPDR", "asset_class": "Sector", "sector": "Communication Services"},
    # Fixed income
    {"symbol": "AGG", "name": "iShares Core US Aggregate Bond ETF", "asset_class": "Fixed Income", "sector": "Aggregate Bonds"},
    {"symbol": "BND", "name": "Vanguard Total Bond Market ETF", "asset_class": "Fixed Income", "sector": "Aggregate Bonds"},
    {"symbol": "TLT", "name": "iShares 20+ Year Treasury Bond ETF", "asset_class": "Fixed Income", "sector": "Long Treasuries"},
    {"symbol": "HYG", "name": "iShares iBoxx High Yield Corporate Bond ETF", "asset_class": "Fixed Income", "sector": "High Yield Credit"},
    {"symbol": "LQD", "name": "iShares iBoxx Investment Grade Corporate Bond ETF", "asset_class": "Fixed Income", "sector": "IG Credit"},
    # International
    {"symbol": "EFA", "name": "iShares MSCI EAFE ETF", "asset_class": "International", "sector": "Developed ex-US"},
    {"symbol": "VEA", "name": "Vanguard FTSE Developed Markets ETF", "asset_class": "International", "sector": "Developed ex-US"},
    {"symbol": "EEM", "name": "iShares MSCI Emerging Markets ETF", "asset_class": "International", "sector": "Emerging Markets"},
    {"symbol": "VWO", "name": "Vanguard FTSE Emerging Markets ETF", "asset_class": "International", "sector": "Emerging Markets"},
    # Commodities / metals
    {"symbol": "GLD", "name": "SPDR Gold Shares", "asset_class": "Commodities", "sector": "Gold"},
    {"symbol": "SLV", "name": "iShares Silver Trust", "asset_class": "Commodities", "sector": "Silver"},
    {"symbol": "USO", "name": "United States Oil Fund", "asset_class": "Commodities", "sector": "Crude Oil"},
]

# Sample AUM anchors (raw dollars) so flow-as-%-of-AUM reads realistically.
SAMPLE_AUM: dict[str, float] = {
    "SPY": 555_000_000_000, "QQQ": 290_000_000_000, "IWM": 68_000_000_000, "VTI": 410_000_000_000,
    "XLK": 72_000_000_000, "XLF": 48_000_000_000, "XLE": 38_000_000_000, "XLV": 40_000_000_000,
    "XLI": 20_000_000_000, "XLY": 21_000_000_000, "XLP": 16_000_000_000, "XLU": 16_000_000_000,
    "XLB": 6_000_000_000, "XLRE": 7_000_000_000, "XLC": 19_000_000_000,
    "AGG": 120_000_000_000, "BND": 118_000_000_000, "TLT": 52_000_000_000, "HYG": 16_000_000_000, "LQD": 32_000_000_000,
    "EFA": 58_000_000_000, "VEA": 140_000_000_000, "EEM": 18_000_000_000, "VWO": 88_000_000_000,
    "GLD": 78_000_000_000, "SLV": 14_000_000_000, "USO": 1_400_000_000,
}

# Sample price anchors (recent-ish) for $ volume scaling.
SAMPLE_PRICE: dict[str, float] = {
    "SPY": 545.0, "QQQ": 470.0, "IWM": 215.0, "VTI": 270.0,
    "XLK": 225.0, "XLF": 44.0, "XLE": 92.0, "XLV": 145.0, "XLI": 135.0, "XLY": 195.0,
    "XLP": 80.0, "XLU": 73.0, "XLB": 90.0, "XLRE": 40.0, "XLC": 88.0,
    "AGG": 98.0, "BND": 73.0, "TLT": 92.0, "HYG": 79.0, "LQD": 109.0,
    "EFA": 82.0, "VEA": 50.0, "EEM": 44.0, "VWO": 46.0,
    "GLD": 215.0, "SLV": 27.0, "USO": 78.0,
}

# Curated directional bias for the sample narrative (signed, roughly -1..+1):
# strong inflows to SPY/QQQ/XLK + bond bid into TLT, persistent outflows from XLE.
SAMPLE_BIAS: dict[str, float] = {
    "SPY": 0.85, "QQQ": 0.78, "VTI": 0.55, "IWM": -0.30,
    "XLK": 0.92, "XLF": 0.34, "XLE": -0.80, "XLV": 0.18, "XLI": 0.22, "XLY": 0.40,
    "XLP": -0.25, "XLU": 0.30, "XLB": -0.18, "XLRE": -0.12, "XLC": 0.48,
    "AGG": 0.36, "BND": 0.30, "TLT": 0.70, "HYG": -0.22, "LQD": 0.26,
    "EFA": 0.20, "VEA": 0.28, "EEM": -0.34, "VWO": -0.20,
    "GLD": 0.62, "SLV": 0.40, "USO": -0.45,
}


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(symbol: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by symbol + salt."""
    return (_hash(symbol, salt) % 1_000_000) / 1_000_000.0


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _direction(flow: float) -> str:
    if flow > 0:
        return "inflow"
    if flow < 0:
        return "outflow"
    return "flat"


def _humanize(amount: float | None) -> str | None:
    if amount is None:
        return None
    sign = "-" if amount < 0 else ""
    a = abs(float(amount))
    if a >= 1e9:
        return f"{sign}${a / 1e9:.2f}B"
    if a >= 1e6:
        return f"{sign}${a / 1e6:.1f}M"
    if a >= 1e3:
        return f"{sign}${a / 1e3:.1f}K"
    return f"{sign}${a:,.0f}"


# ---------------------------------------------------------------------------
# Live path (reuses yfinance access, bounded)
# ---------------------------------------------------------------------------

def _live_one(symbol: str) -> dict | None:
    """Best-effort single-ETF live read: AUM, price, avg $ volume, trend.
    Returns None on failure. Never raises."""
    try:
        import yfinance as yf
        t = yf.Ticker(symbol)
        info = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}

        price = (
            info.get("navPrice")
            or info.get("regularMarketPrice")
            or info.get("previousClose")
        )
        shares = info.get("sharesOutstanding")
        aum = info.get("totalAssets")
        if aum is None and price is not None and shares:
            aum = float(price) * float(shares)

        # Recent history for volume + trend (the money-flow proxy basis).
        avg_dollar_vol = None
        trend = 0.0
        try:
            hist = t.history(period=f"{HIST_DAYS}d", auto_adjust=False)
        except Exception:
            hist = None
        if hist is not None and getattr(hist, "empty", True) is False and len(hist) >= 5:
            closes = [float(c) for c in hist["Close"].tolist() if c == c]
            vols = [float(v) for v in hist["Volume"].tolist() if v == v]
            if closes and price is None:
                price = closes[-1]
            if closes and vols and len(closes) == len(vols):
                # Average daily dollar volume over the window.
                dvs = [c * v for c, v in zip(closes, vols) if c and v]
                if dvs:
                    avg_dollar_vol = sum(dvs) / len(dvs)
                # Trailing trend = total return over the window (directional sign).
                if closes[0]:
                    trend = closes[-1] / closes[0] - 1.0

        if price is None or aum is None or avg_dollar_vol is None or avg_dollar_vol <= 0:
            return None

        # net_pressure: bounded signed fraction of dollar volume that is "net".
        net_pressure = _clamp(trend * TREND_SCALE, -1.0, 1.0) * MAX_NET_PRESSURE
        est_daily_flow = avg_dollar_vol * net_pressure
        return {
            "aum": float(aum),
            "price": round(float(price), 2),
            "est_daily_flow": float(est_daily_flow),
        }
    except Exception as e:  # pragma: no cover - defensive
        log.warning("etf_flows live read failed for %s: %s", symbol, e)
        return None


def _live_payload() -> dict | None:
    started = time.monotonic()
    rows: list[dict] = []
    resolved = 0
    universe = UNIVERSE[:LIVE_MAX]
    for entry in universe:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        got = _live_one(entry["symbol"])
        if got is None:
            continue
        resolved += 1
        rows.append(_build_row(entry, got["aum"], got["price"], got["est_daily_flow"]))

    # Require a meaningful fraction of the universe to have resolved live.
    if resolved < max(8, len(universe) // 3):
        return None
    return _assemble(rows, data_mode="live", method=METHOD_LIVE, source="yfinance")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic rotation)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    rows: list[dict] = []
    for entry in UNIVERSE:
        sym = entry["symbol"]
        aum = SAMPLE_AUM.get(sym, 5_000_000_000)
        price = SAMPLE_PRICE.get(sym, 50.0)
        bias = SAMPLE_BIAS.get(sym, 0.0)
        # Daily flow scales with AUM (bigger funds move more $) and the signed bias,
        # plus a small deterministic jitter so values are not perfectly smooth.
        jitter = 0.6 + _rand01(sym, "flow") * 0.8  # 0.6 - 1.4
        # Typical daily creation/redemption runs a small fraction of AUM.
        est_daily_flow = aum * (bias * 0.0016) * jitter
        rows.append(_build_row(entry, aum, price, est_daily_flow))
    return _assemble(rows, data_mode="sample", method=METHOD_SAMPLE, source="sample")


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_row(entry: dict, aum: float, price: float, est_daily_flow: float) -> dict:
    # Weekly estimate: trailing-week net flow. Mild compounding/persistence factor
    # (~4.4x daily) rather than a naive x5 so it reads like a cumulative week.
    est_weekly_flow = est_daily_flow * 4.4
    flow_pct_aum = round((est_weekly_flow / aum) * 100, 4) if aum else 0.0
    return {
        "symbol": entry["symbol"],
        "name": entry["name"],
        "asset_class": entry["asset_class"],
        "sector": entry["sector"],
        "aum": round(float(aum), 2),
        "aum_display": _humanize(aum),
        "price": round(float(price), 2),
        "est_daily_flow": round(float(est_daily_flow), 2),
        "est_daily_flow_display": _humanize(est_daily_flow),
        "est_weekly_flow": round(float(est_weekly_flow), 2),
        "est_weekly_flow_display": _humanize(est_weekly_flow),
        "flow_pct_aum": flow_pct_aum,
        "direction": _direction(est_weekly_flow),
    }


def _group_rows(rows: list[dict], key: str) -> list[dict]:
    """Aggregate net flow by a grouping key (asset_class or sector)."""
    buckets: dict[str, list[dict]] = {}
    for r in rows:
        buckets.setdefault(r[key], []).append(r)
    groups: list[dict] = []
    for name, members in buckets.items():
        daily = sum(m["est_daily_flow"] for m in members)
        weekly = sum(m["est_weekly_flow"] for m in members)
        top_in = max(members, key=lambda m: m["est_weekly_flow"])
        top_out = min(members, key=lambda m: m["est_weekly_flow"])
        groups.append({
            "group": name,
            "level": key,
            "members": len(members),
            "est_daily_flow": round(daily, 2),
            "est_daily_flow_display": _humanize(daily),
            "est_weekly_flow": round(weekly, 2),
            "est_weekly_flow_display": _humanize(weekly),
            "direction": _direction(weekly),
            "top_inflow": top_in["symbol"] if top_in["est_weekly_flow"] > 0 else None,
            "top_outflow": top_out["symbol"] if top_out["est_weekly_flow"] < 0 else None,
        })
    groups.sort(key=lambda g: g["est_weekly_flow"], reverse=True)
    return groups


def _assemble(rows: list[dict], *, data_mode: str, method: str, source: str) -> dict:
    rows = sorted(rows, key=lambda r: abs(r["est_weekly_flow"]), reverse=True)

    # Asset-class groups first, then sector groups (rotation lens).
    groups = _group_rows(rows, "asset_class") + _group_rows(rows, "sector")

    if rows:
        biggest_in = max(rows, key=lambda r: r["est_weekly_flow"])
        biggest_out = min(rows, key=lambda r: r["est_weekly_flow"])
        net_flow = round(sum(r["est_weekly_flow"] for r in rows), 2)
        # Rotation note: leading asset-class inflow vs leading outflow.
        ac_groups = [g for g in groups if g["level"] == "asset_class"]
        into = ac_groups[0]["group"] if ac_groups else None
        outof = ac_groups[-1]["group"] if len(ac_groups) > 1 else None
        rotation_note = (
            f"Money rotating into {into} (led by {biggest_in['symbol']}) "
            f"and out of {outof or biggest_out['asset_class']} "
            f"(led by {biggest_out['symbol']})."
        )
        summary = {
            "biggest_inflow": biggest_in["symbol"],
            "biggest_inflow_amount": biggest_in["est_weekly_flow"],
            "biggest_inflow_display": biggest_in["est_weekly_flow_display"],
            "biggest_outflow": biggest_out["symbol"],
            "biggest_outflow_amount": biggest_out["est_weekly_flow"],
            "biggest_outflow_display": biggest_out["est_weekly_flow_display"],
            "net_flow": net_flow,
            "net_flow_display": _humanize(net_flow),
            "rotation_note": rotation_note,
        }
    else:
        summary = {
            "biggest_inflow": None, "biggest_inflow_amount": 0, "biggest_inflow_display": None,
            "biggest_outflow": None, "biggest_outflow_amount": 0, "biggest_outflow_display": None,
            "net_flow": 0, "net_flow_display": _humanize(0),
            "rotation_note": "No flow data available.",
        }

    return {
        "etfs": rows,
        "groups": groups,
        "summary": summary,
        "method": method,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def etf_flows() -> dict:
    """Estimate per-ETF net dollar flow + sector/asset-class rotation.

    See module docstring for the honest methodology note. Always returns a
    populated dict; degrades to deterministic SAMPLE data and tags the payload
    with method / data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("etfs"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("etf_flows live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("etf_flows sample path failed hard: %s", e)
        return {
            "etfs": [],
            "groups": [],
            "summary": {
                "biggest_inflow": None, "biggest_inflow_amount": 0, "biggest_inflow_display": None,
                "biggest_outflow": None, "biggest_outflow_amount": 0, "biggest_outflow_display": None,
                "net_flow": 0, "net_flow_display": "$0", "rotation_note": "No flow data available.",
            },
            "method": METHOD_SAMPLE,
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
