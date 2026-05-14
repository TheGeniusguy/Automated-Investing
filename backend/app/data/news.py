"""News aggregation via yfinance.

yfinance exposes news per ticker through `Ticker.news` — list of dicts with
title, publisher, link, providerPublishTime (unix), and sometimes a
relatedTickers list. We normalize the shape, dedupe across overlapping
ticker queries, and persist nothing (news volume is high; the cache layer
covers the freshness requirement).

For a richer view we could add RSS aggregation (Reuters / FT / WSJ free
feeds), but per-ticker yfinance news is the highest signal-to-noise
starting point.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Iterable

from . import cache

log = logging.getLogger(__name__)

NEWS_TTL = 60 * 15  # 15 minutes — news freshness matters more than other caches


def _yf():
    import yfinance as yf
    return yf


def _normalize(raw: dict, source_ticker: str) -> dict | None:
    """yfinance shifted its news payload shape in 0.2.x. Handle both legacy
    flat dicts and the newer nested {content: {...}} variant."""
    content = raw.get("content") or raw
    if not isinstance(content, dict):
        return None

    title       = content.get("title") or raw.get("title")
    publisher   = (content.get("provider") or {}).get("displayName") if isinstance(content.get("provider"), dict) else content.get("publisher") or raw.get("publisher")
    link        = (content.get("canonicalUrl") or {}).get("url") if isinstance(content.get("canonicalUrl"), dict) else content.get("link") or raw.get("link")
    summary     = content.get("summary") or raw.get("summary")
    pub_time    = content.get("pubDate") or content.get("displayTime")
    unix_time   = raw.get("providerPublishTime")
    related     = content.get("relatedTickers") or raw.get("relatedTickers") or []

    # Normalize publish time → ISO 8601 UTC
    iso_published: str | None = None
    if unix_time:
        try:
            iso_published = datetime.fromtimestamp(int(unix_time), tz=timezone.utc).isoformat()
        except Exception:
            pass
    if iso_published is None and pub_time:
        iso_published = str(pub_time)

    if not title or not link:
        return None

    return {
        "title":     title,
        "publisher": publisher or "",
        "url":       link,
        "summary":   summary or "",
        "published": iso_published,
        "tickers":   sorted({source_ticker.upper(), *[str(t).upper() for t in related if t]}),
        "source":    source_ticker.upper(),
    }


def fetch_news_for_ticker(symbol: str, *, limit: int = 25) -> list[dict]:
    cache_key = f"news:{symbol}:{limit}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    yf = _yf()
    try:
        raw = yf.Ticker(symbol).news or []
    except Exception as e:
        log.warning("yfinance news fetch failed for %s: %s", symbol, e)
        stale = cache.get_stale(cache_key)
        return stale if stale is not None else []

    items: list[dict] = []
    seen: set[str] = set()
    for r in raw[:limit * 2]:
        n = _normalize(r, symbol)
        if not n:
            continue
        if n["url"] in seen:
            continue
        seen.add(n["url"])
        items.append(n)
        if len(items) >= limit:
            break

    cache.set(cache_key, items, NEWS_TTL)
    return items


def fetch_news_feed(tickers: Iterable[str], *, per_ticker: int = 8, overall: int = 60) -> dict:
    """Merge news across multiple tickers, dedupe by URL, sort newest-first."""
    started = datetime.utcnow()
    tickers_list = [t.upper().strip() for t in tickers if t.strip()]

    merged: dict[str, dict] = {}
    for sym in tickers_list:
        for item in fetch_news_for_ticker(sym, limit=per_ticker):
            if item["url"] in merged:
                # Re-attribute the source ticker so the panel groups correctly
                merged[item["url"]]["tickers"] = sorted(
                    set(merged[item["url"]]["tickers"]) | set(item["tickers"])
                )
            else:
                merged[item["url"]] = item

    items = sorted(
        merged.values(),
        key=lambda x: x["published"] or "",
        reverse=True,
    )[:overall]

    elapsed = (datetime.utcnow() - started).total_seconds()
    return {
        "items":     items,
        "tickers":   tickers_list,
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "elapsed_s": round(elapsed, 2),
    }
