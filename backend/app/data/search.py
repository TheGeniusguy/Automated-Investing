"""Unified search — powers the command palette.

Merges two universes into one ranked result list:
  - DuckDB `instruments` table (symbol / name matches)
  - The curated FRED series catalog (id / label matches)

Ranking favors exact symbol/id matches, then prefix matches, then
substring matches. Never raises — returns empty results on any failure
(graceful-degradation contract; the palette must always render).
"""
from __future__ import annotations

import logging

from ..db import engine as db_engine
from . import fred_catalog

log = logging.getLogger(__name__)


def _rank(q: str, key: str, label: str | None) -> int:
    """Lower is better. 0 = exact key, 1 = prefix key, 2 = substring key,
    3 = label match only."""
    k = key.lower()
    if k == q:
        return 0
    if k.startswith(q):
        return 1
    if q in k:
        return 2
    if label and q in label.lower():
        return 3
    return 4


def _search_instruments(q: str, limit: int) -> list[dict]:
    like = f"%{q}%"
    try:
        rows = db_engine.fetchall(
            """
            SELECT symbol, name, type
            FROM instruments
            WHERE lower(symbol) LIKE ? OR lower(name) LIKE ?
            ORDER BY
                CASE WHEN lower(symbol) = ? THEN 0
                     WHEN lower(symbol) LIKE ? THEN 1
                     ELSE 2 END,
                symbol
            LIMIT ?
            """,
            [like, like, q, q + "%", limit],
        )
    except Exception as e:
        log.warning("search instruments query failed: %s", e)
        return []

    out: list[dict] = []
    for symbol, name, typ in rows:
        out.append({
            "type":     "ticker",
            "key":      symbol,
            "label":    symbol,
            "sublabel": name or (typ or None),
            "_rank":    _rank(q, symbol, name),
        })
    return out


def _search_series(q: str, limit: int) -> list[dict]:
    out: list[dict] = []
    try:
        for s in fred_catalog.all_series():
            if q in s.id.lower() or q in s.label.lower():
                out.append({
                    "type":     "series",
                    "key":      s.id,
                    "label":    s.id,
                    "sublabel": s.label or None,
                    "_rank":    _rank(q, s.id, s.label),
                })
                if len(out) >= limit:
                    break
    except Exception as e:
        log.warning("search series scan failed: %s", e)
        return out
    return out


def search(q: str, limit: int = 20) -> dict:
    """Return a merged, ranked result list of tickers + FRED series."""
    q = (q or "").strip().lower()
    if not q:
        return {"results": []}

    try:
        merged = _search_instruments(q, limit) + _search_series(q, limit)
        # Stable sort: rank asc, then key asc.
        merged.sort(key=lambda r: (r["_rank"], r["key"]))
        results = [
            {k: v for k, v in r.items() if k != "_rank"}
            for r in merged[:limit]
        ]
        return {"results": results}
    except Exception as e:
        log.warning("search(%s) failed: %s", q, e)
        return {"results": []}
