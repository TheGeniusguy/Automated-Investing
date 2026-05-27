"""FIFO lot tracking — compute current open positions from transaction history.

Buy transactions open lots. Sell transactions consume oldest lots first (FIFO),
generating realized P&L. The resulting open lots define the current portfolio.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field


@dataclass
class Lot:
    symbol: str
    quantity: float
    cost_per_share: float  # includes commission pro-rated per share
    trade_date: str
    trade_id: int


@dataclass
class Position:
    symbol: str
    shares: float = 0.0
    avg_cost: float = 0.0       # weighted average cost per share
    total_cost: float = 0.0     # shares * avg_cost
    lots: list[Lot] = field(default_factory=list)
    realized_pl: float = 0.0    # cumulative realized P&L from sells


def compute_positions(
    transactions: list[dict],
) -> tuple[list[Position], float, float]:
    """
    Process all transactions in chronological order (FIFO lot matching).

    Returns:
        open_positions  — list of Position with open lots
        total_realized  — total realized P&L across all symbols
        cash_delta      — net cash change from all buy/sell/dividend transactions
                          (add to portfolio.cash_balance to get current cash)
    """
    sorted_txns = sorted(
        transactions,
        key=lambda t: (t.get("trade_date") or "", t.get("id") or 0),
    )

    # Per-symbol lot queues (FIFO order)
    lots: dict[str, list[Lot]] = defaultdict(list)
    realized_pl: dict[str, float] = defaultdict(float)
    cash_delta = 0.0

    for txn in sorted_txns:
        symbol    = txn["symbol"].upper()
        ttype     = txn["trade_type"]
        quantity  = float(txn["quantity"])
        price     = float(txn["price"])
        commission = float(txn.get("commission") or 0.0)

        if ttype == "buy":
            cost_per_share = price + (commission / quantity if quantity > 0 else 0.0)
            lots[symbol].append(Lot(
                symbol=symbol,
                quantity=quantity,
                cost_per_share=cost_per_share,
                trade_date=str(txn.get("trade_date", "")),
                trade_id=txn.get("id", 0),
            ))
            cash_delta -= quantity * price + commission

        elif ttype == "sell":
            remaining = quantity
            gross_realized = 0.0
            while remaining > 0 and lots[symbol]:
                oldest = lots[symbol][0]
                if oldest.quantity <= remaining:
                    gross_realized += (price - oldest.cost_per_share) * oldest.quantity
                    remaining -= oldest.quantity
                    lots[symbol].pop(0)
                else:
                    gross_realized += (price - oldest.cost_per_share) * remaining
                    oldest.quantity -= remaining
                    remaining = 0

            if remaining > 0:
                import logging as _log
                _log.getLogger(__name__).warning(
                    "Oversell on %s: %.4f shares not covered by open lots", symbol, remaining
                )

            realized_pl[symbol] += gross_realized - commission
            cash_delta += quantity * price - commission

        elif ttype == "dividend":
            cash_delta += quantity * price  # quantity=amount, price=1 or vice-versa

        elif ttype == "deposit":
            cash_delta += quantity * price

        elif ttype == "withdrawal":
            cash_delta -= quantity * price

    # Build Position objects from remaining lots
    positions: list[Position] = []
    for symbol, sym_lots in lots.items():
        open_lots = [lot for lot in sym_lots if lot.quantity > 0]
        if not open_lots:
            continue
        total_shares = sum(lot.quantity for lot in open_lots)
        if total_shares <= 0:
            continue
        total_cost = sum(lot.quantity * lot.cost_per_share for lot in open_lots)
        avg_cost = total_cost / total_shares
        positions.append(Position(
            symbol=symbol,
            shares=total_shares,
            avg_cost=avg_cost,
            total_cost=total_cost,
            lots=open_lots,
            realized_pl=realized_pl.get(symbol, 0.0),
        ))

    total_realized = sum(realized_pl.values())
    return positions, total_realized, cash_delta


def holdings_at_date(
    transactions: list[dict],
    as_of: str,  # YYYY-MM-DD inclusive
) -> dict[str, float]:
    """Return {symbol: shares} as of `as_of` date (for equity curve building)."""
    sorted_txns = sorted(
        [t for t in transactions if (t.get("trade_date") or "") <= as_of],
        key=lambda t: (t.get("trade_date") or "", t.get("id") or 0),
    )
    positions, _, _ = compute_positions(sorted_txns)
    return {p.symbol: p.shares for p in positions}


def cash_at_date(
    initial_cash: float,
    transactions: list[dict],
    as_of: str,
) -> float:
    """Return cash balance as of `as_of` date."""
    sorted_txns = [t for t in transactions if (t.get("trade_date") or "") <= as_of]
    _, _, cash_delta = compute_positions(sorted_txns)
    return initial_cash + cash_delta
