"""Rebalancing suggestions: compare current allocation to a target and emit trades.

Pure math — no I/O. ``targets`` maps SYMBOL (or the literal "CASH") to a target
weight in percent. Symbols held but absent from ``targets`` get a 0% target
(full sell); target symbols not yet held start at 0% current (buy from scratch).
"""
from __future__ import annotations


def suggest_rebalance(
    enriched_positions: list[dict],
    targets: dict[str, float],
    total_value: float,
    cash_balance: float,
    threshold_pct: float = 5.0,
) -> dict:
    targets = {str(k).upper(): float(v) for k, v in (targets or {}).items()}
    total_value = float(total_value or 0.0)

    current_value: dict[str, float] = {}
    for p in enriched_positions:
        sym = str(p.get("symbol", "")).upper()
        current_value[sym] = current_value.get(sym, 0.0) + float(p.get("market_value") or 0.0)
    current_value["CASH"] = float(cash_balance or 0.0)

    universe = set(current_value) | set(targets)
    universe.discard("")

    rows: list[dict] = []
    total_abs_drift = 0.0
    for sym in sorted(universe):
        cur_val = current_value.get(sym, 0.0)
        cur_wt = (cur_val / total_value * 100.0) if total_value > 0 else 0.0
        tgt_wt = targets.get(sym, 0.0)
        tgt_val = total_value * tgt_wt / 100.0
        drift = cur_wt - tgt_wt
        trade_value = tgt_val - cur_val  # + = buy, - = sell
        total_abs_drift += abs(drift)

        if abs(drift) < threshold_pct:
            action = "hold"
        elif trade_value > 0:
            action = "buy"
        else:
            action = "sell"

        rows.append({
            "symbol": sym,
            "current_weight_pct": round(cur_wt, 2),
            "target_weight_pct": round(tgt_wt, 2),
            "drift_pct": round(drift, 2),
            "current_value": round(cur_val, 2),
            "target_value": round(tgt_val, 2),
            "trade_value": round(trade_value, 2),
            "action": action,
        })

    rows.sort(key=lambda r: -abs(r["drift_pct"]))
    rebalance_needed = any(r["action"] != "hold" for r in rows)

    return {
        "rows": rows,
        "total_drift_pct": round(total_abs_drift, 2),
        "threshold_pct": threshold_pct,
        "rebalance_needed": rebalance_needed,
        "total_value": round(total_value, 2),
    }
