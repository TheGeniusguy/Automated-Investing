"""Tests for the centralized OHLCV loader (app.data.ohlcv).

The point of this module is the DB-first / live-fallback contract that makes
technical indicators and the dossier work on a cold store. We assert that
contract by stubbing the DB and the live fetch (no network, no DB writes).
"""
from __future__ import annotations

import pandas as pd

from app.data import ohlcv


def test_from_records_shapes_and_dtypes():
    recs = [
        {"date": "2024-01-02", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "adj_close": 1.5, "volume": 100},
        {"date": "2024-01-03", "open": 1.5, "high": 2.5, "low": 1.0, "close": 2.0, "adj_close": 2.0, "volume": 200},
    ]
    df = ohlcv._from_records(recs)
    assert list(df.columns) == ["date", "open", "high", "low", "close", "adj_close", "volume"]
    assert len(df) == 2
    assert str(df["date"].dtype).startswith("datetime64")
    assert df["close"].dtype == float
    assert df["volume"].iloc[-1] == 200.0


def test_from_records_empty():
    df = ohlcv._from_records([])
    assert df.empty
    assert list(df.columns) == ["date", "open", "high", "low", "close", "adj_close", "volume"]


def test_load_ohlcv_uses_db_when_rows_present(monkeypatch):
    db_rows = [
        # returned DESC by the query; loader reverses to ascending
        ("2024-01-03", 1.5, 2.5, 1.0, 2.0, 2.0, 200),
        ("2024-01-02", 1.0, 2.0, 0.5, 1.5, 1.5, 100),
    ]
    monkeypatch.setattr(ohlcv.db_engine, "fetchall", lambda *a, **k: db_rows)

    called = {"live": False}
    monkeypatch.setattr(ohlcv, "_fetch_live", lambda *a, **k: called.__setitem__("live", True))

    df = ohlcv.load_ohlcv("AAPL", 30)
    assert called["live"] is False                      # DB path, no network
    assert len(df) == 2
    assert df["date"].iloc[0] == pd.Timestamp("2024-01-02")  # reversed to ascending
    assert df["close"].iloc[-1] == 2.0


def test_load_ohlcv_falls_back_to_live_when_db_empty(monkeypatch):
    monkeypatch.setattr(ohlcv.db_engine, "fetchall", lambda *a, **k: [])

    sentinel = ohlcv._from_records([
        {"date": "2024-02-01", "open": 5, "high": 6, "low": 4, "close": 5.5, "adj_close": 5.5, "volume": 10},
    ])
    monkeypatch.setattr(ohlcv, "_fetch_live", lambda sym, days: sentinel)

    df = ohlcv.load_ohlcv("NEWCO", 30)
    assert len(df) == 1
    assert df["close"].iloc[0] == 5.5


def test_fetch_live_returns_empty_and_negative_caches(monkeypatch):
    # Simulate yfinance import returning an empty history -> empty df + short TTL cache.
    sets = {}
    monkeypatch.setattr(ohlcv.cache, "get", lambda k: None)
    monkeypatch.setattr(ohlcv.cache, "set", lambda k, v, ttl: sets.update({k: (v, ttl)}))

    class _FakeTicker:
        def __init__(self, *a, **k): pass
        def history(self, *a, **k):
            return pd.DataFrame()  # empty

    import sys, types
    fake_yf = types.ModuleType("yfinance")
    fake_yf.Ticker = _FakeTicker
    monkeypatch.setitem(sys.modules, "yfinance", fake_yf)

    df = ohlcv._fetch_live("ZZZZ", 30)
    assert df.empty
    # cached with the short negative TTL, not the full TTL
    (_, ttl) = next(iter(sets.values()))
    assert ttl == ohlcv._NEG_TTL
