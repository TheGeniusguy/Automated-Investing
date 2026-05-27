"""Tax lots, realized gains, wash-sale flagging, and tax-loss-harvest candidates.

Mirrors the FIFO + commission convention used by ``positions.compute_positions``:
- A buy's commission is pro-rated into its per-share cost basis.
- A sell's commission reduces realized P&L once; here we pro-rate that single
  sell commission across the quantity it closed so the per-lot proceeds sum back
  to the sell's net proceeds.

Wash-sale handling is a SIMPLIFIED FLAG, not a full IRS basis re-allocation: a
realized loss is flagged when the same symbol was bought within 30 calendar days
before or after the sale. The disallowed amount shown is the full lot loss; we do
not roll it into the replacement lot's basis.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date


def _to_date(s: str) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def realized_lots(transactions: list[dict]) -> list[dict]:
    """Replay FIFO and emit one record per closed lot quantity.

    Each record: {symbol, quantity, open_date, close_date, proceeds, cost_basis,
    gain, term ("short"|"long"), holding_days}. Proceeds are net of the pro-rated
    sell commission; cost_basis includes the pro-rated buy commission.
    """
    txns = sorted(
        transactions,
        key=lambda t: (str(t.get("trade_date") or ""), t.get("id") or 0),
    )
    # FIFO open-lot queue per symbol: each lot is a mutable dict.
    open_lots: dict[str, list[dict]] = defaultdict(list)
    closed: list[dict] = []

    for t in txns:
        ttype = t.get("trade_type")
        symbol = str(t.get("symbol", "")).upper()
        qty = float(t.get("quantity") or 0.0)
        price = float(t.get("price") or 0.0)
        commission = float(t.get("commission") or 0.0)

        if ttype == "buy":
            cost_per_share = price + (commission / qty if qty > 0 else 0.0)
            open_lots[symbol].append({
                "quantity": qty,
                "cost_per_share": cost_per_share,
                "open_date": str(t.get("trade_date") or ""),
            })
        elif ttype == "sell":
            remaining = qty
            # Pro-rate the single sell commission across the quantity sold.
            comm_per_share = (commission / qty) if qty > 0 else 0.0
            close_date = str(t.get("trade_date") or "")
            while remaining > 1e-12 and open_lots[symbol]:
                lot = open_lots[symbol][0]
                take = min(lot["quantity"], remaining)
                proceeds = take * (price - comm_per_share)
                cost_basis = take * lot["cost_per_share"]
                od = _to_date(lot["open_date"])
                cd = _to_date(close_date)
                holding_days = (cd - od).days if od and cd else None
                term = "long" if (holding_days is not None and holding_days > 365) else "short"
                closed.append({
                    "symbol": symbol,
                    "quantity": round(take, 6),
                    "open_date": lot["open_date"],
                    "close_date": close_date,
                    "proceeds": round(proceeds, 2),
                    "cost_basis": round(cost_basis, 2),
                    "gain": round(proceeds - cost_basis, 2),
                    "term": term,
                    "holding_days": holding_days,
                })
                lot["quantity"] -= take
                remaining -= take
                if lot["quantity"] <= 1e-12:
                    open_lots[symbol].pop(0)
    return closed


def _wash_sale_flags(transactions: list[dict], closed: list[dict]) -> list[dict]:
    """Flag a realized loss when a REPLACEMENT purchase of the same symbol occurs
    within +/-30 calendar days of the sale.

    A "replacement" is any same-symbol buy in the window other than the closed
    lot's own opening purchase — so closing a position you opened <30 days ago is
    not self-flagged, but buying back in (before or after the sale) is. Earliest
    qualifying replacement is reported.
    """
    buys_by_symbol: dict[str, list[date]] = defaultdict(list)
    for t in transactions:
        if t.get("trade_type") == "buy":
            d = _to_date(t.get("trade_date"))
            if d:
                buys_by_symbol[str(t.get("symbol", "")).upper()].append(d)

    flags: list[dict] = []
    for lot in closed:
        if lot["gain"] >= 0:
            continue
        cd = _to_date(lot["close_date"])
        own_open = _to_date(lot["open_date"])
        if not cd:
            continue
        candidates = sorted(
            bd for bd in buys_by_symbol.get(lot["symbol"], [])
            if bd != own_open and abs((bd - cd).days) <= 30
        )
        if candidates:
            flags.append({
                "symbol": lot["symbol"],
                "close_date": lot["close_date"],
                "loss": lot["gain"],
                "repurchase_date": candidates[0].isoformat(),
                "disallowed": True,
            })
    return flags


def tax_summary(transactions: list[dict], year: int | None = None) -> dict:
    """Realized-gain summary, optionally filtered to a calendar year."""
    closed = realized_lots(transactions)
    if year is not None:
        closed = [c for c in closed if str(c["close_date"])[:4] == str(year)]

    short_term = round(sum(c["gain"] for c in closed if c["term"] == "short"), 2)
    long_term = round(sum(c["gain"] for c in closed if c["term"] == "long"), 2)
    flags = _wash_sale_flags(transactions, closed)

    return {
        "year": year,
        "short_term_gain": short_term,
        "long_term_gain": long_term,
        "total_realized": round(short_term + long_term, 2),
        "lot_count": len(closed),
        "wash_sale_flags": flags,
        "lots": closed,
    }


def tlh_candidates(enriched_positions: list[dict]) -> list[dict]:
    """Open positions with an unrealized loss, largest loss first."""
    out = [
        {
            "symbol": p.get("symbol"),
            "unrealized_pl": p.get("unrealized_pl"),
            "unrealized_pl_pct": p.get("unrealized_pl_pct"),
            "market_value": p.get("market_value"),
        }
        for p in enriched_positions
        if (p.get("unrealized_pl") or 0.0) < 0
    ]
    out.sort(key=lambda r: (r["unrealized_pl"] if r["unrealized_pl"] is not None else 0.0))
    return out
