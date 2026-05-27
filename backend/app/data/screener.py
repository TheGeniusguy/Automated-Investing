"""Stock screener — DuckDB queries over instruments + fundamentals + prices.

SQL-injection safety: filter dimensions are a fixed whitelist. User-supplied
values flow through DuckDB parameterized queries. Sort keys are also
whitelisted. We never string-interpolate user input into SQL.
"""
from __future__ import annotations

import logging
from typing import Any

from ..db import engine as db_engine

log = logging.getLogger(__name__)


# Whitelist of filterable columns. Each entry maps a stable filter `key` to:
#   - sql: the SQL expression to compare against (resolved against the
#     `screener_view` CTE in build_query)
#   - type: "number" or "text"
FILTERS: dict[str, dict] = {
    # Identity / classification
    "sector":           {"sql": "i.sector",           "type": "text"},
    "industry":         {"sql": "i.industry",         "type": "text"},
    "country":          {"sql": "i.country",          "type": "text"},
    "type":             {"sql": "i.type",             "type": "text"},
    # Price
    "last_close":       {"sql": "p.close",            "type": "number"},
    # Latest-quarter fundamentals
    "revenue":          {"sql": "f.revenue",          "type": "number"},
    "gross_profit":     {"sql": "f.gross_profit",     "type": "number"},
    "operating_income": {"sql": "f.operating_income", "type": "number"},
    "net_income":       {"sql": "f.net_income",       "type": "number"},
    "eps_diluted":      {"sql": "f.eps_diluted",      "type": "number"},
    "gross_margin":     {"sql": "f.gross_margin",     "type": "number"},
    "operating_margin": {"sql": "f.operating_margin", "type": "number"},
    "net_margin":       {"sql": "f.net_margin",       "type": "number"},
    "free_cash_flow":   {"sql": "f.free_cash_flow",   "type": "number"},
    "total_assets":     {"sql": "f.total_assets",     "type": "number"},
    "total_equity":     {"sql": "f.total_equity",     "type": "number"},
    "long_term_debt":   {"sql": "f.long_term_debt",   "type": "number"},
    # Derived
    "revenue_yoy_pct":  {"sql": "rev_yoy.yoy_pct",    "type": "number"},
}

# Allowed comparison operators per type.
TEXT_OPS   = {"eq", "neq", "in", "not_in", "contains"}
NUMBER_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "between"}

# Whitelist of sort keys (mapped to expressions in the SELECT).
SORT_KEYS = {
    "symbol":           "i.symbol",
    "name":             "i.name",
    "last_close":       "p.close",
    "revenue":          "f.revenue",
    "net_income":       "f.net_income",
    "eps_diluted":      "f.eps_diluted",
    "gross_margin":     "f.gross_margin",
    "operating_margin": "f.operating_margin",
    "net_margin":       "f.net_margin",
    "free_cash_flow":   "f.free_cash_flow",
    "revenue_yoy_pct":  "rev_yoy.yoy_pct",
}


def _build_predicate(spec: dict, params: list[Any]) -> str:
    """Translate one filter spec into a SQL predicate, appending bind params."""
    key   = spec.get("key")
    op    = (spec.get("op") or "eq").lower()
    value = spec.get("value")

    if key not in FILTERS:
        raise ValueError(f"unknown filter key: {key}")
    meta = FILTERS[key]
    col  = meta["sql"]

    if meta["type"] == "number":
        if op not in NUMBER_OPS:
            raise ValueError(f"op {op} not supported for number filter {key}")
        if op == "between":
            lo, hi = value if isinstance(value, (list, tuple)) and len(value) == 2 else (None, None)
            if lo is None or hi is None:
                raise ValueError(f"between filter {key} requires [min, max]")
            params.extend([float(lo), float(hi)])
            return f"{col} BETWEEN ? AND ?"
        params.append(float(value))
        sql_op = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
        return f"{col} {sql_op} ?"

    # text
    if op not in TEXT_OPS:
        raise ValueError(f"op {op} not supported for text filter {key}")
    if op in ("in", "not_in"):
        if not isinstance(value, (list, tuple)) or not value:
            raise ValueError(f"{op} filter {key} requires a non-empty list")
        placeholders = ",".join("?" for _ in value)
        params.extend([str(v) for v in value])
        prefix = "NOT " if op == "not_in" else ""
        return f"{prefix}{col} IN ({placeholders})"
    if op == "contains":
        params.append(f"%{value}%")
        return f"{col} ILIKE ?"
    # eq / neq
    sql_op = "=" if op == "eq" else "<>"
    params.append(str(value))
    return f"{col} {sql_op} ?"


def build_query(
    filters: list[dict],
    sort: str = "symbol",
    sort_dir: str = "asc",
    limit: int = 100,
    offset: int = 0,
) -> tuple[str, list[Any]]:
    """Construct the screener SQL + bind params.

    Result columns are stable: symbol, name, sector, industry, type, country,
    last_close, last_close_date, revenue, gross_margin, operating_margin,
    net_margin, eps_diluted, free_cash_flow, revenue_yoy_pct.
    """
    params: list[Any] = []
    where_parts: list[str] = []
    for f in (filters or []):
        where_parts.append(_build_predicate(f, params))
    where_clause = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""

    sort_col = SORT_KEYS.get(sort, "i.symbol")
    sort_dir = "DESC" if str(sort_dir).lower() == "desc" else "ASC"

    limit  = max(1, min(int(limit), 500))
    offset = max(0, int(offset))

    sql = f"""
    WITH latest_price AS (
        SELECT symbol, MAX(date) AS max_date
        FROM prices_daily
        GROUP BY symbol
    ),
    latest_fund AS (
        SELECT symbol, MAX(period_end) AS max_period
        FROM fundamentals_quarterly
        GROUP BY symbol
    ),
    -- YoY revenue: latest quarter vs. same quarter ~4 quarters prior.
    rev_yoy AS (
        SELECT f1.symbol,
               (f1.revenue - f2.revenue) / NULLIF(f2.revenue, 0) * 100.0 AS yoy_pct
        FROM fundamentals_quarterly f1
        JOIN latest_fund lf ON lf.symbol = f1.symbol AND lf.max_period = f1.period_end
        LEFT JOIN fundamentals_quarterly f2
            ON f2.symbol = f1.symbol
           AND f2.period_end = (
               SELECT MAX(period_end) FROM fundamentals_quarterly
               WHERE symbol = f1.symbol
                 AND period_end <= f1.period_end - INTERVAL '300 days'
                 AND period_end >  f1.period_end - INTERVAL '420 days'
           )
    )
    SELECT
        i.symbol,
        i.name,
        i.sector,
        i.industry,
        i.type,
        i.country,
        p.close            AS last_close,
        p.date             AS last_close_date,
        f.revenue,
        f.gross_margin,
        f.operating_margin,
        f.net_margin,
        f.eps_diluted,
        f.free_cash_flow,
        rev_yoy.yoy_pct    AS revenue_yoy_pct
    FROM instruments i
    LEFT JOIN latest_price lp ON lp.symbol = i.symbol
    LEFT JOIN prices_daily p  ON p.symbol = i.symbol AND p.date = lp.max_date
    LEFT JOIN latest_fund  lf ON lf.symbol = i.symbol
    LEFT JOIN fundamentals_quarterly f
        ON f.symbol = i.symbol AND f.period_end = lf.max_period
    LEFT JOIN rev_yoy ON rev_yoy.symbol = i.symbol
    {where_clause}
    ORDER BY {sort_col} {sort_dir} NULLS LAST, i.symbol ASC
    LIMIT {limit} OFFSET {offset}
    """
    return sql, params


def run(
    filters: list[dict] | None = None,
    sort: str = "symbol",
    sort_dir: str = "asc",
    limit: int = 100,
    offset: int = 0,
) -> dict:
    sql, params = build_query(filters or [], sort=sort, sort_dir=sort_dir, limit=limit, offset=offset)
    rows = db_engine.fetchall(sql, params)
    results = [
        {
            "symbol":           r[0],
            "name":             r[1],
            "sector":           r[2],
            "industry":         r[3],
            "type":             r[4],
            "country":          r[5],
            "last_close":       float(r[6]) if r[6] is not None else None,
            "last_close_date":  str(r[7]) if r[7] else None,
            "revenue":          float(r[8])  if r[8]  is not None else None,
            "gross_margin":     float(r[9])  if r[9]  is not None else None,
            "operating_margin": float(r[10]) if r[10] is not None else None,
            "net_margin":       float(r[11]) if r[11] is not None else None,
            "eps_diluted":      float(r[12]) if r[12] is not None else None,
            "free_cash_flow":   float(r[13]) if r[13] is not None else None,
            "revenue_yoy_pct":  float(r[14]) if r[14] is not None else None,
        }
        for r in rows
    ]
    return {
        "filters":  filters or [],
        "sort":     sort,
        "sort_dir": sort_dir,
        "limit":    limit,
        "offset":   offset,
        "count":    len(results),
        "results":  results,
    }


def schema() -> dict:
    """Metadata for the frontend filter builder (which keys + ops are valid)."""
    return {
        "filters": [
            {"key": k, "type": v["type"]}
            for k, v in FILTERS.items()
        ],
        "ops": {
            "number": sorted(NUMBER_OPS),
            "text":   sorted(TEXT_OPS),
        },
        "sort_keys": sorted(SORT_KEYS.keys()),
    }
