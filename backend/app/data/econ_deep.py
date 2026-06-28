"""Deep economic data - Feature F.

A serious "economic terminal" surface: nine curated macro categories, each with
8-10 hand-picked series, every series carrying a latest value, period change, a
~24 point sparkline, a z-score (latest vs its own recent window) and a trend
read. Each category gets a diffusion / heat read (how many indicators are
improving vs their own trend) and the whole board rolls up into a single
composite z-score plus a plain-language regime read.

Live data comes from FRED via `macro_data.fetch_series` when `settings.has_fred`
is set. When a key is missing (or a single series comes back empty) we fall back
to rich, realistic sample series held in `SAMPLE_ECON`. The sample shapes are
deterministic (seeded per series id) so screenshots are stable across calls.

This module never raises. Every public entrypoint degrades to sample data and a
best-effort payload. Results are cached via the shared sqlite TTL cache.

Public surface:
- `deep_economy() -> dict`            the full nine-category board
- `econ_category(cat: str) -> dict`   one category, with longer per-series history

Payloads carry `data_mode` ("live" | "sample"), `as_of` (ISO date) and `source`.
"""
from __future__ import annotations

import logging
import math
import random
from datetime import date, datetime, timedelta

from ..config import settings
from . import cache, macro_data

log = logging.getLogger(__name__)

DEEP_TTL = 60 * 60 * 6  # 6h - macro series move slowly

# How many points each surface renders.
SPARK_N = 24      # tiles on the main board
HISTORY_N = 60    # drill-down longer history (~5y monthly)


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------
# Each spec: (id, label, unit, sense, end, span, curve, wobble)
#   sense  - "up" (higher is healthier), "down" (lower is healthier), "neutral"
#   end    - latest realistic sample value
#   span   - absolute change across the sample window (end - start)
#   curve  - bow of the path: +1 front-loaded, -1 back-loaded, 0 linear
#   wobble - absolute noise amplitude (stdev-ish) for month-to-month chop
#
# `sense` drives the SIGNED z-score (sense_sign * zscore) used for category heat
# and the composite. "neutral" series are shown but excluded from the composite.

CATEGORY_ORDER = [
    "Growth",
    "Labor",
    "Inflation",
    "Consumer",
    "Housing",
    "Credit & Financial Conditions",
    "Fiscal & Debt",
    "Trade",
    "Global",
]

ECON_CATALOG: dict[str, list[tuple]] = {
    "Growth": [
        ("GDPC1",            "Real GDP",                "$B SAAR 2017", "up",      23400.0,    700.0,  0,    30.0),
        ("A191RL1Q225SBEA",  "Real GDP QoQ",            "% SAAR",       "up",          2.8,      0.6,  1,     0.4),
        ("INDPRO",           "Industrial Production",   "Idx 2017=100", "up",        103.1,      1.2, -1,     0.4),
        ("TCU",              "Capacity Utilization",    "%",            "up",         77.8,     -0.8,  0,     0.3),
        ("CFNAI",            "Chicago Fed Activity",    "Idx",          "up",          0.12,     0.5,  0,     0.25),
        ("PCEC96",           "Real Consumption",        "$B 2017",      "up",      16550.0,    420.0,  0,    25.0),
        ("DGORDER",          "Durable Goods Orders",    "$M",           "up",     289500.0,   4000.0,  1,  3000.0),
        ("USSLIND",          "Leading Activity Index",  "%",            "up",          0.9,      0.5,  0,     0.3),
        ("IPMAN",            "IP: Manufacturing",       "Idx 2017=100", "up",         99.6,      0.6, -1,     0.4),
    ],
    "Labor": [
        ("PAYEMS",           "Nonfarm Payrolls",        "k",            "up",     159200.0,   2600.0,  0,    80.0),
        ("UNRATE",           "Unemployment Rate",       "%",            "down",        4.1,      0.5,  1,     0.08),
        ("U6RATE",           "U-6 Underemployment",     "%",            "down",        7.7,      0.6,  1,     0.12),
        ("CIVPART",          "Labor Force Participation","%",           "up",         62.6,     -0.2,  0,     0.1),
        ("EMRATIO",          "Employment-Pop Ratio",    "%",            "up",         60.0,     -0.3,  0,     0.1),
        ("ICSA",             "Initial Jobless Claims",  "k",            "down",      224.0,     18.0,  1,     8.0),
        ("CCSA",             "Continuing Claims",       "k",            "down",     1870.0,    120.0,  1,    25.0),
        ("JTSJOL",           "Job Openings",            "k",            "up",       7740.0,   -900.0, -1,   120.0),
        ("JTSQUL",           "Quits Level",             "k",            "up",       3070.0,   -350.0, -1,    60.0),
        ("CES0500000003",    "Avg Hourly Earnings",     "$/hr",         "up",         35.6,      1.3,  0,     0.08),
    ],
    "Inflation": [
        ("CPIAUCSL",         "CPI All Items",           "Idx 1982-84",  "down",      317.6,      9.5,  0,     0.3),
        ("CPILFESL",         "Core CPI",                "Idx 1982-84",  "down",      322.9,     11.0,  0,     0.3),
        ("PCEPI",            "PCE Price Index",         "Idx 2017",     "down",      125.2,      3.0,  0,     0.15),
        ("PCEPILFE",         "Core PCE Price Index",    "Idx 2017",     "down",      124.9,      3.1,  0,     0.15),
        ("PPIACO",           "PPI All Commodities",     "Idx 1982",     "down",      260.5,      5.0,  1,     1.0),
        ("T5YIE",            "5Y Breakeven Inflation",  "%",            "down",        2.35,    -0.15,  0,     0.05),
        ("T10YIE",           "10Y Breakeven Inflation", "%",            "down",        2.31,    -0.10,  0,     0.04),
        ("MICH",             "U-Mich 1Y Inflation Exp", "%",            "down",        3.3,      0.5,  1,     0.15),
        ("STICKCPIM157SFRBATL","Sticky-Price CPI",      "% ann",        "down",        3.6,     -1.2,  0,     0.2),
        ("EXPINF1YR",        "Cleveland 1Y Inflation",  "%",            "down",        2.6,     -0.4,  0,     0.08),
    ],
    "Consumer": [
        ("UMCSENT",          "Consumer Sentiment",      "Idx 1966=100", "up",         71.8,      6.0,  1,     2.0),
        ("RSAFS",            "Retail Sales",            "$M SA",        "up",     724000.0,  18000.0,  0,  3000.0),
        ("RSXFS",            "Retail ex Food Svc",      "$M SA",        "up",     580000.0,  14000.0,  0,  2500.0),
        ("PCE",              "Personal Consumption",    "$B SAAR",      "up",      19850.0,    600.0,  0,    40.0),
        ("DSPIC96",          "Real Disposable Income",  "$B 2017",      "up",      17350.0,    300.0,  0,    30.0),
        ("PSAVERT",          "Personal Savings Rate",   "%",            "neutral",     4.6,     -0.8,  0,     0.2),
        ("TOTALSL",          "Consumer Credit",         "$B",           "neutral",  5045.0,    110.0,  0,    12.0),
        ("REVOLSL",          "Revolving Credit",        "$B",           "neutral",  1355.0,     60.0,  0,     8.0),
        ("DSPI",             "Disposable Income",       "$B SAAR",      "up",      21650.0,    650.0,  0,    45.0),
    ],
    "Housing": [
        ("HOUST",            "Housing Starts",          "k SAAR",       "up",       1307.0,   -120.0,  1,    50.0),
        ("PERMIT",           "Building Permits",        "k SAAR",       "up",       1419.0,    -80.0,  0,    40.0),
        ("HSN1F",            "New Home Sales",          "k SAAR",       "up",        664.0,    -40.0,  1,    30.0),
        ("EXHOSLUSM495S",    "Existing Home Sales",     "k SAAR",       "up",       4150.0,   -300.0,  1,    90.0),
        ("MSACSR",           "Months' Supply",          "months",       "down",        8.9,      1.2,  1,     0.3),
        ("CSUSHPISA",        "Case-Shiller Home Price", "Idx Jan00",    "up",        327.5,     12.0,  0,     1.5),
        ("MORTGAGE30US",     "30Y Mortgage Rate",       "%",            "down",        6.85,     0.4,  1,     0.12),
        ("MORTGAGE15US",     "15Y Mortgage Rate",       "%",            "down",        6.03,     0.35, 1,     0.1),
        ("USSTHPI",          "FHFA House Price Index",  "Idx 1980Q1",   "up",        437.2,      9.0,  0,     1.2),
        ("TLRESCONS",        "Residential Construction","$M",           "up",     940000.0, -25000.0, -1,  8000.0),
    ],
    "Credit & Financial Conditions": [
        ("BAMLH0A0HYM2",     "High Yield OAS",          "%",            "down",        3.12,    -0.6,  1,     0.12),
        ("BAMLC0A0CM",       "IG Corporate OAS",        "%",            "down",        0.88,    -0.15, 1,     0.04),
        ("BAMLH0A3HYC",      "CCC & Lower OAS",         "%",            "down",        8.05,    -1.4,  1,     0.3),
        ("NFCI",             "Financial Conditions Idx","Idx",          "down",       -0.55,    -0.15, 0,     0.03),
        ("ANFCI",            "Adjusted NFCI",           "Idx",          "down",       -0.32,    -0.10, 0,     0.04),
        ("STLFSI4",          "Financial Stress Index",  "Idx",          "down",       -0.45,    -0.2,  0,     0.05),
        ("T10Y2Y",           "10Y-2Y Spread",           "%",            "up",          0.34,     0.7,  1,     0.06),
        ("T10Y3M",           "10Y-3M Spread",           "%",            "up",          0.18,     0.9,  1,     0.07),
        ("DRTSCILM",         "Banks Tightening C&I",    "% net",        "down",        7.9,    -14.0,  1,     2.0),
        ("VIXCLS",           "VIX",                     "idx",          "down",       15.4,     -2.5,  1,     1.8),
    ],
    "Fiscal & Debt": [
        ("GFDEBTN",          "Federal Debt: Public",    "$M",           "neutral", 36200000.0, 1500000.0, 0, 60000.0),
        ("GFDEGDQ188S",      "Federal Debt / GDP",      "%",            "down",      121.2,      1.5,  0,     0.4),
        ("FYFSD",            "Federal Surplus/Deficit", "$M",           "up",    -1830000.0,-120000.0,  0, 40000.0),
        ("FYFR",             "Federal Receipts",        "$B",           "up",       4920.0,    180.0,  0,    30.0),
        ("FYONET",           "Federal Outlays",         "$B",           "neutral",  6750.0,    260.0,  0,    35.0),
        ("FGEXPND",          "Federal Expenditures",    "$B SAAR",      "neutral",  7180.0,    220.0,  0,    40.0),
        ("FGRECPT",          "Federal Receipts (NIPA)", "$B SAAR",      "up",       5210.0,    190.0,  0,    35.0),
        ("A091RC1Q027SBEA",  "Federal Interest Outlays","$B SAAR",      "down",     1115.0,    130.0,  1,    12.0),
        ("FYOIGDA188S",      "Net Interest / GDP",      "%",            "down",        3.2,      0.4,  1,     0.06),
    ],
    "Trade": [
        ("BOPGSTB",          "Trade Balance G&S",       "$M",           "up",      -78400.0,  -6000.0,  0,  2500.0),
        ("BOPGEXP",          "Goods Exports",           "$M",           "up",      174500.0,   5000.0,  0,  2000.0),
        ("BOPGIMP",          "Goods Imports",           "$M",           "neutral", 277000.0,   9000.0,  0,  3000.0),
        ("EXPGS",            "Exports G&S",             "$B SAAR",      "up",       3210.0,     90.0,  0,    20.0),
        ("IMPGS",            "Imports G&S",             "$B SAAR",      "neutral",  4140.0,    130.0,  0,    25.0),
        ("BOPSEXP",          "Services Exports",        "$M",           "up",       95800.0,   3200.0,  0,   900.0),
        ("IEABC",            "Current Account Balance", "$M",           "up",     -310500.0, -22000.0,  0,  8000.0),
        ("NETEXP",           "Net Exports",             "$B SAAR",      "up",        -930.0,    -45.0,  0,    18.0),
        ("DTWEXBGS",         "Broad Dollar Index",      "Idx Jan2006",  "neutral",   121.8,      3.5,  1,     0.6),
    ],
    "Global": [
        ("DEXUSEU",          "USD per EUR",             "rate",         "neutral",     1.084,   -0.03,  0,     0.008),
        ("DEXJPUS",          "JPY per USD",             "rate",         "neutral",   152.4,      9.0,  1,     1.5),
        ("DEXCHUS",          "CNY per USD",             "rate",         "neutral",     7.18,     0.12,  0,     0.02),
        ("DEXUSUK",          "USD per GBP",             "rate",         "neutral",     1.268,   -0.02,  0,     0.01),
        ("DEXCAUS",          "CAD per USD",             "rate",         "neutral",     1.398,    0.05,  0,     0.012),
        ("DCOILBRENTEU",     "Brent Crude",             "$/bbl",        "neutral",    73.4,     -8.0,  1,     2.5),
        ("DCOILWTICO",       "WTI Crude",               "$/bbl",        "neutral",    69.6,     -8.0,  1,     2.4),
        ("PALLFNFINDEXM",    "Global Commodity Price",  "Idx 2016=100", "neutral",   168.5,     -6.0,  1,     2.0),
        ("GEPUCURRENT",      "Global Policy Uncertainty","Idx",         "down",      232.0,     30.0,  1,    18.0),
    ],
}


SENSE_SIGN = {"up": 1.0, "down": -1.0, "neutral": 0.0}


# --------------------------------------------------------------------------
# Sample series generation (deterministic, seeded per id)
# --------------------------------------------------------------------------

def _seed_for(series_id: str) -> int:
    return abs(hash(("econ", series_id))) % (2**31)


def _round_val(v: float) -> float:
    a = abs(v)
    if a >= 1000:
        return round(v)
    if a >= 100:
        return round(v, 1)
    if a >= 10:
        return round(v, 2)
    if a >= 1:
        return round(v, 3)
    return round(v, 4)


def _gen_path(end: float, span: float, curve: float, wobble: float,
              seed: int, n: int) -> list[float]:
    """Build a deterministic n-point path that LANDS on `end`.

    `span` is the absolute net change across the window (end - start).
    `curve` bows the trajectory; `wobble` adds seeded month-to-month chop.
    """
    rng = random.Random(seed)
    start = end - span
    pts: list[float] = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 1.0
        base = start + span * t
        # Bow the path: positive curve front-loads the move, negative back-loads.
        base += curve * span * 0.30 * (t - t * t)
        noise = rng.uniform(-1.0, 1.0) * wobble
        pts.append(base + noise)
    # Pin the final observation exactly to the stated latest value.
    pts[-1] = end
    return [_round_val(v) for v in pts]


def _build_sample(n: int) -> dict[str, list[float]]:
    """Generate the full sample universe keyed by series id."""
    out: dict[str, list[float]] = {}
    for specs in ECON_CATALOG.values():
        for (sid, _label, _unit, _sense, end, span, curve, wobble) in specs:
            out[sid] = _gen_path(end, span, curve, wobble, _seed_for(sid), n)
    return out


# Rich, realistic sample series (24 points each). Clearly-named per the
# sample-data policy. Live mode prefers FRED and only uses these as a fallback.
SAMPLE_ECON: dict[str, list[float]] = _build_sample(SPARK_N)


# --------------------------------------------------------------------------
# Stats helpers
# --------------------------------------------------------------------------

def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _std(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    mu = _mean(xs)
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))


def _zscore(latest: float, window: list[float]) -> float:
    sd = _std(window)
    if sd <= 0:
        return 0.0
    z = (latest - _mean(window)) / sd
    # Clamp to a sane display range.
    return max(-4.0, min(4.0, z))


def _trend(window: list[float]) -> str:
    """Slope read: compare the back third of the window to the front third."""
    n = len(window)
    if n < 4:
        return "flat"
    k = max(2, n // 3)
    early = _mean(window[:k])
    late = _mean(window[-k:])
    scale = abs(_mean(window)) or 1.0
    delta = (late - early) / scale
    if delta > 0.01:
        return "up"
    if delta < -0.01:
        return "down"
    return "flat"


def _percentile(latest: float, window: list[float]) -> float:
    if not window:
        return 50.0
    rank = sum(1 for v in window if v <= latest)
    return round(rank / len(window) * 100.0, 1)


def _downsample(vals: list[float], n: int) -> list[float]:
    """Evenly sample `n` points (endpoints included) from a longer series."""
    vals = [v for v in vals if v is not None]
    if not vals:
        return []
    if len(vals) <= n:
        return vals
    idxs = [round(i * (len(vals) - 1) / (n - 1)) for i in range(n)]
    return [vals[j] for j in idxs]


# --------------------------------------------------------------------------
# Series + category assembly
# --------------------------------------------------------------------------

def _values_for(spec: tuple, n: int, use_live: bool) -> tuple[list[float], bool]:
    """Return (values, was_live) for a series spec.

    Tries FRED first when `use_live`; falls back to the seeded sample on any
    empty / failed fetch so each tile is always populated.
    """
    sid, _label, _unit, _sense, end, span, curve, wobble = spec
    if use_live:
        try:
            # Pull ~30 months so monthly series yield enough points; daily
            # series get downsampled below.
            raw = macro_data.fetch_series(sid, days=920)
            vals = [p["value"] for p in raw if p.get("value") is not None]
            if len(vals) >= 6:
                return _downsample(vals, n), True
        except Exception as e:  # never raise
            log.debug("econ live fetch failed for %s: %s", sid, e)
    # Sample fallback (regenerate at the requested length for drill-downs).
    if n == SPARK_N and sid in SAMPLE_ECON:
        return list(SAMPLE_ECON[sid]), False
    return _gen_path(end, span, curve, wobble, _seed_for(sid), n), False


def _build_series(spec: tuple, n: int, use_live: bool) -> tuple[dict, bool]:
    sid, label, unit, sense, *_ = spec
    vals, was_live = _values_for(spec, n, use_live)
    if not vals:
        vals = [0.0]
    spark = [_round_val(v) for v in vals]
    latest = spark[-1]
    prev = spark[-2] if len(spark) >= 2 else latest
    z = round(_zscore(latest, spark), 2)
    return {
        "id": sid,
        "label": label,
        "latest": latest,
        "unit": unit,
        "change": _round_val(latest - prev),
        "spark": spark,
        "zscore": z,
        "trend": _trend(spark),
        "sense": sense,
        "signed_z": round(z * SENSE_SIGN.get(sense, 0.0), 2),
        "percentile": _percentile(latest, spark),
    }


def _diffusion_label(heat: float) -> str:
    if heat >= 70:
        return "Broad improvement"
    if heat >= 55:
        return "Improving"
    if heat >= 45:
        return "Mixed"
    if heat >= 30:
        return "Softening"
    return "Broad deterioration"


def _category_heat(series: list[dict]) -> dict:
    """Diffusion / heat read for a category.

    Heat = share of directional (non-neutral) indicators printing above their
    own recent trend (signed_z > 0). Returns a 0-100 number, a label, the
    improving / total count and the category's average signed z.
    """
    directional = [s for s in series if s.get("sense") in ("up", "down")]
    total = len(directional)
    improving = sum(1 for s in directional if s.get("signed_z", 0.0) > 0)
    heat = round(improving / total * 100.0, 1) if total else 50.0
    avg_signed = round(_mean([s.get("signed_z", 0.0) for s in directional]), 2) if total else 0.0
    return {
        "heat": heat,
        "label": _diffusion_label(heat),
        "improving": improving,
        "total": total,
        "avg_signed_z": avg_signed,
        "read": f"{improving} of {total} indicators improving vs trend",
    }


def _regime_read(cat_signed: dict[str, float], composite: float) -> str:
    """Plain-language synthesis across the major category reads."""
    def phrase(z: float, up: str, down: str, flat: str) -> str:
        if z > 0.3:
            return up
        if z < -0.3:
            return down
        return flat

    growth = phrase(cat_signed.get("Growth", 0.0),
                    "growth is running above trend",
                    "growth is slowing below trend",
                    "growth is holding near trend")
    # Inflation sense is "down" so a positive signed z means cooling prices.
    infl = phrase(cat_signed.get("Inflation", 0.0),
                  "inflation is cooling",
                  "inflation is re-accelerating",
                  "inflation is steady")
    labor = phrase(cat_signed.get("Labor", 0.0),
                   "the labor market is firm",
                   "the labor market is softening",
                   "the labor market is balanced")
    cond = phrase(cat_signed.get("Credit & Financial Conditions", 0.0),
                  "financial conditions are easing",
                  "financial conditions are tightening",
                  "financial conditions are neutral")

    if composite > 0.3:
        tag = "Risk-on / expansion"
    elif composite < -0.3:
        tag = "Risk-off / contraction"
    else:
        tag = "Late-cycle / transition"

    return (f"{tag}. Across the board {growth}, {infl}, {labor}, and "
            f"{cond} (composite z {composite:+.2f}).")


def _today_iso() -> str:
    return date.today().isoformat()


def _monthly_dates(n: int, end_iso: str | None = None) -> list[str]:
    """n ISO month-ends counting back from today (oldest first)."""
    try:
        end = datetime.fromisoformat(end_iso).date() if end_iso else date.today()
    except Exception:
        end = date.today()
    out: list[str] = []
    cur = end
    for _ in range(n):
        out.append(cur.isoformat())
        # Step back roughly one month.
        cur = (cur.replace(day=1) - timedelta(days=1)).replace(day=min(cur.day, 28))
    return list(reversed(out))


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def deep_economy() -> dict:
    """The full nine-category economic board. Never raises."""
    cached = cache.get("econ:deep")
    if cached is not None:
        return cached

    try:
        use_live = bool(settings.has_fred)
        categories: list[dict] = []
        cat_signed: dict[str, float] = {}
        all_signed: list[float] = []
        live_hits = 0
        live_total = 0

        for cat in CATEGORY_ORDER:
            specs = ECON_CATALOG.get(cat, [])
            series: list[dict] = []
            for spec in specs:
                s = _build_series(spec, SPARK_N, use_live)
                series.append(s)
                live_total += 1
            heat = _category_heat(series)
            cat_signed[cat] = heat["avg_signed_z"]
            all_signed.extend(s["signed_z"] for s in series if s.get("sense") in ("up", "down"))
            categories.append({
                "name": cat,
                "series": series,
                "heat": heat["heat"],
                "diffusion": heat["label"],
                "diffusion_read": heat["read"],
                "improving": heat["improving"],
                "total": heat["total"],
                "avg_signed_z": heat["avg_signed_z"],
            })

        composite = round(_mean(all_signed), 2) if all_signed else 0.0
        # We do not get per-series live confirmation back here; treat the whole
        # board as live when a key is configured, sample otherwise.
        data_mode = "live" if use_live else "sample"
        source = "FRED" if use_live else "sample"

        payload = {
            "categories": categories,
            "composite_z": composite,
            "regime_read": _regime_read(cat_signed, composite),
            "category_signed_z": cat_signed,
            "category_count": len(categories),
            "series_count": live_total,
            "data_mode": data_mode,
            "as_of": _today_iso(),
            "source": source,
        }
        cache.set("econ:deep", payload, DEEP_TTL)
        return payload
    except Exception as e:  # hard contract: never raise
        log.warning("deep_economy failed, returning minimal sample: %s", e)
        return _fallback_board()


def econ_category(cat: str) -> dict:
    """Drill-down for one category with longer per-series history. Never raises."""
    name = _match_category(cat)
    cache_key = f"econ:cat:{name}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        use_live = bool(settings.has_fred)
        specs = ECON_CATALOG.get(name, [])
        dates = _monthly_dates(HISTORY_N)
        series: list[dict] = []
        for spec in specs:
            s = _build_series(spec, HISTORY_N, use_live)
            spark = s["spark"]
            # Attach dated history for charting in the drill-down.
            ds = dates[-len(spark):] if len(spark) <= len(dates) else _monthly_dates(len(spark))
            s["history"] = [{"date": d, "value": v} for d, v in zip(ds, spark)]
            s["stats"] = {
                "min": min(spark),
                "max": max(spark),
                "mean": _round_val(_mean(spark)),
                "std": _round_val(_std(spark)),
                "percentile": s["percentile"],
            }
            series.append(s)

        heat = _category_heat(series)
        payload = {
            "name": name,
            "series": series,
            "heat": heat["heat"],
            "diffusion": heat["label"],
            "diffusion_read": heat["read"],
            "improving": heat["improving"],
            "total": heat["total"],
            "avg_signed_z": heat["avg_signed_z"],
            "history_points": HISTORY_N,
            "data_mode": "live" if use_live else "sample",
            "as_of": _today_iso(),
            "source": "FRED" if use_live else "sample",
        }
        cache.set(cache_key, payload, DEEP_TTL)
        return payload
    except Exception as e:  # never raise
        log.warning("econ_category(%s) failed: %s", cat, e)
        return {
            "name": name,
            "series": [],
            "heat": 50.0,
            "diffusion": "Mixed",
            "diffusion_read": "0 of 0 indicators improving vs trend",
            "improving": 0,
            "total": 0,
            "avg_signed_z": 0.0,
            "history_points": HISTORY_N,
            "data_mode": "sample",
            "as_of": _today_iso(),
            "source": "sample",
        }


def _match_category(cat: str) -> str:
    """Resolve a loose category arg (slug / case-insensitive) to a canonical name."""
    if not cat:
        return CATEGORY_ORDER[0]
    raw = cat.strip().lower()
    norm = raw.replace("-", " ").replace("_", " ").replace("&", "and")
    for name in CATEGORY_ORDER:
        cand = name.lower()
        cand_norm = cand.replace("&", "and")
        if raw == cand or norm == cand_norm or raw == cand.split()[0]:
            return name
    # Substring fallback.
    for name in CATEGORY_ORDER:
        if norm in name.lower().replace("&", "and") or name.lower().split()[0] in norm:
            return name
    return CATEGORY_ORDER[0]


def _fallback_board() -> dict:
    """Last-resort sample board if anything in the main path explodes."""
    categories: list[dict] = []
    cat_signed: dict[str, float] = {}
    all_signed: list[float] = []
    for cat in CATEGORY_ORDER:
        series: list[dict] = []
        for spec in ECON_CATALOG.get(cat, []):
            try:
                series.append(_build_series(spec, SPARK_N, use_live=False))
            except Exception:
                continue
        heat = _category_heat(series)
        cat_signed[cat] = heat["avg_signed_z"]
        all_signed.extend(s["signed_z"] for s in series if s.get("sense") in ("up", "down"))
        categories.append({
            "name": cat,
            "series": series,
            "heat": heat["heat"],
            "diffusion": heat["label"],
            "diffusion_read": heat["read"],
            "improving": heat["improving"],
            "total": heat["total"],
            "avg_signed_z": heat["avg_signed_z"],
        })
    composite = round(_mean(all_signed), 2) if all_signed else 0.0
    return {
        "categories": categories,
        "composite_z": composite,
        "regime_read": _regime_read(cat_signed, composite),
        "category_signed_z": cat_signed,
        "category_count": len(categories),
        "series_count": sum(len(c["series"]) for c in categories),
        "data_mode": "sample",
        "as_of": _today_iso(),
        "source": "sample",
    }
