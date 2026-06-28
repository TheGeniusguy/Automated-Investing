"""COT (Commitments of Traders) positioning engine (Bloomberg Wave C, Feature 5).

Mirrors the CFTC Commitments-of-Traders surface (Bloomberg COT). For each futures
market we expose a weekly history of trader positioning - commercial (hedger /
"smart money") and noncommercial (large-spec) long/short open interest - plus the
derived signals desks actually watch: net positioning, the 3-year COT index
(0..100), a positioning z-score, and "crowded long / crowded short" extreme flags.

SAMPLE feature by design. The CFTC publishes free weekly history, but here we
synthesize a deterministic, realistic mean-reverting weekly series seeded off the
market name (mirroring app.data.etf_tracking) so screenshots are stable and every
panel is fully populated on first load. Tagged data_mode="sample",
source="cot-sample".

FUTURE LIVE HOOK (CFTC CSV ingest):
    The CFTC Disaggregated / Legacy COT reports are downloadable as annual CSV /
    XLS bundles (e.g. https://www.cftc.gov/files/dea/history/fut_disagg_txt_2025.zip).
    To go live: add a `_fetch_cftc_history(cftc_code, weeks)` that reads the
    "Open Interest", "Noncommercial Positions-Long/Short (All)" and
    "Commercial Positions-Long/Short (All)" columns for the market's CFTC contract
    code (see MARKET_PROFILES[*]["cftc_code"]), build the same weekly record shape
    `{date, commercial_long, commercial_short, noncommercial_long,
    noncommercial_short, open_interest}`, then set data_mode="live",
    source="cftc". The derived-metric + dashboard layers below are source-agnostic
    and would not change. Until that exists, everything degrades to the sample
    generator. This module never raises.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache

log = logging.getLogger(__name__)

COT_TTL = 60 * 60 * 6  # 6 hours - COT data updates weekly (Friday release)

# Weekly history depth. We synthesize a buffer beyond the trailing 3-year window
# so the rolling COT index / z-score have a full lookback at the earliest plotted
# point. TOTAL_WEEKS history is generated; SERIES_WEEKS most-recent points are
# returned (each carrying derived metrics computed over LOOKBACK_WEEKS trailing).
LOOKBACK_WEEKS = 156   # trailing 3 years for the COT index + z-score window
SERIES_WEEKS = 157     # ~3 years of plottable weekly points returned
TOTAL_WEEKS = LOOKBACK_WEEKS + SERIES_WEEKS  # generated history depth
EXTREME_Z = 2.0        # |z| at/above this is an extreme
EXTREME_INDEX_HI = 90.0
EXTREME_INDEX_LO = 10.0


# ---------------------------------------------------------------------------
# Market profiles (clearly-namespaced SAMPLE config). cftc_code is the CFTC
# contract market code reserved for the future live CSV ingest (see hook above).
# oi_base       - typical total open interest (contracts)
# nc_oi_frac    - fraction of OI held by noncommercials (gross, both sides)
# comm_oi_frac  - fraction of OI held by commercials (gross, both sides)
# net_mean      - mean noncommercial NET as a fraction of OI (sign = structural bias)
# net_amp       - amplitude (std) of the net swing as a fraction of OI
# persistence   - AR(1) week-to-week persistence of the net position
# ---------------------------------------------------------------------------

MARKET_PROFILES: dict[str, dict] = {
    "es": {
        "name": "E-mini S&P 500", "group": "Equity Index", "cftc_code": "13874A",
        "oi_base": 2_350_000, "nc_oi_frac": 0.42, "comm_oi_frac": 0.46,
        "net_mean": -0.04, "net_amp": 0.085, "persistence": 0.90,
    },
    "nq": {
        "name": "E-mini Nasdaq 100", "group": "Equity Index", "cftc_code": "20974P",
        "oi_base": 255_000, "nc_oi_frac": 0.44, "comm_oi_frac": 0.44,
        "net_mean": 0.02, "net_amp": 0.095, "persistence": 0.89,
    },
    "gold": {
        "name": "Gold", "group": "Metals", "cftc_code": "088691",
        "oi_base": 480_000, "nc_oi_frac": 0.46, "comm_oi_frac": 0.48,
        "net_mean": 0.20, "net_amp": 0.11, "persistence": 0.91,
    },
    "silver": {
        "name": "Silver", "group": "Metals", "cftc_code": "084691",
        "oi_base": 150_000, "nc_oi_frac": 0.45, "comm_oi_frac": 0.49,
        "net_mean": 0.16, "net_amp": 0.13, "persistence": 0.90,
    },
    "copper": {
        "name": "Copper", "group": "Metals", "cftc_code": "085692",
        "oi_base": 210_000, "nc_oi_frac": 0.40, "comm_oi_frac": 0.50,
        "net_mean": 0.03, "net_amp": 0.12, "persistence": 0.88,
    },
    "crude": {
        "name": "Crude Oil WTI", "group": "Energy", "cftc_code": "067651",
        "oi_base": 1_750_000, "nc_oi_frac": 0.38, "comm_oi_frac": 0.52,
        "net_mean": 0.12, "net_amp": 0.09, "persistence": 0.91,
    },
    "natgas": {
        "name": "Natural Gas", "group": "Energy", "cftc_code": "023651",
        "oi_base": 1_180_000, "nc_oi_frac": 0.36, "comm_oi_frac": 0.54,
        "net_mean": -0.08, "net_amp": 0.10, "persistence": 0.89,
    },
    "ty": {
        "name": "10-Year T-Note", "group": "Rates", "cftc_code": "043602",
        "oi_base": 4_500_000, "nc_oi_frac": 0.40, "comm_oi_frac": 0.50,
        "net_mean": -0.06, "net_amp": 0.10, "persistence": 0.92,
    },
    "tu": {
        "name": "2-Year T-Note", "group": "Rates", "cftc_code": "042601",
        "oi_base": 4_100_000, "nc_oi_frac": 0.38, "comm_oi_frac": 0.52,
        "net_mean": -0.09, "net_amp": 0.11, "persistence": 0.92,
    },
    "eur": {
        "name": "Euro FX", "group": "Currency", "cftc_code": "099741",
        "oi_base": 720_000, "nc_oi_frac": 0.44, "comm_oi_frac": 0.50,
        "net_mean": 0.05, "net_amp": 0.10, "persistence": 0.90,
    },
    "dxy": {
        "name": "US Dollar Index", "group": "Currency", "cftc_code": "098662",
        "oi_base": 55_000, "nc_oi_frac": 0.48, "comm_oi_frac": 0.42,
        "net_mean": 0.10, "net_amp": 0.13, "persistence": 0.89,
    },
    "corn": {
        "name": "Corn", "group": "Agriculture", "cftc_code": "002602",
        "oi_base": 1_650_000, "nc_oi_frac": 0.34, "comm_oi_frac": 0.56,
        "net_mean": 0.02, "net_amp": 0.12, "persistence": 0.88,
    },
    "bitcoin": {
        "name": "Bitcoin", "group": "Crypto", "cftc_code": "133741",
        "oi_base": 32_000, "nc_oi_frac": 0.50, "comm_oi_frac": 0.38,
        "net_mean": 0.08, "net_amp": 0.16, "persistence": 0.87,
    },
}

# Dashboard ordering. Leads with the markets named in the spec, then the rest.
DASHBOARD_ORDER = [
    "es", "gold", "crude", "ty", "eur", "dxy",
    "nq", "silver", "copper", "natgas", "tu", "corn", "bitcoin",
]

# Alias map so callers can pass a display name, a ticker-ish string, or the slug.
_ALIASES: dict[str, str] = {}
for _slug, _prof in MARKET_PROFILES.items():
    _ALIASES[_slug] = _slug
    _ALIASES[_prof["name"].lower()] = _slug
_ALIASES.update({
    "sp500": "es", "spx": "es", "s&p": "es", "s&p 500": "es", "emini": "es", "es=f": "es",
    "nasdaq": "nq", "ndx": "nq", "nasdaq 100": "nq",
    "xau": "gold", "gc": "gold", "gold futures": "gold",
    "xag": "silver", "si": "silver",
    "hg": "copper",
    "wti": "crude", "oil": "crude", "cl": "crude", "crude oil": "crude",
    "ng": "natgas", "nat gas": "natgas", "natural gas": "natgas",
    "10y": "ty", "10-year": "ty", "tnote": "ty", "note": "ty", "ust10": "ty",
    "2y": "tu", "2-year": "tu", "ust2": "tu",
    "euro": "eur", "eurusd": "eur", "eur/usd": "eur",
    "dollar": "dxy", "usd": "dxy", "dollar index": "dxy",
    "btc": "bitcoin", "btc-usd": "bitcoin",
})


def _resolve_market(market: str | None) -> str:
    if not market:
        return "es"
    key = str(market).strip().lower()
    return _ALIASES.get(key, _ALIASES.get(key.replace("_", " "), "es"))


# ---------------------------------------------------------------------------
# Deterministic sample synthesis (seed off the market name, mirroring
# etf_tracking._seed). Mean-reverting AR(1) net positioning + slow OI drift.
# ---------------------------------------------------------------------------

def _seed(market_slug: str) -> int:
    return int(hashlib.md5(f"cot:{market_slug}".encode()).hexdigest()[:8], 16)


def _weekly_dates(n: int) -> list[str]:
    """`n` weekly report dates (Tuesdays, COT is as-of Tuesday) ending at the most
    recent Tuesday on or before today, oldest first."""
    today = date.today()
    # most recent Tuesday (weekday 1) on or before today
    anchor = today - timedelta(days=(today.weekday() - 1) % 7)
    out = [(anchor - timedelta(weeks=i)).isoformat() for i in range(n)]
    return list(reversed(out))


def _synth_positioning(slug: str, prof: dict, n: int) -> dict[str, np.ndarray]:
    """Build n weeks of {oi, nc_long, nc_short, comm_long, comm_short} arrays."""
    rng = np.random.default_rng(_seed(slug))

    oi_base = float(prof["oi_base"])
    phi = float(prof["persistence"])
    mean = float(prof["net_mean"])
    amp = float(prof["net_amp"])

    # Slowly drifting open interest: gentle multi-quarter cycle + small AR(1) noise.
    cycle = 0.12 * np.sin(np.linspace(0, rng.uniform(2.0, 4.0) * np.pi, n) + rng.uniform(0, 2 * np.pi))
    oi_noise = np.zeros(n)
    for t in range(1, n):
        oi_noise[t] = 0.85 * oi_noise[t - 1] + rng.normal(0.0, 0.012)
    oi = oi_base * (1.0 + cycle + oi_noise)
    oi = np.clip(oi, oi_base * 0.55, oi_base * 1.7)

    # Noncommercial NET as a fraction of OI: mean-reverting AR(1).
    eps_sd = amp * np.sqrt(max(1.0 - phi * phi, 1e-6))
    nc_net_frac = np.zeros(n)
    nc_net_frac[0] = mean + rng.normal(0.0, amp)
    for t in range(1, n):
        nc_net_frac[t] = mean + phi * (nc_net_frac[t - 1] - mean) + rng.normal(0.0, eps_sd)

    # Commercials hedge against specs (opposite side) but not perfectly; the
    # nonreportable/small-trader bucket absorbs the residual.
    comm_net_frac = -0.82 * nc_net_frac + rng.normal(0.0, amp * 0.18, n)

    nc_gross = prof["nc_oi_frac"] * oi
    comm_gross = prof["comm_oi_frac"] * oi
    nc_net = nc_net_frac * oi
    comm_net = comm_net_frac * oi

    nc_long = np.clip((nc_gross + nc_net) / 2.0, 1.0, None)
    nc_short = np.clip((nc_gross - nc_net) / 2.0, 1.0, None)
    comm_long = np.clip((comm_gross + comm_net) / 2.0, 1.0, None)
    comm_short = np.clip((comm_gross - comm_net) / 2.0, 1.0, None)

    return {
        "oi": np.round(oi).astype(float),
        "nc_long": np.round(nc_long).astype(float),
        "nc_short": np.round(nc_short).astype(float),
        "comm_long": np.round(comm_long).astype(float),
        "comm_short": np.round(comm_short).astype(float),
    }


# ---------------------------------------------------------------------------
# Derived-metric helpers (source-agnostic - work on live or sample records).
# ---------------------------------------------------------------------------

def _percentile_rank(window: np.ndarray, value: float) -> float:
    """COT index as a percentile rank (0..100): share of trailing values <= value."""
    if window.size == 0:
        return 50.0
    return round(float(np.mean(window <= value) * 100.0), 2)


def _zscore(window: np.ndarray, value: float) -> float:
    if window.size < 2:
        return 0.0
    sd = float(np.std(window, ddof=1))
    if sd <= 0:
        return 0.0
    return round((value - float(np.mean(window))) / sd, 3)


def _extreme_side(cot_index: float, z: float) -> str | None:
    if z >= EXTREME_Z or cot_index >= EXTREME_INDEX_HI:
        return "crowded_long"
    if z <= -EXTREME_Z or cot_index <= EXTREME_INDEX_LO:
        return "crowded_short"
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def cot_series(market: str) -> dict:
    """Full weekly COT series for one market plus derived positioning signals.

    Returns {market, name, group, series[], latest{}, data_mode, as_of, source}.
    Each series record:
        {date, commercial_long, commercial_short, noncommercial_long,
         noncommercial_short, open_interest, net_noncommercial, net_commercial,
         pct_long, cot_index, z_score, extreme, extreme_side, change_1w}
    Never raises - always returns a populated sample payload on any failure.
    """
    try:
        return _cot_series(market)
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("cot_series failed hard, returning default sample: %s", e)
        try:
            return _cot_series("es")
        except Exception:
            return {
                "market": "es", "name": "E-mini S&P 500", "group": "Equity Index",
                "series": [], "latest": {},
                "data_mode": "sample", "as_of": _now_iso(), "source": "cot-sample",
            }


def _cot_series(market: str) -> dict:
    slug = _resolve_market(market)
    prof = MARKET_PROFILES[slug]

    cache_key = f"cot_series:{slug}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # FUTURE LIVE HOOK: try _fetch_cftc_history(prof["cftc_code"], TOTAL_WEEKS) here
    # and only fall through to the sample synth when it is unavailable.
    pos = _synth_positioning(slug, prof, TOTAL_WEEKS)
    dates = _weekly_dates(TOTAL_WEEKS)

    nc_net = pos["nc_long"] - pos["nc_short"]
    comm_net = pos["comm_long"] - pos["comm_short"]

    series: list[dict] = []
    start = TOTAL_WEEKS - SERIES_WEEKS
    for i in range(start, TOTAL_WEEKS):
        window = nc_net[max(0, i - LOOKBACK_WEEKS):i + 1]
        cot_index = _percentile_rank(window, float(nc_net[i]))
        z = _zscore(window, float(nc_net[i]))
        side = _extreme_side(cot_index, z)
        nc_l, nc_s = float(pos["nc_long"][i]), float(pos["nc_short"][i])
        change_1w = float(nc_net[i] - nc_net[i - 1]) if i > 0 else 0.0
        series.append({
            "date": dates[i],
            "commercial_long": float(pos["comm_long"][i]),
            "commercial_short": float(pos["comm_short"][i]),
            "noncommercial_long": nc_l,
            "noncommercial_short": nc_s,
            "open_interest": float(pos["oi"][i]),
            "net_noncommercial": round(float(nc_net[i]), 1),
            "net_commercial": round(float(comm_net[i]), 1),
            "pct_long": round(nc_l / (nc_l + nc_s) * 100.0, 2) if (nc_l + nc_s) else None,
            "cot_index": cot_index,
            "z_score": z,
            "extreme": side is not None,
            "extreme_side": side,
            "change_1w": round(change_1w, 1),
        })

    latest = dict(series[-1]) if series else {}
    payload = {
        "market": slug,
        "name": prof["name"],
        "group": prof["group"],
        "series": series,
        "latest": latest,
        "data_mode": "sample",
        "as_of": _now_iso(),
        "source": "cot-sample",
    }
    cache.set(cache_key, payload, COT_TTL)
    return payload


def positioning_dashboard() -> dict:
    """Cross-market positioning summary table.

    Returns {markets:[{market, name, group, net_spec, net_commercial, cot_index,
    z_score, change_1w, pct_long, open_interest, extreme, extreme_side}],
    data_mode, as_of, source}. Never raises.
    """
    try:
        return _positioning_dashboard()
    except Exception as e:
        log.warning("positioning_dashboard failed hard: %s", e)
        return {"markets": [], "data_mode": "sample", "as_of": _now_iso(), "source": "cot-sample"}


def _positioning_dashboard() -> dict:
    cache_key = "cot_dashboard"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    rows: list[dict] = []
    for slug in DASHBOARD_ORDER:
        if slug not in MARKET_PROFILES:
            continue
        try:
            ser = _cot_series(slug)
            latest = ser.get("latest") or {}
            if not latest:
                continue
            rows.append({
                "market": slug,
                "name": ser["name"],
                "group": ser["group"],
                "net_spec": latest.get("net_noncommercial"),
                "net_commercial": latest.get("net_commercial"),
                "cot_index": latest.get("cot_index"),
                "z_score": latest.get("z_score"),
                "change_1w": latest.get("change_1w"),
                "pct_long": latest.get("pct_long"),
                "open_interest": latest.get("open_interest"),
                "extreme": latest.get("extreme", False),
                "extreme_side": latest.get("extreme_side"),
            })
        except Exception as e:
            log.warning("cot dashboard row failed for %s: %s", slug, e)
            continue

    payload = {
        "markets": rows,
        "data_mode": "sample",
        "as_of": _now_iso(),
        "source": "cot-sample",
    }
    cache.set(cache_key, payload, COT_TTL)
    return payload


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
