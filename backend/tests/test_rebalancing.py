"""Rebalancing-suggestion invariants for app.portfolio.rebalancing."""
from __future__ import annotations

from app.portfolio import rebalancing


def _row(result, symbol):
    return next(r for r in result["rows"] if r["symbol"] == symbol)


def test_basic_drift_and_trade_direction():
    enriched = [
        {"symbol": "AAPL", "market_value": 60000.0},
        {"symbol": "MSFT", "market_value": 30000.0},
    ]
    result = rebalancing.suggest_rebalance(
        enriched,
        targets={"AAPL": 50.0, "MSFT": 30.0, "CASH": 20.0},
        total_value=100000.0,
        cash_balance=10000.0,
        threshold_pct=5.0,
    )
    aapl = _row(result, "AAPL")
    assert aapl["current_weight_pct"] == 60.0
    assert aapl["drift_pct"] == 10.0
    assert aapl["trade_value"] == -10000.0   # overweight -> sell $10k
    assert aapl["action"] == "sell"

    msft = _row(result, "MSFT")
    assert msft["drift_pct"] == 0.0
    assert msft["action"] == "hold"

    cash = _row(result, "CASH")
    assert cash["current_weight_pct"] == 10.0
    assert cash["drift_pct"] == -10.0
    assert cash["trade_value"] == 10000.0    # underweight -> add $10k
    assert cash["action"] == "buy"

    assert result["rebalance_needed"] is True


def test_threshold_holds_small_drift():
    enriched = [{"symbol": "AAPL", "market_value": 52000.0}]
    result = rebalancing.suggest_rebalance(
        enriched,
        targets={"AAPL": 50.0, "CASH": 50.0},
        total_value=100000.0,
        cash_balance=48000.0,
        threshold_pct=5.0,
    )
    aapl = _row(result, "AAPL")
    assert aapl["drift_pct"] == 2.0          # within 5% threshold
    assert aapl["action"] == "hold"


def test_held_but_untargeted_is_full_sell():
    enriched = [
        {"symbol": "AAPL", "market_value": 50000.0},
        {"symbol": "OLD", "market_value": 50000.0},   # not in targets
    ]
    result = rebalancing.suggest_rebalance(
        enriched,
        targets={"AAPL": 100.0},
        total_value=100000.0,
        cash_balance=0.0,
        threshold_pct=5.0,
    )
    old = _row(result, "OLD")
    assert old["target_weight_pct"] == 0.0
    assert old["action"] == "sell"
    assert old["trade_value"] == -50000.0


def test_targeted_but_unheld_is_buy():
    enriched = [{"symbol": "AAPL", "market_value": 100000.0}]
    result = rebalancing.suggest_rebalance(
        enriched,
        targets={"AAPL": 70.0, "NVDA": 30.0},
        total_value=100000.0,
        cash_balance=0.0,
        threshold_pct=5.0,
    )
    nvda = _row(result, "NVDA")
    assert nvda["current_weight_pct"] == 0.0
    assert nvda["target_weight_pct"] == 30.0
    assert nvda["trade_value"] == 30000.0
    assert nvda["action"] == "buy"
