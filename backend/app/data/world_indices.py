"""World Equity Indices Monitor (Bloomberg `WEI`) - Feature (Wave F).

A global markets-at-a-glance board: the major equity indices grouped by region
(Americas / EMEA / Asia-Pacific), each with its current level, day change %,
YTD %, base currency, and a short sparkline.

Live path: per-index prices via app.data.macro_data.fetch_arbitrary_ticker
(last close + prior close => day change %, a ~1y window => YTD % + 30-point
sparkline). When a live source is unavailable for an index we degrade that index
to a deterministic md5-seeded SAMPLE level / change / curve so the board is fully
populated for screenshots. This module never raises - it always returns a
populated payload and tags it with data_mode / as_of / source for honesty under
the hood.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timezone

log = logging.getLogger(__name__)

SPARK_POINTS = 30
HIST_DAYS = 370  # ~1y window so YTD anchor + sparkline are always covered

# ---------------------------------------------------------------------------
# Index catalog (clearly namespaced). base_level / base_ytd / vol drive the
# deterministic SAMPLE walk; they are realistic recent-market figures.
# ---------------------------------------------------------------------------

INDEX_CATALOG: list[dict] = [
    # Americas
    {"name": "S&P 500", "ticker": "^GSPC", "region": "Americas", "currency": "USD", "base_level": 5960.0, "base_ytd": 12.4, "vol": 0.0085},
    {"name": "Nasdaq 100", "ticker": "^NDX", "region": "Americas", "currency": "USD", "base_level": 21680.0, "base_ytd": 16.8, "vol": 0.0110},
    {"name": "Dow Jones", "ticker": "^DJI", "region": "Americas", "currency": "USD", "base_level": 43180.0, "base_ytd": 7.9, "vol": 0.0072},
    {"name": "Russell 2000", "ticker": "^RUT", "region": "Americas", "currency": "USD", "base_level": 2335.0, "base_ytd": 5.2, "vol": 0.0120},
    {"name": "S&P/TSX Composite", "ticker": "^GSPTSE", "region": "Americas", "currency": "CAD", "base_level": 25410.0, "base_ytd": 9.6, "vol": 0.0070},
    {"name": "Bovespa", "ticker": "^BVSP", "region": "Americas", "currency": "BRL", "base_level": 137800.0, "base_ytd": 14.7, "vol": 0.0140},
    # EMEA
    {"name": "FTSE 100", "ticker": "^FTSE", "region": "EMEA", "currency": "GBP", "base_level": 8420.0, "base_ytd": 8.1, "vol": 0.0068},
    {"name": "DAX", "ticker": "^GDAXI", "region": "EMEA", "currency": "EUR", "base_level": 18650.0, "base_ytd": 11.3, "vol": 0.0095},
    {"name": "CAC 40", "ticker": "^FCHI", "region": "EMEA", "currency": "EUR", "base_level": 7610.0, "base_ytd": 4.6, "vol": 0.0090},
    {"name": "Euro Stoxx 50", "ticker": "^STOXX50E", "region": "EMEA", "currency": "EUR", "base_level": 5040.0, "base_ytd": 9.2, "vol": 0.0088},
    {"name": "IBEX 35", "ticker": "^IBEX", "region": "EMEA", "currency": "EUR", "base_level": 11930.0, "base_ytd": 13.5, "vol": 0.0092},
    {"name": "SMI", "ticker": "^SSMI", "region": "EMEA", "currency": "CHF", "base_level": 12080.0, "base_ytd": 6.4, "vol": 0.0066},
    # Asia-Pacific
    {"name": "Nikkei 225", "ticker": "^N225", "region": "Asia-Pacific", "currency": "JPY", "base_level": 38950.0, "base_ytd": 10.7, "vol": 0.0105},
    {"name": "Hang Seng", "ticker": "^HSI", "region": "Asia-Pacific", "currency": "HKD", "base_level": 19340.0, "base_ytd": 15.1, "vol": 0.0130},
    {"name": "Shanghai Composite", "ticker": "000001.SS", "region": "Asia-Pacific", "currency": "CNY", "base_level": 3360.0, "base_ytd": 3.8, "vol": 0.0100},
    {"name": "KOSPI", "ticker": "^KS11", "region": "Asia-Pacific", "currency": "KRW", "base_level": 2710.0, "base_ytd": 6.9, "vol": 0.0108},
    {"name": "ASX 200", "ticker": "^AXJO", "region": "Asia-Pacific", "currency": "AUD", "base_level": 8240.0, "base_ytd": 7.2, "vol": 0.0074},
    {"name": "Sensex", "ticker": "^BSESN", "region": "Asia-Pacific", "currency": "INR", "base_level": 80650.0, "base_ytd": 11.9, "vol": 0.0095},
    {"name": "Nifty 50", "ticker": "^NSEI", "region": "Asia-Pacific", "currency": "INR", "base_level": 24560.0, "base_ytd": 12.3, "vol": 0.0094},
]

REGION_ORDER = ["Americas", "EMEA", "Asia-Pacific"]

MIN_POINTS = 8  # need at least this many live bars to trust the live path


# ---------------------------------------------------------------------------
# Deterministic sample synthesis (stable across calls, md5-seeded)
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _unit_noise(key: str) -> float:
    """Deterministic pseudo-random value in [-1, 1] from a string key."""
    return (_seed(key) % 20000) / 10000.0 - 1.0


def _sample_index(cat: dict) -> dict:
    """Build a fully-populated SAMPLE index entry from the catalog metadata."""
    ticker = cat["ticker"]
    vol = cat["vol"]
    base = cat["base_level"]

    # Day change: deterministic, scaled to the index's typical daily vol.
    change_pct = round(_unit_noise(ticker + ":day") * vol * 100 * 1.4, 2)
    level = round(base * (1.0 + change_pct / 100.0), 2)

    # YTD: anchor on the catalog figure with a small deterministic wobble.
    ytd_pct = round(cat["base_ytd"] + _unit_noise(ticker + ":ytd") * 1.5, 2)

    spark = _sample_spark(ticker, level, vol, ytd_pct)
    return _entry(cat, level, change_pct, ytd_pct, spark, "sample")


def _sample_spark(ticker: str, level: float, vol: float, ytd_pct: float) -> list[float]:
    """A SPARK_POINTS curve ending at `level`, drifting in line with YTD sign,
    fully deterministic per ticker."""
    n = SPARK_POINTS
    # Total drift across the window roughly tracks a fraction of YTD momentum.
    drift = (ytd_pct / 100.0) * 0.35
    start = level / (1.0 + drift) if (1.0 + drift) != 0 else level
    pts: list[float] = []
    step = (level - start) / max(n - 1, 1)
    for i in range(n):
        wobble = _unit_noise(f"{ticker}:spark:{i}") * vol * level * 0.6
        v = start + step * i + wobble
        pts.append(round(v, 2))
    pts[-1] = round(level, 2)  # pin the last point to the true level
    return pts


# ---------------------------------------------------------------------------
# Live helpers
# ---------------------------------------------------------------------------

def _live_index(cat: dict) -> dict | None:
    """Try to build a live index entry. Returns None if data is unusable."""
    try:
        from .macro_data import fetch_arbitrary_ticker
        pts = fetch_arbitrary_ticker(cat["ticker"], days=HIST_DAYS)
    except Exception as e:
        log.debug("world_indices live fetch failed for %s: %s", cat["ticker"], e)
        return None

    if not pts:
        return None
    series = [(p["date"], float(p["value"])) for p in pts if p.get("value") is not None]
    if len(series) < MIN_POINTS:
        return None

    dates = [d for d, _ in series]
    values = [v for _, v in series]

    level = round(values[-1], 2)
    prior = values[-2] if len(values) >= 2 else values[-1]
    change_pct = round((values[-1] / prior - 1.0) * 100, 2) if prior else 0.0

    # YTD anchor: last close on or before Dec 31 of last year, else first bar.
    jan1 = date(date.today().year, 1, 1).isoformat()
    ytd_base = None
    for d, v in series:
        if d < jan1:
            ytd_base = v  # keep advancing to the latest pre-Jan-1 close
        else:
            break
    if ytd_base is None:
        ytd_base = values[0]
    ytd_pct = round((values[-1] / ytd_base - 1.0) * 100, 2) if ytd_base else 0.0

    spark = _downsample(values, SPARK_POINTS)
    return _entry(cat, level, change_pct, ytd_pct, spark, "live")


def _downsample(values: list[float], n: int) -> list[float]:
    """Take the trailing `n` evenly-spaced points (always include the last)."""
    if len(values) <= n:
        return [round(float(v), 2) for v in values]
    out: list[float] = []
    step = (len(values) - 1) / (n - 1)
    for i in range(n):
        idx = int(round(i * step))
        idx = min(idx, len(values) - 1)
        out.append(round(float(values[idx]), 2))
    out[-1] = round(float(values[-1]), 2)
    return out


# ---------------------------------------------------------------------------
# Shared entry assembly
# ---------------------------------------------------------------------------

def _entry(cat: dict, level: float, change_pct: float, ytd_pct: float,
           spark: list[float], mode: str) -> dict:
    return {
        "name": cat["name"],
        "ticker": cat["ticker"],
        "region": cat["region"],
        "level": level,
        "change_pct": change_pct,
        "ytd_pct": ytd_pct,
        "currency": cat["currency"],
        "spark": spark,
        "data_mode": mode,
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def world_indices() -> dict:
    """Global equity-indices board grouped by region.

    Never raises - degrades to deterministic SAMPLE data per index and tags the
    payload (and each index) with data_mode / as_of / source.
    """
    try:
        return _world_indices()
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("world_indices failed hard, returning sample: %s", e)
        return _all_sample()


def _world_indices() -> dict:
    entries: list[dict] = []
    any_live = False
    all_live = True

    for cat in INDEX_CATALOG:
        live = None
        try:
            live = _live_index(cat)
        except Exception as e:
            log.debug("world_indices entry failed for %s: %s", cat["ticker"], e)
            live = None
        if live is not None:
            any_live = True
            entries.append(live)
        else:
            all_live = False
            entries.append(_sample_index(cat))

    data_mode = "live" if all_live else ("live" if any_live else "sample")
    # Be honest: only call the whole board "live" when every index resolved live.
    data_mode = "live" if all_live else "sample"
    source = "yfinance" if any_live else "sample"

    return _assemble(entries, data_mode=data_mode, source=source)


def _all_sample() -> dict:
    entries = [_sample_index(cat) for cat in INDEX_CATALOG]
    return _assemble(entries, data_mode="sample", source="sample")


def _assemble(entries: list[dict], *, data_mode: str, source: str) -> dict:
    # Group by region in the canonical order.
    by_region: dict[str, list[dict]] = {r: [] for r in REGION_ORDER}
    for e in entries:
        by_region.setdefault(e["region"], []).append(e)

    regions = [
        {"region": r, "indices": by_region[r]}
        for r in REGION_ORDER
        if by_region.get(r)
    ]
    # Include any unexpected region buckets at the end (defensive).
    for r, idxs in by_region.items():
        if r not in REGION_ORDER and idxs:
            regions.append({"region": r, "indices": idxs})

    summary = _summary(entries)

    return {
        "regions": regions,
        "summary": summary,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


def _summary(entries: list[dict]) -> dict:
    advancers = sum(1 for e in entries if e["change_pct"] > 0)
    decliners = sum(1 for e in entries if e["change_pct"] < 0)
    unchanged = sum(1 for e in entries if e["change_pct"] == 0)

    best = None
    worst = None
    if entries:
        best_e = max(entries, key=lambda e: e["change_pct"])
        worst_e = min(entries, key=lambda e: e["change_pct"])
        best = {"name": best_e["name"], "ticker": best_e["ticker"], "change_pct": best_e["change_pct"]}
        worst = {"name": worst_e["name"], "ticker": worst_e["ticker"], "change_pct": worst_e["change_pct"]}

    # Region average day change.
    region_acc: dict[str, list[float]] = {}
    for e in entries:
        region_acc.setdefault(e["region"], []).append(e["change_pct"])
    region_avg = []
    for r in REGION_ORDER:
        vals = region_acc.get(r)
        if vals:
            region_avg.append({"region": r, "avg_change_pct": round(sum(vals) / len(vals), 2)})
    for r, vals in region_acc.items():
        if r not in REGION_ORDER and vals:
            region_avg.append({"region": r, "avg_change_pct": round(sum(vals) / len(vals), 2)})

    return {
        "advancers": advancers,
        "decliners": decliners,
        "unchanged": unchanged,
        "total": len(entries),
        "best": best,
        "worst": worst,
        "region_avg": region_avg,
    }
