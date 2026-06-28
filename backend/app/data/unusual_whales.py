"""Unusual Whales market feeds — market-wide News and Insiders.

Unusual Whales (UW) is a paid market-data API. We surface two market-wide
feeds from it: breaking news headlines and insider buy/sell transactions
(Forms 3/4/5 style activity across the whole market).

UW is a paid API and we cannot exercise it live, so every normalizer here is
deliberately defensive: the payload may arrive as a bare list at the JSON
root, or wrapped as ``{"data": [...]}``, ``{"news": [...]}`` or
``{"transactions": [...]}``. We map UW fields to our own stable shape with
``.get()`` and sensible fallbacks so the frontend contract never shifts.

Graceful degradation is a hard contract (mirrors macro_data/news):
no ``UNUSUAL_WHALES_API_KEY`` -> ``configured: false``, ``degraded: true``,
empty data, a plain-language ``error``, and never a raised exception. On an
upstream failure we fall back to the stale cache when one exists.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.config import settings

from . import cache

log = logging.getLogger(__name__)

UW_TTL = 60 * 5  # 5 minutes — market feeds want freshness, but spare the paid API

# Endpoint paths assumed against settings.unusual_whales_base_url. UW groups
# market-wide feeds under /api/<feed>; adjust here if UW renames them.
NEWS_PATH = "/api/news"
INSIDERS_PATH = "/api/insider/transactions"


def _now_z() -> str:
    """ISO 8601 UTC timestamp with a trailing Z, matching the news.py style."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _uw_get(path: str, params: dict | None = None) -> tuple[dict | list | None, str | None]:
    """Single HTTP entrypoint for UW. Module-level so tests can patch it.

    Returns ``(data, None)`` on success and ``(None, "error message")`` on any
    failure or a missing key. Never raises.
    """
    if not settings.has_unusual_whales:
        return None, "UNUSUAL_WHALES_API_KEY not configured"

    try:
        import httpx

        base = settings.unusual_whales_base_url.rstrip("/")
        url = f"{base}{path}"
        headers = {"Authorization": f"Bearer {settings.unusual_whales_api_key}"}
        resp = httpx.get(url, params=params or {}, headers=headers, timeout=8.0)
        resp.raise_for_status()
        return resp.json(), None
    except Exception as e:  # noqa: BLE001 - graceful degradation, never raise
        return None, str(e)


def _rows(payload: dict | list | None, *keys: str) -> list:
    """Pull the list of records out of whatever envelope UW returned.

    Accepts a bare list at the root, or a dict wrapping the records under any
    of ``keys`` (e.g. ``data``, ``news``, ``transactions``). Falls back to the
    first list-valued entry in the dict so an unexpected key still works.
    """
    if payload is None:
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            val = payload.get(key)
            if isinstance(val, list):
                return val
        for val in payload.values():
            if isinstance(val, list):
                return val
    return []


def _as_float(value, default: float = 0.0) -> float:
    """Coerce UW numeric-ish fields (which may be strings) to float."""
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _tickers_from(raw: dict) -> list[str]:
    """Extract a clean upper-case ticker list from whatever field UW used."""
    candidate = (
        raw.get("tickers")
        or raw.get("symbols")
        or raw.get("ticker")
        or raw.get("symbol")
        or raw.get("meta")
        or []
    )
    if isinstance(candidate, str):
        # Could be a single symbol or a comma-separated list.
        parts = [p.strip() for p in candidate.replace(";", ",").split(",")]
        return [p.upper() for p in parts if p]
    if isinstance(candidate, dict):
        candidate = candidate.get("tickers") or candidate.get("symbols") or []
    out: list[str] = []
    if isinstance(candidate, list):
        for t in candidate:
            if isinstance(t, str) and t.strip():
                out.append(t.strip().upper())
            elif isinstance(t, dict):
                sym = t.get("ticker") or t.get("symbol")
                if isinstance(sym, str) and sym.strip():
                    out.append(sym.strip().upper())
    return out


def _normalize_news(raw: dict) -> dict | None:
    """Map one UW news record to our MarketNewsItem shape."""
    if not isinstance(raw, dict):
        return None

    title = raw.get("title") or raw.get("headline") or raw.get("name")
    url = raw.get("url") or raw.get("link") or raw.get("source_url") or ""
    source = raw.get("source") or raw.get("publisher") or raw.get("feed") or ""
    published = (
        raw.get("published")
        or raw.get("published_at")
        or raw.get("created_at")
        or raw.get("timestamp")
        or raw.get("date")
    )
    sentiment = raw.get("sentiment") or raw.get("tone")
    summary = raw.get("summary") or raw.get("description") or raw.get("body") or ""

    major_flag = (
        raw.get("is_major")
        or raw.get("major")
        or raw.get("importance")
        or raw.get("important")
    )
    if isinstance(major_flag, str):
        is_major = major_flag.strip().lower() in ("1", "true", "yes", "high", "major")
    else:
        is_major = bool(major_flag)

    tags_raw = raw.get("tags") or raw.get("categories") or raw.get("labels") or []
    if isinstance(tags_raw, str):
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
    elif isinstance(tags_raw, list):
        tags = [str(t) for t in tags_raw if t]
    else:
        tags = []

    if not title:
        return None

    return {
        "id": str(
            raw.get("id")
            or raw.get("uuid")
            or raw.get("guid")
            or url
            or title
        ),
        "title": str(title),
        "url": str(url),
        "source": str(source),
        "published": str(published) if published else None,
        "tickers": _tickers_from(raw),
        "sentiment": str(sentiment) if sentiment else None,
        "is_major": is_major,
        "tags": tags,
        "summary": str(summary),
    }


def fetch_market_news(*, limit: int = 60, sources: str | None = None) -> dict:
    """Market-wide breaking-news feed from Unusual Whales.

    Returns the MarketNewsResponse shape. Degrades gracefully: missing key or
    upstream failure yields empty items with ``degraded: true`` and a
    plain-language ``error``. Never raises.
    """
    configured = settings.has_unusual_whales
    cache_key = f"uw_news:{limit}:{sources or ''}"

    if not configured:
        return {
            "items": [],
            "count": 0,
            "configured": False,
            "degraded": True,
            "error": "UNUSUAL_WHALES_API_KEY not configured",
            "fetched_at": _now_z(),
            "source": "unusual_whales",
        }

    params: dict = {"limit": limit}
    if sources:
        params["sources"] = sources

    data, error = _uw_get(NEWS_PATH, params)

    if error is not None:
        log.warning("Unusual Whales news fetch failed: %s", error)
        stale = cache.get_stale(cache_key)
        if stale is not None:
            stale = {**stale, "degraded": True, "error": error, "fetched_at": _now_z()}
            return stale
        return {
            "items": [],
            "count": 0,
            "configured": True,
            "degraded": True,
            "error": error,
            "fetched_at": _now_z(),
            "source": "unusual_whales",
        }

    items: list[dict] = []
    seen: set[str] = set()
    for raw in _rows(data, "data", "news"):
        item = _normalize_news(raw)
        if item is None:
            continue
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        items.append(item)
        if len(items) >= limit:
            break

    payload = {
        "items": items,
        "count": len(items),
        "configured": True,
        "degraded": False,
        "error": None,
        "fetched_at": _now_z(),
        "source": "unusual_whales",
    }
    cache.set(cache_key, payload, UW_TTL)
    return payload


def _direction_for(txn_code: str) -> str:
    """Classify a transaction direction from its SEC transaction code."""
    code = (txn_code or "").strip().upper()
    if code == "P":
        return "buy"
    if code == "S":
        return "sell"
    return "other"


def _as_bool(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y")
    return bool(value)


def _normalize_insider(raw: dict) -> dict | None:
    """Map one UW insider record to our MarketInsiderTransaction shape."""
    if not isinstance(raw, dict):
        return None

    ticker = raw.get("ticker") or raw.get("symbol") or ""
    txn_code = str(
        raw.get("txn_code")
        or raw.get("transaction_code")
        or raw.get("code")
        or ""
    ).strip().upper()

    return {
        "ticker": str(ticker).upper(),
        "company": raw.get("company") or raw.get("company_name") or raw.get("issuer") or None,
        "insider_name": str(
            raw.get("insider_name")
            or raw.get("owner_name")
            or raw.get("reporting_name")
            or raw.get("name")
            or ""
        ),
        "insider_title": raw.get("insider_title") or raw.get("title") or raw.get("officer_title") or None,
        "is_director": _as_bool(raw.get("is_director") or raw.get("director")),
        "is_officer": _as_bool(raw.get("is_officer") or raw.get("officer")),
        "is_ten_pct": _as_bool(
            raw.get("is_ten_pct")
            or raw.get("is_ten_percent_owner")
            or raw.get("ten_percent_owner")
        ),
        "txn_date": raw.get("txn_date") or raw.get("transaction_date") or raw.get("trade_date") or None,
        "filing_date": raw.get("filing_date") or raw.get("filed_at") or raw.get("report_date") or None,
        "txn_code": txn_code,
        "direction": _direction_for(txn_code),
        "shares": _as_float(raw.get("shares") or raw.get("quantity") or raw.get("amount")),
        "price": _as_float(raw.get("price") or raw.get("share_price")),
        "value": _as_float(raw.get("value") or raw.get("total_value") or raw.get("transaction_value")),
        "shares_after": _as_float(
            raw.get("shares_after")
            or raw.get("shares_owned_after")
            or raw.get("amount_after")
        ),
        "source_url": raw.get("source_url") or raw.get("url") or raw.get("filing_url") or None,
    }


def _summarize(transactions: list[dict]) -> dict:
    """Compute the insider summary block per the build contract math."""
    buys = [t for t in transactions if t["direction"] == "buy"]
    sells = [t for t in transactions if t["direction"] == "sell"]
    buy_value = sum(_as_float(t["value"]) for t in buys)
    sell_value = sum(_as_float(t["value"]) for t in sells)
    return {
        "total": len(transactions),
        "buy_count": len(buys),
        "sell_count": len(sells),
        "buy_value": round(buy_value, 2),
        "sell_value": round(sell_value, 2),
        "net_value": round(buy_value - sell_value, 2),
        "unique_tickers": len({t["ticker"] for t in transactions if t["ticker"]}),
        "unique_insiders": len({t["insider_name"] for t in transactions if t["insider_name"]}),
        "buy_sell_ratio": round(buy_value / sell_value, 4) if sell_value > 0 else 0.0,
    }


def fetch_market_insiders(
    *,
    limit: int = 100,
    direction: str = "all",
    min_value: float = 0.0,
    ticker: str | None = None,
) -> dict:
    """Market-wide insider buy/sell feed from Unusual Whales.

    Returns the MarketInsidersResponse shape. The direction/min_value/ticker
    filters are applied in Python after normalization. Degrades gracefully:
    missing key or upstream failure yields empty data with ``degraded: true``
    and a plain-language ``error``. Never raises.
    """
    configured = settings.has_unusual_whales
    direction = (direction or "all").strip().lower()
    if direction not in ("all", "buy", "sell"):
        direction = "all"
    ticker_filter = ticker.strip().upper() if ticker else None
    filters = {"direction": direction, "min_value": min_value, "ticker": ticker_filter}

    cache_key = f"uw_insiders:{limit}:{direction}:{min_value}:{ticker_filter or ''}"

    if not configured:
        return {
            "transactions": [],
            "summary": _summarize([]),
            "count": 0,
            "configured": False,
            "degraded": True,
            "error": "UNUSUAL_WHALES_API_KEY not configured",
            "fetched_at": _now_z(),
            "filters": filters,
            "source": "unusual_whales",
        }

    # Over-fetch a little so Python-side filtering still has material to work with.
    params: dict = {"limit": max(limit, 200)}
    data, error = _uw_get(INSIDERS_PATH, params)

    if error is not None:
        log.warning("Unusual Whales insiders fetch failed: %s", error)
        stale = cache.get_stale(cache_key)
        if stale is not None:
            stale = {**stale, "degraded": True, "error": error, "fetched_at": _now_z()}
            return stale
        return {
            "transactions": [],
            "summary": _summarize([]),
            "count": 0,
            "configured": True,
            "degraded": True,
            "error": error,
            "fetched_at": _now_z(),
            "filters": filters,
            "source": "unusual_whales",
        }

    normalized: list[dict] = []
    for raw in _rows(data, "data", "transactions"):
        txn = _normalize_insider(raw)
        if txn is not None:
            normalized.append(txn)

    # Apply filters in Python after normalization.
    filtered = normalized
    if direction in ("buy", "sell"):
        filtered = [t for t in filtered if t["direction"] == direction]
    if min_value > 0:
        filtered = [t for t in filtered if _as_float(t["value"]) >= min_value]
    if ticker_filter:
        filtered = [t for t in filtered if t["ticker"] == ticker_filter]

    filtered = filtered[:limit]

    payload = {
        "transactions": filtered,
        "summary": _summarize(filtered),
        "count": len(filtered),
        "configured": True,
        "degraded": False,
        "error": None,
        "fetched_at": _now_z(),
        "filters": filters,
        "source": "unusual_whales",
    }
    cache.set(cache_key, payload, UW_TTL)
    return payload
