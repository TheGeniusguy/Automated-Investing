"""Paper trading portfolio surface (IB-light).

Self-contained DuckDB-backed paper books. The order log is the source of truth;
positions are always DERIVED via app.portfolio.positions.compute_positions and
never stored. Live fills go through app.data.macro_data.fetch_arbitrary_ticker
with a deterministic sample-price fallback. Every payload carries
data_mode/as_of/source and no public function ever raises - it degrades to
sample data instead.
"""
from __future__ import annotations

from .engine import (
    create_paper_portfolio,
    get_paper_overview,
    list_paper_portfolios,
    place_paper_order,
    reset_paper_portfolio,
)

__all__ = [
    "list_paper_portfolios",
    "create_paper_portfolio",
    "place_paper_order",
    "get_paper_overview",
    "reset_paper_portfolio",
]
