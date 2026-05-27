"""DB-backed multi-watchlist storage.

Sits alongside `watchlist.py` (the legacy JSON-file singleton). Downstream
panels (correlations, filings) still read `watchlist.load_watchlist()` for
backwards compat. This module powers the new multi-watchlist UI: users can
create named watchlists, add/remove tickers per list, mark one as default,
and downstream code can opt in to "active default" via `active_watchlist()`.

Schema lives in `db/schema.sql` — tables `watchlists` and `watchlist_items`.
"""
from __future__ import annotations

import logging
from typing import Optional

from ..db import engine as db_engine

log = logging.getLogger(__name__)


# ── Watchlists ──────────────────────────────────────────────────────────────

def list_watchlists() -> list[dict]:
    """All watchlists, ordered by name. Includes item counts."""
    rows = db_engine.fetchall(
        """
        SELECT w.id, w.name, w.description, w.is_default,
               w.created_at, w.updated_at,
               COALESCE(c.item_count, 0) AS item_count
        FROM watchlists w
        LEFT JOIN (
            SELECT watchlist_id, COUNT(*) AS item_count
            FROM watchlist_items
            GROUP BY watchlist_id
        ) c ON c.watchlist_id = w.id
        ORDER BY w.name ASC
        """,
    )
    return [
        {
            "id":          int(r[0]),
            "name":        r[1],
            "description": r[2],
            "is_default":  bool(r[3]),
            "created_at":  str(r[4]) if r[4] else None,
            "updated_at":  str(r[5]) if r[5] else None,
            "item_count":  int(r[6]),
        }
        for r in rows
    ]


def get_watchlist(watchlist_id: int) -> Optional[dict]:
    """Watchlist + items, ordered by order_index then ticker."""
    head = db_engine.fetchone(
        """
        SELECT id, name, description, is_default, created_at, updated_at
        FROM watchlists WHERE id = ?
        """,
        [watchlist_id],
    )
    if not head:
        return None
    items = db_engine.fetchall(
        """
        SELECT ticker, label, group_name, order_index, added_at
        FROM watchlist_items
        WHERE watchlist_id = ?
        ORDER BY order_index ASC, ticker ASC
        """,
        [watchlist_id],
    )
    return {
        "id":          int(head[0]),
        "name":        head[1],
        "description": head[2],
        "is_default":  bool(head[3]),
        "created_at":  str(head[4]) if head[4] else None,
        "updated_at":  str(head[5]) if head[5] else None,
        "items": [
            {
                "ticker":      i[0],
                "label":       i[1],
                "group_name":  i[2],
                "order_index": int(i[3]) if i[3] is not None else 0,
                "added_at":    str(i[4]) if i[4] else None,
            }
            for i in items
        ],
    }


def create_watchlist(name: str, description: str | None = None) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("name is required")
    with db_engine.conn() as c:
        r = c.execute(
            """
            INSERT INTO watchlists (name, description)
            VALUES (?, ?)
            RETURNING id
            """,
            [name, description],
        ).fetchone()
        new_id = int(r[0])
    return get_watchlist(new_id)  # type: ignore[return-value]


def update_watchlist(
    watchlist_id: int,
    *,
    name: str | None = None,
    description: str | None = None,
    is_default: bool | None = None,
) -> Optional[dict]:
    sets: list[str] = []
    params: list = []
    if name is not None:
        sets.append("name = ?")
        params.append(name.strip())
    if description is not None:
        sets.append("description = ?")
        params.append(description)
    if is_default is not None:
        if is_default:
            # Only one default. Clear others first.
            db_engine.execute("UPDATE watchlists SET is_default = false WHERE is_default = true")
        sets.append("is_default = ?")
        params.append(bool(is_default))
    if not sets:
        return get_watchlist(watchlist_id)
    sets.append("updated_at = now()")
    params.append(watchlist_id)
    db_engine.execute(
        f"UPDATE watchlists SET {', '.join(sets)} WHERE id = ?",
        params,
    )
    return get_watchlist(watchlist_id)


def delete_watchlist(watchlist_id: int) -> bool:
    db_engine.execute(
        "DELETE FROM watchlist_items WHERE watchlist_id = ?",
        [watchlist_id],
    )
    db_engine.execute(
        "DELETE FROM watchlists WHERE id = ?",
        [watchlist_id],
    )
    return True


# ── Items ───────────────────────────────────────────────────────────────────

def add_item(
    watchlist_id: int,
    ticker: str,
    *,
    label: str | None = None,
    group_name: str | None = None,
    order_index: int | None = None,
) -> dict:
    ticker = ticker.upper().strip()
    if not ticker:
        raise ValueError("ticker is required")
    if order_index is None:
        # Append: take max(order_index) + 1.
        row = db_engine.fetchone(
            "SELECT COALESCE(MAX(order_index), -1) + 1 FROM watchlist_items WHERE watchlist_id = ?",
            [watchlist_id],
        )
        order_index = int(row[0]) if row else 0
    db_engine.execute(
        """
        INSERT INTO watchlist_items (watchlist_id, ticker, label, group_name, order_index)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (watchlist_id, ticker) DO UPDATE SET
            label       = excluded.label,
            group_name  = excluded.group_name,
            order_index = excluded.order_index
        """,
        [watchlist_id, ticker, label, group_name, order_index],
    )
    return {
        "watchlist_id": watchlist_id,
        "ticker":       ticker,
        "label":        label,
        "group_name":   group_name,
        "order_index":  order_index,
    }


def remove_item(watchlist_id: int, ticker: str) -> bool:
    ticker = ticker.upper().strip()
    db_engine.execute(
        "DELETE FROM watchlist_items WHERE watchlist_id = ? AND ticker = ?",
        [watchlist_id, ticker],
    )
    return True


def reorder_items(watchlist_id: int, tickers_in_order: list[str]) -> bool:
    """Set order_index for each ticker by its position in the list."""
    for i, t in enumerate(tickers_in_order):
        db_engine.execute(
            "UPDATE watchlist_items SET order_index = ? WHERE watchlist_id = ? AND ticker = ?",
            [i, watchlist_id, t.upper().strip()],
        )
    return True


# ── Default-active helper for downstream callers ────────────────────────────

def active_watchlist() -> Optional[dict]:
    """The user-marked default watchlist, or None if none exists.

    Downstream panels that want the user's choice can call this; if it returns
    None they should fall back to `watchlist.load_watchlist()` (legacy JSON).
    """
    row = db_engine.fetchone(
        "SELECT id FROM watchlists WHERE is_default = true LIMIT 1",
    )
    return get_watchlist(int(row[0])) if row else None
