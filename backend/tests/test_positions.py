"""FIFO lot-tracking invariants for app.portfolio.positions.compute_positions.

These are exact-value tests — the math is pure and deterministic.
"""
from __future__ import annotations

import math

from app.portfolio.positions import compute_positions


def _pos_by_symbol(positions):
    return {p.symbol: p for p in positions}


def test_single_buy_opens_lot(txn):
    txns = [txn("AAPL", "buy", 10, 100.0, "2024-01-02")]
    positions, realized, cash_delta = compute_positions(txns)
    p = _pos_by_symbol(positions)["AAPL"]
    assert p.shares == 10
    assert p.avg_cost == 100.0
    assert p.total_cost == 1000.0
    assert realized == 0.0
    assert cash_delta == -1000.0
    assert len(p.lots) == 1


def test_buy_commission_prorated_into_cost(txn):
    # commission of $10 over 10 shares => +$1/share cost basis
    txns = [txn("AAPL", "buy", 10, 100.0, "2024-01-02", commission=10.0)]
    positions, realized, cash_delta = compute_positions(txns)
    p = _pos_by_symbol(positions)["AAPL"]
    assert p.avg_cost == 101.0
    assert p.total_cost == 1010.0
    # cash out = qty*price + commission
    assert cash_delta == -(10 * 100.0 + 10.0)


def test_fifo_full_lot_consumption(txn):
    txns = [
        txn("AAPL", "buy", 10, 100.0, "2024-01-02"),  # lot A @100
        txn("AAPL", "buy", 10, 110.0, "2024-01-03"),  # lot B @110
        txn("AAPL", "sell", 10, 120.0, "2024-01-04"),  # consumes lot A fully
    ]
    positions, realized, cash_delta = compute_positions(txns)
    p = _pos_by_symbol(positions)["AAPL"]
    # Lot A (oldest, $100) sold at $120 => $20/share * 10 = $200 realized
    assert realized == 200.0
    assert p.realized_pl == 200.0
    # remaining is lot B only
    assert p.shares == 10
    assert p.avg_cost == 110.0
    assert len(p.lots) == 1
    assert p.lots[0].cost_per_share == 110.0
    # cash: -1000 -1100 +1200 = -900
    assert cash_delta == -900.0


def test_fifo_partial_lot_consumption(txn):
    txns = [
        txn("MSFT", "buy", 10, 200.0, "2024-02-01"),
        txn("MSFT", "sell", 4, 250.0, "2024-02-05"),  # partial of the single lot
    ]
    positions, realized, _ = compute_positions(txns)
    p = _pos_by_symbol(positions)["MSFT"]
    assert realized == (250.0 - 200.0) * 4  # 200
    assert p.shares == 6
    assert p.lots[0].quantity == 6
    assert p.avg_cost == 200.0


def test_fifo_spans_multiple_lots(txn):
    txns = [
        txn("X", "buy", 5, 10.0, "2024-01-01"),
        txn("X", "buy", 5, 20.0, "2024-01-02"),
        txn("X", "sell", 7, 30.0, "2024-01-03"),  # all of lot1 + 2 of lot2
    ]
    positions, realized, _ = compute_positions(txns)
    p = _pos_by_symbol(positions)["X"]
    # lot1: (30-10)*5 = 100 ; lot2 partial: (30-20)*2 = 20 => 120
    assert realized == 120.0
    assert p.shares == 3
    assert p.lots[0].cost_per_share == 20.0
    assert p.lots[0].quantity == 3


def test_commission_deducted_once_from_gross_on_sell(txn):
    # Two lots consumed by one sell with a single commission — commission must
    # be subtracted exactly once from the gross, not per lot.
    txns = [
        txn("C", "buy", 5, 10.0, "2024-01-01"),
        txn("C", "buy", 5, 10.0, "2024-01-02"),
        txn("C", "sell", 10, 15.0, "2024-01-03", commission=7.0),
    ]
    _, realized, _ = compute_positions(txns)
    gross = (15.0 - 10.0) * 10  # 50 across both lots
    assert realized == gross - 7.0  # 43.0, commission once


def test_full_exit_leaves_no_position(txn):
    txns = [
        txn("Z", "buy", 10, 50.0, "2024-01-01"),
        txn("Z", "sell", 10, 60.0, "2024-01-02"),
    ]
    positions, realized, cash_delta = compute_positions(txns)
    assert _pos_by_symbol(positions).get("Z") is None  # no open lots
    assert realized == 100.0
    assert cash_delta == (-500.0 + 600.0)


def test_dividend_deposit_withdrawal_cash_only(txn):
    txns = [
        txn("CASH", "deposit", 1, 1000.0, "2024-01-01"),
        txn("AAA", "dividend", 1, 25.0, "2024-01-15"),
        txn("CASH", "withdrawal", 1, 200.0, "2024-02-01"),
    ]
    positions, realized, cash_delta = compute_positions(txns)
    assert positions == []  # no equity lots opened
    assert realized == 0.0
    assert cash_delta == 1000.0 + 25.0 - 200.0


def test_chronological_ordering_independent_of_input_order(txn):
    # Build out-of-order; compute_positions sorts by (trade_date, id).
    later_sell = txn("AAPL", "sell", 10, 120.0, "2024-01-04")
    early_buy = txn("AAPL", "buy", 10, 100.0, "2024-01-02")
    out_of_order = [later_sell, early_buy]
    _, realized, _ = compute_positions(out_of_order)
    assert realized == 200.0


def test_avg_cost_weighted_across_remaining_lots(txn):
    txns = [
        txn("W", "buy", 10, 100.0, "2024-01-01"),
        txn("W", "buy", 30, 200.0, "2024-01-02"),
    ]
    positions, _, _ = compute_positions(txns)
    p = _pos_by_symbol(positions)["W"]
    expected_avg = (10 * 100.0 + 30 * 200.0) / 40
    assert math.isclose(p.avg_cost, expected_avg)
    assert p.shares == 40
