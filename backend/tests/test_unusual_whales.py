"""Unusual Whales market-feed invariants for ``app.data.unusual_whales``.

These tests NEVER hit the network. We monkeypatch the module-level HTTP shim
``app.data.unusual_whales._uw_get`` to return canned UW-shaped payloads, and we
monkeypatch ``app.config.settings.unusual_whales_api_key`` for the configured /
unconfigured branches.

Cache strategy (robustness): the UW module follows the repo convention
``from . import cache`` (see app/data/macro_data.py), so its ``cache.get`` /
``cache.set`` / ``cache.get_stale`` resolve to the *same* function objects on
``app.data.cache``. The autouse ``_disable_cache`` fixture neutralizes those at
the source module, which guarantees no cross-test cache bleed regardless of any
sqlite TTL. As belt-and-suspenders, each test also uses distinct tickers / ids so
results can't collide on a shared cache key even if caching were left live.

Like conftest.py for the portfolio math, the summary test recomputes the
documented formula independently rather than asserting magic numbers, so the
buy/sell/net/ratio invariants are locked.
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.data import unusual_whales as uw


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _disable_cache(monkeypatch):
    """No-op the shared TTL cache so canned _uw_get payloads are never shadowed."""
    monkeypatch.setattr("app.data.cache.get", lambda *a, **k: None, raising=False)
    monkeypatch.setattr("app.data.cache.get_stale", lambda *a, **k: None, raising=False)
    monkeypatch.setattr("app.data.cache.set", lambda *a, **k: None, raising=False)


@pytest.fixture
def configured(monkeypatch):
    """Give the settings a non-empty key so payloads report configured=True."""
    monkeypatch.setattr(settings, "unusual_whales_api_key", "uw-test-key")


def patch_uw(monkeypatch, result):
    """Patch the module-level HTTP shim to return ``result`` (a (data, err) tuple)."""
    monkeypatch.setattr(uw, "_uw_get", lambda *a, **k: result)


# --------------------------------------------------------------------------- #
# Canned UW-shaped records
#
# Each record intentionally carries BOTH the contract's output field names and
# the common Unusual Whales raw aliases (same value on each), so the test stays
# resilient to whichever alias the defensive normalizer happens to read.
# --------------------------------------------------------------------------- #
def make_news_record():
    return {
        "id": "uw-news-1",
        "title": "Fed holds rates steady",
        "headline": "Fed holds rates steady",          # UW alias
        "url": "https://unusualwhales.com/news/1",
        "source": "Reuters",
        "news_source": "Reuters",                       # UW alias
        "published": "2026-06-27T14:30:00Z",
        "created_at": "2026-06-27T14:30:00Z",           # UW alias
        "timestamp": "2026-06-27T14:30:00Z",            # UW alias
        # lower-case on purpose: normalizer must upper-case
        "tickers": ["aapl", "msft"],
        "symbols": ["aapl", "msft"],                    # UW alias
        "sentiment": "neutral",
        "is_major": True,
        "major": True,                                  # UW alias
        "tags": ["fed", "rates"],
        "summary": "The Federal Reserve left rates unchanged.",
        "description": "The Federal Reserve left rates unchanged.",  # UW alias
        "meta": "The Federal Reserve left rates unchanged.",         # UW alias
    }


def make_insider_record(*, txn_code, value, ticker="AAPL", insider_name="Jane Doe",
                        shares=100.0, price=10.0):
    return {
        "ticker": ticker,
        "symbol": ticker,                               # UW alias
        "company": f"{ticker} Inc",
        "company_name": f"{ticker} Inc",                # UW alias
        "insider_name": insider_name,
        "full_name": insider_name,                      # UW alias
        "owner_name": insider_name,                     # UW alias
        "insider_title": "Chief Executive Officer",
        "title": "Chief Executive Officer",             # UW alias
        "is_director": True,
        "is_officer": True,
        "is_ten_pct": False,
        "is_ten_percent_owner": False,                  # UW alias
        "txn_date": "2026-06-20",
        "transaction_date": "2026-06-20",               # UW alias
        "filing_date": "2026-06-21",
        "txn_code": txn_code,
        "transaction_code": txn_code,                   # UW alias
        "code": txn_code,                               # UW alias
        "shares": shares,
        "amount": shares,                               # UW alias
        "price": price,
        "transaction_price": price,                     # UW alias
        "value": value,
        "transaction_value": value,                     # UW alias
        "shares_after": 1000.0,
        "shares_owned_after": 1000.0,                   # UW alias
        "source_url": "https://www.sec.gov/filing/1",
        "url": "https://www.sec.gov/filing/1",          # UW alias
    }


# --------------------------------------------------------------------------- #
# 1. Degraded path: no API key
# --------------------------------------------------------------------------- #
def test_news_degraded_when_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "unusual_whales_api_key", "")
    # Even if the fetcher delegates the key-check to _uw_get, keep it offline.
    patch_uw(monkeypatch, (None, "UNUSUAL_WHALES_API_KEY not configured"))

    res = uw.fetch_market_news()  # must not raise

    assert res["configured"] is False
    assert res["degraded"] is True
    assert res["items"] == []
    assert res["count"] == 0
    assert res["error"]  # non-null, human-readable
    assert res["source"] == "unusual_whales"


def test_insiders_degraded_when_unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "unusual_whales_api_key", "")
    patch_uw(monkeypatch, (None, "UNUSUAL_WHALES_API_KEY not configured"))

    res = uw.fetch_market_insiders()  # must not raise

    assert res["configured"] is False
    assert res["degraded"] is True
    assert res["transactions"] == []
    assert res["count"] == 0
    assert res["error"]  # non-null
    assert res["source"] == "unusual_whales"


# --------------------------------------------------------------------------- #
# 2. News normalization across the three accepted root shapes
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "wrap",
    [
        pytest.param(lambda recs: recs, id="bare-list"),
        pytest.param(lambda recs: {"data": recs}, id="data-key"),
        pytest.param(lambda recs: {"news": recs}, id="news-key"),
    ],
)
def test_news_normalization_root_shapes(monkeypatch, configured, wrap):
    patch_uw(monkeypatch, (wrap([make_news_record()]), None))

    res = uw.fetch_market_news()

    assert res["configured"] is True
    assert res["degraded"] is False
    assert res["error"] is None
    assert res["count"] == 1
    assert len(res["items"]) == 1

    item = res["items"][0]
    assert item["id"] == "uw-news-1"
    assert item["title"] == "Fed holds rates steady"
    assert item["url"] == "https://unusualwhales.com/news/1"
    assert item["source"] == "Reuters"
    assert item["tickers"] == ["AAPL", "MSFT"]   # upper-cased
    assert item["is_major"] is True
    assert item["published"]  # carried through, not null


# --------------------------------------------------------------------------- #
# 3. Insider direction classification from txn_code
# --------------------------------------------------------------------------- #
def test_insider_direction_classification(monkeypatch, configured):
    recs = [
        make_insider_record(txn_code="P", value=1000.0, ticker="AAA"),
        make_insider_record(txn_code="S", value=1000.0, ticker="BBB"),
        make_insider_record(txn_code="A", value=1000.0, ticker="CCC"),
    ]
    patch_uw(monkeypatch, ({"data": recs}, None))

    res = uw.fetch_market_insiders()  # default direction="all" keeps all three

    by_code = {t["txn_code"]: t["direction"] for t in res["transactions"]}
    assert by_code == {"P": "buy", "S": "sell", "A": "other"}


# --------------------------------------------------------------------------- #
# 4. Insider summary math — recomputed independently (locks the formula)
# --------------------------------------------------------------------------- #
def test_insider_summary_math(monkeypatch, configured):
    records = [
        make_insider_record(txn_code="P", value=1000.0, ticker="AAPL", insider_name="Jane Doe"),
        make_insider_record(txn_code="P", value=3000.0, ticker="MSFT", insider_name="Bob Smith"),
        make_insider_record(txn_code="S", value=2000.0, ticker="AAPL", insider_name="Jane Doe"),
        make_insider_record(txn_code="S", value=500.0, ticker="GOOG", insider_name="Carol Lee"),
    ]
    patch_uw(monkeypatch, ({"data": records}, None))

    res = uw.fetch_market_insiders()
    summary = res["summary"]

    # Independent recomputation of the documented contract formula.
    def direction(code):
        return {"P": "buy", "S": "sell"}.get(code, "other")

    buys = [r for r in records if direction(r["txn_code"]) == "buy"]
    sells = [r for r in records if direction(r["txn_code"]) == "sell"]
    exp_buy_value = sum(r["value"] for r in buys)
    exp_sell_value = sum(r["value"] for r in sells)
    exp_net = exp_buy_value - exp_sell_value
    exp_ratio = round(exp_buy_value / exp_sell_value, 4) if exp_sell_value > 0 else 0.0
    exp_unique_tickers = len({r["ticker"] for r in records})
    exp_unique_insiders = len({r["insider_name"] for r in records})

    assert summary["total"] == len(records)
    assert summary["buy_count"] == len(buys)
    assert summary["sell_count"] == len(sells)
    assert summary["buy_value"] == exp_buy_value
    assert summary["sell_value"] == exp_sell_value
    assert summary["net_value"] == exp_net
    assert summary["buy_sell_ratio"] == exp_ratio
    assert summary["unique_tickers"] == exp_unique_tickers
    assert summary["unique_insiders"] == exp_unique_insiders


# --------------------------------------------------------------------------- #
# 5. Filters (direction / min_value / ticker)
# --------------------------------------------------------------------------- #
def test_filter_direction_buy_excludes_sells(monkeypatch, configured):
    recs = [
        make_insider_record(txn_code="P", value=1000.0, ticker="AAA"),
        make_insider_record(txn_code="P", value=2000.0, ticker="BBB"),
        make_insider_record(txn_code="S", value=3000.0, ticker="CCC"),
    ]
    patch_uw(monkeypatch, ({"data": recs}, None))

    res = uw.fetch_market_insiders(direction="buy")

    assert res["filters"]["direction"] == "buy"
    assert res["count"] == 2
    assert all(t["direction"] == "buy" for t in res["transactions"])


def test_filter_min_value_drops_sub_threshold(monkeypatch, configured):
    recs = [
        make_insider_record(txn_code="P", value=1000.0, ticker="SMALL"),
        make_insider_record(txn_code="P", value=100000.0, ticker="BIG"),
    ]
    patch_uw(monkeypatch, ({"data": recs}, None))

    res = uw.fetch_market_insiders(min_value=50000.0)

    assert res["filters"]["min_value"] == 50000.0
    tickers = {t["ticker"] for t in res["transactions"]}
    assert tickers == {"BIG"}


def test_filter_ticker_keeps_only_match(monkeypatch, configured):
    recs = [
        make_insider_record(txn_code="P", value=1000.0, ticker="AAPL"),
        make_insider_record(txn_code="P", value=2000.0, ticker="MSFT"),
    ]
    patch_uw(monkeypatch, ({"data": recs}, None))

    res = uw.fetch_market_insiders(ticker="AAPL")

    assert res["filters"]["ticker"] == "AAPL"
    assert {t["ticker"] for t in res["transactions"]} == {"AAPL"}


# --------------------------------------------------------------------------- #
# 6. HTTP failure: _uw_get returns (None, "boom") — surface, don't raise
# --------------------------------------------------------------------------- #
def test_news_http_failure_is_degraded(monkeypatch, configured):
    patch_uw(monkeypatch, (None, "boom"))

    res = uw.fetch_market_news()  # must not raise

    assert res["configured"] is True   # key present, upstream failed
    assert res["degraded"] is True
    assert res["items"] == []
    assert res["count"] == 0
    assert res["error"] is not None
    assert "boom" in res["error"]


def test_insiders_http_failure_is_degraded(monkeypatch, configured):
    patch_uw(monkeypatch, (None, "boom"))

    res = uw.fetch_market_insiders()  # must not raise

    assert res["configured"] is True
    assert res["degraded"] is True
    assert res["transactions"] == []
    assert res["count"] == 0
    assert res["error"] is not None
    assert "boom" in res["error"]
