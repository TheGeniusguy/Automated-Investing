"""IRS Swap Curve & Vanilla Swap Pricer (Bloomberg `IRSB` / `SWPM`).

Bootstraps a USD SOFR / OIS par-swap curve, derives a clean set of discount
factors from it, prices a representative fixed-for-floating vanilla swap (par
rate, PV, annuity, DV01), and measures swap spreads against the matched-maturity
Treasury curve.

THE MATH

Par-swap bootstrap (annual fixed leg, accrual tau = 1). A par swap of tenor n
years with par rate S_n satisfies fixed-leg PV == float-leg PV, which (with a
notional-exchange float leg) reduces to:

    S_n * sum_{i=1..n} DF_i = 1 - DF_n

Solving recursively for the year-n discount factor given the prior DFs:

    DF_n = (1 - S_n * sum_{i=1..n-1} DF_i) / (1 + S_n)

The par rates only quote at standard tenors (1Y,2Y,3Y,5Y,7Y,10Y,20Y,30Y); we
linearly interpolate them onto an annual grid so every coupon date has a DF.
Because each DF_n is solved to reprice ITS OWN par swap exactly to par, the par
rate recovered from the discount factors at any node equals the input par rate -
the curve reconciles by construction, and a swap struck at the par rate prices
to PV = 0.

Pricer (representative 5Y, $10mm, pay-fixed):
    annuity_unit = sum_{i=1..5} DF_i           (fixed-leg PV01 per unit rate)
    annuity      = annuity_unit * notional
    par_rate     = (1 - DF_5) / annuity_unit   (recovers the curve's 5Y rate)
    PV(pay-fixed)= (1 - DF_5) * notional - (K/100) * annuity
    DV01         = annuity * 1bp               (= annuity * 0.0001)
At K = par_rate, PV = 0 and PV(fixed) == PV(float).

LIVE vs SAMPLE

Live path: pull the par-swap tenors through the SAME FRED fetcher
(`app.data.macro_data.fetch_series`) used by yield_curve.py / forward_rates.py,
and the matched Treasury yields via the DGS* series. Note that the legacy USD
constant-maturity swap series (DSWP1..DSWP30) were DISCONTINUED by FRED in 2016,
so most tenors no longer resolve; per the honesty contract we never fabricate a
gone tenor as live - if too few swap tenors resolve we degrade the WHOLE payload
to a deterministic, realistic SAMPLE SOFR curve (and bootstrap the same DFs from
it). This module never raises - it always returns a populated payload tagged with
data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from .macro_data import fetch_series

log = logging.getLogger(__name__)

# Standard swap tenors. (label, years, swap FRED id, treasury FRED id).
# The DSWP* swap series are discontinued on FRED (kept here for the honest live
# attempt); DGS* Treasury series are still active and free.
TENORS: list[tuple[str, float, str, str]] = [
    ("1Y", 1.0, "DSWP1", "DGS1"),
    ("2Y", 2.0, "DSWP2", "DGS2"),
    ("3Y", 3.0, "DSWP3", "DGS3"),
    ("5Y", 5.0, "DSWP5", "DGS5"),
    ("7Y", 7.0, "DSWP7", "DGS7"),
    ("10Y", 10.0, "DSWP10", "DGS10"),
    ("20Y", 20.0, "DSWP20", "DGS20"),
    ("30Y", 30.0, "DSWP30", "DGS30"),
]

# Representative swap the pricer card prices.
PRICER_TENOR_YEARS = 5.0
PRICER_NOTIONAL = 10_000_000.0
PRICER_DIRECTION = "pay-fixed"

# Deterministic SAMPLE SOFR par-swap curve (percent). Realistic late-2025 /
# early-2026 levels: an inverted front end that dips through the belly and rolls
# back up - the SOFR swap curve has sat slightly below Treasuries (negative swap
# spreads) that widen at the long end.
SAMPLE_SWAP: dict[str, float] = {
    "1Y": 4.25,
    "2Y": 4.00,
    "3Y": 3.92,
    "5Y": 3.90,
    "7Y": 3.98,
    "10Y": 4.08,
    "20Y": 4.28,
    "30Y": 4.22,
}

# Deterministic SAMPLE matched-maturity Treasury curve (percent).
SAMPLE_TREASURY: dict[str, float] = {
    "1Y": 4.30,
    "2Y": 4.07,
    "3Y": 4.00,
    "5Y": 4.02,
    "7Y": 4.12,
    "10Y": 4.24,
    "20Y": 4.52,
    "30Y": 4.46,
}


# ---------------------------------------------------------------------------
# Interpolation + bootstrap
# ---------------------------------------------------------------------------

def _interp(nodes: list[tuple[float, float]], t: float) -> float:
    """Linear-interpolate the par rate (percent) at `t` years from an ascending
    list of (years, rate). Clamps flat beyond the endpoints."""
    if not nodes:
        return 0.0
    if t <= nodes[0][0]:
        return nodes[0][1]
    if t >= nodes[-1][0]:
        return nodes[-1][1]
    for (x0, y0), (x1, y1) in zip(nodes, nodes[1:]):
        if x0 <= t <= x1:
            if x1 == x0:
                return y0
            w = (t - x0) / (x1 - x0)
            return y0 + w * (y1 - y0)
    return nodes[-1][1]


def _bootstrap_dfs(nodes: list[tuple[float, float]], max_year: int) -> dict[int, float]:
    """Bootstrap annual discount factors from the (years, par-rate-%) nodes.

    Interpolates the par curve onto an annual grid, then for each year solves the
    DF that reprices that year's par swap to par given the prior DFs. Returns
    {year: DF} for years 1..max_year. DFs are clamped into (0, 1] and are strictly
    decreasing whenever the implied annual forwards are positive (true for any
    realistic positive-rate curve)."""
    dfs: dict[int, float] = {}
    running = 0.0  # sum of DF_i for i < current year
    for y in range(1, max_year + 1):
        s = _interp(nodes, float(y)) / 100.0  # par rate as a decimal
        df = (1.0 - s * running) / (1.0 + s)
        # Guard the contract: DF must stay in (0, 1].
        if df > 1.0:
            df = 1.0
        elif df <= 0.0:
            df = 1e-9
        dfs[y] = df
        running += df
    return dfs


# ---------------------------------------------------------------------------
# Curve + pricer assembly
# ---------------------------------------------------------------------------

def _build_rows(swap_by_label: dict[str, float], treasury_by_label: dict[str, float],
                dfs: dict[int, float]) -> list[dict]:
    rows: list[dict] = []
    for label, years, _swap_id, _tsy_id in TENORS:
        swap_rate = swap_by_label.get(label)
        tsy = treasury_by_label.get(label)
        df = dfs.get(int(years))
        spread_bps = (
            round((swap_rate - tsy) * 100.0, 1)
            if swap_rate is not None and tsy is not None
            else None
        )
        rows.append({
            "tenor_label": label,
            "tenor_years": years,
            "swap_rate": round(swap_rate, 3) if swap_rate is not None else None,
            "treasury_yield": round(tsy, 3) if tsy is not None else None,
            "swap_spread_bps": spread_bps,
            "discount_factor": round(df, 6) if df is not None else None,
        })
    return rows


def _price_swap(dfs: dict[int, float]) -> dict:
    """Price the representative pay-fixed vanilla swap off the bootstrapped DFs."""
    n = int(PRICER_TENOR_YEARS)
    notional = PRICER_NOTIONAL
    annuity_unit = sum(dfs[y] for y in range(1, n + 1))  # sum DF * accrual (tau=1)
    df_n = dfs[n]

    annuity = annuity_unit * notional                    # fixed-leg PV01 per unit rate
    par_rate_dec = (1.0 - df_n) / annuity_unit if annuity_unit else 0.0
    par_rate_pct = par_rate_dec * 100.0

    # Strike the representative swap at-market (fixed_rate = par rate) so it prices
    # to PV ~ 0 - the canonical SWPM check that the curve reconciles.
    fixed_rate_pct = par_rate_pct
    pv_float = (1.0 - df_n) * notional
    pv_fixed = (fixed_rate_pct / 100.0) * annuity
    pv = pv_float - pv_fixed                             # ~ 0 at the par rate

    dv01 = annuity * 0.0001                              # PV of a 1bp coupon stream

    return {
        "tenor_years": PRICER_TENOR_YEARS,
        "notional": notional,
        "fixed_rate": round(fixed_rate_pct, 4),
        "par_rate": round(par_rate_pct, 4),
        "pv": round(pv, 2),
        "annuity": round(annuity, 2),
        "dv01": round(dv01, 2),
        "direction": PRICER_DIRECTION,
    }


def _classify_shape(swap_by_label: dict[str, float]) -> str:
    s2 = swap_by_label.get("2Y")
    s10 = swap_by_label.get("10Y")
    if s2 is None or s10 is None:
        return "unknown"
    slope = s10 - s2
    if slope < -0.10:
        return "inverted"
    if abs(slope) < 0.20:
        return "flat"
    if slope > 1.20:
        return "steep"
    return "normal"


def _assemble(swap_by_label: dict[str, float], treasury_by_label: dict[str, float],
              *, data_mode: str, source: str) -> dict:
    nodes = sorted(
        (years, swap_by_label[label])
        for label, years, _s, _t in TENORS
        if swap_by_label.get(label) is not None
    )
    max_year = int(max((y for y, _ in nodes), default=0))
    dfs = _bootstrap_dfs(nodes, max_year) if nodes else {}

    rows = _build_rows(swap_by_label, treasury_by_label, dfs)
    pricer = _price_swap(dfs) if dfs.get(int(PRICER_TENOR_YEARS)) else {}

    # Widest swap spread = largest absolute spread across the curve.
    widest = {"tenor_label": None, "spread_bps": None}
    for r in rows:
        sb = r["swap_spread_bps"]
        if sb is None:
            continue
        if widest["spread_bps"] is None or abs(sb) > abs(widest["spread_bps"]):
            widest = {"tenor_label": r["tenor_label"], "spread_bps": sb}

    summary = {
        "curve_shape": _classify_shape(swap_by_label),
        "widest_spread": widest,
        "par_5y": pricer.get("par_rate"),
    }

    return {
        "curve": rows,
        "pricer": pricer,
        "summary": summary,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Live + sample paths
# ---------------------------------------------------------------------------

def _latest(series_id: str) -> float | None:
    """Latest non-null level for a FRED series, or None. Never raises."""
    try:
        series = fetch_series(series_id, days=30)
        for p in reversed(series or []):
            v = p.get("value")
            if v is not None:
                return round(float(v), 3)
    except Exception:
        return None
    return None


def _live_payload() -> dict | None:
    """Attempt a live swap curve from FRED. The legacy DSWP* series are
    discontinued, so this typically resolves too few tenors and returns None so
    the caller falls to SAMPLE - we never fabricate a gone tenor as live."""
    swap_by_label: dict[str, float] = {}
    treasury_by_label: dict[str, float] = {}
    for label, _years, swap_id, tsy_id in TENORS:
        sr = _latest(swap_id)
        if sr is not None:
            swap_by_label[label] = sr
        tr = _latest(tsy_id)
        if tr is not None:
            treasury_by_label[label] = tr
    # Require a meaningful chunk of the SWAP curve to resolve live (it won't while
    # DSWP* stays discontinued) - Treasury alone is not enough to claim "live".
    if len(swap_by_label) < 6:
        return None
    return _assemble(swap_by_label, treasury_by_label, data_mode="live", source="FRED")


def _sample_payload() -> dict:
    return _assemble(dict(SAMPLE_SWAP), dict(SAMPLE_TREASURY),
                     data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def swap_curve() -> dict:
    """Bootstrap the SOFR swap curve, price a vanilla swap, and measure swap
    spreads vs Treasuries. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("curve"):
            return live
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("swap_curve live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("swap_curve sample path failed hard: %s", e)
        return {
            "curve": [],
            "pricer": {},
            "summary": {"curve_shape": "unknown",
                        "widest_spread": {"tenor_label": None, "spread_bps": None},
                        "par_5y": None},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
