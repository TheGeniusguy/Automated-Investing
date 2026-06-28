"""Deterministic sample price paths for the backtester.

When `fetch_arbitrary_ticker` returns nothing (no key / upstream down), the
engine falls back to a geometric-Brownian-motion price path seeded off the
symbol so screenshots are stable and reproducible. Clearly a SAMPLE source.
"""
from __future__ import annotations

import hashlib
from datetime import date, timedelta

import numpy as np


def _seed_for(symbol: str) -> int:
    h = hashlib.sha256((symbol or "SAMPLE").upper().encode()).hexdigest()
    return int(h[:8], 16)


def _trading_days(n: int, end: date) -> list[str]:
    """Return `n` business-day ISO dates ending on/just before `end`."""
    out: list[str] = []
    d = end
    while len(out) < n:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def sample_price_series(
    symbol: str,
    n_days: int,
    end: date | None = None,
    start_price: float = 100.0,
    drift_annual: float = 0.08,
    vol_annual: float = 0.18,
) -> list[dict]:
    """Deterministic GBM path as [{date, value}], seeded off `symbol`.

    Symbol also nudges the drift/vol so different tickers look distinct but a
    given ticker is always identical.
    """
    n_days = max(2, int(n_days))
    end = end or date.today()
    seed = _seed_for(symbol)
    rng = np.random.default_rng(seed)

    # Symbol-dependent character so paths differ but stay deterministic.
    drift = drift_annual + ((seed % 7) - 3) * 0.015
    vol = vol_annual + ((seed % 5) * 0.02)

    dt = 1.0 / 252.0
    mu = (drift - 0.5 * vol * vol) * dt
    sigma = vol * np.sqrt(dt)
    shocks = rng.standard_normal(n_days - 1)
    log_rets = mu + sigma * shocks
    log_path = np.concatenate([[0.0], np.cumsum(log_rets)])
    prices = start_price * np.exp(log_path)

    dates = _trading_days(n_days, end)
    return [{"date": d, "value": round(float(v), 4)} for d, v in zip(dates, prices)]
