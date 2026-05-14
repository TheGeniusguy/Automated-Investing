"""FastAPI entrypoint for the Automated-Investing terminal backend."""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .briefing import claude_briefing
from .config import settings
from .correlations import correlation_model
from .data import earnings as earnings_mod, macro_data, news as news_mod, options as options_mod, sec_edgar, watchlist
from .db import engine as db_engine
from .ingest import fundamentals as ingest_fundamentals
from .ingest import instruments as ingest_instruments
from .ingest import prices as ingest_prices
from .regime import regime_model, stress_test as stress_test_mod

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

app = FastAPI(
    title="Automated-Investing Terminal",
    description="Personal Bloomberg + AI macro intelligence layer.",
    version="0.1.0",
)


@app.on_event("startup")
def _on_startup() -> None:
    db_engine.init()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Health ----------

@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "fred_configured": settings.has_fred,
        "anthropic_configured": settings.has_anthropic,
        "claude_model": settings.claude_model,
    }


# ---------- Macro series ----------

@app.get("/api/macro/series")
def get_all_series(days: int = 90) -> dict:
    """Return the 5 Panel-1 macro series (SPX served via the per-id route)."""
    data = macro_data.fetch_all(days=days, series=macro_data.PANEL1_SERIES)
    return {
        "days": days,
        "meta": {k: macro_data.SERIES_META[k] for k in macro_data.PANEL1_SERIES},
        "series": data,
    }


@app.get("/api/macro/series/{series_id}")
def get_one_series(series_id: str, days: int = 90) -> dict:
    if series_id not in macro_data.ALL_SERIES:
        raise HTTPException(404, f"Unknown series: {series_id}")
    try:
        points = macro_data.fetch_series(series_id, days=days)
    except Exception as e:
        raise HTTPException(503, f"Failed to fetch {series_id}: {e}") from e
    return {
        "series_id": series_id,
        "meta": macro_data.SERIES_META[series_id],
        "points": points,
    }


# ---------- Regime ----------

def _regime_inputs(days: int = 90):
    """Fetch the three series the regime model depends on."""
    vix = macro_data.fetch_series("^VIX", days=days)
    y2 = macro_data.fetch_series("DGS2", days=days)
    y10 = macro_data.fetch_series("DGS10", days=days)
    return vix, y2, y10


@app.get("/api/regime/current")
def get_current_regime() -> dict:
    vix, y2, y10 = _regime_inputs(days=30)
    state = regime_model.detect_current(vix, y2, y10)
    return state.to_dict()


@app.get("/api/regime/history")
def get_regime_history(days: int = 365) -> dict:
    vix, y2, y10 = _regime_inputs(days=days)
    history = regime_model.regime_history(vix, y2, y10)
    transitions = regime_model.find_transitions(history, limit=10)
    return {
        "days": days,
        "history": history,
        "recent_transitions": transitions,
    }


# ---------- Regime Journal (Panel 2) ----------

@app.get("/api/journal/spx")
def get_spx_for_journal(days: int = 3650) -> dict:
    """SPX price history, paired with the per-day regime label over the same window."""
    spx = macro_data.fetch_series("^GSPC", days=days)
    vix, y2, y10 = _regime_inputs(days=days)
    history = regime_model.regime_history(vix, y2, y10)
    return {
        "days": days,
        "spx": spx,
        "regime_history": history,
        "segments": [
            {"label": s.label, "start": s.start, "end": s.end}
            for s in stress_test_mod.collapse_regime_history(history)
        ],
    }


class StressTestRequest(BaseModel):
    positions: list[dict]                # [{ticker, weight}]
    days: int = 3650                     # default ~10 years


@app.post("/api/portfolio/stress-test")
def post_stress_test(req: StressTestRequest) -> dict:
    vix, y2, y10 = _regime_inputs(days=req.days)
    history = regime_model.regime_history(vix, y2, y10)
    return stress_test_mod.stress_test(req.positions, history, days=req.days)


# ---------- Correlations (Panel 3) ----------

@app.get("/api/watchlist")
def get_watchlist() -> dict:
    return watchlist.watchlist_meta()


@app.get("/api/correlations")
def get_correlations(recent_days: int = 30, baseline_days: int = 365) -> dict:
    return correlation_model.compute_correlations(
        recent_days=recent_days,
        baseline_days=baseline_days,
    )


# ---------- SEC Filings (Panel 4) ----------

@app.get("/api/filings")
def get_filings(
    tickers: str = "",
    days: int = 30,
    forms: str = "",
) -> dict:
    """Recent SEC filings across a list of equity tickers.

    Query params:
      tickers — comma-separated. Empty → DEFAULT_EQUITIES_WATCHLIST.
      days    — lookback window in days. Default 30.
      forms   — comma-separated form types (8-K, 10-K, 10-Q, 4, etc.).
                Empty → all known form types.
    """
    ticker_list = (
        [t.strip().upper() for t in tickers.split(",") if t.strip()]
        if tickers
        else watchlist.DEFAULT_EQUITIES_WATCHLIST
    )
    form_list = [f.strip() for f in forms.split(",") if f.strip()] or None
    return sec_edgar.fetch_filings_batch(
        ticker_list,
        days=days,
        forms=form_list,
    )


@app.get("/api/filings/defaults")
def get_filings_defaults() -> dict:
    """Defaults the frontend uses to render the filings panel: equities
    watchlist, form-type metadata."""
    return {
        "default_tickers": watchlist.DEFAULT_EQUITIES_WATCHLIST,
        "form_meta": sec_edgar.FORM_TYPES,
    }


# ---------- Data Infrastructure (Panel 5) ----------

@app.get("/api/db/status")
def get_db_status() -> dict:
    """Counts + date ranges + recent ETL runs."""
    def _count(table: str) -> int:
        row = db_engine.fetchone(f"SELECT count(*) FROM {table}")
        return int(row[0]) if row else 0

    def _date_range(table: str, col: str = "date") -> dict:
        row = db_engine.fetchone(f"SELECT min({col}), max({col}) FROM {table}")
        return {"first": str(row[0]) if row and row[0] else None,
                "last":  str(row[1]) if row and row[1] else None}

    tables = {
        "instruments":            _count("instruments"),
        "prices_daily":           _count("prices_daily"),
        "fundamentals_quarterly": _count("fundamentals_quarterly"),
        "corporate_actions":      _count("corporate_actions"),
        "macro_series_history":   _count("macro_series_history"),
        "filings_archive":        _count("filings_archive"),
    }

    instrument_types = {
        t: int(n) for t, n in db_engine.fetchall(
            "SELECT COALESCE(type,'unknown') t, count(*) FROM instruments GROUP BY t ORDER BY count(*) DESC"
        )
    }

    price_range = _date_range("prices_daily")
    fundamentals_range = _date_range("fundamentals_quarterly", col="period_end")

    runs = db_engine.fetchall(
        """
        SELECT id, source, target, status, started_at, completed_at, rows_out, note
        FROM etl_runs
        ORDER BY started_at DESC
        LIMIT 25
        """
    )
    recent_runs = [
        {
            "id":           int(r[0]),
            "source":       r[1],
            "target":       r[2],
            "status":       r[3],
            "started_at":   str(r[4]) if r[4] else None,
            "completed_at": str(r[5]) if r[5] else None,
            "rows_out":     int(r[6]) if r[6] is not None else 0,
            "note":         r[7],
        }
        for r in runs
    ]

    return {
        "tables":            tables,
        "instrument_types":  instrument_types,
        "price_range":       price_range,
        "fundamentals_range": fundamentals_range,
        "recent_runs":       recent_runs,
        "db_path":           str(db_engine.db_path()),
    }


@app.get("/api/db/instruments/search")
def search_instruments(q: str = "", limit: int = 25) -> dict:
    q = q.strip()
    if not q:
        return {"results": []}
    like = f"%{q.lower()}%"
    rows = db_engine.fetchall(
        """
        SELECT symbol, cik, name, type, source
        FROM instruments
        WHERE lower(symbol) LIKE ? OR lower(name) LIKE ?
        ORDER BY
            CASE WHEN lower(symbol) = ? THEN 0
                 WHEN lower(symbol) LIKE ? THEN 1
                 ELSE 2 END,
            symbol
        LIMIT ?
        """,
        [like, like, q.lower(), q.lower() + "%", limit],
    )
    return {
        "results": [
            {"symbol": r[0], "cik": r[1], "name": r[2], "type": r[3], "source": r[4]}
            for r in rows
        ]
    }


@app.get("/api/db/prices")
def get_db_prices(symbol: str, days: int = 365) -> dict:
    symbol = symbol.upper().strip()
    rows = db_engine.fetchall(
        """
        SELECT date, open, high, low, close, adj_close, volume
        FROM prices_daily
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        [symbol, days],
    )
    points = [
        {
            "date":      str(r[0]),
            "open":      r[1],
            "high":      r[2],
            "low":       r[3],
            "close":     r[4],
            "adj_close": r[5],
            "volume":    r[6],
        }
        for r in reversed(rows)
    ]
    return {"symbol": symbol, "points": points, "count": len(points)}


@app.get("/api/db/fundamentals")
def get_db_fundamentals(symbol: str) -> dict:
    symbol = symbol.upper().strip()
    rows = db_engine.fetchall(
        """
        SELECT period_end, period_label,
               revenue, gross_profit, operating_income, net_income,
               eps_basic, eps_diluted,
               gross_margin, operating_margin, net_margin,
               operating_cash_flow, free_cash_flow,
               total_assets, total_equity, long_term_debt
        FROM fundamentals_quarterly
        WHERE symbol = ?
        ORDER BY period_end ASC
        """,
        [symbol],
    )
    quarters = [
        {
            "period_end":         str(r[0]),
            "period_label":       r[1],
            "revenue":            r[2],
            "gross_profit":       r[3],
            "operating_income":   r[4],
            "net_income":         r[5],
            "eps_basic":          r[6],
            "eps_diluted":        r[7],
            "gross_margin":       r[8],
            "operating_margin":   r[9],
            "net_margin":         r[10],
            "operating_cash_flow": r[11],
            "free_cash_flow":     r[12],
            "total_assets":       r[13],
            "total_equity":       r[14],
            "long_term_debt":     r[15],
        }
        for r in rows
    ]
    return {"symbol": symbol, "quarters": quarters, "count": len(quarters)}


# ---------- Ingest triggers ----------

@app.post("/api/ingest/universe")
def ingest_universe() -> dict:
    return ingest_instruments.bootstrap_universe()


@app.post("/api/ingest/prices")
def ingest_prices_endpoint(symbols: str, days: int = 3650) -> dict:
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return ingest_prices.backfill_symbols(sym_list, days=days)


@app.post("/api/ingest/fundamentals")
def ingest_fundamentals_endpoint(symbols: str) -> dict:
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return ingest_fundamentals.ingest_fundamentals_batch(sym_list)


# ---------- News (Panel 7) ----------

@app.get("/api/news/feed")
def get_news_feed(tickers: str = "", per_ticker: int = 8, overall: int = 60) -> dict:
    ticker_list = (
        [t.strip().upper() for t in tickers.split(",") if t.strip()]
        if tickers
        else watchlist.DEFAULT_EQUITIES_WATCHLIST
    )
    return news_mod.fetch_news_feed(ticker_list, per_ticker=per_ticker, overall=overall)


@app.get("/api/news/ticker/{symbol}")
def get_news_ticker(symbol: str, limit: int = 25) -> dict:
    items = news_mod.fetch_news_for_ticker(symbol.upper(), limit=limit)
    return {"symbol": symbol.upper(), "items": items, "count": len(items)}


# ---------- Options (Panel 8) ----------

@app.get("/api/options/vix-term")
def get_vix_term() -> dict:
    return options_mod.vix_term_structure()


@app.get("/api/options/chains")
def get_option_chains(tickers: str = "SPY,QQQ,AAPL,NVDA,TSLA,MSFT,GOOGL,AMZN", target_days: int = 30) -> dict:
    sym_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    return options_mod.chain_summaries(sym_list, target_days=target_days)


# ---------- Earnings (Panel 9) ----------

@app.get("/api/earnings/overview")
def get_earnings_overview(tickers: str = "") -> dict:
    ticker_list = (
        [t.strip().upper() for t in tickers.split(",") if t.strip()]
        if tickers
        else watchlist.DEFAULT_EQUITIES_WATCHLIST
    )
    return earnings_mod.fetch_overview(ticker_list)


@app.get("/api/earnings/{symbol}")
def get_earnings_ticker(symbol: str) -> dict:
    cal  = earnings_mod.fetch_calendar(symbol.upper())
    hist = earnings_mod.fetch_surprise_history(symbol.upper(), limit=12)
    return {**cal, "stats": hist["stats"], "events": hist["events"]}


# ---------- Briefing (SSE) ----------

class BriefingRequest(BaseModel):
    positions: list[dict] | None = None  # optional [{ticker, weight}]


def _sse_event(event_type: str, data: dict | str) -> str:
    payload = data if isinstance(data, str) else json.dumps(data)
    return f"event: {event_type}\ndata: {payload}\n\n"


async def _briefing_stream(positions: list[dict] | None) -> AsyncIterator[str]:
    # Gather context — done up front so errors surface as SSE events.
    try:
        all_macro = macro_data.fetch_all(days=90)
        vix = all_macro.get("^VIX", [])
        y2 = all_macro.get("DGS2", [])
        y10 = all_macro.get("DGS10", [])
        regime_state = regime_model.detect_current(vix, y2, y10).to_dict()
    except Exception as e:
        yield _sse_event("error", {"error": f"Context assembly failed: {e}"})
        yield _sse_event("done", {})
        return

    context = claude_briefing.assemble_context(
        regime_state=regime_state,
        macro_data=all_macro,
        positions=positions,
    )

    # Frontend shows the regime banner before tokens start streaming.
    yield _sse_event("regime", regime_state)

    try:
        async for chunk in claude_briefing.stream_briefing(context):
            yield _sse_event("token", {"text": chunk})
    except Exception as e:
        yield _sse_event("error", {"error": str(e)})
    yield _sse_event("done", {})


@app.post("/api/briefing/stream")
async def post_briefing_stream(req: BriefingRequest) -> StreamingResponse:
    return StreamingResponse(
        _briefing_stream(req.positions),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# GET variant — easier to test from a browser / curl.
@app.get("/api/briefing/stream")
async def get_briefing_stream() -> StreamingResponse:
    return StreamingResponse(
        _briefing_stream(None),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
