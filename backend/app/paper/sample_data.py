"""Sample data for the paper trading surface.

Used to SEED a populated "Demo Book" on first use and as the graceful-degradation
fallback whenever live prices or the DuckDB store are unavailable. All hardcoded
values live here under clearly-named SAMPLE_* constants so the engine code stays
honest about what is real and what is filled in.

Nothing here renders a "sample" badge in the UI - the data_mode field on every
payload is the honest signal for debugging.
"""
from __future__ import annotations

# Default paper book seeded on first read so screenshots are fully populated.
SAMPLE_PORTFOLIO_NAME = "Demo Book"
SAMPLE_STARTING_CASH = 100_000.0

# ~8 realistic filled orders. `price` is the clean base (pre-slippage) entry; the
# engine applies the commission + slippage model on top when seeding so the
# execution analytics card has real numbers. Two sells are included so win_rate
# and realized P&L are meaningful out of the box.
SAMPLE_DEMO_ORDERS: list[dict] = [
    {"symbol": "AAPL",  "side": "buy",  "quantity": 60,  "price": 212.40, "trade_date": "2026-01-15"},
    {"symbol": "MSFT",  "side": "buy",  "quantity": 25,  "price": 415.20, "trade_date": "2026-01-22"},
    {"symbol": "NVDA",  "side": "buy",  "quantity": 120, "price": 118.50, "trade_date": "2026-02-10"},
    {"symbol": "SPY",   "side": "buy",  "quantity": 20,  "price": 588.30, "trade_date": "2026-02-18"},
    {"symbol": "AMZN",  "side": "buy",  "quantity": 40,  "price": 195.60, "trade_date": "2026-03-05"},
    {"symbol": "GOOGL", "side": "buy",  "quantity": 50,  "price": 168.40, "trade_date": "2026-03-20"},
    {"symbol": "NVDA",  "side": "sell", "quantity": 40,  "price": 138.90, "trade_date": "2026-04-15"},
    {"symbol": "META",  "side": "buy",  "quantity": 12,  "price": 612.10, "trade_date": "2026-05-02"},
    {"symbol": "AAPL",  "side": "sell", "quantity": 20,  "price": 205.30, "trade_date": "2026-05-20"},
]

# Current marks used when fetch_arbitrary_ticker returns nothing (no network /
# rate-limited). Keyed by symbol -> last close. Chosen so the seeded book shows a
# realistic blend of winners and one trimmed loser.
SAMPLE_PRICES: dict[str, float] = {
    "AAPL":  219.80,
    "MSFT":  438.60,
    "NVDA":  142.30,
    "SPY":   601.20,
    "AMZN":  207.40,
    "GOOGL": 181.90,
    "META":  638.50,
    "IWM":   228.40,
    "QQQ":   534.70,
    "DIA":   441.30,
    "TSLA":  286.50,
    "GLD":   312.80,
    "TLT":    88.90,
}

# Last-resort mark when a symbol is unknown to SAMPLE_PRICES and no live quote
# is available - keeps the engine from ever dividing by None.
SAMPLE_FALLBACK_PRICE = 100.0


def sample_price(symbol: str) -> float:
    """Return a deterministic sample mark for a symbol. Never raises."""
    return SAMPLE_PRICES.get((symbol or "").upper(), SAMPLE_FALLBACK_PRICE)
