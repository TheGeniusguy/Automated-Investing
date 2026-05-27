"""Per (symbol, timeframe) chart layout persistence.

Stores the full state of the Technical Analysis panel so reopening the chart
restores it: enabled indicators, indicator params, chart type, scale type,
comparison symbol, drawing tool default, sub-pane order, etc.

State is a free-form JSON blob; the frontend defines the shape.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..db import engine as db_engine

log = logging.getLogger(__name__)


def get_layout(symbol: str, timeframe: str = "1d") -> Optional[dict]:
    row = db_engine.fetchone(
        "SELECT symbol, timeframe, state, updated_at FROM chart_layouts WHERE symbol = ? AND timeframe = ?",
        [symbol.upper().strip(), timeframe],
    )
    if not row:
        return None
    state = row[2] if isinstance(row[2], dict) else (json.loads(row[2]) if row[2] else {})
    return {
        "symbol":     row[0],
        "timeframe":  row[1],
        "state":      state,
        "updated_at": str(row[3]) if row[3] else None,
    }


def upsert_layout(symbol: str, timeframe: str, state: dict[str, Any]) -> dict:
    sym = symbol.upper().strip()
    db_engine.execute(
        """
        INSERT INTO chart_layouts (symbol, timeframe, state)
        VALUES (?, ?, ?)
        ON CONFLICT (symbol, timeframe) DO UPDATE SET
            state      = excluded.state,
            updated_at = now()
        """,
        [sym, timeframe, json.dumps(state)],
    )
    return get_layout(sym, timeframe)  # type: ignore[return-value]


def delete_layout(symbol: str, timeframe: str = "1d") -> bool:
    db_engine.execute(
        "DELETE FROM chart_layouts WHERE symbol = ? AND timeframe = ?",
        [symbol.upper().strip(), timeframe],
    )
    return True
