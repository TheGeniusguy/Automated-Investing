"""Strategy backtester package (Bloomberg BT analog).

Public surface:
- `run_backtest(symbol, strategy, params, start, end, capital=100000) -> dict`
- `list_strategies() -> list[dict]`  (catalog with param schemas + defaults)

Never raises. When live prices are unavailable, falls back to a deterministic
sample price path so panels are always populated. Every payload carries
`data_mode` / `as_of` / `source`.
"""
from __future__ import annotations

from .engine import run_backtest
from .strategies import list_strategies

__all__ = ["run_backtest", "list_strategies"]
