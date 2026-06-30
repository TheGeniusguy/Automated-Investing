"""Brinson-Fachler Performance Attribution (Bloomberg PORT attribution tab).

Decomposes a portfolio's ACTIVE return (portfolio return minus benchmark return)
into three effects per GICS sector:

  - Allocation_i = (w_p,i - w_b,i) * (R_b,i - R_b)
        reward for over/under-weighting a sector relative to the benchmark,
        measured against how that sector's benchmark return beat the overall
        benchmark.
  - Selection_i  = w_b,i * (R_p,i - R_b,i)
        reward for picking holdings that beat the sector's benchmark proxy,
        scaled by the BENCHMARK weight (pure Brinson-Fachler selection).
  - Interaction_i = (w_p,i - w_b,i) * (R_p,i - R_b,i)
        the cross term between active weight and active selection.

THE INVARIANT (built into the math, not asserted after the fact):
  sum_i (Allocation_i + Selection_i + Interaction_i) == R_p - R_b   exactly,
provided both weight vectors sum to 1 over the SAME sector set. Algebra:
  Alloc_i + Sel_i + Int_i = w_p,i*R_p,i - w_b,i*R_b,i - (w_p,i - w_b,i)*R_b
  summing and using sum(w_p) = sum(w_b) = 1  =>  sum(w_p,i-w_b,i)=0, so the last
  term vanishes and the sum collapses to sum(w_p,i R_p,i) - sum(w_b,i R_b,i)
  = R_p - R_b. We therefore DEFINE R_b = sum_i w_b,i * R_b,i and
  R_p = sum_i w_p,i * R_p,i so the decomposition reconciles to the penny.

Benchmark = SPY, proxied by the 11 SPDR sector ETFs (XLK/XLF/XLV/XLY/XLC/XLI/
XLP/XLE/XLU/XLRE/XLB) over a trailing ~3-month (~63 trading-day) window. Each
sector ETF's trailing return is R_b,i. The benchmark per-sector weight w_b,i is a
documented fixed GICS weight vector for the S&P 500 (SPY_GICS_WEIGHTS) - exact
live SPY sector weights are not freely available, so this is carried as a
constant; it is a legitimate, disclosed benchmark assumption, not "sample" data.
SPY's own trailing return is also fetched (live-availability signal + reported as
spy_actual_return) but the canonical bench_return used in the formulas is the
sector-weighted SPY proxy so the math reconciles exactly.

Portfolio side: holdings come from the shipped transaction log via
crud.get_transactions -> positions.compute_positions -> valuation.enrich_positions
(which supplies each holding's GICS `sector` from yfinance .info and its
market value). Each holding is mapped to a canonical GICS sector and weights are
aggregated + renormalized to 1 across mapped equity holdings. R_p,i is the
market-value-weighted trailing return of that sector's holdings (each holding's
trailing return via fetch_arbitrary_ticker).

Live path uses fetch_arbitrary_ticker for every ETF + SPY + holding. When no
portfolio exists, the book has no mappable holdings, or live prices are
unavailable, the function returns a rich deterministic SAMPLE attribution tagged
data_mode="sample". This module NEVER raises - it always returns a populated
payload carrying data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Trailing window for sector + holding returns (~3 months of trading days).
PERIOD_DAYS = 63
PERIOD_LABEL = "Trailing 3M (~63 trading days)"
BENCHMARK = "SPY"

# Minimum sector ETFs that must resolve live before we trust the live path.
MIN_LIVE_ETFS = 9

# Minimum fraction of mapped portfolio market value whose OWN trailing return must
# resolve before we trust the live path. Below this the portfolio side was never
# really measured, so we fall back to SAMPLE rather than tag fabricated data live.
MIN_LIVE_HOLDING_COVERAGE = 0.5


# ---------------------------------------------------------------------------
# GICS sector definitions: canonical name -> SPDR ETF + yfinance sector aliases
# + a documented fixed S&P 500 sector weight (normalized to 1 at use time).
# ---------------------------------------------------------------------------

class _Sector:
    __slots__ = ("name", "etf", "aliases", "spy_weight")

    def __init__(self, name: str, etf: str, aliases: tuple[str, ...], spy_weight: float):
        self.name = name
        self.etf = etf
        self.aliases = aliases
        self.spy_weight = spy_weight


# Order = display order. spy_weight = approximate S&P 500 GICS weights (mid-2024,
# documented constant; renormalized to sum 1 in _normalize). yfinance reports
# slightly different sector strings (e.g. "Financial Services", "Consumer
# Cyclical") so each canonical sector lists its aliases.
GICS_SECTORS: list[_Sector] = [
    _Sector("Technology",             "XLK",  ("Technology", "Information Technology"),          0.290),
    _Sector("Financials",             "XLF",  ("Financial Services", "Financials"),             0.130),
    _Sector("Health Care",            "XLV",  ("Healthcare", "Health Care"),                    0.120),
    _Sector("Consumer Discretionary", "XLY",  ("Consumer Cyclical", "Consumer Discretionary"),  0.105),
    _Sector("Communication Services", "XLC",  ("Communication Services",),                      0.087),
    _Sector("Industrials",            "XLI",  ("Industrials",),                                 0.083),
    _Sector("Consumer Staples",       "XLP",  ("Consumer Defensive", "Consumer Staples"),       0.060),
    _Sector("Energy",                 "XLE",  ("Energy",),                                      0.038),
    _Sector("Utilities",              "XLU",  ("Utilities",),                                   0.025),
    _Sector("Real Estate",            "XLRE", ("Real Estate",),                                 0.022),
    _Sector("Materials",              "XLB",  ("Basic Materials", "Materials"),                 0.022),
]

_ALIAS_TO_SECTOR: dict[str, str] = {}
for _s in GICS_SECTORS:
    _ALIAS_TO_SECTOR[_s.name.lower()] = _s.name
    for _a in _s.aliases:
        _ALIAS_TO_SECTOR[_a.lower()] = _s.name

_ETF_BY_SECTOR: dict[str, str] = {s.name: s.etf for s in GICS_SECTORS}
_SPYW_BY_SECTOR: dict[str, float] = {s.name: s.spy_weight for s in GICS_SECTORS}


# ---------------------------------------------------------------------------
# Deterministic SAMPLE attribution. Realistic active book vs the benchmark; the
# effects are COMPUTED from these inputs via the same formulas, so the sample
# payload reconciles exactly by construction. Weights are fractions, returns are
# decimal fractions (e.g. 0.078 = +7.8%).
# ---------------------------------------------------------------------------

# (sector, w_port, w_bench, r_port, r_bench)
SAMPLE_SECTORS: list[tuple[str, float, float, float, float]] = [
    ("Technology",             0.34, 0.290,  0.078,  0.065),
    ("Financials",             0.10, 0.130,  0.032,  0.041),
    ("Health Care",            0.08, 0.120,  0.015,  0.021),
    ("Consumer Discretionary", 0.12, 0.105,  0.054,  0.047),
    ("Communication Services", 0.11, 0.087,  0.090,  0.072),
    ("Industrials",            0.07, 0.083,  0.038,  0.035),
    ("Consumer Staples",       0.04, 0.060,  0.012,  0.010),
    ("Energy",                 0.05, 0.038, -0.025, -0.018),
    ("Utilities",              0.03, 0.025,  0.020,  0.016),
    ("Real Estate",            0.02, 0.022, -0.010, -0.005),
    ("Materials",              0.04, 0.022,  0.028,  0.022),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _map_sector(raw: str | None) -> str | None:
    if not raw:
        return None
    return _ALIAS_TO_SECTOR.get(str(raw).strip().lower())


def _period_return(symbol: str) -> float | None:
    """Trailing return (decimal) over ~PERIOD_DAYS trading days via the shipped
    price entrypoint. None when fewer than 2 valid closes resolve."""
    from ..data.macro_data import fetch_arbitrary_ticker
    try:
        pts = fetch_arbitrary_ticker(symbol, days=PERIOD_DAYS)
    except Exception as e:
        log.warning("attribution: fetch %s failed: %s", symbol, e)
        return None
    vals = [float(p["value"]) for p in (pts or []) if p.get("value") is not None]
    if len(vals) < 2 or vals[0] <= 0:
        return None
    return vals[-1] / vals[0] - 1.0


def _round(x: float, n: int = 4) -> float:
    return round(float(x), n)


# ---------------------------------------------------------------------------
# Core assembly - shared by the live and sample paths. Both invariants are
# guaranteed here because R_b and R_p are defined from the same weight set.
# ---------------------------------------------------------------------------

def _assemble(
    rows: list[dict],          # each: {sector, w_port_raw, w_bench_raw, r_port, r_bench}
    *,
    portfolio_id: int | None,
    data_mode: str,
    source: str,
    spy_actual_return: float | None,
) -> dict:
    # Normalize both weight vectors to sum 1 over the SAME sector set so the
    # decomposition reconciles exactly.
    wp_tot = sum(max(r["w_port_raw"], 0.0) for r in rows) or 1.0
    wb_tot = sum(max(r["w_bench_raw"], 0.0) for r in rows) or 1.0
    for r in rows:
        r["w_port"] = max(r["w_port_raw"], 0.0) / wp_tot
        r["w_bench"] = max(r["w_bench_raw"], 0.0) / wb_tot
        # Sectors the portfolio does not hold contribute no selection/interaction.
        if r["w_port"] <= 0.0:
            r["r_port"] = r["r_bench"]

    # Canonical benchmark + portfolio returns (decimal) from the weight set.
    bench_ret = sum(r["w_bench"] * r["r_bench"] for r in rows)
    port_ret = sum(r["w_port"] * r["r_port"] for r in rows)

    sectors: list[dict] = []
    tot_alloc = tot_sel = tot_int = 0.0
    for r in rows:
        dw = r["w_port"] - r["w_bench"]
        alloc = dw * (r["r_bench"] - bench_ret)
        sel = r["w_bench"] * (r["r_port"] - r["r_bench"])
        inter = dw * (r["r_port"] - r["r_bench"])
        total = alloc + sel + inter
        tot_alloc += alloc
        tot_sel += sel
        tot_int += inter
        sectors.append({
            "sector":      r["sector"],
            "w_port":      _round(r["w_port"]),
            "w_bench":     _round(r["w_bench"]),
            "r_port":      _round(r["r_port"] * 100.0),
            "r_bench":     _round(r["r_bench"] * 100.0),
            "allocation":  _round(alloc * 100.0),
            "selection":   _round(sel * 100.0),
            "interaction": _round(inter * 100.0),
            "total":       _round(total * 100.0),
        })

    active = port_ret - bench_ret
    totals = {
        "allocation":    _round(tot_alloc * 100.0),
        "selection":     _round(tot_sel * 100.0),
        "interaction":   _round(tot_int * 100.0),
        "active_return": _round(active * 100.0),
        "port_return":   _round(port_ret * 100.0),
        "bench_return":  _round(bench_ret * 100.0),
    }

    best = max(sectors, key=lambda s: s["total"]) if sectors else None
    worst = min(sectors, key=lambda s: s["total"]) if sectors else None
    effects = {
        "Allocation": abs(totals["allocation"]),
        "Selection": abs(totals["selection"]),
        "Interaction": abs(totals["interaction"]),
    }
    dominant = max(effects, key=effects.get) if any(effects.values()) else "Allocation"
    summary = {
        "best_sector": best["sector"] if best else None,
        "worst_sector": worst["sector"] if worst else None,
        "dominant_effect": dominant,
    }

    return {
        "portfolio_id": portfolio_id,
        "period_label": PERIOD_LABEL,
        "sectors": sectors,
        "totals": totals,
        "summary": summary,
        "spy_actual_return": _round(spy_actual_return * 100.0) if spy_actual_return is not None else None,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Sample + live builders
# ---------------------------------------------------------------------------

def _sample_payload(portfolio_id: int | None) -> dict:
    rows = [
        {"sector": name, "w_port_raw": wp, "w_bench_raw": wb, "r_port": rp, "r_bench": rb}
        for (name, wp, wb, rp, rb) in SAMPLE_SECTORS
    ]
    # SPY actual (informational) is left None in sample to avoid implying a
    # separately-sourced number; bench_return is the sector-weighted proxy.
    return _assemble(rows, portfolio_id=portfolio_id, data_mode="sample",
                     source="sample", spy_actual_return=None)


def _build_portfolio_rows(portfolio_id: int) -> list[dict] | None:
    """Aggregate the portfolio's enriched holdings into per-sector
    {weight, return}. Returns None when no mappable equity holdings resolve."""
    from . import crud
    from .positions import compute_positions
    from .valuation import enrich_positions

    txns = crud.get_transactions(portfolio_id)
    if not txns:
        return None
    positions, _realized, _cash_delta = compute_positions(txns)
    if not positions:
        return None

    port = crud.get_portfolio(portfolio_id)
    cash = float(port["cash_balance"]) if port else 0.0
    enriched, _summary = enrich_positions(positions, cash)

    # Aggregate market value + value-weighted return by canonical sector. A
    # holding whose own trailing return fails to resolve contributes its MV to
    # mv_by_sector (so weights stay honest) but NOT to the return numerator or to
    # resolved_mv_by_sector, so r_port is computed over only the MV we actually
    # measured (never silently diluted toward 0% by unresolved holdings).
    mv_by_sector: dict[str, float] = {}            # total mapped MV per sector
    resolved_mv_by_sector: dict[str, float] = {}   # MV of holdings whose return resolved
    ret_num_by_sector: dict[str, float] = {}       # sum(resolved_mv * holding_return)
    total_mapped_mv = 0.0
    total_resolved_mv = 0.0
    for pos in enriched:
        sector = _map_sector(pos.get("sector"))
        if sector is None:
            continue
        mv = float(pos.get("market_value") or 0.0)
        if mv <= 0:
            continue
        mv_by_sector[sector] = mv_by_sector.get(sector, 0.0) + mv
        total_mapped_mv += mv
        hret = _period_return(pos["symbol"])
        if hret is not None:
            resolved_mv_by_sector[sector] = resolved_mv_by_sector.get(sector, 0.0) + mv
            ret_num_by_sector[sector] = ret_num_by_sector.get(sector, 0.0) + mv * hret
            total_resolved_mv += mv

    if not mv_by_sector:
        return None

    # Fetch each sector ETF trailing return (R_b,i). Only sectors whose ETF
    # resolves LIVE are carried; a missed ETF is dropped entirely rather than
    # back-filled from a sample constant, so no hardcoded value can leak into a
    # payload tagged data_mode="live". _assemble renormalizes both weight vectors
    # over whatever sector set survives, so the BF invariant still reconciles.
    etf_returns: dict[str, float] = {}
    for sec in GICS_SECTORS:
        r = _period_return(sec.etf)
        if r is not None:
            etf_returns[sec.name] = r

    spy_actual = _period_return(BENCHMARK)
    # Live gate: SPY + most sector ETFs must resolve.
    if spy_actual is None or len(etf_returns) < MIN_LIVE_ETFS:
        return None
    # Live gate: the portfolio side must actually be measured. If holdings
    # covering at least MIN_LIVE_HOLDING_COVERAGE of mapped MV failed to resolve
    # their own trailing return, every r_port would collapse to its ETF proxy and
    # the "live" portfolio return would be fabricated -> fall back to SAMPLE.
    if total_mapped_mv <= 0 or total_resolved_mv < MIN_LIVE_HOLDING_COVERAGE * total_mapped_mv:
        return None

    rows: list[dict] = []
    for sec in GICS_SECTORS:
        r_bench = etf_returns.get(sec.name)
        if r_bench is None:
            continue  # ETF return unresolved -> cannot honestly benchmark this sector
        mv = mv_by_sector.get(sec.name, 0.0)
        if mv > 0:
            res_mv = resolved_mv_by_sector.get(sec.name, 0.0)
            # r_port over only the MV whose return resolved. If NO holding in this
            # sector resolved, proxy with the sector ETF (selection/interaction
            # collapse to 0 for that sector rather than reporting a false 0% return).
            r_port = (ret_num_by_sector[sec.name] / res_mv) if res_mv > 0 else r_bench
        else:
            r_port = r_bench  # not held -> selection/interaction collapse to 0
        rows.append({
            "sector": sec.name,
            "w_port_raw": mv,
            "w_bench_raw": sec.spy_weight,
            "r_port": r_port,
            "r_bench": r_bench,
        })
    rows.append({"__spy_actual__": spy_actual})  # carried out-of-band
    return rows


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def attribution(portfolio_id: int | None = None) -> dict:
    """Brinson-Fachler sector attribution for a portfolio vs SPY. See module
    docstring. Always returns a populated dict; degrades to deterministic SAMPLE
    data tagged with data_mode / as_of / source."""
    try:
        from . import crud
        pid = portfolio_id
        if pid is None:
            try:
                portfolios = crud.list_portfolios()
            except Exception:
                portfolios = []
            if portfolios:
                pid = int(portfolios[0]["id"])
        if pid is not None:
            built = _build_portfolio_rows(pid)
            if built:
                spy_actual = None
                clean: list[dict] = []
                for r in built:
                    if "__spy_actual__" in r:
                        spy_actual = r["__spy_actual__"]
                    else:
                        clean.append(r)
                if clean:
                    return _assemble(clean, portfolio_id=pid, data_mode="live",
                                     source="yfinance", spy_actual_return=spy_actual)
        return _sample_payload(pid)
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("attribution failed hard, returning sample: %s", e)
        try:
            return _sample_payload(portfolio_id)
        except Exception as e2:
            log.error("attribution sample path failed hard: %s", e2)
            return {
                "portfolio_id": portfolio_id,
                "period_label": PERIOD_LABEL,
                "sectors": [],
                "totals": {
                    "allocation": 0.0, "selection": 0.0, "interaction": 0.0,
                    "active_return": 0.0, "port_return": 0.0, "bench_return": 0.0,
                },
                "summary": {"best_sector": None, "worst_sector": None, "dominant_effect": "Allocation"},
                "spy_actual_return": None,
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": "sample",
            }
