"""Paper trading engine.

Owns two self-contained DuckDB tables (paper_portfolios, paper_orders) created
lazily via CREATE TABLE IF NOT EXISTS - we do NOT touch db/schema.sql. On first
use a default "Demo Book" ($100k) is seeded with ~8 realistic filled orders so
the surface is fully populated for screenshots.

Design contract:
- The order log is the source of truth. Positions are DERIVED on every read via
  app.portfolio.positions.compute_positions and are never persisted.
- Fills price at the live last close (fetch_arbitrary_ticker) with a sample-price
  fallback. A commission ($0.005/share, $1 min) and slippage (2 bps) model is
  applied to every fill.
- Every payload carries data_mode ("live" | "sample"), as_of (ISO), and source.
- No public function raises. On any failure we degrade to sample data.
"""
from __future__ import annotations

import logging
import threading
from datetime import date, datetime

from ..db import engine as db
from ..portfolio.positions import compute_positions
from . import sample_data as sd

log = logging.getLogger(__name__)

# ---------- Execution model constants ----------

COMMISSION_PER_SHARE = 0.005   # $0.005 per share
COMMISSION_MIN = 1.0           # $1.00 minimum per order
SLIPPAGE_BPS = 2.0             # 2 basis points of adverse price movement

_READY_LOCK = threading.Lock()
_READY = False


# ---------- Lazy table creation + seeding ----------

_DDL = [
    "CREATE SEQUENCE IF NOT EXISTS seq_paper_portfolios START 1",
    """
    CREATE TABLE IF NOT EXISTS paper_portfolios (
        id            BIGINT PRIMARY KEY DEFAULT nextval('seq_paper_portfolios'),
        name          VARCHAR NOT NULL,
        starting_cash DOUBLE  NOT NULL DEFAULT 100000,
        created_at    TIMESTAMP DEFAULT now()
    )
    """,
    "CREATE SEQUENCE IF NOT EXISTS seq_paper_orders START 1",
    """
    CREATE TABLE IF NOT EXISTS paper_orders (
        id            BIGINT PRIMARY KEY DEFAULT nextval('seq_paper_orders'),
        portfolio_id  BIGINT  NOT NULL,
        symbol        VARCHAR NOT NULL,
        side          VARCHAR NOT NULL,
        quantity      DOUBLE  NOT NULL,
        order_type    VARCHAR NOT NULL DEFAULT 'market',
        limit_price   DOUBLE,
        base_price    DOUBLE  NOT NULL,
        fill_price    DOUBLE  NOT NULL,
        commission    DOUBLE  NOT NULL DEFAULT 0,
        slippage_cost DOUBLE  NOT NULL DEFAULT 0,
        status        VARCHAR NOT NULL DEFAULT 'filled',
        trade_date    DATE,
        filled_at     TIMESTAMP DEFAULT now()
    )
    """,
]


def _ensure_ready() -> None:
    """Create tables (idempotent) and seed the Demo Book on first ever use."""
    global _READY
    if _READY:
        return
    with _READY_LOCK:
        if _READY:
            return
        try:
            with db.conn() as c:
                for stmt in _DDL:
                    c.execute(stmt)
                _ensure_demo_book_seeded(c)
            _READY = True
        except Exception as e:  # pragma: no cover - degrade silently
            # Do NOT set _READY: a failed/partial attempt should retry next call.
            log.warning("paper _ensure_ready failed: %s", e)


def _ensure_demo_book_seeded(c) -> None:
    """Find-or-create the Demo Book and (re)seed its orders if it has none.

    Self-healing: reseeds whenever the portfolio is missing OR exists with zero
    orders, so a partial seed (e.g. a write conflict that committed the portfolio
    row but not its orders) recovers on the next read instead of being stuck
    empty forever. Seed fill prices come straight from sample_data (hardcoded),
    so this never touches the network and always succeeds offline.
    """
    row = c.execute(
        "SELECT id FROM paper_portfolios WHERE name = ? ORDER BY id LIMIT 1",
        [sd.SAMPLE_PORTFOLIO_NAME],
    ).fetchone()
    if row:
        pid = int(row[0])
    else:
        created = c.execute(
            "INSERT INTO paper_portfolios (name, starting_cash) VALUES (?, ?) RETURNING id",
            [sd.SAMPLE_PORTFOLIO_NAME, sd.SAMPLE_STARTING_CASH],
        ).fetchone()
        pid = int(created[0])

    cnt = c.execute(
        "SELECT COUNT(*) FROM paper_orders WHERE portfolio_id = ?", [pid]
    ).fetchone()
    if cnt and int(cnt[0]) > 0:
        return  # already populated - nothing to do

    _insert_sample_orders(c, pid)


def _insert_sample_orders(c, pid: int) -> None:
    """Atomically (re)write the ~9 sample filled orders for a portfolio.

    Wrapped in a transaction with a leading DELETE so it is idempotent: a retry
    after a partial failure can never duplicate or leave a half-seeded book.
    """
    c.execute("BEGIN TRANSACTION")
    try:
        c.execute("DELETE FROM paper_orders WHERE portfolio_id = ?", [pid])
        for o in sd.SAMPLE_DEMO_ORDERS:
            side = o["side"]
            qty = float(o["quantity"])
            base = float(o["price"])          # hardcoded sample fill - no network
            fill = _apply_slippage(base, side)
            commission = _commission(qty)
            slippage_cost = round(abs(fill - base) * qty, 2)
            c.execute(
                """
                INSERT INTO paper_orders
                    (portfolio_id, symbol, side, quantity, order_type, limit_price,
                     base_price, fill_price, commission, slippage_cost, status, trade_date)
                VALUES (?, ?, ?, ?, 'market', NULL, ?, ?, ?, ?, 'filled', ?)
                """,
                [pid, o["symbol"].upper(), side, qty, base, fill,
                 commission, slippage_cost, o["trade_date"]],
            )
        c.execute("COMMIT")
    except Exception:
        try:
            c.execute("ROLLBACK")
        except Exception:
            pass
        raise
    log.info("paper: seeded Demo Book (id=%s) with %d orders", pid, len(sd.SAMPLE_DEMO_ORDERS))


# ---------- Execution model helpers ----------

def _commission(quantity: float) -> float:
    return round(max(COMMISSION_MIN, COMMISSION_PER_SHARE * abs(quantity)), 2)


def _apply_slippage(base_price: float, side: str) -> float:
    """Adverse slippage: buys fill higher, sells fill lower, by SLIPPAGE_BPS."""
    factor = SLIPPAGE_BPS / 10_000.0
    if side == "buy":
        return round(base_price * (1 + factor), 4)
    return round(base_price * (1 - factor), 4)


def _last_close(symbol: str) -> tuple[float, bool]:
    """Return (price, is_live). Live last close via fetch_arbitrary_ticker, else sample."""
    try:
        from ..data.macro_data import fetch_arbitrary_ticker
        pts = fetch_arbitrary_ticker(symbol, days=7)
        if pts:
            val = pts[-1].get("value")
            if val:
                return float(val), True
    except Exception as e:
        log.warning("paper _last_close(%s) failed: %s", symbol, e)
    return sd.sample_price(symbol), False


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


# ---------- Row mappers ----------

def _portfolio_row(r) -> dict:
    return {
        "id": int(r[0]),
        "name": r[1],
        "starting_cash": float(r[2]) if r[2] is not None else 0.0,
        "created_at": str(r[3]) if r[3] else None,
    }


def _order_row(r) -> dict:
    return {
        "id": int(r[0]),
        "portfolio_id": int(r[1]),
        "symbol": r[2],
        "side": r[3],
        "quantity": float(r[4]),
        "order_type": r[5],
        "limit_price": float(r[6]) if r[6] is not None else None,
        "base_price": float(r[7]) if r[7] is not None else None,
        "fill_price": float(r[8]) if r[8] is not None else None,
        "commission": float(r[9]) if r[9] is not None else 0.0,
        "slippage_cost": float(r[10]) if r[10] is not None else 0.0,
        "status": r[11],
        "trade_date": str(r[12]) if r[12] else None,
        "filled_at": str(r[13]) if r[13] else None,
    }


_ORDER_COLS = (
    "id, portfolio_id, symbol, side, quantity, order_type, limit_price, "
    "base_price, fill_price, commission, slippage_cost, status, trade_date, filled_at"
)


def _load_orders(pid: int) -> list[dict]:
    rows = db.fetchall(
        f"SELECT {_ORDER_COLS} FROM paper_orders "
        "WHERE portfolio_id = ? ORDER BY trade_date, id",
        [pid],
    )
    return [_order_row(r) for r in rows]


# ---------- Public API ----------

def list_paper_portfolios() -> list[dict]:
    """All paper books (Demo Book is seeded on first call). Never raises."""
    _ensure_ready()
    try:
        rows = db.fetchall(
            "SELECT id, name, starting_cash, created_at "
            "FROM paper_portfolios ORDER BY created_at, id"
        )
        if rows:
            return [_portfolio_row(r) for r in rows]
    except Exception as e:
        log.warning("list_paper_portfolios failed: %s", e)
    # Degrade to the sample Demo Book descriptor.
    return [{
        "id": 1,
        "name": sd.SAMPLE_PORTFOLIO_NAME,
        "starting_cash": sd.SAMPLE_STARTING_CASH,
        "created_at": None,
    }]


def create_paper_portfolio(name: str, starting_cash: float = 100000) -> dict:
    """Create a new empty paper book. Never raises; degrades to a sample dict."""
    _ensure_ready()
    try:
        cash = float(starting_cash) if starting_cash else sd.SAMPLE_STARTING_CASH
        with db.conn() as c:
            r = c.execute(
                "INSERT INTO paper_portfolios (name, starting_cash) "
                "VALUES (?, ?) RETURNING id, name, starting_cash, created_at",
                [name or "New Book", cash],
            ).fetchone()
        out = _portfolio_row(r)
        out.update({"data_mode": "live", "as_of": _now_iso(), "source": "paper-engine"})
        return out
    except Exception as e:
        log.warning("create_paper_portfolio failed: %s", e)
        return {
            "id": 0,
            "name": name or "New Book",
            "starting_cash": float(starting_cash) if starting_cash else sd.SAMPLE_STARTING_CASH,
            "created_at": None,
            "data_mode": "sample",
            "as_of": _now_iso(),
            "source": "sample",
        }


def place_paper_order(
    pid: int,
    symbol: str,
    side: str,
    quantity: float,
    order_type: str = "market",
    limit_price: float | None = None,
) -> dict:
    """Fill an order at the live last close (sample fallback) and record it.

    Applies the commission + slippage model. Positions are not stored - they are
    re-derived from the order log on the next overview read. Never raises.
    """
    _ensure_ready()
    symbol = (symbol or "").upper()
    side = "sell" if str(side).lower() == "sell" else "buy"
    try:
        qty = abs(float(quantity))
    except (TypeError, ValueError):
        qty = 0.0

    live_price, is_live = _last_close(symbol)

    # Limit handling: fill at the more favorable of live vs limit (marketable
    # paper assumption). Market orders fill at the live close.
    base = live_price
    lp = None
    if order_type == "limit" and limit_price:
        try:
            lp = float(limit_price)
            base = min(live_price, lp) if side == "buy" else max(live_price, lp)
        except (TypeError, ValueError):
            lp = None

    fill = _apply_slippage(base, side)
    commission = _commission(qty)
    slippage_cost = round(abs(fill - base) * qty, 2)
    td = date.today().isoformat()

    try:
        with db.conn() as c:
            r = c.execute(
                f"""
                INSERT INTO paper_orders
                    (portfolio_id, symbol, side, quantity, order_type, limit_price,
                     base_price, fill_price, commission, slippage_cost, status, trade_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filled', ?)
                RETURNING {_ORDER_COLS}
                """,
                [int(pid), symbol, side, qty, order_type, lp,
                 base, fill, commission, slippage_cost, td],
            ).fetchone()
        out = _order_row(r)
    except Exception as e:
        log.warning("place_paper_order failed: %s", e)
        out = {
            "id": 0, "portfolio_id": int(pid) if pid else 0, "symbol": symbol,
            "side": side, "quantity": qty, "order_type": order_type,
            "limit_price": lp, "base_price": base, "fill_price": fill,
            "commission": commission, "slippage_cost": slippage_cost,
            "status": "filled", "trade_date": td, "filled_at": None,
        }
        is_live = False

    out.update({
        "data_mode": "live" if is_live else "sample",
        "as_of": _now_iso(),
        "source": "yfinance" if is_live else "sample",
    })
    return out


def get_paper_overview(pid: int) -> dict:
    """Full book snapshot: derived positions + cash + P&L + execution analytics.

    Positions are DERIVED via compute_positions over the order log - never stored.
    Never raises; degrades to a sample overview built from sample_data.
    """
    _ensure_ready()
    try:
        prow = db.fetchone(
            "SELECT id, name, starting_cash, created_at FROM paper_portfolios WHERE id = ?",
            [int(pid)],
        )
        if prow:
            portfolio = _portfolio_row(prow)
            orders = _load_orders(int(pid))
            return _overview_from_orders(portfolio, orders)
    except Exception as e:
        log.warning("get_paper_overview(%s) failed: %s", pid, e)
    return _sample_overview()


def reset_paper_portfolio(pid: int) -> dict:
    """Wipe all orders for a book, restoring it to full starting cash. Never raises."""
    _ensure_ready()
    try:
        db.execute("DELETE FROM paper_orders WHERE portfolio_id = ?", [int(pid)])
        prow = db.fetchone(
            "SELECT id, name, starting_cash, created_at FROM paper_portfolios WHERE id = ?",
            [int(pid)],
        )
        if prow:
            return _overview_from_orders(_portfolio_row(prow), [])
    except Exception as e:
        log.warning("reset_paper_portfolio(%s) failed: %s", pid, e)
    return _sample_overview()


# ---------- Overview assembly (pure given portfolio + orders) ----------

def _overview_from_orders(portfolio: dict, orders: list[dict]) -> dict:
    """Build the overview payload. Pricing is the only side effect (price fetch)."""
    starting_cash = float(portfolio.get("starting_cash") or 0.0)

    # Map orders into the transaction shape compute_positions expects.
    txns = [
        {
            "id": o["id"],
            "symbol": o["symbol"],
            "trade_type": o["side"],
            "quantity": o["quantity"],
            "price": o["fill_price"],
            "commission": o.get("commission") or 0.0,
            "trade_date": o.get("trade_date") or "",
        }
        for o in orders
    ]
    positions, total_realized, cash_delta = compute_positions(txns)

    cash = round(starting_cash + cash_delta, 2)

    any_live = False
    enriched: list[dict] = []
    total_market_value = 0.0
    total_unrealized = 0.0
    for pos in positions:
        price, is_live = _last_close(pos.symbol)
        any_live = any_live or is_live
        market_value = pos.shares * price
        unreal = market_value - pos.total_cost
        total_market_value += market_value
        total_unrealized += unreal
        enriched.append({
            "symbol": pos.symbol,
            "shares": round(pos.shares, 6),
            "avg_cost": round(pos.avg_cost, 4),
            "total_cost": round(pos.total_cost, 2),
            "current_price": round(price, 4),
            "market_value": round(market_value, 2),
            "unrealized_pl": round(unreal, 2),
            "unrealized_pl_pct": round((unreal / pos.total_cost * 100) if pos.total_cost > 0 else 0.0, 2),
            "realized_pl": round(pos.realized_pl, 2),
            "total_pl": round(unreal + pos.realized_pl, 2),
            "weight": 0.0,  # filled below once equity is known
        })

    equity = round(cash + total_market_value, 2)
    for p in enriched:
        p["weight"] = round((p["market_value"] / equity * 100) if equity > 0 else 0.0, 2)

    total_pl = round(equity - starting_cash, 2)
    total_pl_pct = round((total_pl / starting_cash * 100) if starting_cash > 0 else 0.0, 2)

    execution = _execution_block(orders, cash, equity, total_market_value)

    return {
        "portfolio": portfolio,
        "positions": enriched,
        "orders": list(reversed(orders))[:25],  # most recent first
        "starting_cash": round(starting_cash, 2),
        "cash": cash,
        "market_value": round(total_market_value, 2),
        "equity": equity,
        "total_pl": total_pl,
        "total_pl_pct": total_pl_pct,
        "realized_pl": round(total_realized, 2),
        "unrealized_pl": round(total_unrealized, 2),
        "position_count": len(enriched),
        "execution": execution,
        "data_mode": "live" if any_live else "sample",
        "as_of": _now_iso(),
        "source": "yfinance + paper-engine" if any_live else "sample",
    }


def _execution_block(orders: list[dict], cash: float, equity: float, gross_exposure: float) -> dict:
    """IB-light execution analytics derived from the order log."""
    commissions_paid = round(sum(o.get("commission") or 0.0 for o in orders), 2)
    est_slippage_cost = round(sum(o.get("slippage_cost") or 0.0 for o in orders), 2)
    fill_count = len(orders)

    # Reg-T style framing: ~50% of gross exposure is the initial requirement tied
    # up; remaining equity is extendable at 2:1.
    margin_used = round(gross_exposure * 0.5, 2)
    buying_power = round(max(0.0, equity - margin_used) * 2.0, 2)

    realized_per_sell = _sell_realized(orders)
    wins = sum(1 for r in realized_per_sell if r > 0)
    win_rate = round(wins / len(realized_per_sell), 4) if realized_per_sell else 0.0

    return {
        "buying_power": buying_power,
        "margin_used": margin_used,
        "gross_exposure": round(gross_exposure, 2),
        "commissions_paid": commissions_paid,
        "est_slippage_cost": est_slippage_cost,
        "fill_count": fill_count,
        "win_rate": win_rate,
        "closed_trades": len(realized_per_sell),
    }


def _sell_realized(orders: list[dict]) -> list[float]:
    """Attribute realized P&L to each sell order via per-symbol FIFO replay.

    Mirrors compute_positions' matching so win_rate counts closed round-trips.
    """
    from collections import defaultdict, deque

    lots: dict[str, deque] = defaultdict(deque)
    results: list[float] = []
    ordered = sorted(orders, key=lambda o: (o.get("trade_date") or "", o.get("id") or 0))
    for o in ordered:
        sym = o["symbol"].upper()
        qty = float(o["quantity"])
        price = float(o["fill_price"])
        commission = float(o.get("commission") or 0.0)
        if o["side"] == "buy":
            cost_per_share = price + (commission / qty if qty > 0 else 0.0)
            lots[sym].append([qty, cost_per_share])
        else:
            remaining = qty
            gross = 0.0
            while remaining > 0 and lots[sym]:
                lot = lots[sym][0]
                take = min(lot[0], remaining)
                gross += (price - lot[1]) * take
                lot[0] -= take
                remaining -= take
                if lot[0] <= 0:
                    lots[sym].popleft()
            results.append(round(gross - commission, 2))
    return results


def _sample_overview() -> dict:
    """Ultimate fallback: build an overview straight from sample_data, no DB."""
    portfolio = {
        "id": 1,
        "name": sd.SAMPLE_PORTFOLIO_NAME,
        "starting_cash": sd.SAMPLE_STARTING_CASH,
        "created_at": None,
    }
    orders: list[dict] = []
    for i, o in enumerate(sd.SAMPLE_DEMO_ORDERS, start=1):
        side = o["side"]
        qty = float(o["quantity"])
        base = float(o["price"])
        fill = _apply_slippage(base, side)
        commission = _commission(qty)
        orders.append({
            "id": i,
            "portfolio_id": 1,
            "symbol": o["symbol"].upper(),
            "side": side,
            "quantity": qty,
            "order_type": "market",
            "limit_price": None,
            "base_price": base,
            "fill_price": fill,
            "commission": commission,
            "slippage_cost": round(abs(fill - base) * qty, 2),
            "status": "filled",
            "trade_date": o["trade_date"],
            "filled_at": None,
        })
    out = _overview_from_orders(portfolio, orders)
    out["data_mode"] = "sample"
    out["source"] = "sample"
    return out
