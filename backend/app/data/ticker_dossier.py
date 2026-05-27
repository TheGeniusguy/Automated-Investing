"""Single-ticker dossier — fuses every data stream for ONE symbol.

Today each data type lives in its own panel (price, fundamentals, news,
filings, options, technicals). This module COMPOSES the existing modules
into a single payload keyed by one symbol so the frontend can render a
unified "everything about AAPL" view.

Each sub-section is wrapped in its own try/except: a single upstream
failure yields a null/empty section, never a raised exception. This keeps
the dossier usable when (e.g.) EDGAR is down but yfinance is up.
"""
from __future__ import annotations

import logging
import statistics

from . import news as news_mod
from . import options as options_mod
from . import sec_edgar
from . import indicators as indicators_mod
from .macro_data import fetch_arbitrary_ticker
from ..portfolio import fundamentals as fundamentals_mod
from ..portfolio.valuation import _yf_info

log = logging.getLogger(__name__)


def _build_price(symbol: str) -> dict | None:
    """Recent price history + last/prior/52w-ish stats."""
    pts = fetch_arbitrary_ticker(symbol, days=365)
    if not pts:
        return None
    values = [p["value"] for p in pts if p.get("value") is not None]
    if not values:
        return None
    last = values[-1]
    prior = values[-2] if len(values) >= 2 else last
    high_52w = max(values)
    low_52w = min(values)
    change = last - prior
    change_pct = (change / prior * 100) if prior else 0.0
    return {
        "last":            round(last, 4),
        "prior":           round(prior, 4),
        "change":          round(change, 4),
        "change_pct":      round(change_pct, 4),
        "high_52w":        round(high_52w, 4),
        "low_52w":         round(low_52w, 4),
        "pct_from_high":   round((last / high_52w - 1) * 100, 2) if high_52w else None,
        "pct_from_low":    round((last / low_52w - 1) * 100, 2) if low_52w else None,
        "avg_365d":        round(statistics.mean(values), 4),
        "points":          pts,
    }


def _build_profile(symbol: str) -> dict | None:
    """yfinance .info — name, sector, market cap, PE, day change."""
    info = _yf_info(symbol)
    if not info:
        return None
    current = (
        info.get("regularMarketPrice")
        or info.get("currentPrice")
        or info.get("navPrice")
    )
    prev = info.get("previousClose") or info.get("regularMarketPreviousClose")
    day_change = None
    day_change_pct = None
    if current is not None and prev:
        try:
            day_change = round(float(current) - float(prev), 4)
            day_change_pct = round((float(current) / float(prev) - 1) * 100, 4)
        except (TypeError, ValueError, ZeroDivisionError):
            pass
    return {
        "name":           info.get("longName") or info.get("shortName") or symbol,
        "sector":         info.get("sector"),
        "industry":       info.get("industry"),
        "exchange":       info.get("exchange") or info.get("fullExchangeName"),
        "currency":       info.get("currency"),
        "market_cap":     info.get("marketCap"),
        "pe_ratio":       info.get("trailingPE"),
        "forward_pe":     info.get("forwardPE"),
        "dividend_yield": info.get("dividendYield"),
        "beta":           info.get("beta"),
        "current_price":  float(current) if current else None,
        "prev_close":     float(prev) if prev else None,
        "day_change":     day_change,
        "day_change_pct": day_change_pct,
        "summary":        info.get("longBusinessSummary"),
    }


def _build_fundamentals(symbol: str) -> dict | None:
    out = fundamentals_mod.enrich_fundamentals([symbol])
    data = out.get(symbol)
    return data if data else None


def _build_technicals(symbol: str) -> dict | None:
    """Composite buy/sell/hold signal. Reads OHLC from prices_daily internally."""
    sig = indicators_mod.compute(symbol, "signal", timeframe="1d", days=365)
    # signal_strength returns bucket "insufficient_data" when there are no bars.
    if sig.get("bucket") == "insufficient_data" and not sig.get("votes"):
        return None
    return sig


def _build_news(symbol: str) -> list[dict]:
    return news_mod.fetch_news_for_ticker(symbol, limit=10)


def _build_filings(symbol: str) -> list[dict]:
    cik_map = sec_edgar.resolve_ciks([symbol])
    cik = cik_map.get(symbol)
    if not cik:
        return []
    return sec_edgar.fetch_filings_for_ticker(symbol, cik, days=90, limit=15)


def _build_options(symbol: str) -> dict | None:
    summary = options_mod.chain_summary(symbol)
    # chain_summary always returns a dict; treat a hard error w/o data as null.
    if summary.get("error") and summary.get("expiry") is None:
        return None
    return summary


def build_dossier(symbol: str) -> dict:
    """Fuse price + profile + fundamentals + technicals + news + filings +
    options for ONE symbol into a single payload. Each section degrades to
    null/[] independently."""
    symbol = (symbol or "").upper().strip()

    def _safe(fn, default):
        try:
            return fn(symbol)
        except Exception as e:
            log.warning("dossier section %s failed for %s: %s", fn.__name__, symbol, e)
            return default

    return {
        "symbol":       symbol,
        "profile":      _safe(_build_profile, None),
        "price":        _safe(_build_price, None),
        "fundamentals": _safe(_build_fundamentals, None),
        "technicals":   _safe(_build_technicals, None),
        "news":         _safe(_build_news, []),
        "filings":      _safe(_build_filings, []),
        "options":      _safe(_build_options, None),
    }
