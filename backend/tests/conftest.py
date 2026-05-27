"""Shared fixtures for portfolio-math tests.

The portfolio analytics/risk modules pull prices through
``app.data.macro_data.fetch_arbitrary_ticker`` and the risk-free rate through
``fetch_series``. Both are imported *inside* the functions, so patching the
module attribute is enough — the local import resolves the patched name at call
time. Tests register deterministic series in ``PRICE_DB`` and assert against an
independent recomputation of the documented formula, so the *invariants*
(Sortino all-N denominator, R² via lstsq, YTD prior-Dec anchoring, FIFO
commission-once) are locked rather than magic numbers.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

# symbol -> list[{"date": "YYYY-MM-DD", "value": float}]
PRICE_DB: dict[str, list[dict]] = {}
# annualized risk-free rate the fake fetch_series should imply (value is %/100)
RF_ANNUAL = {"value": 0.0}


def calendar_grid(n_days: int, end: date | None = None) -> list[str]:
    """Return n_days consecutive calendar dates ending at ``end`` (default today)."""
    end = end or date.today()
    return [(end - timedelta(days=n_days - 1 - i)).isoformat() for i in range(n_days)]


def make_series(dates: list[str], values: list[float]) -> list[dict]:
    return [{"date": d, "value": v} for d, v in zip(dates, values)]


def register(symbol: str, dates: list[str], values: list[float]) -> None:
    PRICE_DB[symbol.upper()] = make_series(dates, values)


@pytest.fixture(autouse=True)
def patch_data(monkeypatch):
    """Route all price/rate fetches to the in-memory PRICE_DB."""
    PRICE_DB.clear()
    RF_ANNUAL["value"] = 0.0

    def fake_fetch_arbitrary_ticker(ticker: str, days: int = 365):
        return list(PRICE_DB.get(ticker.upper(), []))

    def fake_fetch_series(series: str, days: int = 30):
        # _fetch_risk_free_rate divides the last value by 100 → return rf*100
        return [{"date": date.today().isoformat(), "value": RF_ANNUAL["value"] * 100.0}]

    monkeypatch.setattr(
        "app.data.macro_data.fetch_arbitrary_ticker", fake_fetch_arbitrary_ticker
    )
    monkeypatch.setattr("app.data.macro_data.fetch_series", fake_fetch_series)
    yield
    PRICE_DB.clear()


@pytest.fixture
def txn():
    """Factory for transaction dicts with sensible defaults."""
    _id = {"n": 0}

    def _make(symbol, trade_type, quantity, price, trade_date, commission=0.0, **extra):
        _id["n"] += 1
        d = {
            "id": _id["n"],
            "symbol": symbol,
            "trade_type": trade_type,
            "quantity": float(quantity),
            "price": float(price),
            "trade_date": trade_date,
            "commission": float(commission),
        }
        d.update(extra)
        return d

    return _make
