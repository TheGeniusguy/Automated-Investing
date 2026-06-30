"""EM Sovereign Risk & Reserves Dashboard (Bloomberg `EMBI`).

A per-country crisis-vulnerability board for emerging-market sovereigns. For each
country we frame four pillars of external solvency / liquidity:

  1. FX reserves and import-cover adequacy (reserves / monthly imports, in months).
     The classic Guidotti-Greenspan style read on how long a country can keep
     paying for imports if external financing dries up.
  2. A hard-currency EMBI-style spread (bps) - the country's USD-bond / long-term
     yield over the US 10Y. The market's running price of sovereign credit risk.
  3. A 5y sovereign CDS proxy (bps) derived from that spread via a simple
     recovery-adjusted basis mapping (R = 40%), labelled a proxy - we do not claim
     to be quoting a live CDS curve.
  4. External-debt-to-GDP and reserves-to-external-debt ratios - the stock side of
     vulnerability (how big is the hard-currency liability versus the buffer).

These roll into a composite crisis-vulnerability score (0-100) that is monotonic
in each pillar: higher spread, higher external-debt ratio, lower import-cover, and
lower reserves coverage all push the score UP. Countries are ranked riskiest-first
so a strong-reserves / low-debt sovereign can never outrank a weak one.

Live path: best-effort, bounded FRED pulls through the SAME cached
`app.data.macro_data.fetch_series` helper the shipped FRED modules use - the
IMF/IFS total-reserves series (USD) where FRED carries it. The hard-currency
spread is a credit-risk measure (USD-bond / CDS), which free FRED does NOT carry
for EM sovereigns, so it stays curated rather than being faked from a
local-currency nominal yield (a local-currency yield gap is dominated by inflation
and FX premium, not hard-currency default risk - mixing the two would mislabel the
column and wildly overstate high-inflation EMs). The spread column therefore
carries ONE consistent hard-currency definition across every row in both modes.
Every single fetch is wrapped in try/except; anything that does not resolve falls
back to a documented curated value (spreads / monthly imports / GDP / external-debt
ratios are curated samples). When too few reserves resolve live we degrade to a
fully deterministic SAMPLE grid.

This module NEVER raises - it always returns a populated payload carrying an
internal data_mode ("live" | "sample") + as_of + source for honesty under the
hood. No on-screen badge.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 6.0
# Require at least this many EM countries to resolve live FX reserves before trusting it.
LIVE_MIN_COUNTRIES = 6

# Recovery assumption for the CDS proxy mapping (40% recovery is the EM convention).
CDS_RECOVERY = 0.40
# Liquidity/basis factor: EM 5y CDS typically trades a touch inside the cash spread.
CDS_BASIS = 0.95

# Import cover above this many months is "more than adequate" - capped for scoring.
COVER_CAP_MONTHS = 14.0


# ---------------------------------------------------------------------------
# Country table.
#   fred_10y  = OECD LOCAL-currency long-term rate id. Retained for reference only;
#               NOT used to derive the hard-currency spread (a local-currency nominal
#               yield gap embeds inflation/FX premium, not USD default risk, so using
#               it would mislabel the column and overstate high-inflation EMs).
#   fred_res  = FRED IMF/IFS total-reserves-ex-gold id (USD). Best-effort, live.
#   curated_* = realistic mid-2026 sample levels for the sample board / missing legs.
#   reserves / imports / gdp are in USD BILLIONS in the table; converted to absolute
#   USD in the row builder.
# ---------------------------------------------------------------------------

COUNTRIES: list[dict] = [
    {
        "country": "Egypt", "code": "EG", "flag_label": "\U0001F1EA\U0001F1EC",
        "fred_10y": None, "fred_res": "TRESEGEGM052N",
        "curated_spread_bps": 560.0, "curated_ext_debt_pct": 43.0,
        "curated_reserves_b": 46.0, "curated_imports_b": 7.0, "curated_gdp_b": 400.0,
    },
    {
        "country": "Turkey", "code": "TR", "flag_label": "\U0001F1F9\U0001F1F7",
        "fred_10y": "IRLTLT01TRM156N", "fred_res": "TRESEGTRM052N",
        "curated_spread_bps": 380.0, "curated_ext_debt_pct": 50.0,
        "curated_reserves_b": 150.0, "curated_imports_b": 30.0, "curated_gdp_b": 1100.0,
    },
    {
        "country": "South Africa", "code": "ZA", "flag_label": "\U0001F1FF\U0001F1E6",
        "fred_10y": "IRLTLT01ZAM156N", "fred_res": "TRESEGZAM052N",
        "curated_spread_bps": 320.0, "curated_ext_debt_pct": 42.0,
        "curated_reserves_b": 62.0, "curated_imports_b": 9.0, "curated_gdp_b": 400.0,
    },
    {
        "country": "Colombia", "code": "CO", "flag_label": "\U0001F1E8\U0001F1F4",
        "fred_10y": "IRLTLT01COM156N", "fred_res": "TRESEGCOM052N",
        "curated_spread_bps": 290.0, "curated_ext_debt_pct": 55.0,
        "curated_reserves_b": 60.0, "curated_imports_b": 6.0, "curated_gdp_b": 360.0,
    },
    {
        "country": "Hungary", "code": "HU", "flag_label": "\U0001F1ED\U0001F1FA",
        "fred_10y": "IRLTLT01HUM156N", "fred_res": "TRESEGHUM052N",
        "curated_spread_bps": 200.0, "curated_ext_debt_pct": 60.0,
        "curated_reserves_b": 45.0, "curated_imports_b": 12.0, "curated_gdp_b": 220.0,
    },
    {
        "country": "Chile", "code": "CL", "flag_label": "\U0001F1E8\U0001F1F1",
        "fred_10y": "IRLTLT01CLM156N", "fred_res": "TRESEGCLM052N",
        "curated_spread_bps": 150.0, "curated_ext_debt_pct": 70.0,
        "curated_reserves_b": 46.0, "curated_imports_b": 7.5, "curated_gdp_b": 350.0,
    },
    {
        "country": "Brazil", "code": "BR", "flag_label": "\U0001F1E7\U0001F1F7",
        "fred_10y": "IRLTLT01BRM156N", "fred_res": "TRESEGBRM052N",
        "curated_spread_bps": 240.0, "curated_ext_debt_pct": 38.0,
        "curated_reserves_b": 350.0, "curated_imports_b": 21.0, "curated_gdp_b": 2100.0,
    },
    {
        "country": "Mexico", "code": "MX", "flag_label": "\U0001F1F2\U0001F1FD",
        "fred_10y": "IRLTLT01MXM156N", "fred_res": "TRESEGMXM052N",
        "curated_spread_bps": 210.0, "curated_ext_debt_pct": 35.0,
        "curated_reserves_b": 215.0, "curated_imports_b": 45.0, "curated_gdp_b": 1800.0,
    },
    {
        "country": "Indonesia", "code": "ID", "flag_label": "\U0001F1EE\U0001F1E9",
        "fred_10y": "IRLTLT01IDM156N", "fred_res": "TRESEGIDM052N",
        "curated_spread_bps": 175.0, "curated_ext_debt_pct": 30.0,
        "curated_reserves_b": 145.0, "curated_imports_b": 18.0, "curated_gdp_b": 1400.0,
    },
    {
        "country": "Poland", "code": "PL", "flag_label": "\U0001F1F5\U0001F1F1",
        "fred_10y": "IRLTLT01PLM156N", "fred_res": "TRESEGPLM052N",
        "curated_spread_bps": 120.0, "curated_ext_debt_pct": 50.0,
        "curated_reserves_b": 200.0, "curated_imports_b": 28.0, "curated_gdp_b": 810.0,
    },
    {
        "country": "Malaysia", "code": "MY", "flag_label": "\U0001F1F2\U0001F1FE",
        "fred_10y": "IRLTLT01MYM156N", "fred_res": "TRESEGMYM052N",
        "curated_spread_bps": 100.0, "curated_ext_debt_pct": 65.0,
        "curated_reserves_b": 115.0, "curated_imports_b": 20.0, "curated_gdp_b": 430.0,
    },
    {
        "country": "Philippines", "code": "PH", "flag_label": "\U0001F1F5\U0001F1ED",
        "fred_10y": "IRLTLT01PHM156N", "fred_res": "TRESEGPHM052N",
        "curated_spread_bps": 130.0, "curated_ext_debt_pct": 28.0,
        "curated_reserves_b": 105.0, "curated_imports_b": 11.0, "curated_gdp_b": 470.0,
    },
    {
        "country": "India", "code": "IN", "flag_label": "\U0001F1EE\U0001F1F3",
        "fred_10y": "IRLTLT01INM156N", "fred_res": "TRESEGINM052N",
        "curated_spread_bps": 110.0, "curated_ext_debt_pct": 19.0,
        "curated_reserves_b": 645.0, "curated_imports_b": 55.0, "curated_gdp_b": 3900.0,
    },
]

# Composite-score weights (sum to 1.0). Spread is the market's credit verdict so it
# carries the most weight; the stock/flow buffers split the rest.
W_SPREAD = 0.35
W_DEBT = 0.25
W_COVER = 0.20
W_RESERVES = 0.20


# ---------------------------------------------------------------------------
# Scoring helpers (deterministic, monotonic in each pillar)
# ---------------------------------------------------------------------------

def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _scale(value: float, at_zero: float, at_hundred: float) -> float:
    """Linearly map `value` to 0..100 where value==at_zero -> 0 and
    value==at_hundred -> 100. Handles either direction; clamps to [0, 100]."""
    if at_hundred == at_zero:
        return 0.0
    return _clamp((value - at_zero) / (at_hundred - at_zero) * 100.0)


def _spread_score(spread_bps: float) -> float:
    # 80 bps -> 0 (clean IG-ish), 650 bps -> 100 (distress).
    return _scale(spread_bps, 80.0, 650.0)


def _debt_score(ext_debt_pct: float) -> float:
    # 15% -> 0, 80% -> 100. Higher external debt = more risk.
    return _scale(ext_debt_pct, 15.0, 80.0)


def _cover_score(import_cover_months: float) -> float:
    # 12 months -> 0 (ample), 2 months -> 100 (thin). Lower cover = more risk.
    return _scale(import_cover_months, 12.0, 2.0)


def _reserves_score(reserves_to_debt: float) -> float:
    # 0.90 -> 0 (well covered), 0.10 -> 100 (uncovered). Lower coverage = more risk.
    return _scale(reserves_to_debt, 0.90, 0.10)


def _risk_band(score: float) -> str:
    if score >= 60.0:
        return "Critical"
    if score >= 48.0:
        return "High"
    if score >= 36.0:
        return "Elevated"
    if score >= 24.0:
        return "Moderate"
    return "Low"


def _cds_proxy_bps(spread_bps: float) -> float:
    """5y sovereign CDS proxy from the hard-currency spread.

    A bond spread `s` implies an annual default intensity ~ s/(1-R); the par CDS
    premium reprices that risk back to ~ s, so to first order CDS ~ spread. We
    apply a small EM basis (CDS tends to trade just inside the cash spread) to
    avoid implying a 1:1 identity. Labelled a proxy - this is NOT a live CDS quote.
    """
    return round(spread_bps * CDS_BASIS, 0)


# ---------------------------------------------------------------------------
# Live FRED pull (best-effort, bounded)
# ---------------------------------------------------------------------------

def _last_value(series: list[dict]) -> float | None:
    for p in reversed(series or []):
        if p.get("value") is not None:
            return float(p["value"])
    return None


def _live_payload() -> dict | None:
    """Bounded, fast live FRED scan. Pulls live FX reserves (IMF/IFS, USD) per
    country; the hard-currency EMBI-style spread stays curated because free FRED
    carries no EM USD credit spread, and the only EM long-term rate FRED does carry
    (OECD IRLTLT01, local-currency) measures inflation/FX premium - not hard-currency
    default risk - so deriving the spread from it would mislabel the column and wildly
    overstate high-inflation EMs. The spread column therefore holds ONE consistent
    hard-currency definition across every row. Returns None when too few countries
    resolve live reserves so the caller can fall back to sample. Never raises (caller
    guards)."""
    try:
        from . import macro_data
    except Exception as e:
        log.warning("em_sovereign: macro_data import failed: %s", e)
        return None

    started = time.monotonic()

    rows: list[dict] = []
    resolved = 0
    for spec in COUNTRIES:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break

        # Hard-currency spread is a USD credit-risk measure FRED does not carry for
        # EM sovereigns, so it stays curated - never derived from a local-currency
        # yield gap. Same definition in live and sample modes.
        spread_bps = spec["curated_spread_bps"]

        # FX reserves (USD) where FRED carries the IMF/IFS series; else curated. The
        # live signal for this board is the reserves leg.
        reserves_usd = spec["curated_reserves_b"] * 1e9
        if spec.get("fred_res"):
            try:
                res = _last_value(macro_data.fetch_series(spec["fred_res"], days=420) or [])
                if res is not None and res > 0:
                    reserves_usd = float(res)  # series already in USD
                    resolved += 1
            except Exception:
                pass

        rows.append(_build_row(
            spec,
            spread_bps=spread_bps,
            ext_debt_pct=spec["curated_ext_debt_pct"],
            reserves_usd=reserves_usd,
            monthly_imports_usd=spec["curated_imports_b"] * 1e9,
            gdp_usd=spec["curated_gdp_b"] * 1e9,
        ))

    if resolved < LIVE_MIN_COUNTRIES:
        return None

    return _assemble(rows, data_mode="live",
                     source="FRED IMF/IFS total reserves (USD); "
                            "spreads/imports/GDP/external-debt curated")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic EM grid)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    rows: list[dict] = []
    for spec in COUNTRIES:
        rows.append(_build_row(
            spec,
            spread_bps=spec["curated_spread_bps"],
            ext_debt_pct=spec["curated_ext_debt_pct"],
            reserves_usd=spec["curated_reserves_b"] * 1e9,
            monthly_imports_usd=spec["curated_imports_b"] * 1e9,
            gdp_usd=spec["curated_gdp_b"] * 1e9,
        ))
    return _assemble(rows, data_mode="sample",
                     source="curated mid-2026 EM external-balance levels")


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_row(spec: dict, *, spread_bps: float, ext_debt_pct: float,
               reserves_usd: float, monthly_imports_usd: float,
               gdp_usd: float) -> dict:
    # Import cover: how many months of imports the reserves buy. Floor the divisor.
    monthly_imports_usd = max(monthly_imports_usd, 1e6)
    import_cover_months = round(reserves_usd / monthly_imports_usd, 1)

    # External debt stock and reserves coverage of it.
    external_debt_usd = ext_debt_pct / 100.0 * gdp_usd
    reserves_to_debt = round(reserves_usd / external_debt_usd, 2) if external_debt_usd > 0 else 0.0

    # Pillar sub-scores (each 0-100, monotonic in the stated direction).
    s_spread = _spread_score(spread_bps)
    s_debt = _debt_score(ext_debt_pct)
    s_cover = _cover_score(min(import_cover_months, COVER_CAP_MONTHS))
    s_reserves = _reserves_score(reserves_to_debt)

    risk_score = round(
        W_SPREAD * s_spread
        + W_DEBT * s_debt
        + W_COVER * s_cover
        + W_RESERVES * s_reserves,
        1,
    )

    return {
        "country": spec["country"],
        "code": spec["code"],
        "flag_label": spec["flag_label"],
        "fx_reserves_usd": round(reserves_usd, 0),
        "import_cover_months": import_cover_months,
        "embi_spread_bps": round(spread_bps, 0),
        "cds_5y_proxy_bps": _cds_proxy_bps(spread_bps),
        "external_debt_pct_gdp": round(float(ext_debt_pct), 1),
        "reserves_to_debt": reserves_to_debt,
        "risk_score": risk_score,
        "risk_band": _risk_band(risk_score),
    }


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    # Riskiest first. Tie-break on spread so the order is fully deterministic and
    # the ranking is always consistent with the score (invariant).
    rows = sorted(rows, key=lambda r: (r["risk_score"], r["embi_spread_bps"]), reverse=True)

    most_vulnerable = rows[0] if rows else None
    safest = rows[-1] if rows else None
    avg_spread = round(sum(r["embi_spread_bps"] for r in rows) / len(rows), 0) if rows else 0.0

    def _ref(r: dict | None) -> dict | None:
        if not r:
            return None
        return {
            "country": r["country"],
            "code": r["code"],
            "flag_label": r["flag_label"],
            "risk_score": r["risk_score"],
            "risk_band": r["risk_band"],
            "embi_spread_bps": r["embi_spread_bps"],
        }

    return {
        "countries": rows,
        "summary": {
            "most_vulnerable": _ref(most_vulnerable),
            "safest": _ref(safest),
            "avg_spread": avg_spread,
            "count": len(rows),
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def em_sovereign() -> dict:
    """Per-country EM crisis-vulnerability board: FX reserves + import cover, an
    EMBI-style hard-currency spread, a 5y CDS proxy, external-debt ratios, and a
    composite risk score ranking the riskiest sovereigns first. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("countries"):
            return live
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("em_sovereign live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("em_sovereign sample path failed hard: %s", e)
        return {
            "countries": [],
            "summary": {
                "most_vulnerable": None,
                "safest": None,
                "avg_spread": 0.0,
                "count": 0,
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "curated mid-2026 EM external-balance levels",
        }
