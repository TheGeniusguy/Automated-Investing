"""Tests for the bounded ingest universe (app.ingest.prices.universe_symbols)."""
from __future__ import annotations

from app.ingest import prices as ingest_prices
from app.data.watchlist import DEFAULT_EQUITIES_WATCHLIST


def test_universe_includes_watchlist_and_core_etfs(monkeypatch):
    monkeypatch.setattr(ingest_prices.engine, "fetchall", lambda *a, **k: [])
    syms = ingest_prices.universe_symbols()
    for s in DEFAULT_EQUITIES_WATCHLIST:
        assert s.upper() in syms
    for etf in ("SPY", "QQQ", "TLT"):
        assert etf in syms


def test_universe_merges_portfolio_holdings(monkeypatch):
    monkeypatch.setattr(ingest_prices.engine, "fetchall", lambda *a, **k: [("nvda",), ("PLTR",)])
    syms = ingest_prices.universe_symbols()
    assert "NVDA" in syms  # uppercased
    assert "PLTR" in syms


def test_universe_dedups_and_caps(monkeypatch):
    # Holdings overlap the watchlist (AAPL) and add many unique names.
    extra = [(f"SYM{i}",) for i in range(500)]
    monkeypatch.setattr(ingest_prices.engine, "fetchall", lambda *a, **k: [("AAPL",)] + extra)
    syms = ingest_prices.universe_symbols(max_symbols=50)
    assert len(syms) == 50
    assert len(set(syms)) == len(syms)            # no duplicates
    assert syms.count("AAPL") == 1


def test_universe_survives_db_failure(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(ingest_prices.engine, "fetchall", _boom)
    syms = ingest_prices.universe_symbols()
    # still returns the static watchlist + ETFs, never raises
    assert "AAPL" in syms and "SPY" in syms
