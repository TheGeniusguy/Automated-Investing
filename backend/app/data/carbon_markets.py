"""Carbon & emissions allowance markets board (energy/macro desk).

Tracks the major compliance-carbon markets a macro desk watches alongside
energy: the EU Emissions Trading System (EUA), the California / WCI Carbon
Allowance (CCA), and the Regional Greenhouse Gas Initiative (RGGI), plus the
two broad listed carbon vehicles, KraneShares' KRBN (global carbon basket)
and the iPath GRN carbon ETN. For each instrument it derives the latest
price, the daily change %, a short trend read, a YTD % move, and a downsampled
sparkline history, then prints a one-line plain-English read on whether the
carbon-price regime is tightening or loosening the cost of compliance.

HONESTY MODEL. There is no free, real-time auction-settlement feed for EUA /
CCA / RGGI allowances. So:

  * KRBN and GRN are listed ETFs/ETNs - their printed price IS the live ETF
    close (exact), fetched via app.data.macro_data.fetch_arbitrary_ticker.
  * EUA and CCA are *derived* from their dedicated KraneShares carbon ETFs
    (KEUA / KCCA). The daily/YTD move and the sparkline SHAPE come from the
    live ETF series; the printed allowance LEVEL is anchored to a plausible
    mid-2026 reference (~EUR70s/t, ~USD30s/t) and the `method` field says so
    out loud. We never claim an exact auction settlement.
  * RGGI has no liquid listed proxy, so it is always an honest deterministic
    SAMPLE series around a plausible ~USD20s/t level, labelled as such.

Each leg degrades independently: a missing/empty fetch falls back to a rich
md5-seeded SAMPLE series (stable across runs for clean screenshots). The
payload carries an internal data_mode ("live" | "mixed" | "sample"), as_of,
and source for under-the-hood honesty - there is no on-screen badge. This
module never raises; it always returns a fully-populated board.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import cache
from .macro_data import fetch_arbitrary_ticker

log = logging.getLogger(__name__)

CARBON_TTL = 60 * 30   # 30 minutes - allowance markets move slowly
HISTORY_DAYS = 300     # ~1y+ of weekday closes requested per proxy (covers YTD)
MIN_POINTS = 30        # need at least this many points to trust a live proxy
MAX_HISTORY_OUT = 90   # downsample sparkline to keep payloads lean


# ---------------------------------------------------------------------------
# Instrument definitions.
#
# kind: "etf"       -> printed price is the live ETF/ETN close itself (exact).
#       "allowance" -> printed price is anchored; move/shape derived from the
#                      proxy ETF (or sampled when the proxy is unavailable).
# proxy: yfinance symbol used as the live source (None => always sample).
# anchor / unit: plausible mid-2026 level + display unit for the allowance,
#                or the plausible ETF price for the listed vehicles.
# ---------------------------------------------------------------------------

CARBON_SPECS: list[dict] = [
    {
        "key": "eua",
        "name": "EU ETS (EUA)",
        "region": "Europe",
        "kind": "allowance",
        "proxy": "KEUA",
        "unit": "EUR/t",
        "anchor": 72.0,
        "precision": 2,
        "sample_sigma": 0.9,
        "sample_trend": 0.020,
        "method_live": "derived from KEUA ETF (live); level anchored to ~EUR72/t, not an auction settlement",
        "method_sample": "sample EUA series anchored to ~EUR72/t (KEUA proxy unavailable)",
        "blurb": "The EU Emissions Trading System price - the deepest, most liquid carbon market. The benchmark cost of a tonne of CO2 for European industry and power.",
    },
    {
        "key": "cca",
        "name": "California CCA",
        "region": "WCI (US/CA)",
        "kind": "allowance",
        "proxy": "KCCA",
        "unit": "USD/t",
        "anchor": 34.0,
        "precision": 2,
        "sample_sigma": 0.45,
        "sample_trend": 0.012,
        "method_live": "derived from KCCA ETF (live); level anchored to ~$34/t, not an auction settlement",
        "method_sample": "sample CCA series anchored to ~$34/t (KCCA proxy unavailable)",
        "blurb": "The California / Western Climate Initiative allowance - North America's largest cap-and-trade market, with a quarterly auction floor.",
    },
    {
        "key": "rggi",
        "name": "RGGI",
        "region": "US Northeast",
        "kind": "allowance",
        "proxy": None,  # no liquid listed proxy - always honest sample
        "unit": "USD/t",
        "anchor": 21.0,
        "precision": 2,
        "sample_sigma": 0.30,
        "sample_trend": 0.006,
        "method_live": "",
        "method_sample": "sample RGGI series anchored to ~$21/t (no free real-time auction feed)",
        "blurb": "The Regional Greenhouse Gas Initiative - the power-sector cap-and-trade program across the US Northeast, cleared via quarterly auctions.",
    },
    {
        "key": "krbn",
        "name": "KRBN (Global Carbon)",
        "region": "Global ETF",
        "kind": "etf",
        "proxy": "KRBN",
        "unit": "USD",
        "anchor": 56.0,
        "precision": 2,
        "sample_sigma": 0.55,
        "sample_trend": 0.015,
        "method_live": "live ETF close (KraneShares Global Carbon Strategy ETF)",
        "method_sample": "sample KRBN price ~ $56 (live ETF feed unavailable)",
        "blurb": "KraneShares Global Carbon ETF - a single tradable basket of EUA, CCA and RGGI futures. The cleanest broad read on world carbon pricing.",
    },
    {
        "key": "grn",
        "name": "GRN (iPath Carbon)",
        "region": "Global ETN",
        "kind": "etf",
        "proxy": "GRN",
        "unit": "USD",
        "anchor": 32.0,
        "precision": 2,
        "sample_sigma": 0.40,
        "sample_trend": 0.011,
        "method_live": "live ETN close (iPath Series B Carbon ETN)",
        "method_sample": "sample GRN price ~ $32 (live ETN feed unavailable)",
        "blurb": "The iPath Series B Carbon ETN - a long-running listed proxy for the global carbon complex, useful as a cross-check on KRBN.",
    },
]


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(f"carbon:{key}".encode()).hexdigest()[:8], 16)


def _trading_dates(days: int) -> list[str]:
    """`days` weekday date strings ending today (most recent last)."""
    out: list[str] = []
    d = date.today()
    while len(out) < days:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _sample_series(spec: dict, dates: list[str]) -> np.ndarray:
    """Mean-reverting series around a gently drifting center, anchored so the
    LAST point sits at `anchor`. Deterministic per key (screenshot-stable)."""
    n = len(dates)
    rng = np.random.default_rng(_seed(spec["key"]))
    anchor = float(spec["anchor"])
    sigma = float(spec["sample_sigma"])
    trend = float(spec["sample_trend"])
    kappa = 0.05
    x = np.empty(n, dtype=float)
    # start below anchor by the cumulative drift so the series ends near anchor
    x[0] = anchor - trend * (n - 1)
    for i in range(1, n):
        center = (anchor - trend * (n - 1)) + trend * i
        shock = rng.normal(0.0, sigma)
        x[i] = x[i - 1] + kappa * (center - x[i - 1]) + shock
    # renormalize so the final printed level lands exactly on the anchor
    x = x * (anchor / x[-1]) if x[-1] != 0 else x
    return x


def _downsample(dates: list[str], values: list[float], n: int) -> list[dict]:
    """Evenly sample down to ~n points, always keeping the last point."""
    m = len(values)
    if m <= n:
        idx = list(range(m))
    else:
        step = (m - 1) / (n - 1)
        idx = sorted({int(round(k * step)) for k in range(n)} | {m - 1})
    return [{"date": dates[i], "value": round(float(values[i]), 4)} for i in idx]


def _ytd_ref_index(dates: list[str]) -> int:
    """Index of the first point in the current calendar year (YTD anchor).
    Falls back to the first point if the window is entirely intra-year."""
    yr = date.today().year
    for i, d in enumerate(dates):
        if d[:4] == str(yr):
            return i
    return 0


def _trend_word(values: np.ndarray) -> str:
    """Short trend read over the trailing window (last ~20 points)."""
    if values.size < 3:
        return "flat"
    tail = values[-20:] if values.size >= 20 else values
    first = float(tail[0])
    last = float(tail[-1])
    if first == 0:
        return "flat"
    move = (last - first) / abs(first) * 100.0
    if move > 1.5:
        return "rising"
    if move < -1.5:
        return "falling"
    return "flat"


# ---------------------------------------------------------------------------
# Live price helper
# ---------------------------------------------------------------------------

def _fetch_series(ticker: str) -> tuple[list[str], list[float]]:
    """(dates, closes) for a ticker via the universal entrypoint. Never raises."""
    try:
        pts = fetch_arbitrary_ticker(ticker, days=HISTORY_DAYS) or []
    except Exception as e:  # belt-and-suspenders; fetch already guards
        log.warning("carbon_markets fetch %s failed: %s", ticker, e)
        return [], []
    dates: list[str] = []
    vals: list[float] = []
    for p in pts:
        v = p.get("value")
        if v is None:
            continue
        dates.append(p["date"])
        vals.append(float(v))
    return dates, vals


# ---------------------------------------------------------------------------
# Per-instrument assembly
# ---------------------------------------------------------------------------

def _stats(
    spec: dict,
    dates: list[str],
    display: np.ndarray,
    *,
    data_mode: str,
    method: str,
) -> dict:
    prec = int(spec["precision"])
    cur = float(display[-1])
    prev = float(display[-2]) if display.size >= 2 else cur
    change = cur - prev
    change_pct = (change / prev * 100.0) if prev else 0.0

    ytd_i = _ytd_ref_index(dates)
    ytd_ref = float(display[ytd_i]) if display.size else cur
    ytd_pct = ((cur - ytd_ref) / ytd_ref * 100.0) if ytd_ref else 0.0

    hi = float(np.max(display))
    lo = float(np.min(display))

    return {
        "key": spec["key"],
        "name": spec["name"],
        "region": spec["region"],
        "kind": spec["kind"],
        "unit": spec["unit"],
        "price": round(cur, prec),
        "change": round(change, prec + 1),
        "change_pct": round(change_pct, 2),
        "ytd_pct": round(ytd_pct, 1),
        "trend": _trend_word(display),
        "hi": round(hi, prec),
        "lo": round(lo, prec),
        "n_obs": int(display.size),
        "blurb": spec["blurb"],
        "method": method,
        "data_mode": data_mode,
        "history": _downsample(dates, list(display), MAX_HISTORY_OUT),
    }


def _live_instrument(spec: dict) -> dict | None:
    """Attempt a live-derived instrument. None when the proxy is too thin."""
    proxy = spec.get("proxy")
    if not proxy:
        return None
    dates, closes = _fetch_series(proxy)
    if len(closes) < MIN_POINTS:
        return None
    etf = np.asarray(closes, dtype=float)

    if spec["kind"] == "etf":
        # Printed price IS the live ETF/ETN close - exact.
        display = etf
    else:
        # Allowance: real move + real shape from the ETF, but the printed LEVEL
        # is anchored. Scale the series so the last point lands on the anchor.
        last = float(etf[-1])
        if last == 0:
            return None
        display = etf * (float(spec["anchor"]) / last)

    return _stats(spec, dates, display, data_mode="live", method=spec["method_live"])


def _sample_instrument(spec: dict) -> dict:
    dates = _trading_dates(HISTORY_DAYS)
    display = _sample_series(spec, dates)
    return _stats(spec, dates, display, data_mode="sample", method=spec["method_sample"])


# ---------------------------------------------------------------------------
# Regime read
# ---------------------------------------------------------------------------

def _regime_read(markets: list[dict]) -> str:
    """One-line plain-English read on the carbon-price regime, keyed off the
    broad listed vehicles (KRBN/GRN) with the compliance markets as confirms."""
    by_key = {m["key"]: m for m in markets}
    broad = [by_key[k] for k in ("krbn", "grn") if k in by_key]
    ref = broad if broad else markets
    avg_ytd = float(np.mean([m["ytd_pct"] for m in ref])) if ref else 0.0
    eua = by_key.get("eua")
    eua_bit = ""
    if eua:
        eua_bit = f" EU ETS sits near {eua['price']:.0f} {eua['unit']} ({eua['ytd_pct']:+.1f}% YTD)."

    if avg_ytd > 4:
        return (
            "Carbon prices are climbing - the cost of emitting is rising and compliance "
            f"is tightening across the major schemes (broad carbon {avg_ytd:+.1f}% YTD)." + eua_bit
        )
    if avg_ytd < -4:
        return (
            "Carbon prices are easing - the cost of compliance is loosening as allowance "
            f"prices soften (broad carbon {avg_ytd:+.1f}% YTD)." + eua_bit
        )
    return (
        "Carbon prices are broadly range-bound - the cost of compliance is steady, with "
        f"no decisive tightening or loosening (broad carbon {avg_ytd:+.1f}% YTD)." + eua_bit
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def carbon_markets() -> dict:
    """Carbon & emissions allowance markets board. Never raises - always
    returns a fully-populated payload tagged with data_mode / as_of / source."""
    try:
        return _carbon_markets()
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("carbon_markets failed hard, returning sample: %s", e)
        markets = [_sample_instrument(spec) for spec in CARBON_SPECS]
        return _assemble(markets, data_mode="sample", source="sample", live_count=0)


def _carbon_markets() -> dict:
    cached = cache.get("carbon_markets:v1")
    if cached is not None:
        return cached

    markets: list[dict] = []
    live_count = 0
    for spec in CARBON_SPECS:
        live = None
        try:
            live = _live_instrument(spec)
        except Exception as e:
            log.warning("carbon_markets live %s failed: %s", spec["key"], e)
            live = None
        if live is not None:
            live_count += 1
            markets.append(live)
        else:
            markets.append(_sample_instrument(spec))

    # Honesty tag. RGGI has no proxy and is always sample, so a fully "live"
    # board is impossible - the best honest state is "mixed".
    if live_count == 0:
        data_mode, source = "sample", "sample"
    elif live_count < len(CARBON_SPECS):
        data_mode, source = "mixed", "yfinance ETF proxies + sample"
    else:
        data_mode, source = "live", "yfinance ETF proxies"

    payload = _assemble(markets, data_mode=data_mode, source=source, live_count=live_count)
    cache.set("carbon_markets:v1", payload, CARBON_TTL)
    return payload


def _assemble(markets: list[dict], *, data_mode: str, source: str, live_count: int) -> dict:
    return {
        "markets": markets,
        "count": len(markets),
        "live_count": live_count,
        "regime_read": _regime_read(markets),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }
