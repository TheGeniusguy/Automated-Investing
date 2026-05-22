"""FastAPI entrypoint for the Automated-Investing terminal backend."""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .briefing import claude_briefing, daily_briefing as daily_briefing_mod
from .chat import terminal_chat
from .config import settings
from .correlations import correlation_model
from .data import (
    calendar as calendar_mod,
    compare as compare_mod,
    drawings as drawings_mod,
    earnings as earnings_mod,
    eia_energy,
    fred_catalog,
    indicators as indicators_mod,
    insider_transactions as insider_mod,
    inflation as inflation_mod,
    institutional_holdings as inst_mod,
    layouts as layouts_mod,
    macro_data,
    macro_pins as macro_pins_mod,
    macro_snapshot,
    news as news_mod,
    nowcast as nowcast_mod,
    options as options_mod,
    real_estate_detail,
    recession as recession_mod,
    screener as screener_mod,
    sec_edgar,
    sector_detail,
    sector_kpis as sector_kpis_mod,
    sector_rotation,
    series_stats as series_stats_mod,
    shipping as shipping_mod,
    watchlist,
    watchlists_db,
    yield_curve as yield_curve_mod,
)
from .db import engine as db_engine
from .ingest import fundamentals as ingest_fundamentals
from .ingest import instruments as ingest_instruments
from .ingest import prices as ingest_prices
from .regime import regime_model, regime_model_v2, stress_test as stress_test_mod

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
def get_one_series(series_id: str, days: int = 365) -> dict:
    """Returns a series — either from the Panel-1 hardcoded set or any FRED/yfinance
    ID via the expanded catalog."""
    meta = macro_data.SERIES_META.get(series_id)
    if meta is None:
        cat_entry = fred_catalog.series_by_id(series_id)
        if cat_entry is not None:
            meta = {"label": cat_entry.label, "unit": cat_entry.unit, "source": "FRED"}
        else:
            meta = {"label": series_id, "unit": "", "source": "yfinance" if macro_data._looks_like_yf(series_id) else "FRED"}
    try:
        points = macro_data.fetch_series(series_id, days=days)
    except Exception as e:
        raise HTTPException(503, f"Failed to fetch {series_id}: {e}") from e
    return {
        "series_id": series_id,
        "meta": meta,
        "points": points,
    }


# ---------- Macro catalog (Panel 12) ----------

@app.get("/api/macro/catalog")
def get_macro_catalog() -> dict:
    return {
        "categories": fred_catalog.categories(),
        "order":      fred_catalog.CATEGORY_ORDER,
    }


@app.get("/api/macro/snapshot/{category}")
def get_macro_snapshot(category: str, days: int = 365) -> dict:
    if category not in fred_catalog.CATALOG:
        raise HTTPException(404, f"Unknown category: {category}")
    return macro_snapshot.snapshot_category(category, days=days)


@app.get("/api/macro/highlights")
def get_macro_highlights(days: int = 365, per_cat: int = 2) -> dict:
    return {"tiles": macro_snapshot.snapshot_all_highlights(days=days, per_cat=per_cat)}


# ---------- Energy Detail (Panel 13) ----------

@app.get("/api/energy/dashboard")
def get_energy_dashboard() -> dict:
    return eia_energy.fetch_full()


@app.get("/api/energy/section/{section}")
def get_energy_section(section: str) -> dict:
    return eia_energy.fetch_section(section)


# ---------- Shipping & Freight (Panel 14) ----------

@app.get("/api/shipping/dashboard")
def get_shipping_dashboard() -> dict:
    return shipping_mod.fetch_shipping()


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


# ---------- Daily Briefing (Panel 10) ----------

@app.get("/api/briefing/daily/cached")
def get_daily_briefing_cached() -> dict:
    cached = daily_briefing_mod.get_cached_briefing()
    return cached or {"summary": None, "context": None, "regime_label": None, "generated_at": None}


@app.get("/api/briefing/daily/history")
def get_daily_briefing_history(limit: int = 30) -> dict:
    return {"entries": daily_briefing_mod.list_briefings(limit=limit)}


@app.post("/api/briefing/daily/stream")
async def post_daily_briefing_stream() -> StreamingResponse:
    async def gen():
        async for event, data in daily_briefing_mod.stream_daily_briefing():
            yield f"event: {event}\ndata: {data}\n\n"
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- Ask the Terminal (Panel 11) ----------

@app.post("/api/chat/stream")
async def post_chat_stream(req: terminal_chat.ChatRequest) -> StreamingResponse:
    async def gen():
        async for event, data in terminal_chat.stream_chat(req.messages):
            yield f"event: {event}\ndata: {data}\n\n"
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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


# ──────────────────────────────────────────────────────────────────────────
# Wave 2: Watchlists (multi, DB-backed)
# ──────────────────────────────────────────────────────────────────────────

class WatchlistCreate(BaseModel):
    name: str
    description: str | None = None


class WatchlistUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_default: bool | None = None


class WatchlistItemAdd(BaseModel):
    ticker: str
    label: str | None = None
    group_name: str | None = None
    order_index: int | None = None


class WatchlistReorder(BaseModel):
    tickers: list[str]


@app.get("/api/watchlists")
def list_watchlists() -> dict:
    return {"watchlists": watchlists_db.list_watchlists()}


@app.post("/api/watchlists")
def create_watchlist(req: WatchlistCreate) -> dict:
    try:
        return watchlists_db.create_watchlist(req.name, req.description)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/watchlists/{watchlist_id}")
def get_watchlist(watchlist_id: int) -> dict:
    w = watchlists_db.get_watchlist(watchlist_id)
    if not w:
        raise HTTPException(status_code=404, detail="watchlist not found")
    return w


@app.patch("/api/watchlists/{watchlist_id}")
def update_watchlist(watchlist_id: int, req: WatchlistUpdate) -> dict:
    w = watchlists_db.update_watchlist(
        watchlist_id,
        name=req.name,
        description=req.description,
        is_default=req.is_default,
    )
    if not w:
        raise HTTPException(status_code=404, detail="watchlist not found")
    return w


@app.delete("/api/watchlists/{watchlist_id}")
def delete_watchlist(watchlist_id: int) -> dict:
    watchlists_db.delete_watchlist(watchlist_id)
    return {"ok": True}


@app.post("/api/watchlists/{watchlist_id}/items")
def add_watchlist_item(watchlist_id: int, req: WatchlistItemAdd) -> dict:
    try:
        return watchlists_db.add_item(
            watchlist_id,
            req.ticker,
            label=req.label,
            group_name=req.group_name,
            order_index=req.order_index,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/watchlists/{watchlist_id}/items/{ticker}")
def remove_watchlist_item(watchlist_id: int, ticker: str) -> dict:
    watchlists_db.remove_item(watchlist_id, ticker)
    return {"ok": True}


@app.post("/api/watchlists/{watchlist_id}/reorder")
def reorder_watchlist_items(watchlist_id: int, req: WatchlistReorder) -> dict:
    watchlists_db.reorder_items(watchlist_id, req.tickers)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
# Wave 2: Technical Indicators
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/indicators/{symbol}")
def get_indicator(
    symbol: str,
    indicator: str = "rsi",
    timeframe: str = "1d",
    period: int = 14,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
    std_dev: float = 2.0,
    k_period: int = 14,
    k_smooth: int = 3,
    d_period: int = 3,
    atr_period: int = 10,
    multiplier: float = 2.0,
    step: float = 0.02,
    max_step: float = 0.2,
    tenkan: int = 9,
    kijun: int = 26,
    senkou_b: int = 52,
    chikou_shift: int = 26,
    kind: str = "classic",
    days: int = 365,
) -> dict:
    try:
        return indicators_mod.compute(
            symbol, indicator, timeframe=timeframe, days=days,
            period=period, fast=fast, slow=slow, signal=signal,
            std_dev=std_dev, k_period=k_period, k_smooth=k_smooth,
            d_period=d_period, atr_period=atr_period, multiplier=multiplier,
            step=step, max_step=max_step, tenkan=tenkan, kijun=kijun,
            senkou_b=senkou_b, chikou_shift=chikou_shift, kind=kind,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class MultiIndicatorRequest(BaseModel):
    symbol: str
    indicators: list[str]
    timeframe: str = "1d"
    days: int = 365
    params: dict | None = None


@app.post("/api/indicators/multi")
def post_indicators_multi(req: MultiIndicatorRequest) -> dict:
    """Compute multiple indicators in one round-trip. Also returns OHLCV bars
    for the same timeframe so the frontend can draw candles + volume without
    a second request."""
    try:
        return indicators_mod.compute_many(
            req.symbol,
            req.indicators,
            timeframe=req.timeframe,
            days=req.days,
            params=req.params,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/indicators")
def get_indicator_meta() -> dict:
    """Metadata: which indicators are supported, used by the frontend."""
    return {
        "supported":  list(indicators_mod.SUPPORTED_INDICATORS),
        "timeframes": list(indicators_mod.TIMEFRAMES),
    }


# ──────────────────────────────────────────────────────────────────────────
# Wave 3: Events Calendar (no API key — hardcoded recurring schedule)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/calendar/week")
def get_calendar_week(reference_date: str | None = None) -> dict:
    """Events for the week containing `reference_date` (defaults to today)."""
    from datetime import date
    ref = date.fromisoformat(reference_date) if reference_date else None
    return calendar_mod.week_view(ref)


@app.get("/api/calendar/upcoming")
def get_calendar_upcoming(days_forward: int = 14) -> dict:
    return calendar_mod.upcoming(days_forward=days_forward)


# ──────────────────────────────────────────────────────────────────────────
# Wave 3: Chart drawings CRUD
# ──────────────────────────────────────────────────────────────────────────

class DrawingPoint(BaseModel):
    time: str
    price: float


class DrawingCreate(BaseModel):
    symbol: str
    timeframe: str = "1d"
    drawing_type: str
    points: list[DrawingPoint]
    style: dict | None = None
    label: str | None = None


class DrawingUpdate(BaseModel):
    points: list[DrawingPoint] | None = None
    style: dict | None = None
    label: str | None = None


@app.get("/api/drawings")
def list_drawings(symbol: str, timeframe: str = "1d") -> dict:
    return {"drawings": drawings_mod.list_drawings(symbol, timeframe)}


@app.post("/api/drawings")
def create_drawing(req: DrawingCreate) -> dict:
    try:
        return drawings_mod.create_drawing(
            req.symbol,
            req.drawing_type,
            [p.model_dump() for p in req.points],
            timeframe=req.timeframe,
            style=req.style,
            label=req.label,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/drawings/{drawing_id}")
def update_drawing(drawing_id: int, req: DrawingUpdate) -> dict:
    d = drawings_mod.update_drawing(
        drawing_id,
        points=[p.model_dump() for p in req.points] if req.points else None,
        style=req.style,
        label=req.label,
    )
    if not d:
        raise HTTPException(status_code=404, detail="drawing not found")
    return d


@app.delete("/api/drawings/{drawing_id}")
def delete_drawing(drawing_id: int) -> dict:
    drawings_mod.delete_drawing(drawing_id)
    return {"ok": True}


@app.delete("/api/drawings")
def clear_drawings(symbol: str, timeframe: str = "1d") -> dict:
    n = drawings_mod.clear_drawings(symbol, timeframe)
    return {"ok": True, "deleted": n}


# ──────────────────────────────────────────────────────────────────────────
# Wave 2: Sector Rotation
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/sector-rotation")
def get_sector_rotation() -> dict:
    return sector_rotation.dashboard()


# ──────────────────────────────────────────────────────────────────────────
# Sector Detail (drill-down per sector)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/sectors")
def get_sectors_list() -> dict:
    """Catalog of all sectors for sidebar rendering."""
    return {"sectors": sector_detail.list_sectors()}


@app.get("/api/sectors/overview")
def get_sectors_overview() -> dict:
    """All sectors with ETF-level returns -- no individual stocks."""
    return sector_detail.sector_overview()


@app.get("/api/sectors/{sector_id}")
def get_sector_detail(sector_id: str) -> dict:
    """Full drill-down: ETF + key stocks + fundamentals + related ETFs."""
    try:
        return sector_detail.sector_detail(sector_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/sectors/{sector_id}/kpis")
def get_sector_kpis(sector_id: str) -> dict:
    """Sector-specific KPIs: medians + per-stock breakdown.

    Returns curated metrics for each sector (e.g. Rule of 40 for tech,
    EV/EBITDA for O&G, P/B + ROE for banks, inventory days for semis).
    """
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    stocks = sec.get("key_stocks", [])
    return sector_kpis_mod.sector_kpis(sector_id, stocks)


# ──────────────────────────────────────────────────────────────────────────
# Real Estate Deep-Dive (sub-sector breakdown)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/real-estate/overview")
def get_re_overview() -> dict:
    """RE sector overview with benchmarks and sub-sector list."""
    return real_estate_detail.overview()


@app.get("/api/real-estate/subsectors")
def get_re_subsectors() -> dict:
    """List all RE sub-sectors."""
    return {"subsectors": real_estate_detail.list_subsectors()}


@app.get("/api/real-estate/{subsector_id}")
def get_re_subsector(subsector_id: str) -> dict:
    """Full drill-down for one RE sub-sector."""
    try:
        return real_estate_detail.subsector_detail(subsector_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ──────────────────────────────────────────────────────────────────────────
# Compare / Portfolio Simulator
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/compare")
def get_compare(tickers: str, days: int = 365) -> dict:
    """Compare 2+ tickers: normalized chart + metrics + correlation."""
    sym_list = [s.strip().upper() for s in tickers.split(",") if s.strip()]
    if len(sym_list) < 2:
        raise HTTPException(400, "Need at least 2 tickers")
    return compare_mod.compare(sym_list, days=days)


class PortfolioPosition(BaseModel):
    ticker: str
    weight: float


class PortfolioSimRequest(BaseModel):
    positions: list[PortfolioPosition]
    days: int = 365


@app.post("/api/compare/portfolio")
def post_portfolio_simulate(req: PortfolioSimRequest) -> dict:
    """Simulate a weighted portfolio and return blended metrics + equity curve."""
    positions = [{"ticker": p.ticker, "weight": p.weight} for p in req.positions]
    return compare_mod.portfolio_simulate(positions, days=req.days)


# ──────────────────────────────────────────────────────────────────────────
# Wave 2: Screener
# ──────────────────────────────────────────────────────────────────────────

class ScreenerFilter(BaseModel):
    key: str
    op: str = "eq"
    value: object  # number | str | list


class ScreenerRequest(BaseModel):
    filters: list[ScreenerFilter] = []
    sort: str = "symbol"
    sort_dir: str = "asc"
    limit: int = 100
    offset: int = 0


@app.get("/api/screener/schema")
def get_screener_schema() -> dict:
    return screener_mod.schema()


@app.post("/api/screener")
def run_screener(req: ScreenerRequest) -> dict:
    try:
        return screener_mod.run(
            filters=[f.model_dump() for f in req.filters],
            sort=req.sort,
            sort_dir=req.sort_dir,
            limit=req.limit,
            offset=req.offset,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ──────────────────────────────────────────────────────────────────────────
# Wave 4: Chart layouts (per symbol+timeframe state persistence)
# ──────────────────────────────────────────────────────────────────────────

class LayoutUpsert(BaseModel):
    symbol: str
    timeframe: str = "1d"
    state: dict


@app.get("/api/layouts/{symbol}")
def get_layout(symbol: str, timeframe: str = "1d") -> dict:
    layout = layouts_mod.get_layout(symbol, timeframe)
    if not layout:
        return {"symbol": symbol.upper(), "timeframe": timeframe, "state": None, "updated_at": None}
    return layout


@app.post("/api/layouts")
def post_layout(req: LayoutUpsert) -> dict:
    return layouts_mod.upsert_layout(req.symbol, req.timeframe, req.state)


@app.delete("/api/layouts/{symbol}")
def delete_layout(symbol: str, timeframe: str = "1d") -> dict:
    layouts_mod.delete_layout(symbol, timeframe)
    return {"ok": True}


# ──────────────────────────────────────────────────────────────────────────
# Wave 4: Chart event markers (news/earnings/filings/calendar for one ticker)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/chart-events/{symbol}")
def get_chart_events(symbol: str, days: int = 365) -> dict:
    """Aggregate timeline of events relevant to plotting on a price chart:
    - SEC filings for the ticker (from filings_archive)
    - Earnings dates (yfinance)
    - Economic calendar events that affect everything (from calendar module)
    Returns a unified list of {date, kind, label, impact, color} markers.
    """
    from datetime import date, timedelta
    sym = symbol.upper().strip()
    today = date.today()
    start = today - timedelta(days=days)

    markers: list[dict] = []

    # Filings — from DuckDB archive (no API call needed).
    rows = db_engine.fetchall(
        """
        SELECT filing_date, form, description
        FROM filings_archive
        WHERE symbol = ? AND filing_date >= ?
        ORDER BY filing_date DESC
        LIMIT 100
        """,
        [sym, start.isoformat()],
    )
    for r in rows:
        form = r[1] or "?"
        markers.append({
            "date":   str(r[0]),
            "kind":   "filing",
            "label":  form,
            "detail": r[2] or "",
            "impact": "high" if form in ("8-K", "10-Q", "10-K") else "low",
            "color":  "#fb7185",
        })

    # Earnings — try to pull from yfinance via earnings_mod if it exposes a per-ticker helper.
    try:
        if hasattr(earnings_mod, "ticker_earnings"):
            earn = earnings_mod.ticker_earnings(sym)
            for e in earn.get("events", []):
                markers.append({
                    "date":   e.get("date"),
                    "kind":   "earnings",
                    "label":  "Earnings",
                    "detail": e.get("note", ""),
                    "impact": "high",
                    "color":  "#ffb800",
                })
    except Exception:
        pass

    # Economic calendar — high/medium impact only on the chart (low is too noisy).
    cal = calendar_mod.events_in_range(start, today + timedelta(days=14))
    for e in cal:
        if e["impact"] == "low":
            continue
        markers.append({
            "date":   e["date"],
            "kind":   "macro",
            "label":  e["name"],
            "detail": e["market_impact"],
            "impact": e["impact"],
            "color":  "#a78bfa" if e["category"] == "monetary_policy" else "#26a69a",
        })

    markers.sort(key=lambda m: m["date"])
    return {"symbol": sym, "markers": markers}


# ─────────────────────────────────────────────────────────────────
# Wave 5: Mile-deep Macro
# ─────────────────────────────────────────────────────────────────

# ---- Yield curve ----

@app.get("/api/yield-curve/dashboard")
def yield_curve_dashboard() -> dict:
    return yield_curve_mod.dashboard()


@app.get("/api/yield-curve/current")
def yield_curve_current(real: bool = False) -> dict:
    return yield_curve_mod.current_curve(real=real)


@app.get("/api/yield-curve/historical")
def yield_curve_historical(date: str, real: bool = False) -> dict:
    return yield_curve_mod.historical_curve(date, real=real)


@app.get("/api/yield-curve/spread/{spread_id}")
def yield_curve_spread(spread_id: str, days: int = 365 * 5) -> dict:
    if spread_id not in yield_curve_mod.all_spread_ids():
        raise HTTPException(404, f"unknown spread '{spread_id}'")
    return yield_curve_mod.spread_series(spread_id, days=days)


@app.get("/api/yield-curve/butterfly/{bf_id}")
def yield_curve_butterfly(bf_id: str, days: int = 365 * 2) -> dict:
    if bf_id not in yield_curve_mod.all_butterfly_ids():
        raise HTTPException(404, f"unknown butterfly '{bf_id}'")
    return yield_curve_mod.butterfly_series(bf_id, days=days)


@app.get("/api/yield-curve/recession-probability")
def yield_curve_recession_prob(days: int = 365 * 30) -> dict:
    return {
        "current": yield_curve_mod.recession_probability_current(),
        "history": yield_curve_mod.recession_probability_history(days=days),
    }


@app.get("/api/yield-curve/term-premium")
def yield_curve_term_premium(days: int = 365 * 5) -> dict:
    return yield_curve_mod.term_premium_proxy(days=days)


# ---- Inflation ----

@app.get("/api/inflation/dashboard")
def inflation_dashboard() -> dict:
    return inflation_mod.dashboard()


@app.get("/api/inflation/momentum/{series_id}")
def inflation_momentum(series_id: str, years: int = 5) -> dict:
    return inflation_mod.momentum(series_id, years=years)


@app.get("/api/inflation/expectations")
def inflation_expectations() -> dict:
    return inflation_mod.inflation_expectations_curve()


@app.get("/api/inflation/decomposition")
def inflation_decomposition(days: int = 365 * 5) -> dict:
    return inflation_mod.real_yield_decomposition(days=days)


# ---- Recession ----

@app.get("/api/recession/dashboard")
def recession_dashboard() -> dict:
    return recession_mod.dashboard()


@app.get("/api/recession/sahm")
def recession_sahm(years: int = 30) -> dict:
    return recession_mod.sahm_rule(years=years)


@app.get("/api/recession/lei")
def recession_lei(years: int = 30) -> dict:
    return recession_mod.lei_proxy(years=years)


@app.get("/api/recession/composite")
def recession_composite() -> dict:
    return recession_mod.composite_score()


# ---- Nowcast ----

@app.get("/api/nowcast/dashboard")
def nowcast_dashboard() -> dict:
    return nowcast_mod.dashboard()


@app.get("/api/nowcast/gdpnow")
def nowcast_gdpnow() -> dict:
    return nowcast_mod.atlanta_fed_gdpnow()


@app.get("/api/nowcast/composite")
def nowcast_composite() -> dict:
    return nowcast_mod.composite()


# ---- Series stats + transforms ----

@app.get("/api/macro/series-detail/{series_id}")
def macro_series_detail(series_id: str, transform: str = "level", years: int = 20) -> dict:
    return series_stats_mod.get_series_with_stats(series_id, transform=transform, years=years)


@app.get("/api/macro/heatmap")
def macro_heatmap(transform: str = "z_score") -> dict:
    return series_stats_mod.heatmap_payload(transform=transform)


# ---- Regime v2 (5-state) ----

@app.get("/api/regime/v2")
def regime_v2() -> dict:
    return regime_model_v2.detect_current().to_dict()


# ---- Macro pinboards ----

class MacroBoardPayload(BaseModel):
    name: str
    description: str | None = None
    series_ids: list[str] = []


@app.get("/api/macro/boards")
def macro_boards_list() -> dict:
    return {"boards": macro_pins_mod.list_boards()}


@app.post("/api/macro/boards")
def macro_boards_create(payload: MacroBoardPayload) -> dict:
    return macro_pins_mod.create_board(
        payload.name, description=payload.description, series_ids=payload.series_ids,
    )


@app.get("/api/macro/boards/{board_id}")
def macro_boards_get(board_id: int) -> dict:
    b = macro_pins_mod.get_board(board_id)
    if not b:
        raise HTTPException(404, "board not found")
    return b


@app.patch("/api/macro/boards/{board_id}")
def macro_boards_update(board_id: int, payload: MacroBoardPayload) -> dict:
    b = macro_pins_mod.update_board(
        board_id,
        name=payload.name,
        description=payload.description,
        series_ids=payload.series_ids,
    )
    if not b:
        raise HTTPException(404, "board not found")
    return b


@app.delete("/api/macro/boards/{board_id}")
def macro_boards_delete(board_id: int) -> dict:
    ok = macro_pins_mod.delete_board(board_id)
    if not ok:
        raise HTTPException(404, "board not found")
    return {"ok": True}


@app.get("/api/macro/boards/{board_id}/snapshot")
def macro_boards_snapshot(board_id: int) -> dict:
    """Resolve a board into a full snapshot: per-series tile data."""
    b = macro_pins_mod.get_board(board_id)
    if not b:
        raise HTTPException(404, "board not found")
    tiles = [macro_snapshot.snapshot_series(sid) for sid in b["series_ids"]]
    return {"board": b, "tiles": tiles}


# ──────────────────────────────────────────────────────────────────────────
# Insider Transactions (SEC Form 4)
# ──────────────────────────────────────────────────────────────────────────

@app.post("/api/insider/ingest")
def ingest_insiders(tickers: str = "AAPL,MSFT,NVDA,GOOGL,TSLA,JPM,AMZN", days: int = 365) -> dict:
    """Fetch + parse Form 4 filings for the given tickers."""
    sym_list = [s.strip().upper() for s in tickers.split(",") if s.strip()]
    return insider_mod.ingest_insider_transactions(sym_list, days=days)


@app.get("/api/insider/{symbol}")
def get_insider_summary(symbol: str, days: int = 365) -> dict:
    """Insider activity summary for one ticker."""
    return insider_mod.ticker_summary(symbol, days=days)


@app.get("/api/insider/multi")
def get_insider_multi(tickers: str = "", days: int = 180) -> dict:
    """Quick insider overview across multiple tickers."""
    sym_list = [s.strip().upper() for s in tickers.split(",") if s.strip()]
    if not sym_list:
        from . data.watchlist import DEFAULT_EQUITIES_WATCHLIST
        sym_list = DEFAULT_EQUITIES_WATCHLIST
    return insider_mod.multi_ticker_summary(sym_list, days=days)


# ──────────────────────────────────────────────────────────────────────────
# 13F Institutional Holdings
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/institutional/filers")
def list_institutional_filers() -> dict:
    """List all tracked institutional filers with ingestion status."""
    return {"filers": inst_mod.list_tracked_filers()}


@app.post("/api/institutional/ingest")
def ingest_institutional(limit_per_filer: int = 1) -> dict:
    """Ingest latest 13F-HR for all tracked fund managers."""
    return inst_mod.ingest_all_top_filers(limit_per_filer=limit_per_filer)


@app.post("/api/institutional/ingest/{filer_cik}")
def ingest_institutional_filer(filer_cik: str, limit: int = 2) -> dict:
    """Ingest 13F for a specific filer by CIK."""
    filer = next((f for f in inst_mod.TOP_FILERS if f["cik"] == filer_cik), None)
    name = filer["name"] if filer else filer_cik
    return inst_mod.ingest_13f_for_filer(filer_cik, name, limit=limit)


@app.get("/api/institutional/holders/{symbol}")
def get_institutional_holders(symbol: str, limit: int = 20) -> dict:
    """Top institutional holders of a stock."""
    return inst_mod.top_holders(symbol=symbol, limit=limit)


@app.get("/api/institutional/portfolio/{filer_cik}")
def get_institutional_portfolio(filer_cik: str, report_date: str | None = None, limit: int = 50) -> dict:
    """Full portfolio for a fund manager."""
    return inst_mod.filer_portfolio(filer_cik, report_date=report_date, limit=limit)


@app.get("/api/institutional/changes/{filer_cik}")
def get_institutional_changes(filer_cik: str) -> dict:
    """QoQ position changes for a filer."""
    return inst_mod.filer_changes(filer_cik)
