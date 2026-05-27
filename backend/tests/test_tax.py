"""Tax-lot, realized-gain, and wash-sale invariants for app.portfolio.tax."""
from __future__ import annotations

from app.portfolio import tax


def test_short_vs_long_term_classification(txn):
    txns = [
        txn("X", "buy", 10, 100.0, "2023-01-02"),
        txn("X", "sell", 10, 120.0, "2023-06-01"),   # ~150d held -> short
        txn("Y", "buy", 10, 50.0, "2022-01-03"),
        txn("Y", "sell", 10, 70.0, "2023-06-01"),    # >365d held -> long
    ]
    lots = tax.realized_lots(txns)
    by_symbol = {l["symbol"]: l for l in lots}
    assert by_symbol["X"]["term"] == "short"
    assert by_symbol["X"]["gain"] == 200.0
    assert by_symbol["Y"]["term"] == "long"
    assert by_symbol["Y"]["gain"] == 200.0
    assert by_symbol["Y"]["holding_days"] > 365


def test_commission_convention_matches_positions(txn):
    # buy comm pro-rated into basis (11/sh); sell comm reduces proceeds once.
    txns = [
        txn("Z", "buy", 10, 10.0, "2023-01-02", commission=10.0),
        txn("Z", "sell", 10, 15.0, "2023-03-02", commission=5.0),
    ]
    lots = tax.realized_lots(txns)
    assert len(lots) == 1
    lot = lots[0]
    assert lot["cost_basis"] == 110.0          # 10 * 11
    assert lot["proceeds"] == 145.0            # 10 * (15 - 0.5)
    assert lot["gain"] == 35.0                 # gross 40 minus 5 commission, once


def test_fifo_split_across_two_buys(txn):
    txns = [
        txn("A", "buy", 5, 10.0, "2023-01-02"),
        txn("A", "buy", 5, 20.0, "2023-02-02"),
        txn("A", "sell", 7, 30.0, "2023-03-02"),
    ]
    lots = tax.realized_lots(txns)
    # lot1: 5 @ (30-10)=100 ; lot2 partial: 2 @ (30-20)=20
    gains = sorted(l["gain"] for l in lots)
    assert gains == [20.0, 100.0]
    assert round(sum(l["quantity"] for l in lots), 6) == 7.0


def test_wash_sale_flagged_when_repurchase_within_30d(txn):
    txns = [
        txn("W", "buy", 10, 100.0, "2023-01-02"),
        txn("W", "sell", 10, 90.0, "2023-02-01"),    # loss -100
        txn("W", "buy", 5, 95.0, "2023-02-15"),       # repurchase 14d later
    ]
    summary = tax.tax_summary(txns)
    assert summary["total_realized"] == -100.0
    assert len(summary["wash_sale_flags"]) == 1
    flag = summary["wash_sale_flags"][0]
    assert flag["symbol"] == "W"
    assert flag["repurchase_date"] == "2023-02-15"
    assert flag["disallowed"] is True


def test_wash_sale_not_flagged_without_repurchase(txn):
    txns = [
        txn("V", "buy", 10, 100.0, "2023-01-02"),
        txn("V", "sell", 10, 90.0, "2023-06-01"),    # loss, no repurchase near
    ]
    summary = tax.tax_summary(txns)
    assert summary["total_realized"] == -100.0
    assert summary["wash_sale_flags"] == []


def test_gain_does_not_trigger_wash_sale(txn):
    txns = [
        txn("G", "buy", 10, 100.0, "2023-01-02"),
        txn("G", "sell", 10, 120.0, "2023-01-10"),   # GAIN, repurchase near
        txn("G", "buy", 10, 118.0, "2023-01-20"),
    ]
    summary = tax.tax_summary(txns)
    assert summary["wash_sale_flags"] == []


def test_year_filter(txn):
    txns = [
        txn("X", "buy", 10, 100.0, "2022-01-02"),
        txn("X", "sell", 10, 110.0, "2022-12-01"),   # closes in 2022
        txn("Y", "buy", 10, 100.0, "2023-01-02"),
        txn("Y", "sell", 10, 130.0, "2023-12-01"),   # closes in 2023
    ]
    s2023 = tax.tax_summary(txns, year=2023)
    assert s2023["lot_count"] == 1
    assert s2023["total_realized"] == 300.0


def test_tlh_candidates_sorted_by_largest_loss():
    enriched = [
        {"symbol": "WIN", "unrealized_pl": 500.0, "unrealized_pl_pct": 5.0, "market_value": 10500},
        {"symbol": "LOSE1", "unrealized_pl": -200.0, "unrealized_pl_pct": -4.0, "market_value": 4800},
        {"symbol": "LOSE2", "unrealized_pl": -900.0, "unrealized_pl_pct": -9.0, "market_value": 9100},
    ]
    cands = tax.tlh_candidates(enriched)
    assert [c["symbol"] for c in cands] == ["LOSE2", "LOSE1"]
