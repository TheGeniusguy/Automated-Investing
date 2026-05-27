"""CRUD for user_portfolios and portfolio_transactions."""
from __future__ import annotations

from datetime import date

from ..db import engine as db


# ---------- Portfolios ----------

def list_portfolios() -> list[dict]:
    rows = db.fetchall(
        "SELECT id, name, description, cash_balance, created_at, updated_at "
        "FROM user_portfolios ORDER BY created_at"
    )
    return [_portfolio_row(r) for r in rows]


def get_portfolio(portfolio_id: int) -> dict | None:
    r = db.fetchone(
        "SELECT id, name, description, cash_balance, created_at, updated_at "
        "FROM user_portfolios WHERE id = ?",
        [portfolio_id],
    )
    return _portfolio_row(r) if r else None


def create_portfolio(name: str, description: str | None, cash_balance: float) -> dict:
    with db.conn() as c:
        r = c.execute(
            "INSERT INTO user_portfolios (name, description, cash_balance) "
            "VALUES (?, ?, ?) RETURNING id",
            [name, description, cash_balance],
        ).fetchone()
        pid = int(r[0])
    return {
        "id": pid,
        "name": name,
        "description": description,
        "cash_balance": cash_balance,
        "created_at": None,
        "updated_at": None,
    }


def update_portfolio_cash(portfolio_id: int, cash_balance: float) -> None:
    db.execute(
        "UPDATE user_portfolios SET cash_balance = ?, updated_at = now() WHERE id = ?",
        [cash_balance, portfolio_id],
    )


def delete_portfolio(portfolio_id: int) -> bool:
    db.execute("DELETE FROM portfolio_transactions WHERE portfolio_id = ?", [portfolio_id])
    db.execute("DELETE FROM portfolio_snapshots WHERE portfolio_id = ?", [portfolio_id])
    n = db.execute("DELETE FROM user_portfolios WHERE id = ?", [portfolio_id])
    return n > 0


# ---------- Transactions ----------

def get_transactions(portfolio_id: int) -> list[dict]:
    rows = db.fetchall(
        "SELECT id, portfolio_id, symbol, trade_date, trade_type, "
        "quantity, price, commission, notes, created_at "
        "FROM portfolio_transactions "
        "WHERE portfolio_id = ? ORDER BY trade_date, id",
        [portfolio_id],
    )
    return [_txn_row(r) for r in rows]


def add_transaction(
    portfolio_id: int,
    symbol: str,
    trade_date: date,
    trade_type: str,
    quantity: float,
    price: float,
    commission: float = 0.0,
    notes: str | None = None,
) -> dict:
    with db.conn() as c:
        r = c.execute(
            "INSERT INTO portfolio_transactions "
            "(portfolio_id, symbol, trade_date, trade_type, quantity, price, commission, notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            [portfolio_id, symbol.upper(), str(trade_date), trade_type,
             quantity, price, commission, notes],
        ).fetchone()
        tid = int(r[0])
    return {
        "id": tid,
        "portfolio_id": portfolio_id,
        "symbol": symbol.upper(),
        "trade_date": str(trade_date),
        "trade_type": trade_type,
        "quantity": quantity,
        "price": price,
        "commission": commission,
        "notes": notes,
    }


def delete_transaction(portfolio_id: int, transaction_id: int) -> bool:
    n = db.execute(
        "DELETE FROM portfolio_transactions WHERE id = ? AND portfolio_id = ?",
        [transaction_id, portfolio_id],
    )
    return n > 0


# ---------- Helpers ----------

def _portfolio_row(r) -> dict:
    return {
        "id": int(r[0]),
        "name": r[1],
        "description": r[2],
        "cash_balance": float(r[3]) if r[3] is not None else 0.0,
        "created_at": str(r[4]) if r[4] else None,
        "updated_at": str(r[5]) if r[5] else None,
    }


def _txn_row(r) -> dict:
    return {
        "id": int(r[0]),
        "portfolio_id": int(r[1]),
        "symbol": r[2],
        "trade_date": str(r[3]) if r[3] else None,
        "trade_type": r[4],
        "quantity": float(r[5]),
        "price": float(r[6]),
        "commission": float(r[7]) if r[7] is not None else 0.0,
        "notes": r[8],
        "created_at": str(r[9]) if r[9] else None,
    }
