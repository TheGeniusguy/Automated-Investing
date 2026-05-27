"""Chart drawings CRUD — TradingView-style annotations persisted to DuckDB.

Drawing types:
  trend_line       — 2 points; freeform line on the chart.
  hline            — 1 point; horizontal line at a price level.
  vline            — 1 point; vertical line at a date.
  fib_retracement  — 2 points (high & low anchor); frontend renders
                     standard ratios (0, 23.6, 38.2, 50, 61.8, 78.6, 100).
  rectangle        — 2 points (opposite corners).
  text             — 1 point; anchor for a label.

Points are stored as `[{time: ISO-8601 string, price: number}, ...]`. Style
is a free-form JSON blob the frontend interprets (color, line_width, etc.).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from ..db import engine as db_engine

log = logging.getLogger(__name__)

ALLOWED_TYPES = {
    "trend_line", "hline", "vline", "fib_retracement", "rectangle", "text",
    "parallel_channel", "fib_extension", "fib_time_zones",
    "risk_reward", "arrow", "anchored_vwap_anchor",
}


def list_drawings(symbol: str, timeframe: str = "1d") -> list[dict]:
    rows = db_engine.fetchall(
        """
        SELECT id, symbol, timeframe, drawing_type, points, style, label,
               created_at, updated_at
        FROM chart_drawings
        WHERE symbol = ? AND timeframe = ?
        ORDER BY id ASC
        """,
        [symbol.upper().strip(), timeframe],
    )
    return [_row_to_dict(r) for r in rows]


def get_drawing(drawing_id: int) -> Optional[dict]:
    row = db_engine.fetchone(
        """
        SELECT id, symbol, timeframe, drawing_type, points, style, label,
               created_at, updated_at
        FROM chart_drawings
        WHERE id = ?
        """,
        [drawing_id],
    )
    return _row_to_dict(row) if row else None


def create_drawing(
    symbol: str,
    drawing_type: str,
    points: list[dict],
    *,
    timeframe: str = "1d",
    style: Optional[dict] = None,
    label: Optional[str] = None,
) -> dict:
    if drawing_type not in ALLOWED_TYPES:
        raise ValueError(f"unknown drawing_type: {drawing_type}")
    _validate_points(drawing_type, points)
    with db_engine.conn() as c:
        r = c.execute(
            """
            INSERT INTO chart_drawings (symbol, timeframe, drawing_type, points, style, label)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            [
                symbol.upper().strip(),
                timeframe,
                drawing_type,
                json.dumps(points),
                json.dumps(style or {}),
                label,
            ],
        ).fetchone()
        new_id = int(r[0])
    return get_drawing(new_id)  # type: ignore[return-value]


def update_drawing(
    drawing_id: int,
    *,
    points: Optional[list[dict]] = None,
    style: Optional[dict] = None,
    label: Optional[str] = None,
) -> Optional[dict]:
    existing = get_drawing(drawing_id)
    if not existing:
        return None
    sets: list[str] = []
    params: list[Any] = []
    if points is not None:
        _validate_points(existing["drawing_type"], points)
        sets.append("points = ?")
        params.append(json.dumps(points))
    if style is not None:
        sets.append("style = ?")
        params.append(json.dumps(style))
    if label is not None:
        sets.append("label = ?")
        params.append(label)
    if not sets:
        return existing
    sets.append("updated_at = now()")
    params.append(drawing_id)
    db_engine.execute(
        f"UPDATE chart_drawings SET {', '.join(sets)} WHERE id = ?",
        params,
    )
    return get_drawing(drawing_id)


def delete_drawing(drawing_id: int) -> bool:
    db_engine.execute("DELETE FROM chart_drawings WHERE id = ?", [drawing_id])
    return True


def clear_drawings(symbol: str, timeframe: str = "1d") -> int:
    """Delete all drawings for a symbol+timeframe. Returns deleted count
    (best-effort; DuckDB's rowcount can be flaky)."""
    rows_before = db_engine.fetchone(
        "SELECT COUNT(*) FROM chart_drawings WHERE symbol = ? AND timeframe = ?",
        [symbol.upper().strip(), timeframe],
    )
    db_engine.execute(
        "DELETE FROM chart_drawings WHERE symbol = ? AND timeframe = ?",
        [symbol.upper().strip(), timeframe],
    )
    return int(rows_before[0]) if rows_before else 0


# ─── Internals ─────────────────────────────────────────────────────────────

def _row_to_dict(r: tuple) -> dict:
    if r is None:
        return {}
    points = r[4] if isinstance(r[4], list) else json.loads(r[4]) if r[4] else []
    style  = r[5] if isinstance(r[5], dict) else (json.loads(r[5]) if r[5] else {})
    return {
        "id":           int(r[0]),
        "symbol":       r[1],
        "timeframe":    r[2],
        "drawing_type": r[3],
        "points":       points,
        "style":        style,
        "label":        r[6],
        "created_at":   str(r[7]) if r[7] else None,
        "updated_at":   str(r[8]) if r[8] else None,
    }


def _validate_points(drawing_type: str, points: list[dict]) -> None:
    if not isinstance(points, list) or not points:
        raise ValueError("points must be a non-empty list")
    expected = {
        "trend_line":            2,
        "hline":                 1,
        "vline":                 1,
        "fib_retracement":       2,
        "rectangle":             2,
        "text":                  1,
        "parallel_channel":      3,   # 2 trend-line anchors + 1 offset
        "fib_extension":         3,   # A (origin) + B (top) + C (retracement)
        "fib_time_zones":        2,   # 2 anchor points for spacing
        "risk_reward":           3,   # entry, stop, target
        "arrow":                 2,   # start, end
        "anchored_vwap_anchor":  1,   # single anchor; backend recomputes VWAP from this bar
    }
    need = expected[drawing_type]
    if len(points) != need:
        raise ValueError(f"{drawing_type} requires exactly {need} point(s); got {len(points)}")
    for p in points:
        if "time" not in p or "price" not in p:
            raise ValueError("each point must have 'time' and 'price'")
