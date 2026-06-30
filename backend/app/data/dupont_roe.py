"""DuPont ROE Decomposition (3-step + 5-step, multi-year).

Breaks Return on Equity into the operating, efficiency, and leverage drivers
that produced it, so a reader can see *why* ROE moved rather than just that it
did.

- 3-step DuPont:
    ROE = Net Profit Margin (NI / Revenue)
        x Asset Turnover     (Revenue / Total Assets)
        x Equity Multiplier  (Total Assets / Total Equity)

- 5-step DuPont (splits net margin into tax / interest / operating drag):
    ROE = Tax Burden        (NI / Pretax Income)
        x Interest Burden   (Pretax Income / EBIT)
        x Operating Margin  (EBIT / Revenue)
        x Asset Turnover    (Revenue / Total Assets)
        x Equity Multiplier (Total Assets / Total Equity)

Both chains telescope to NI / Equity, so the product of the components MUST tie
back to the reconstructed ROE for every fiscal year. That multiplicative
identity is the integrity invariant of this module: each component is computed
from the same coherent base dollar figures (Revenue, Net Income, Pretax, EBIT,
Total Assets, Total Equity), so the chain reconstructs ROE exactly. A per-year
`tie` flag records that the product reconciles to NI/Equity within rounding.

The live path reads yfinance `income_stmt` + `balance_sheet` row labels across
the available fiscal-year columns (typically four), with sensible aliases since
yfinance label names drift. When statements are missing or too sparse, the
module degrades to a deterministic, md5-seeded SAMPLE built from coherent base
dollar figures (so the DuPont identity holds in sample too, not from independent
random ratios). This module NEVER raises - it always returns a populated dict
tagged with data_mode / as_of / source / symbol for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import math
from datetime import datetime, timezone

log = logging.getLogger(__name__)

SOURCE_LIVE = "yfinance fundamentals"
SOURCE_SAMPLE = "sample"

MAX_YEARS = 4
# Reconstructed-vs-actual ROE tolerance (fraction of actual) for the tie flag.
TIE_TOL = 1e-4


# ---------------------------------------------------------------------------
# Determinism helpers
# ---------------------------------------------------------------------------

def _jitter(symbol: str, key: str, lo: float, hi: float) -> float:
    """Stable pseudo-random value in [lo, hi] keyed by symbol+field."""
    h = int(hashlib.md5(f"{symbol}:{key}".encode()).hexdigest()[:8], 16)
    frac = (h % 10_000) / 10_000.0
    return lo + frac * (hi - lo)


# ---------------------------------------------------------------------------
# Safe math helpers
# ---------------------------------------------------------------------------

def _div(a, b):
    if a is None or b is None or b == 0:
        return None
    try:
        return a / b
    except Exception:
        return None


def _round(x, n=2):
    if x is None:
        return None
    try:
        if math.isnan(x) or math.isinf(x):
            return None
        return round(float(x), n)
    except Exception:
        return None


def _num(x):
    """Coerce to a finite float or None."""
    if x is None:
        return None
    try:
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Sample financials - a healthy large-cap with improving ROE over 4 fiscal years.
# Built from coherent base dollar figures so the DuPont identity holds exactly.
# All figures in millions of USD. Year index 0 = latest (t).
# ---------------------------------------------------------------------------

def _sample_financials(symbol: str) -> list[dict]:
    sym = (symbol or "AAPL").upper()
    scale = _jitter(sym, "scale", 0.5, 1.7)           # company size multiplier
    growth = _jitter(sym, "growth", 1.06, 1.13)       # YoY revenue growth
    base_rev = 380_000.0 * scale                      # latest-year revenue

    net_margin0 = _jitter(sym, "nm", 0.16, 0.27)      # latest net margin
    tax_burden0 = _jitter(sym, "tax", 0.79, 0.88)     # NI / pretax
    int_burden0 = _jitter(sym, "intb", 0.93, 0.995)   # pretax / EBIT
    turn0 = _jitter(sym, "turn", 0.70, 1.10)          # revenue / assets
    mult0 = _jitter(sym, "mult", 2.3, 3.6)            # assets / equity

    this_year = datetime.now(timezone.utc).year - 1

    rows: list[dict] = []
    for i in range(MAX_YEARS):
        # Prior years are slightly weaker so the latest year shows ROE improving,
        # driven mostly by margin + efficiency (turnover), with leverage easing.
        rev = base_rev / (growth ** i)
        nm = net_margin0 * (1 - 0.055 * i)
        turn = turn0 * (1 - 0.030 * i)
        mult = mult0 * (1 + 0.022 * i)                # more leverage in the past
        taxb = tax_burden0 * (1 + 0.004 * i)
        intb = int_burden0 * (1 - 0.004 * i)

        ni = rev * nm
        pretax = ni / taxb
        ebit = pretax / intb
        assets = rev / turn
        equity = assets / mult

        rows.append({
            "year": str(this_year - i),
            "revenue": rev,
            "net_income": ni,
            "pretax": pretax,
            "ebit": ebit,
            "assets": assets,
            "equity": equity,
        })
    return rows


# ---------------------------------------------------------------------------
# Live financials extraction (yfinance) - heavily guarded
# ---------------------------------------------------------------------------

def _row(df, names, col_idx):
    """Pull a numeric value for the first matching line-item label at a given
    year-column index. Returns None on any miss / NaN."""
    if df is None:
        return None
    try:
        if getattr(df, "empty", True):
            return None
        cols = list(df.columns)
        if col_idx >= len(cols):
            return None
        index_labels = {str(i).strip().lower(): i for i in df.index}
        for nm in names:
            key = nm.strip().lower()
            if key in index_labels:
                return _num(df.loc[index_labels[key], cols[col_idx]])
        return None
    except Exception:
        return None


def _col_year(df, col_idx) -> str:
    try:
        c = list(df.columns)[col_idx]
        if hasattr(c, "year"):
            return str(c.year)
        return str(c)[:4]
    except Exception:
        return "?"


def _live_financials(symbol: str) -> list[dict] | None:
    """Best-effort multi-year DuPont input set from yfinance. Returns None if the
    statements are missing or too sparse (need >=2 years with the core-4 items:
    revenue, net income, total assets, total equity)."""
    try:
        import yfinance as yf
        t = yf.Ticker(symbol)
        try:
            inc = t.income_stmt
        except Exception:
            inc = None
        try:
            bs = t.balance_sheet
        except Exception:
            bs = None

        if any(getattr(d, "empty", True) for d in (inc, bs)):
            return None

        n_years = min(len(inc.columns), len(bs.columns), MAX_YEARS)
        if n_years < 2:
            return None

        rows: list[dict] = []
        for i in range(n_years):
            rev = _row(inc, ["Total Revenue", "Operating Revenue", "Revenue"], i)
            ni = _row(inc, ["Net Income", "Net Income Common Stockholders",
                            "Net Income Continuous Operations"], i)
            pretax = _row(inc, ["Pretax Income", "Pre Tax Income",
                                "Income Before Tax"], i)
            ebit = _row(inc, ["EBIT", "Operating Income",
                              "Total Operating Income As Reported", "Normalized EBITDA"], i)
            assets = _row(bs, ["Total Assets"], i)
            equity = _row(bs, ["Stockholders Equity",
                               "Total Equity Gross Minority Interest",
                               "Common Stock Equity",
                               "Total Stockholder Equity"], i)

            # Core-4 must exist or we cannot decompose ROE honestly for this year.
            if any(v is None for v in (rev, ni, assets, equity)) or rev == 0 or equity == 0:
                continue

            # yfinance statements are in raw dollars; normalize to millions to
            # match the sample scale (ratios are scale-invariant either way).
            def m(v):
                return None if v is None else v / 1e6

            rows.append({
                "year": _col_year(inc, i),
                "revenue": m(rev),
                "net_income": m(ni),
                "pretax": m(pretax),
                "ebit": m(ebit),
                "assets": m(assets),
                "equity": m(equity),
            })

        if len(rows) < 2:
            return None
        return rows
    except Exception as e:
        log.warning("dupont_roe live fetch failed for %s: %s", symbol, e)
        return None


# ---------------------------------------------------------------------------
# Decomposition
# ---------------------------------------------------------------------------

def _decompose_year(fin: dict) -> dict:
    """Compute the 3-step and 5-step DuPont components for one fiscal year and
    verify the multiplicative identity ties to NI/Equity."""
    rev = _num(fin.get("revenue"))
    ni = _num(fin.get("net_income"))
    pretax = _num(fin.get("pretax"))
    ebit = _num(fin.get("ebit"))
    assets = _num(fin.get("assets"))
    equity = _num(fin.get("equity"))

    # 3-step decimals
    net_margin_d = _div(ni, rev)
    asset_turnover = _div(rev, assets)
    equity_multiplier = _div(assets, equity)
    roe_actual_d = _div(ni, equity)

    roe_3_d = None
    if None not in (net_margin_d, asset_turnover, equity_multiplier):
        roe_3_d = net_margin_d * asset_turnover * equity_multiplier

    # 5-step decimals
    tax_burden = _div(ni, pretax)
    interest_burden = _div(pretax, ebit)
    operating_margin_d = _div(ebit, rev)
    have_5 = None not in (tax_burden, interest_burden, operating_margin_d,
                          asset_turnover, equity_multiplier)
    roe_5_d = None
    if have_5:
        roe_5_d = (tax_burden * interest_burden * operating_margin_d
                   * asset_turnover * equity_multiplier)

    # Integrity invariant: reconstructed ROE must tie to actual NI/Equity.
    def _tie(recon):
        if recon is None or roe_actual_d is None:
            return False
        denom = max(abs(roe_actual_d), 1e-9)
        return abs(recon - roe_actual_d) / denom < TIE_TOL

    tie_3 = _tie(roe_3_d)
    tie_5 = _tie(roe_5_d) if roe_5_d is not None else None

    return {
        "year": fin.get("year", "?"),
        # 3-step (margins as %, turnover/multiplier as x)
        "net_margin": _round((net_margin_d or 0) * 100, 2) if net_margin_d is not None else None,
        "asset_turnover": _round(asset_turnover, 3),
        "equity_multiplier": _round(equity_multiplier, 2),
        "roe": _round((roe_3_d if roe_3_d is not None else roe_actual_d or 0) * 100, 2)
        if (roe_3_d is not None or roe_actual_d is not None) else None,
        # 5-step
        "tax_burden": _round(tax_burden, 3),
        "interest_burden": _round(interest_burden, 3),
        "operating_margin": _round((operating_margin_d or 0) * 100, 2) if operating_margin_d is not None else None,
        "roe_5step": _round((roe_5_d or 0) * 100, 2) if roe_5_d is not None else None,
        # reconciliation
        "roe_actual": _round((roe_actual_d or 0) * 100, 2) if roe_actual_d is not None else None,
        "tie": bool(tie_3),
        "tie_5step": tie_5,
        # raw decimals retained for attribution math (not for display)
        "_roe_d": roe_actual_d,
        "_margin_d": net_margin_d,
        "_turnover": asset_turnover,
        "_multiplier": equity_multiplier,
    }


# ---------------------------------------------------------------------------
# Driver attribution (latest vs prior year, log-decomposition)
# ---------------------------------------------------------------------------

def _attribution(rows: list[dict]) -> dict:
    """Identify which 3-step factor moved ROE most YoY (latest vs prior) and
    whether the change was margin- / efficiency- / leverage-driven."""
    out = {
        "dominant": None,
        "verdict": "Not enough fiscal-year history to attribute the ROE change.",
        "roe_change_pct": None,
        "contributions": [],
        "direction": "flat",
    }
    if len(rows) < 2:
        return out

    cur, prev = rows[0], rows[1]

    def _ln(x):
        return math.log(x) if (x is not None and x > 0) else None

    factors = [
        ("Net Margin", "margin", cur["_margin_d"], prev["_margin_d"]),
        ("Asset Turnover", "efficiency", cur["_turnover"], prev["_turnover"]),
        ("Equity Multiplier", "leverage", cur["_multiplier"], prev["_multiplier"]),
    ]

    contribs = []
    for label, kind, c, p in factors:
        lc, lp = _ln(c), _ln(p)
        d = (lc - lp) if (lc is not None and lp is not None) else None
        contribs.append({"factor": label, "kind": kind, "dln": d})

    roe_cur, roe_prev = cur["_roe_d"], prev["_roe_d"]
    roe_change_pct = None
    if roe_cur is not None and roe_prev is not None:
        roe_change_pct = _round((roe_cur - roe_prev) * 100, 2)
        out["direction"] = "up" if roe_cur > roe_prev else ("down" if roe_cur < roe_prev else "flat")
    out["roe_change_pct"] = roe_change_pct

    scored = [c for c in contribs if c["dln"] is not None]
    if not scored:
        out["verdict"] = "ROE drivers could not be compared across years."
        out["contributions"] = [
            {"factor": c["factor"], "kind": c["kind"],
             "contribution_pct": None} for c in contribs
        ]
        return out

    total_abs = sum(abs(c["dln"]) for c in scored) or 1.0
    for c in contribs:
        if c["dln"] is None:
            c["contribution_pct"] = None
        else:
            c["contribution_pct"] = _round(abs(c["dln"]) / total_abs * 100, 1)

    dominant = max(scored, key=lambda c: abs(c["dln"]))
    out["dominant"] = dominant["factor"]
    out["contributions"] = [
        {"factor": c["factor"], "kind": c["kind"], "contribution_pct": c["contribution_pct"]}
        for c in contribs
    ]

    kind_word = {"margin": "margin-driven", "efficiency": "efficiency-driven",
                 "leverage": "leverage-driven"}[dominant["kind"]]
    rose = dominant["dln"] > 0
    if out["direction"] == "up":
        out["verdict"] = (
            f"ROE rose {abs(roe_change_pct):.1f}pts YoY - {kind_word}, led by "
            f"{'a higher ' if rose else 'a lower '}{dominant['factor'].lower()}."
        )
    elif out["direction"] == "down":
        out["verdict"] = (
            f"ROE fell {abs(roe_change_pct):.1f}pts YoY - {kind_word}, dragged by "
            f"{'a higher ' if rose else 'a lower '}{dominant['factor'].lower()}."
        )
    else:
        out["verdict"] = f"ROE held roughly flat YoY; {dominant['factor'].lower()} moved most."
    return out


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def dupont_roe(symbol: str) -> dict:
    """Multi-year DuPont ROE decomposition for a single equity.

    Returns a fully-populated dict (never raises). Falls back to deterministic
    sample financials when live statements are unavailable or too sparse. Every
    year's 3-step and 5-step components multiply back to the reconstructed ROE
    (the `tie` flag records the reconciliation).
    """
    sym = (symbol or "AAPL").strip().upper() or "AAPL"
    try:
        fins = _live_financials(sym)
        data_mode = "live"
        source = SOURCE_LIVE
        if not fins:
            fins = _sample_financials(sym)
            data_mode = "sample"
            source = SOURCE_SAMPLE
        return _build(sym, fins, data_mode, source)
    except Exception as e:  # absolute safety net
        log.warning("dupont_roe hard-failed for %s: %s", sym, e)
        try:
            return _build(sym, _sample_financials(sym), "sample", SOURCE_SAMPLE)
        except Exception:
            return {
                "symbol": sym,
                "years": [],
                "attribution": {"dominant": None, "verdict": "No data.",
                                "roe_change_pct": None, "contributions": [],
                                "direction": "flat"},
                "latest_roe": None,
                "identity_holds": False,
                "data_mode": "sample",
                "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": SOURCE_SAMPLE,
            }


def _build(sym: str, fins: list[dict], data_mode: str, source: str) -> dict:
    rows = [_decompose_year(f) for f in fins]
    attribution = _attribution(rows)

    # Strip internal raw-decimal helpers before serializing.
    public_rows = []
    for r in rows:
        public_rows.append({k: v for k, v in r.items() if not k.startswith("_")})

    identity_holds = all(r["tie"] for r in rows) if rows else False
    latest_roe = public_rows[0]["roe"] if public_rows else None

    return {
        "symbol": sym,
        "years": public_rows,
        "attribution": attribution,
        "latest_roe": latest_roe,
        "identity_holds": identity_holds,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
