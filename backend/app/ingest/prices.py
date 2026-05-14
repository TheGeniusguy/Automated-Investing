"""Price-history backfill into DuckDB.

For a list of symbols and a lookback window, pulls OHLCV via yfinance,
upserts into prices_daily, and records corporate actions (splits/divs)
as we discover them. Designed to run on demand from the UI rather than
on a fixed schedule — backfilling all 13k EDGAR symbols isn't realistic
without paid data.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from ..db import engine

log = logging.getLogger(__name__)


def _yf():
    import yfinance as yf
    return yf


def _record_actions(c, symbol: str, actions_df) -> int:
    """Record split + dividend events. yfinance returns a multi-column df."""
    if actions_df is None or actions_df.empty:
        return 0
    written = 0
    for idx, row in actions_df.iterrows():
        date_str = idx.strftime("%Y-%m-%d")
        for action, col in (("dividend", "Dividends"), ("split", "Stock Splits")):
            val = row.get(col)
            if val is None or val == 0 or (isinstance(val, float) and val != val):  # NaN check
                continue
            try:
                c.execute(
                    """
                    INSERT OR REPLACE INTO corporate_actions
                        (symbol, date, action_type, value)
                    VALUES (?, ?, ?, ?)
                    """,
                    [symbol, date_str, action, float(val)],
                )
                written += 1
            except Exception as e:
                log.warning("corporate_action upsert failed for %s %s: %s", symbol, action, e)
    return written


def backfill_symbol(symbol: str, *, days: int = 3650) -> dict:
    """Pull daily OHLCV for one symbol, upsert into prices_daily.
    Returns a per-symbol summary dict."""
    yf = _yf()
    symbol = symbol.upper().strip()
    run_id = engine.etl_start("prices", target=symbol)
    rows_written = 0
    actions_written = 0
    error: str | None = None
    first_date: str | None = None
    last_date: str | None = None

    try:
        # yfinance's `period` flag is unreliable past ~5y; for anything longer,
        # use explicit start dates.
        if days <= 365 * 2:
            df = yf.Ticker(symbol).history(period=f"{days}d", auto_adjust=False, actions=True)
        else:
            start = (datetime.utcnow().date() - timedelta(days=days + 14)).isoformat()
            df = yf.Ticker(symbol).history(start=start, auto_adjust=False, actions=True)

        if df is None or df.empty:
            engine.etl_finish(run_id, status="ok", note="empty (likely delisted or not yet listed)")
            return {"symbol": symbol, "rows": 0, "actions": 0, "error": "no data", "run_id": run_id}

        df = df.tail(days)
        first_date = df.index[0].strftime("%Y-%m-%d")
        last_date  = df.index[-1].strftime("%Y-%m-%d")

        with engine.conn() as c:
            for idx, row in df.iterrows():
                date_str = idx.strftime("%Y-%m-%d")
                try:
                    c.execute(
                        """
                        INSERT INTO prices_daily
                            (symbol, date, open, high, low, close, adj_close, volume, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yfinance')
                        ON CONFLICT (symbol, date) DO UPDATE SET
                            open      = EXCLUDED.open,
                            high      = EXCLUDED.high,
                            low       = EXCLUDED.low,
                            close     = EXCLUDED.close,
                            adj_close = EXCLUDED.adj_close,
                            volume    = EXCLUDED.volume,
                            ingested_at = now()
                        """,
                        [
                            symbol, date_str,
                            _f(row.get("Open")), _f(row.get("High")),
                            _f(row.get("Low")),  _f(row.get("Close")),
                            _f(row.get("Adj Close")) or _f(row.get("Close")),
                            _i(row.get("Volume")),
                        ],
                    )
                    rows_written += 1
                except Exception as e:
                    log.warning("price upsert failed for %s %s: %s", symbol, date_str, e)

            # Corporate actions piggyback on the same fetch
            actions_written = _record_actions(c, symbol, df)

        engine.etl_finish(
            run_id, status="ok",
            rows_in=len(df), rows_out=rows_written,
            note=f"{first_date}..{last_date}, actions={actions_written}",
        )
    except Exception as e:
        log.exception("backfill_symbol failed for %s", symbol)
        error = str(e)
        engine.etl_finish(run_id, status="error", note=error)

    return {
        "symbol":  symbol,
        "rows":    rows_written,
        "actions": actions_written,
        "first":   first_date,
        "last":    last_date,
        "error":   error,
        "run_id":  run_id,
    }


def backfill_symbols(symbols: list[str], *, days: int = 3650) -> dict:
    """Run backfill_symbol over a list. Sequential is fine — yfinance throttles
    aggressively if you parallelize."""
    started = datetime.utcnow()
    per_symbol = [backfill_symbol(s, days=days) for s in symbols if s.strip()]
    total_rows = sum(p["rows"] for p in per_symbol)
    total_actions = sum(p["actions"] for p in per_symbol)
    elapsed = (datetime.utcnow() - started).total_seconds()
    return {
        "symbols":       [p["symbol"] for p in per_symbol],
        "per_symbol":    per_symbol,
        "total_rows":    total_rows,
        "total_actions": total_actions,
        "elapsed_s":     round(elapsed, 2),
    }


def _f(v) -> float | None:
    try:
        f = float(v)
        return None if f != f else f  # NaN check
    except (TypeError, ValueError):
        return None


def _i(v) -> int | None:
    try:
        return int(v) if v == v else None
    except (TypeError, ValueError):
        return None
