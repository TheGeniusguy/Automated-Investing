"""Broker-agnostic CSV import for portfolio transactions.

Maps common Schwab / Fidelity / IBKR export headers onto the canonical
transaction shape. Never raises — malformed rows are collected into ``errors``.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import datetime

# Canonical field -> set of accepted header aliases (lowercased, stripped).
_HEADER_ALIASES: dict[str, set[str]] = {
    "symbol": {"symbol", "ticker", "ticker symbol", "instrument"},
    "trade_type": {"action", "type", "transaction type", "activity", "buy/sell"},
    "quantity": {"quantity", "shares", "qty", "amount"},
    "price": {"price", "price (usd)", "trade price", "price per share", "unit price"},
    "commission": {"commission", "fees", "fees & comm", "commission/fees", "fees and commissions"},
    "trade_date": {"date", "trade date", "run date", "settlement date", "as of date"},
}

_BUY_WORDS = {"buy", "bought", "buy to open", "buy to close", "reinvestment", "purchase"}
_SELL_WORDS = {"sell", "sold", "sell to open", "sell to close", "sale"}
_DIV_WORDS = {"dividend", "qualified dividend", "div"}


def _normalize_header(h: str) -> str | None:
    key = (h or "").strip().lower()
    for canonical, aliases in _HEADER_ALIASES.items():
        if key in aliases:
            return canonical
    return None


def _normalize_trade_type(raw: str) -> str | None:
    v = (raw or "").strip().lower()
    if v in _BUY_WORDS or any(w in v for w in _BUY_WORDS):
        return "buy"
    if v in _SELL_WORDS or any(w in v for w in _SELL_WORDS):
        return "sell"
    if v in _DIV_WORDS or any(w in v for w in _DIV_WORDS):
        return "dividend"
    return None


def _parse_number(raw: str) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # Strip currency symbols, commas, and parentheses (accounting negatives).
    neg = s.startswith("(") and s.endswith(")")
    s = re.sub(r"[^0-9.\-]", "", s)
    if s in ("", "-", ".", "-."):
        return None
    try:
        val = float(s)
    except ValueError:
        return None
    return -val if neg else val


def _parse_date(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    # Some exports append a time or " as of ..."; take the leading token.
    s = s.split(" ")[0]
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_csv(text: str) -> dict:
    """Parse broker CSV text into canonical transaction rows + errors."""
    rows: list[dict] = []
    errors: list[str] = []

    if not text or not text.strip():
        return {"rows": [], "errors": ["empty input"], "detected_format": None}

    try:
        sample = text[:2048]
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = next(reader)
    except StopIteration:
        return {"rows": [], "errors": ["no header row"], "detected_format": None}

    col_map: dict[int, str] = {}
    for idx, h in enumerate(header):
        canonical = _normalize_header(h)
        if canonical:
            col_map[idx] = canonical

    matched = set(col_map.values())
    required = {"symbol", "trade_type", "quantity", "price"}
    missing = required - matched
    if missing:
        return {
            "rows": [],
            "errors": [f"missing required columns: {', '.join(sorted(missing))}"],
            "detected_format": None,
        }

    for line_no, raw_row in enumerate(reader, start=2):
        if not any(cell.strip() for cell in raw_row):
            continue
        rec: dict = {}
        for idx, canonical in col_map.items():
            if idx < len(raw_row):
                rec[canonical] = raw_row[idx]

        symbol = (rec.get("symbol") or "").strip().upper()
        trade_type = _normalize_trade_type(rec.get("trade_type", ""))
        qty = _parse_number(rec.get("quantity"))
        price = _parse_number(rec.get("price"))
        commission = _parse_number(rec.get("commission")) or 0.0
        trade_date = _parse_date(rec.get("trade_date")) if "trade_date" in rec else None

        if not symbol:
            errors.append(f"row {line_no}: missing symbol")
            continue
        if trade_type is None:
            errors.append(f"row {line_no}: unrecognized action '{rec.get('trade_type','')}'")
            continue
        if qty is None or price is None:
            errors.append(f"row {line_no}: missing/invalid quantity or price")
            continue

        rows.append({
            "symbol": symbol,
            "trade_date": trade_date or datetime.utcnow().date().isoformat(),
            "trade_type": trade_type,
            "quantity": abs(qty),
            "price": abs(price),
            "commission": abs(commission),
        })

    return {
        "rows": rows,
        "errors": errors,
        "detected_format": f"{len(matched)} columns mapped",
    }
