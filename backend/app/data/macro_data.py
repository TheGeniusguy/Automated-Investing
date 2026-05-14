"""Macro data fetchers for the 5 v1 series.

FRED series (require API key):
- DGS2:           2-Year Treasury yield
- DGS10:          10-Year Treasury yield
- BAMLH0A0HYM2:   ICE BofA US High Yield Index Option-Adjusted Spread

yfinance tickers (no key needed):
- ^VIX:           CBOE Volatility Index
- DX-Y.NYB:       US Dollar Index (DXY)

All series return a list of {date, value} dicts, sorted ascending by date,
last 90 days unless overridden.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Iterable, Literal

import httpx

from ..config import settings
from . import cache

log = logging.getLogger(__name__)

FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"

FRED_TTL = 60 * 60 * 24  # 24h — FRED data updates daily at best
YF_TTL = 60 * 60         # 1h — protects against IP blocking on yfinance

FredSeries = Literal["DGS2", "DGS10", "BAMLH0A0HYM2"]
YfSeries = Literal["^VIX", "DX-Y.NYB"]

SeriesPoint = dict  # {"date": "YYYY-MM-DD", "value": float | None}


def _date_range(days: int) -> tuple[str, str]:
    end = datetime.utcnow().date()
    start = end - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def _fred_fetch(series_id: str, days: int = 90) -> list[SeriesPoint]:
    """Fetch a FRED series. Raises on missing key or HTTP error."""
    if not settings.has_fred:
        raise RuntimeError("FRED_API_KEY not configured")

    start, end = _date_range(days)
    params = {
        "series_id": series_id,
        "api_key": settings.fred_api_key,
        "file_type": "json",
        "observation_start": start,
        "observation_end": end,
    }
    with httpx.Client(timeout=10.0) as client:
        r = client.get(FRED_BASE, params=params)
        r.raise_for_status()
        data = r.json()

    points: list[SeriesPoint] = []
    for obs in data.get("observations", []):
        v = obs.get("value")
        # FRED uses "." for missing values
        try:
            value = float(v) if v not in (".", "", None) else None
        except (TypeError, ValueError):
            value = None
        points.append({"date": obs["date"], "value": value})
    return points


def _yf_fetch(ticker: str, days: int = 90) -> list[SeriesPoint]:
    """Fetch a yfinance ticker close-price series.

    For long windows (>2y) we use start/end dates because yfinance's `period`
    parameter behaves inconsistently above ~5y across Yahoo endpoints.
    """
    # Import locally — yfinance is slow to import, defer until needed
    import yfinance as yf

    if days <= 365 * 2:
        period_days = max(days + 7, 100)
        df = yf.Ticker(ticker).history(period=f"{period_days}d", auto_adjust=False)
    else:
        start_date = (datetime.utcnow().date() - timedelta(days=days + 14)).isoformat()
        df = yf.Ticker(ticker).history(start=start_date, auto_adjust=False)

    if df.empty:
        return []
    df = df.tail(days)
    return [
        {"date": idx.strftime("%Y-%m-%d"), "value": float(row["Close"])}
        for idx, row in df.iterrows()
        if row["Close"] == row["Close"]  # filter NaN
    ]


def fetch_arbitrary_ticker(ticker: str, days: int) -> list[SeriesPoint]:
    """Fetch any yfinance ticker (used by portfolio stress-test).

    Bypasses SERIES_META — supports arbitrary tickers a user types in.
    Uses cache, with 1h TTL like the standard yfinance path.
    """
    cache_key = f"yf:{ticker}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        data = _yf_fetch(ticker, days=days)
        cache.set(cache_key, data, YF_TTL)
        return data
    except Exception as e:
        log.warning("fetch_arbitrary_ticker(%s) failed: %s", ticker, e)
        stale = cache.get_stale(cache_key)
        return stale if stale is not None else []


def fetch_explicit(series_id: str, *, source: str, days: int) -> list[SeriesPoint]:
    """Source-typed fetch used by the catalog/energy/shipping modules.

    `source` is one of 'fred' | 'yfinance'. We bypass the heuristic in
    `fetch_series` because plain ETF tickers (XLE, USO) can't be cleanly
    distinguished from short FRED IDs by shape alone.
    """
    cache_key = f"explicit:{source}:{series_id}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    if source == "fred":
        if not settings.has_fred:
            return []
        try:
            data = _fred_fetch(series_id, days=days)
            cache.set(cache_key, data, FRED_TTL)
            _persist_macro_series(series_id, data, source="fred")
            return data
        except Exception as e:
            log.warning("fetch_explicit FRED %s failed: %s", series_id, e)
            stale = cache.get_stale(cache_key)
            return stale if stale is not None else []
    if source == "yfinance":
        try:
            data = _yf_fetch(series_id, days=days)
            cache.set(cache_key, data, YF_TTL)
            _persist_macro_series(series_id, data, source="yfinance")
            return data
        except Exception as e:
            log.warning("fetch_explicit yfinance %s failed: %s", series_id, e)
            stale = cache.get_stale(cache_key)
            return stale if stale is not None else []
    raise ValueError(f"unknown source: {source}")


def fetch_series(series: str, days: int = 90) -> list[SeriesPoint]:
    """Cached fetch with graceful degradation: serve stale on failure."""
    cache_key = f"series:{series}:{days}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    fred_series = {"DGS2", "DGS10", "BAMLH0A0HYM2"}
    yf_tickers = {"^VIX", "DX-Y.NYB", "^GSPC"}

    # Missing FRED key is a config issue, not a runtime error — surface as
    # empty data so the UI can render a "configure key" state.
    is_fred = series in fred_series or _looks_like_fred(series)
    is_yf   = series in yf_tickers or _looks_like_yf(series)

    if is_fred and not settings.has_fred:
        return []

    try:
        if is_fred:
            data = _fred_fetch(series, days=days)
            cache.set(cache_key, data, FRED_TTL)
            _persist_macro_series(series, data, source="fred")
            return data
        if is_yf:
            data = _yf_fetch(series, days=days)
            cache.set(cache_key, data, YF_TTL)
            _persist_macro_series(series, data, source="yfinance")
            return data
        raise ValueError(f"Unknown series: {series}")
    except Exception as e:
        log.warning("fetch_series(%s) failed: %s — falling back to stale", series, e)
        stale = cache.get_stale(cache_key)
        if stale is not None:
            return stale
        # Last resort: empty list so callers can render a degraded state.
        return []


def _looks_like_fred(series_id: str) -> bool:
    """FRED IDs are uppercase alphanumerics, no special chars except digits."""
    if not series_id:
        return False
    if series_id.startswith("^") or "-USD" in series_id or "=F" in series_id or "." in series_id:
        return False
    return series_id.replace("_", "").isalnum()


def _looks_like_yf(series_id: str) -> bool:
    return (
        series_id.startswith("^")
        or series_id.endswith("-USD")
        or series_id.endswith("=F")
        or "." in series_id
    )


def _persist_macro_series(series_id: str, points: list[SeriesPoint], source: str) -> None:
    """Upsert into macro_series_history. Best-effort — failures are logged
    but don't block the caller."""
    if not points:
        return
    try:
        from ..db import engine
        with engine.conn() as c:
            for p in points:
                if p["value"] is None:
                    continue
                try:
                    c.execute(
                        """
                        INSERT INTO macro_series_history (series_id, date, value, source, ingested_at)
                        VALUES (?, ?, ?, ?, now())
                        ON CONFLICT (series_id, date) DO UPDATE SET
                            value       = EXCLUDED.value,
                            source      = EXCLUDED.source,
                            ingested_at = now()
                        """,
                        [series_id, p["date"], p["value"], source],
                    )
                except Exception as e:
                    log.debug("macro persist row failed (%s %s): %s", series_id, p["date"], e)
    except Exception as e:
        log.debug("macro persist outer failure for %s: %s", series_id, e)


SERIES_META = {
    "DGS2":         {"label": "2Y Treasury Yield",    "unit": "%",   "source": "FRED"},
    "DGS10":        {"label": "10Y Treasury Yield",   "unit": "%",   "source": "FRED"},
    "BAMLH0A0HYM2": {"label": "HY Spread (OAS)",      "unit": "%",   "source": "FRED"},
    "^VIX":         {"label": "VIX",                  "unit": "idx", "source": "yfinance"},
    "DX-Y.NYB":     {"label": "Dollar Index (DXY)",   "unit": "idx", "source": "yfinance"},
    "^GSPC":        {"label": "S&P 500",              "unit": "idx", "source": "yfinance"},
}

# Panel 1 (Macro Regime Tracker) uses the first 5; SPX is added for Panel 2.
ALL_SERIES: list[str] = list(SERIES_META.keys())
PANEL1_SERIES: list[str] = [s for s in ALL_SERIES if s != "^GSPC"]


def fetch_all(days: int = 90, series: list[str] | None = None) -> dict[str, list[SeriesPoint]]:
    """Fetch all (or a subset of) v1 series. Individual failures are logged,
    not fatal — callers can decide whether to proceed with partial data.
    """
    out: dict[str, list[SeriesPoint]] = {}
    for s in (series or ALL_SERIES):
        try:
            out[s] = fetch_series(s, days=days)
        except Exception as e:
            log.error("fetch_all: %s failed: %s", s, e)
            out[s] = []
    return out


def latest_value(points: Iterable[SeriesPoint]) -> float | None:
    """Most recent non-null value from a series."""
    for p in reversed(list(points)):
        if p["value"] is not None:
            return p["value"]
    return None
