"""Crypto overview + comparison.

Cross-asset surface for the top crypto majors. Mirrors the pure-function,
never-raise contract used across the data layer: every public function
returns a dict and degrades to empty/null fields on any upstream failure.

Price history flows through `macro_data.fetch_arbitrary_ticker` (cached,
yfinance-backed). Live name/market-cap/24h metadata comes from `yf.Ticker().info`
wrapped exactly like `valuation.py::_yf_info`. Global market-cap / BTC dominance
is an OPTIONAL CoinGecko call — its absence never blocks the payload.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

import httpx

from . import cache
from .macro_data import fetch_arbitrary_ticker, latest_value

log = logging.getLogger(__name__)

_TTL = 900  # 15 min for quotes

# Top majors, ordered. (yfinance symbol, display name)
COINS: list[tuple[str, str]] = [
    ("BTC-USD",   "Bitcoin"),
    ("ETH-USD",   "Ethereum"),
    ("SOL-USD",   "Solana"),
    ("BNB-USD",   "BNB"),
    ("XRP-USD",   "XRP"),
    ("ADA-USD",   "Cardano"),
    ("DOGE-USD",  "Dogecoin"),
    ("AVAX-USD",  "Avalanche"),
    ("LINK-USD",  "Chainlink"),
    ("DOT-USD",   "Polkadot"),
]

COINGECKO_GLOBAL = "https://api.coingecko.com/api/v3/global"


def _yf_info(symbol: str) -> dict:
    """Single-symbol yfinance .info with graceful fallback (mirrors valuation.py)."""
    try:
        import yfinance as yf
        return yf.Ticker(symbol).info or {}
    except Exception as e:
        log.warning("crypto yf.info(%s) failed: %s", symbol, e)
        return {}


def _pct_change(latest: float | None, base: float | None) -> float | None:
    if latest is None or base is None or base == 0:
        return None
    return round((latest / base - 1) * 100, 2)


def _coin_row(symbol: str, name: str) -> dict:
    """One coin: price, 24h/7d change, optional market cap. Never raises."""
    cache_key = f"crypto:row:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    row: dict = {
        "symbol": symbol,
        "name": name,
        "price": None,
        "change_24h_pct": None,
        "change_7d_pct": None,
        "market_cap": None,
        "volume_24h": None,
    }
    try:
        pts = fetch_arbitrary_ticker(symbol, days=8)
        values = [p["value"] for p in pts if p.get("value") is not None]
        if values:
            price = values[-1]
            prior = values[-2] if len(values) >= 2 else None
            week_ago = values[0] if len(values) >= 2 else None
            row["price"] = round(price, 4) if price < 10 else round(price, 2)
            row["change_24h_pct"] = _pct_change(price, prior)
            row["change_7d_pct"] = _pct_change(price, week_ago)

        info = _yf_info(symbol)
        if info:
            row["market_cap"] = info.get("marketCap")
            row["volume_24h"] = info.get("volume24Hr") or info.get("volume")
            # Prefer info's live regularMarketPrice if history was empty.
            if row["price"] is None and info.get("regularMarketPrice") is not None:
                row["price"] = round(float(info["regularMarketPrice"]), 4)
            # Prefer info's 24h change pct if we couldn't derive it.
            if row["change_24h_pct"] is None and info.get("regularMarketChangePercent") is not None:
                row["change_24h_pct"] = round(float(info["regularMarketChangePercent"]) * 100, 2)
    except Exception as e:
        log.warning("crypto _coin_row(%s) failed: %s", symbol, e)

    cache.set(cache_key, row, _TTL)
    return row


def _global_stats() -> dict:
    """Optional CoinGecko global market-cap / BTC dominance. Null on any failure."""
    out = {"total_market_cap_usd": None, "btc_dominance_pct": None, "market_cap_change_24h_pct": None}
    cache_key = "crypto:global"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        with httpx.Client(timeout=8.0) as client:
            r = client.get(COINGECKO_GLOBAL)
            r.raise_for_status()
            data = (r.json() or {}).get("data", {})
        tmc = data.get("total_market_cap", {}) or {}
        dom = data.get("market_cap_percentage", {}) or {}
        out["total_market_cap_usd"] = tmc.get("usd")
        out["btc_dominance_pct"] = (
            round(dom["btc"], 2) if dom.get("btc") is not None else None
        )
        chg = data.get("market_cap_change_percentage_24h_usd")
        out["market_cap_change_24h_pct"] = round(chg, 2) if chg is not None else None
        cache.set(cache_key, out, _TTL)
    except Exception as e:
        log.warning("crypto _global_stats failed: %s", e)
    return out


def overview() -> dict:
    """Top-coin table + optional global stats. Never raises."""
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(_coin_row, sym, name) for sym, name in COINS]
        for fut, (sym, name) in zip(futures, COINS):
            try:
                rows.append(fut.result())
            except Exception as e:
                log.warning("crypto overview row(%s) failed: %s", sym, e)
                rows.append({
                    "symbol": sym, "name": name, "price": None,
                    "change_24h_pct": None, "change_7d_pct": None,
                    "market_cap": None, "volume_24h": None,
                })

    # Keep input ordering (rows may complete out of order via the executor).
    order = {sym: i for i, (sym, _) in enumerate(COINS)}
    rows.sort(key=lambda r: order.get(r["symbol"], 999))

    return {
        "coins": rows,
        "global": _global_stats(),
    }


def compare(symbols: list[str], days: int = 365) -> dict:
    """Normalized-to-100 curves per symbol + per-symbol return metrics.

    Never raises — symbols that fail to fetch are omitted from `series` and
    carry null metrics.
    """
    syms = [s.strip().upper() for s in symbols if s and s.strip()]
    days = max(2, min(int(days), 365 * 5))

    series: dict[str, list[dict]] = {}
    metrics: dict[str, dict] = {}

    def _one(sym: str) -> tuple[str, list[dict], dict]:
        try:
            pts = fetch_arbitrary_ticker(sym, days=days)
            clean = [p for p in pts if p.get("value") is not None]
            if not clean:
                return sym, [], {"return_pct": None, "start": None, "latest": None}
            base = clean[0]["value"]
            norm: list[dict] = []
            if base and base != 0:
                norm = [
                    {"date": p["date"], "value": round(p["value"] / base * 100, 3)}
                    for p in clean
                ]
            latest = clean[-1]["value"]
            return sym, norm, {
                "return_pct": _pct_change(latest, base),
                "start": round(base, 4) if base < 10 else round(base, 2),
                "latest": round(latest, 4) if latest < 10 else round(latest, 2),
            }
        except Exception as e:
            log.warning("crypto compare(%s) failed: %s", sym, e)
            return sym, [], {"return_pct": None, "start": None, "latest": None}

    with ThreadPoolExecutor(max_workers=8) as pool:
        for sym, norm, m in pool.map(_one, syms):
            if norm:
                series[sym] = norm
            metrics[sym] = m

    return {
        "symbols": syms,
        "days": days,
        "series": series,
        "metrics": metrics,
    }
