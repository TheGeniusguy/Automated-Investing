"""User-defined macro pinboards — Wave 5.

A "board" is a named collection of FRED series IDs the user wants to
track on a single screen. Persisted to DuckDB so dashboards survive
restarts.

Schema is created in db/schema.sql.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

from ..db import engine

log = logging.getLogger(__name__)


def list_boards() -> list[dict]:
    rows = engine.fetchall(
        "SELECT id, name, description, series_ids, created_at, updated_at FROM macro_boards ORDER BY id",
    )
    return [_row_to_dict(r) for r in rows]


def get_board(board_id: int) -> dict | None:
    rows = engine.fetchall(
        "SELECT id, name, description, series_ids, created_at, updated_at FROM macro_boards WHERE id = ?",
        [board_id],
    )
    if not rows:
        return None
    return _row_to_dict(rows[0])


def create_board(name: str, *, description: str | None = None, series_ids: list[str] | None = None) -> dict:
    sids = series_ids or []
    with engine.conn() as c:
        c.execute(
            """
            INSERT INTO macro_boards (name, description, series_ids, created_at, updated_at)
            VALUES (?, ?, ?, now(), now())
            """,
            [name, description, json.dumps(sids)],
        )
        rows = c.execute(
            "SELECT id, name, description, series_ids, created_at, updated_at FROM macro_boards WHERE name = ? ORDER BY id DESC LIMIT 1",
            [name],
        ).fetchall()
    return _row_to_dict(rows[0])


def update_board(board_id: int, *,
                 name: str | None = None,
                 description: str | None = None,
                 series_ids: list[str] | None = None) -> dict | None:
    existing = get_board(board_id)
    if not existing:
        return None
    new_name = name if name is not None else existing["name"]
    new_desc = description if description is not None else existing["description"]
    new_sids = series_ids if series_ids is not None else existing["series_ids"]

    with engine.conn() as c:
        c.execute(
            """
            UPDATE macro_boards
            SET name = ?, description = ?, series_ids = ?, updated_at = now()
            WHERE id = ?
            """,
            [new_name, new_desc, json.dumps(new_sids), board_id],
        )
    return get_board(board_id)


def delete_board(board_id: int) -> bool:
    existing = get_board(board_id)
    if not existing:
        return False
    with engine.conn() as c:
        c.execute("DELETE FROM macro_boards WHERE id = ?", [board_id])
    return True


def _row_to_dict(row) -> dict:
    sids = row[3]
    if isinstance(sids, str):
        try:
            sids = json.loads(sids)
        except Exception:
            sids = []
    return {
        "id":          row[0],
        "name":        row[1],
        "description": row[2],
        "series_ids":  sids or [],
        "created_at":  str(row[4]) if row[4] else None,
        "updated_at":  str(row[5]) if row[5] else None,
    }
