"""FastAPI entrypoint for the Automated-Investing terminal backend."""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .briefing import claude_briefing, daily_briefing as daily_briefing_mod, sector_briefing as sector_briefing_mod
from .chat import terminal_chat
from .config import settings
from .correlations import correlation_model
from .data import (
    allocation_optimizer as allocation_mod,
    bond_analytics as bond_analytics_mod,
    breakevens as breakevens_mod,
    calendar as calendar_mod,
    cds_pricer as cds_pricer_mod,
    central_bank_rates as central_bank_rates_mod,
    commodity_spreads as commodity_spreads_mod,
    compare as compare_mod,
    comps_grid as comps_grid_mod,
    cot_positioning as cot_mod,
    crack_spreads as crack_spreads_mod,
    deals_monitor as deals_mod,
    dividends_tracker as dividends_tracker_mod,
    earnings_quality as earnings_quality_mod,
    economic_calendar as econ_calendar_mod,
    fear_greed as fear_greed_mod,
    net_liquidity as net_liquidity_mod,
    news_heat as news_heat_mod,
    news_sentiment as news_sentiment_mod,
    oas_curves as oas_curves_mod,
    options_strategy as options_strategy_mod,
    pairs_trading as pairs_mod,
    portfolio_risk as portfolio_risk_mod,
    reer as reer_mod,
    rrg as rrg_mod,
    taylor_rule as taylor_rule_mod,
    treasury_auctions as treasury_auctions_mod,
    vol_dashboard as vol_dashboard_mod,
    world_indices as world_indices_mod,
    commodities_curve as commodities_mod,
    credit_curves as credit_mod,
    crypto as crypto_mod,
    data_health as data_health_mod,
    drawings as drawings_mod,
    earnings as earnings_mod,
    econ_deep as econ_deep_mod,
    econ_surprise as econ_surprise_mod,
    eia_energy,
    estimates as estimates_mod,
    etf_tracking as etf_tracking_mod,
    factor_analysis as factor_mod,
    fixed_income as fixed_income_mod,
    fred_catalog,
    fx as fx_mod,
    fx_analytics as fx_analytics_mod,
    indicators as indicators_mod,
    insider_transactions as insider_mod,
    inflation as inflation_mod,
    institutional_holdings as inst_mod,
    layouts as layouts_mod,
    macro_data,
    macro_pins as macro_pins_mod,
    macro_snapshot,
    montecarlo as montecarlo_mod,
    news as news_mod,
    nowcast as nowcast_mod,
    options as options_mod,
    options_greeks as options_greeks_mod,
    rate_path as rate_path_mod,
    real_estate_detail,
    recession as recession_mod,
    screener as screener_mod,
    search as search_mod,
    seasonality as seasonality_mod,
    sec_edgar,
    sector_detail,
    sector_breadth as sector_breadth_mod,
    sector_kpis as sector_kpis_mod,
    sector_peer_comparison as sector_peer_comparison_mod,
    sector_macro_drivers as sector_macro_drivers_mod,
    sector_regime_playbook as sector_regime_playbook_mod,
    sector_rs as sector_rs_mod,
    sector_supply_chain as sector_supply_chain_mod,
    sector_operational as sector_operational_mod,
    sector_decomposition as sector_decomposition_mod,
    sector_risk as sector_risk_mod,
    sector_credit as sector_credit_mod,
    sector_flows as sector_flows_mod,
    sector_subindustry as sector_subindustry_mod,
    sector_rotation,
    series_stats as series_stats_mod,
    shipping as shipping_mod,
    short_interest as short_interest_mod,
    ticker_dossier as ticker_dossier_mod,
    unusual_whales as uw_mod,
    watchlist,
    watchlists_db,
    yield_curve as yield_curve_mod,
    superinvestors as superinvestors_mod,
    volume_profile as volume_profile_mod,
    social_sentiment as social_sentiment_mod,
    forward_rates as forward_rates_mod,
    carry_rolldown as carry_rolldown_mod,
    sovereign_bonds as sovereign_bonds_mod,
    financial_conditions as financial_conditions_mod,
    pmi_diffusion as pmi_diffusion_mod,
    unusual_options as unusual_options_mod,
    etf_flows as etf_flows_mod,
    dark_pool as dark_pool_mod,
    holdings_changes as holdings_changes_mod,
    swap_curve as swap_curve_mod,
    em_sovereign as em_sovereign_mod,
    natgas_storage as natgas_storage_mod,
    degree_days as degree_days_mod,
    macro_scorecard as macro_scorecard_mod,
    repo_funding as repo_funding_mod,
    rating_changes as rating_changes_mod,
    dupont_roe as dupont_roe_mod,
)
from .alerts import engine as alerts_mod
from .db import engine as db_engine
from .ingest import fundamentals as ingest_fundamentals
from .ingest import instruments as ingest_instruments
from .ingest import prices as ingest_prices
from .portfolio import crud as pcrud
from .portfolio.analytics import build_equity_curve, compute_performance_metrics
from .portfolio.dividends import compute_dividend_income
from .portfolio.fundamentals import enrich_fundamentals
from .portfolio.positions import compute_positions
from .portfolio.risk import compute_portfolio_risk
from .portfolio.valuation import enrich_positions
from .portfolio.comparison import compare_portfolios
from .portfolio import tax as ptax
from .portfolio import rebalancing as prebal
from .portfolio import csv_import as pcsv
from .portfolio import weighted as weighted_mod
from .portfolio import metrics_ext as metrics_ext_mod
from .portfolio import attribution as attribution_mod
from .portfolio import whatif as whatif_mod
from .portfolio import component_var as component_var_mod
from .portfolio import hedging as hedging_mod
from .paper import engine as paper_mod
from .proforma import model as proforma_mod
from . import backtest as backtest_mod  # package re-exports run_backtest + list_strategies
from .etf.compare import compare_tickers
from .compare import engine as compare_engine
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
    from .scheduler import start as _sched_start
    _sched_start()


@app.on_event("shutdown")
def _on_shutdown() -> None:
    from .scheduler import shutdown
    shutdown()

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
        "uw_configured": settings.has_unusual_whales,
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


@app.get("/api/data-health")
def get_data_health() -> dict:
    """Freshness of each persistent source, sqlite cache footprint, and the
    background scheduler job state."""
    return data_health_mod.health()


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


@app.post("/api/ingest/prices/universe")
def ingest_universe_prices(background_tasks: BackgroundTasks, days: int = 400) -> dict:
    """Warm prices_daily for the watchlist + holdings universe in the background
    (the sequential yfinance backfill takes minutes; don't block the request).
    Progress shows up in /api/data-health as rows land."""
    syms = ingest_prices.universe_symbols()
    background_tasks.add_task(ingest_prices.backfill_universe, days=days)
    return {
        "started": True,
        "symbols": len(syms),
        "note": "ingesting in background; watch /api/data-health for prices freshness",
    }


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


@app.get("/api/news/market")
def get_market_news(limit: int = 60, sources: str = "") -> dict:
    """Market-wide news feed from Unusual Whales. Degrades gracefully without a key."""
    return uw_mod.fetch_market_news(limit=limit, sources=sources or None)


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


@app.get("/api/sectors/{sector_id}/macro-drivers")
def get_sector_macro_drivers(sector_id: str) -> dict:
    """Rolling 90-day correlation between sector ETF and curated macro series.

    yfinance drivers always available. FRED drivers require FRED_API_KEY.
    """
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    etf = sec.get("etf", "SPY")
    return sector_macro_drivers_mod.sector_macro_drivers(sector_id, etf)


@app.get("/api/sectors/{sector_id}/supply-chain")
def get_sector_supply_chain(sector_id: str) -> dict:
    """Static upstream/downstream/correlated sector adjacency map."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_supply_chain_mod.supply_chain(sector_id, sector_detail.SECTORS)


@app.get("/api/sectors/{sector_id}/briefing/cached")
def get_sector_briefing_cached(sector_id: str) -> dict:
    """Today's cached sector briefing, if one was generated. None when missing."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    cached = sector_briefing_mod.get_cached_briefing(sector_id)
    return cached or {"sector_id": sector_id, "summary": None, "context": None, "date": None}


@app.post("/api/sectors/{sector_id}/briefing/stream")
async def post_sector_briefing_stream(sector_id: str) -> StreamingResponse:
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")

    async def _gen() -> AsyncIterator[str]:
        async for event, data in sector_briefing_mod.stream_sector_briefing(sector_id):
            yield _sse_event(event, data)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/sectors/{sector_id}/sub-industries")
def get_sector_sub_industries(sector_id: str) -> dict:
    """Editorial sub-industry decomposition for a sector. Returns per-group
    member tickers, total market cap, weight % of sector, cap-weighted returns
    across 1d/1w/1m/3m/ytd/1y, and top performer per window."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_subindustry_mod.sector_sub_industries(sector_id)


@app.get("/api/sectors/{sector_id}/flows")
def get_sector_flows(sector_id: str) -> dict:
    """Pair-spread dashboard + sector ETF options summary. Two pair spreads
    (vs SPY + vs sector's curated risk-on/off partner) with 1y normalized
    series. Options: 30d + 90d ATM IV, term-structure delta + inversion flag,
    P/C ratios, IV skew, implied move, IV-vs-realized ratio."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_flows_mod.sector_flows(sector_id)


@app.get("/api/sectors/{sector_id}/credit")
def get_sector_credit(sector_id: str) -> dict:
    """Sector-relevant credit conditions: broad IG/HY OAS, rating-tier ladder,
    universal bond ETFs, sector-specific FRED sector indices when available,
    plus credit-equity divergence indicator (rolling 60D correlation of sector
    returns vs HY OAS changes vs 5y baseline)."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_credit_mod.sector_credit(sector_id)


@app.get("/api/sectors/{sector_id}/risk")
def get_sector_risk(sector_id: str) -> dict:
    """10-year drawdown analytics, tail-risk metrics, vol regime, and rolling
    sector-SPY correlation z-score. Drawdown troughs are tagged with the
    macro regime active when they hit (requires FRED key)."""
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_risk_mod.sector_risk(sector_id)


@app.get("/api/sectors/{sector_id}/decomposition")
def get_sector_decomposition(sector_id: str) -> dict:
    """Constituent decomposition: cap-weighted contribution per window, if-removed
    simulator, Herfindahl concentration, and hidden-weakness detector for the
    sector's curated key_stocks list.
    """
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_decomposition_mod.sector_decomposition(sector_id)


@app.get("/api/sectors/{sector_id}/operational")
def get_sector_operational(sector_id: str) -> dict:
    """Operational KPIs (the "factory dashboard") for one sector.

    Per-sector curated industry inputs: oil inventories for energy, mortgage
    market for real estate, ISM new orders for industrials, etc. Returns
    bucketed tiles with sparklines and 1d/1w/1m/3m/ytd change. FRED KPIs
    degrade gracefully when FRED_API_KEY is absent.
    """
    if sector_id not in sector_detail.SECTORS:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    return sector_operational_mod.sector_operational(sector_id)


@app.get("/api/sectors/{sector_id}/relative-strength")
def get_sector_relative_strength(sector_id: str, benchmark: str = "SPY") -> dict:
    """Rolling 20d and 60d relative strength of sector ETF vs SPY (or custom benchmark).

    Returns normalized raw RS + two rolling momentum series for charting.
    Values above 1.0 = outperforming; below = underperforming.
    """
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    etf = sec.get("etf", "SPY")
    return sector_rs_mod.sector_relative_strength(sector_id, etf, benchmark=benchmark)


@app.get("/api/sectors/{sector_id}/news")
def get_sector_news(sector_id: str, per_ticker: int = 5, limit: int = 30) -> dict:
    """Latest news for all key stocks in a sector, merged and deduped."""
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    stocks = sec.get("key_stocks", [])
    return news_mod.fetch_news_feed(stocks, per_ticker=per_ticker, overall=limit)


@app.get("/api/sectors/{sector_id}/earnings")
def get_sector_earnings(sector_id: str) -> dict:
    """Upcoming earnings calendar for all key stocks in a sector."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from datetime import date

    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    stocks = sec.get("key_stocks", [])

    calendars: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(earnings_mod.fetch_calendar, sym): sym for sym in stocks}
        for fut in as_completed(futures):
            try:
                calendars.append(fut.result())
            except Exception:
                pass

    today = date.today().isoformat()
    # Sort: upcoming first, then past/None
    def _sort_key(c: dict):
        d = c.get("next_earnings")
        if d and d >= today:
            return (0, d)
        return (1, d or "9999")

    calendars.sort(key=_sort_key)
    return {
        "sector_id": sector_id,
        "today": today,
        "calendars": calendars,
    }


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


@app.get("/api/sectors/{sector_id}/peer-comparison")
def get_sector_peer_comparison(sector_id: str) -> dict:
    """YTD price series for all sector stocks + ETF, normalized to 100 at Jan 1."""
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    stocks = sec.get("key_stocks", [])
    etf = sec.get("etf", "SPY")
    return sector_peer_comparison_mod.sector_peer_comparison(sector_id, stocks, etf)


@app.get("/api/sectors/{sector_id}/breadth")
def get_sector_breadth(sector_id: str) -> dict:
    """Breadth indicators: % above 50/200MA, % at 52w high/low, avg distance from 52w high."""
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    stocks = sec.get("key_stocks", [])
    return sector_breadth_mod.sector_breadth(sector_id, stocks)


@app.get("/api/sectors/{sector_id}/regime-playbook")
def get_sector_regime_playbook(sector_id: str) -> dict:
    """Historical avg return + beat rate vs SPY per regime state for this sector ETF."""
    sec = sector_detail.SECTORS.get(sector_id)
    if sec is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector: {sector_id}")
    etf = sec.get("etf", "SPY")
    # get current regime from the live regime endpoint
    try:
        from .regime import regime_model
        current = regime_model.current_regime().get("regime", "unknown")
    except Exception:
        current = "unknown"
    return sector_regime_playbook_mod.sector_regime_playbook(sector_id, etf, current)


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
# Unified search + single-ticker dossier (command palette + fused panel)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/search")
def get_search(q: str = "", limit: int = 20) -> dict:
    """Merged ticker + FRED-series search. Powers the command palette."""
    return search_mod.search(q, limit=limit)


@app.get("/api/ticker/{symbol}/dossier")
def get_ticker_dossier(symbol: str) -> dict:
    """Single-ticker dossier — price + profile + fundamentals + technicals +
    news + filings + options fused into one payload."""
    return ticker_dossier_mod.build_dossier(symbol.upper())


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


# ---- Deep economic data (v2 Feature F) ----

@app.get("/api/economy/deep")
def economy_deep() -> dict:
    return econ_deep_mod.deep_economy()


@app.get("/api/economy/category/{cat}")
def economy_category(cat: str) -> dict:
    return econ_deep_mod.econ_category(cat)


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


@app.get("/api/insiders/market")
def get_market_insiders(
    limit: int = 100,
    direction: str = "all",
    min_value: float = 0.0,
    ticker: str = "",
) -> dict:
    """Market-wide insider buying/selling from Unusual Whales. Degrades gracefully without a key."""
    return uw_mod.fetch_market_insiders(
        limit=limit,
        direction=direction,
        min_value=min_value,
        ticker=ticker or None,
    )


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


# ──────────────────────────────────────────────────────────────────────────
# Portfolio Module
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio")
def list_portfolios() -> list:
    return pcrud.list_portfolios()


@app.post("/api/portfolio")
def create_portfolio(body: dict) -> dict:
    # body: {name, description?, cash_balance?}
    return pcrud.create_portfolio(
        name=body["name"],
        description=body.get("description"),
        cash_balance=float(body.get("cash_balance", 0.0)),
    )


@app.delete("/api/portfolio/{portfolio_id}")
def delete_portfolio(portfolio_id: int) -> dict:
    ok = pcrud.delete_portfolio(portfolio_id)
    return {"ok": ok}


@app.get("/api/portfolio/{portfolio_id}/overview")
def portfolio_overview(portfolio_id: int) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, total_realized, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    try:
        metrics = compute_performance_metrics(txns, pf["cash_balance"])
    except Exception as e:
        log.warning("portfolio_overview metrics failed for %s: %s", portfolio_id, e)
        metrics = {}
    return {"portfolio": pf, "summary": summary, "metrics": metrics}


@app.get("/api/portfolio/{portfolio_id}/positions")
def portfolio_positions(portfolio_id: int) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, total_realized, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    return {"positions": enriched, "summary": summary}


@app.get("/api/portfolio/{portfolio_id}/performance")
def portfolio_performance(portfolio_id: int, days: int = 365) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    curve = build_equity_curve(txns, pf["cash_balance"], lookback_days=days)
    metrics = compute_performance_metrics(txns, pf["cash_balance"], lookback_days=days)
    return {"curve": curve, "metrics": metrics}


@app.get("/api/portfolio/{portfolio_id}/risk")
def portfolio_risk(portfolio_id: int, days: int = 252) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    risk = compute_portfolio_risk(enriched, lookback_days=days)
    return risk


@app.get("/api/portfolio/{portfolio_id}/fundamentals")
def portfolio_fundamentals(portfolio_id: int) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, _ = enrich_positions(positions, current_cash)
    symbols = [p["symbol"] for p in enriched]
    fundamentals = enrich_fundamentals(symbols)
    return {"fundamentals": fundamentals, "symbols": symbols}


@app.get("/api/portfolio/{portfolio_id}/dividends")
def portfolio_dividends(portfolio_id: int) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    div_data = compute_dividend_income(enriched)
    return div_data


@app.get("/api/portfolio/{portfolio_id}/allocation")
def portfolio_allocation(portfolio_id: int) -> dict:
    from collections import defaultdict
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    sectors: dict[str, float] = defaultdict(float)
    for p in enriched:
        sec = p.get("sector") or "Unknown"
        sectors[sec] += p.get("portfolio_weight", 0.0)
    sector_list = [{"sector": k, "weight_pct": round(v, 2)} for k, v in sectors.items()]
    sector_list.sort(key=lambda x: -x["weight_pct"])
    cash_pct = summary.get("cash_pct", 0.0)
    return {
        "sectors": sector_list,
        "cash_pct": cash_pct,
        "total_value": summary.get("total_value"),
    }


@app.get("/api/portfolio/{portfolio_id}/transactions")
def get_portfolio_transactions(portfolio_id: int) -> list:
    return pcrud.get_transactions(portfolio_id)


@app.get("/api/portfolio/compare")
def portfolio_compare(ids: str, days: int = 365):
    # ids is comma-separated: "1,2,3"
    portfolio_ids = [int(x.strip()) for x in ids.split(",") if x.strip()]
    if len(portfolio_ids) < 1:
        raise HTTPException(400, "Provide at least one portfolio id")
    return compare_portfolios(portfolio_ids, lookback_days=days)


@app.get("/api/etf/compare")
def etf_compare(symbols: str, days: int = 252, benchmark: str = "SPY"):
    # symbols is comma-separated: "SPY,QQQ,IWM"
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not syms:
        raise HTTPException(400, "Provide at least one symbol")
    return compare_tickers(syms, lookback_days=days, benchmark=benchmark)


# ──────────────────────────────────────────────────────────────────────────
# v2 Feature A: Advanced analytics metrics
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/analytics/advanced")
def analytics_advanced(symbol: str = "SPY", benchmark: str = "SPY", days: int = 756) -> dict:
    from datetime import datetime, timezone

    def _simple_returns(sym: str) -> list[float]:
        pts = macro_data.fetch_arbitrary_ticker(sym, days=days)
        vals = [p["value"] for p in pts if p.get("value") is not None]
        rets: list[float] = []
        for i in range(1, len(vals)):
            prev = vals[i - 1]
            if prev:
                rets.append(vals[i] / prev - 1.0)
        return rets

    sym_returns = _simple_returns(symbol)
    bench_returns = _simple_returns(benchmark)
    metrics = metrics_ext_mod.compute_extended_metrics(sym_returns, bench_returns)
    rolling_sharpe = metrics.get("rolling_sharpe", []) if isinstance(metrics, dict) else []
    return {
        "symbol": symbol,
        "benchmark": benchmark,
        "days": days,
        "metrics": metrics,
        "rolling_sharpe": rolling_sharpe,
        "data_mode": "live" if sym_returns else "sample",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "source": "yfinance",
    }


@app.get("/api/analytics/catalog")
def analytics_catalog() -> dict:
    return {"metrics": metrics_ext_mod.validate_available_metrics()}


# ──────────────────────────────────────────────────────────────────────────
# v2 Feature B: Paper trading portfolio
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/paper/portfolios")
def paper_portfolios() -> list:
    return paper_mod.list_paper_portfolios()


@app.post("/api/paper/portfolios")
def paper_create(body: dict) -> dict:
    # body: {name, starting_cash?}
    return paper_mod.create_paper_portfolio(
        name=body["name"],
        starting_cash=float(body.get("starting_cash", 100000)),
    )


@app.get("/api/paper/portfolios/{pid}")
def paper_overview(pid: int) -> dict:
    return paper_mod.get_paper_overview(pid)


@app.post("/api/paper/portfolios/{pid}/orders")
def paper_order(pid: int, body: dict) -> dict:
    # body: {symbol, side, quantity, order_type?, limit_price?}
    return paper_mod.place_paper_order(
        pid,
        symbol=body["symbol"],
        side=body["side"],
        quantity=float(body["quantity"]),
        order_type=body.get("order_type", "market"),
        limit_price=body.get("limit_price"),
    )


@app.post("/api/paper/portfolios/{pid}/reset")
def paper_reset(pid: int) -> dict:
    return paper_mod.reset_paper_portfolio(pid)


# ──────────────────────────────────────────────────────────────────────────
# v2 Feature C: Weighted / model portfolio tracking
# ──────────────────────────────────────────────────────────────────────────

@app.post("/api/weighted/analyze")
def weighted_analyze(body: dict) -> dict:
    # body: {holdings, days?, benchmark?, notional?}
    return weighted_mod.analyze_weighted_portfolio(
        body["holdings"],
        days=int(body.get("days", 365)),
        benchmark=body.get("benchmark", "SPY"),
        notional=float(body.get("notional", 100000)),
    )


@app.get("/api/weighted/sample")
def weighted_sample(days: int = 365) -> dict:
    return weighted_mod.analyze_weighted_portfolio(weighted_mod.SAMPLE_MODEL_BOOK, days=days)


# ──────────────────────────────────────────────────────────────────────────
# v2 Feature D: ETF tracking dashboard
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/etf/track")
def etf_track(symbols: str = "SPY,QQQ,IWM,DIA", days: int = 365) -> dict:
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return etf_tracking_mod.track_etfs(syms, days=days)


# ──────────────────────────────────────────────────────────────────────────
# v2 Feature E: IB-level Pro Forma modeling
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/proforma")
def proforma(ticker: str = "AAPL") -> dict:
    return proforma_mod.proforma_overview(ticker)


# ── Cross-Asset: Crypto / FX / Fixed Income ──────────────────────────────────
@app.get("/api/crypto/overview")
def crypto_overview() -> dict:
    return crypto_mod.overview()


@app.get("/api/crypto/compare")
def crypto_compare(symbols: str = "BTC-USD,ETH-USD", days: int = 365) -> dict:
    # symbols is comma-separated: "BTC-USD,ETH-USD,SOL-USD"
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    if not syms:
        raise HTTPException(400, "Provide at least one symbol")
    return crypto_mod.compare(syms, days=days)


@app.get("/api/fx/matrix")
def fx_matrix() -> dict:
    return fx_mod.matrix()


@app.get("/api/fixed-income/overview")
def fixed_income_overview() -> dict:
    return fixed_income_mod.overview()


@app.post("/api/portfolio/{portfolio_id}/transactions")
def add_portfolio_transaction(portfolio_id: int, body: dict) -> dict:
    from datetime import date as _date
    return pcrud.add_transaction(
        portfolio_id=portfolio_id,
        symbol=body["symbol"],
        trade_date=body.get("trade_date", str(_date.today())),
        trade_type=body["trade_type"],
        quantity=float(body["quantity"]),
        price=float(body["price"]),
        commission=float(body.get("commission", 0.0)),
        notes=body.get("notes"),
    )


@app.delete("/api/portfolio/{portfolio_id}/transactions/{txn_id}")
def delete_portfolio_transaction(portfolio_id: int, txn_id: int) -> dict:
    ok = pcrud.delete_transaction(portfolio_id, txn_id)
    return {"ok": ok}


# ── Portfolio: tax, rebalancing, regime-stress, CSV import ───────────────────
@app.get("/api/portfolio/{portfolio_id}/tax")
def portfolio_tax(portfolio_id: int, year: int | None = None) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    summary = ptax.tax_summary(txns, year=year)
    try:
        positions, _, cash_delta = compute_positions(txns)
        enriched, _ = enrich_positions(positions, pf["cash_balance"] + cash_delta)
        tlh = ptax.tlh_candidates(enriched)
    except Exception as e:
        log.warning("portfolio_tax tlh failed for %s: %s", portfolio_id, e)
        tlh = []
    return {"summary": summary, "tlh": tlh}


class RebalanceRequest(BaseModel):
    targets: dict[str, float]
    threshold_pct: float = 5.0


@app.post("/api/portfolio/{portfolio_id}/rebalance")
def portfolio_rebalance(portfolio_id: int, body: RebalanceRequest) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    current_cash = pf["cash_balance"] + cash_delta
    enriched, summary = enrich_positions(positions, current_cash)
    return prebal.suggest_rebalance(
        enriched,
        targets=body.targets,
        total_value=summary.get("total_value", 0.0),
        cash_balance=current_cash,
        threshold_pct=body.threshold_pct,
    )


@app.get("/api/portfolio/{portfolio_id}/regime-stress")
def portfolio_regime_stress(portfolio_id: int, days: int = 365) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    txns = pcrud.get_transactions(portfolio_id)
    positions, _, cash_delta = compute_positions(txns)
    enriched, _ = enrich_positions(positions, pf["cash_balance"] + cash_delta)
    stress_positions = [
        {"ticker": p["symbol"], "weight": (p.get("portfolio_weight") or 0.0) / 100.0}
        for p in enriched
    ]
    try:
        vix = macro_data.fetch_series("^VIX", days=days)
        y2 = macro_data.fetch_series("DGS2", days=days)
        y10 = macro_data.fetch_series("DGS10", days=days)
        history = regime_model.regime_history(vix, y2, y10)
    except Exception as e:
        log.warning("regime-stress history failed for %s: %s", portfolio_id, e)
        history = []
    return stress_test_mod.stress_test(stress_positions, history, days=days)


class CsvImportPreview(BaseModel):
    csv: str


class CsvImportCommit(BaseModel):
    rows: list[dict]


@app.post("/api/portfolio/{portfolio_id}/import/preview")
def portfolio_import_preview(portfolio_id: int, body: CsvImportPreview) -> dict:
    return pcsv.parse_csv(body.csv)


@app.post("/api/portfolio/{portfolio_id}/import")
def portfolio_import_commit(portfolio_id: int, body: CsvImportCommit) -> dict:
    pf = pcrud.get_portfolio(portfolio_id)
    if not pf:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    return pcrud.bulk_insert_transactions(portfolio_id, body.rows)


# ──────────────────────────────────────────────────────────────────────────
# Cross-asset investment return comparator
# ──────────────────────────────────────────────────────────────────────────

class CompareInvestmentsRequest(BaseModel):
    investments: list[dict]


@app.post("/api/compare/investments")
def compare_investments_route(body: CompareInvestmentsRequest) -> dict:
    """Compare heterogeneous investments (real estate / market / custom)
    side-by-side on an apples-to-apples basis (IRR, CAGR, total return,
    equity multiple) with a normalized equity-value-over-time overlay."""
    return compare_engine.compare_investments(body.investments)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave C: Options greeks + vol surface + GEX / max-pain
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/options/greeks/{symbol}")
def options_greeks(symbol: str) -> dict:
    return options_greeks_mod.greeks_ladder(symbol)


@app.get("/api/options/surface/{symbol}")
def options_surface(symbol: str) -> dict:
    return options_greeks_mod.build_surface(symbol)


@app.get("/api/options/gex/{symbol}")
def options_gex(symbol: str) -> dict:
    return options_greeks_mod.gamma_exposure(symbol)


@app.get("/api/options/max-pain/{symbol}")
def options_max_pain(symbol: str) -> dict:
    return options_greeks_mod.max_pain(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave C: Fed rate path / WIRP
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/rates/path")
def rates_path() -> dict:
    return rate_path_mod.rate_path()


@app.get("/api/rates/probabilities")
def rates_probabilities() -> dict:
    return rate_path_mod.rate_probabilities()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave C: Strategy backtester
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/backtest/strategies")
def backtest_strategies() -> list:
    return backtest_mod.list_strategies()


@app.post("/api/backtest/run")
def backtest_run(body: dict) -> dict:
    # body: {symbol, strategy, params?, start?, end?, capital?}
    return backtest_mod.run_backtest(
        body["symbol"],
        body["strategy"],
        body.get("params", {}),
        body.get("start"),
        body.get("end"),
        capital=float(body.get("capital", 100000)),
    )


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave C: Bond analytics / YAS
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/bonds/universe")
def bonds_universe() -> dict:
    return bond_analytics_mod.bond_universe()


@app.post("/api/bonds/analyze")
def bonds_analyze(body: dict) -> dict:
    # body: {face, coupon, maturity, freq?, ytm|price}
    is_price = "price" in body
    return bond_analytics_mod.analyze_bond(
        face=float(body["face"]),
        coupon=float(body["coupon"]),
        maturity=float(body["maturity"]),
        freq=int(body.get("freq", 2)),
        ytm_or_price=float(body["price"]) if is_price else float(body["ytm"]),
        is_price=is_price,
    )


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave C: COT positioning
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/cot/markets")
def cot_markets() -> dict:
    return cot_mod.positioning_dashboard()


@app.get("/api/cot/{market}")
def cot_market_series(market: str) -> dict:
    return cot_mod.cot_series(market)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave D: FX carry, forwards & vol
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/fx/carry")
def fx_carry() -> dict:
    return fx_analytics_mod.fx_carry_table()


@app.get("/api/fx/vol/{pair}")
def fx_vol(pair: str) -> dict:
    return fx_analytics_mod.fx_vol_cone(pair)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave D: Commodities term structure
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/commodities/curves")
def commodities_curves() -> dict:
    return commodities_mod.commodity_curves()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave D: Analyst estimates & revisions
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/estimates/{symbol}")
def estimates(symbol: str) -> dict:
    return estimates_mod.estimates(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave D: Credit & CDS curves
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/credit/curves")
def credit_curves() -> dict:
    return credit_mod.credit_curves()


@app.get("/api/credit/{issuer}")
def issuer_credit(issuer: str) -> dict:
    return credit_mod.issuer_credit(issuer)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave D: Alerts engine
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/alerts/rules")
def alerts_rules() -> dict:
    return alerts_mod.list_rules()


@app.post("/api/alerts/rules")
def alerts_create_rule(body: dict) -> dict:
    return alerts_mod.create_rule(body)


@app.delete("/api/alerts/rules/{rid}")
def alerts_delete_rule(rid: int) -> dict:
    return alerts_mod.delete_rule(rid)


@app.post("/api/alerts/evaluate")
def alerts_evaluate() -> dict:
    return alerts_mod.evaluate_rules()


@app.get("/api/alerts/events")
def alerts_events() -> dict:
    return alerts_mod.list_events()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave E: Economic surprise index
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/econ-surprise")
def econ_surprise() -> dict:
    return econ_surprise_mod.surprise_index()


@app.get("/api/econ-surprise/{region}")
def econ_surprise_region(region: str) -> dict:
    return econ_surprise_mod.surprise_index(region)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave E: Seasonality
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/seasonality/{symbol}")
def seasonality(symbol: str) -> dict:
    return seasonality_mod.seasonality(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave E: Factor / style analysis
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/factors/{symbol}")
def factor_exposures(symbol: str) -> dict:
    return factor_mod.factor_exposures(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave E: Monte Carlo risk simulation
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/montecarlo/{symbol}")
def montecarlo(symbol: str) -> dict:
    return montecarlo_mod.monte_carlo(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave E: Short interest & squeeze
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/short-interest/{symbol}")
def short_interest(symbol: str) -> dict:
    return short_interest_mod.short_interest(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave F: M&A / Deals Monitor (MA)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/deals")
def deals() -> dict:
    return deals_mod.deals_monitor()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave F: Options Strategy Builder (OSA)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/options-strategy-list")
def options_strategy_list() -> dict:
    return options_strategy_mod.list_strategies()


@app.get("/api/options-strategy/{symbol}")
def options_strategy(symbol: str, strategy: str = "bull_call_spread") -> dict:
    return options_strategy_mod.build_strategy(symbol, strategy)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave F: Economic Calendar (ECO)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/econ-calendar")
def econ_calendar() -> dict:
    return econ_calendar_mod.economic_calendar()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave F: Pairs / Relative Value
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/pairs-screen")
def pairs_screen() -> dict:
    return pairs_mod.pairs_screen()


@app.get("/api/pairs/{sym1}/{sym2}")
def pairs(sym1: str, sym2: str) -> dict:
    return pairs_mod.pairs_analysis(sym1, sym2)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave F: Allocation Optimizer / Risk Parity (PORT)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/allocation-optimizer")
def allocation_optimizer(symbols: str | None = None, method: str = "risk_parity") -> dict:
    return allocation_mod.optimize(symbols, method)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave G: Relative Rotation Graph (RRG)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/rrg")
def rrg(benchmark: str = "SPY") -> dict:
    return rrg_mod.rrg(benchmark)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave G: Volatility & Risk Dashboard (VIX/VOL)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/vol-dashboard")
def vol_dashboard() -> dict:
    return vol_dashboard_mod.vol_dashboard()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave G: World Equity Indices Monitor (WEI)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/world-indices")
def world_indices() -> dict:
    return world_indices_mod.world_indices()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave G: Portfolio Risk / VaR & Stress (PORT risk)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio-risk")
def portfolio_risk(symbols: str | None = None, weights: str | None = None) -> dict:
    return portfolio_risk_mod.portfolio_risk(symbols, weights)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave G: Dividend & Buyback / Shareholder Yield (DVD)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/dividends-tracker")
def dividends_tracker() -> dict:
    return dividends_tracker_mod.dividends_tracker()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave H: Relative Valuation Comps Grid (RV)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/comps/{symbol}")
def comps(symbol: str) -> dict:
    return comps_grid_mod.comps_grid(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave H: Global Central-Bank Policy-Rate Monitor (WIRP)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/central-bank-rates")
def central_bank_rates() -> dict:
    return central_bank_rates_mod.central_bank_rates()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave H: Treasury Auction Calendar & Results
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/treasury-auctions")
def treasury_auctions() -> dict:
    return treasury_auctions_mod.treasury_auctions()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave H: Fed Net-Liquidity Monitor (FARBAST)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/net-liquidity")
def net_liquidity() -> dict:
    return net_liquidity_mod.net_liquidity()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave H: Per-Ticker NLP News Sentiment (NSTM)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/news-sentiment/{symbol}")
def news_sentiment(symbol: str) -> dict:
    return news_sentiment_mod.news_sentiment(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave I: Earnings-Quality Scorecard (Piotroski/Altman/Beneish)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/earnings-quality/{symbol}")
def earnings_quality(symbol: str) -> dict:
    return earnings_quality_mod.earnings_quality(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave I: Market-Wide Fear & Greed Index
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/fear-greed")
def fear_greed() -> dict:
    return fear_greed_mod.fear_greed()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave I: Crack Spreads & Refining Margins (CRK)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/crack-spreads")
def crack_spreads() -> dict:
    return crack_spreads_mod.crack_spreads()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave I: Inter-Commodity Spreads & Ratios
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/commodity-spreads")
def commodity_spreads() -> dict:
    return commodity_spreads_mod.commodity_spreads()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave I: Taylor Rule / Policy-Rule Estimator (TAYL)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/taylor-rule")
def taylor_rule() -> dict:
    return taylor_rule_mod.taylor_rule()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave J: Corporate OAS Term-Structure by Rating (SPRD)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/oas-curves")
def oas_curves() -> dict:
    return oas_curves_mod.oas_curves()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave J: Breakeven Inflation & Real-Yield Curve (BEI)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/breakevens")
def breakevens() -> dict:
    return breakevens_mod.breakevens()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave J: REER & PPP Fair-Value Monitor (REER)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/reer")
def reer() -> dict:
    return reer_mod.reer()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave J: Single-Name CDS Pricer (CDSW)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/cds-pricer")
def cds_pricer(
    spread_bps: float = 100.0,
    recovery: float = 0.40,
    tenor_years: float = 5.0,
    coupon_bps: float = 100.0,
    notional: float = 10_000_000.0,
) -> dict:
    return cds_pricer_mod.cds_pricer(spread_bps, recovery, tenor_years, coupon_bps, notional)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave J: News-Heat / Abnormal News-Volume Detector (NH)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/news-heat")
def news_heat() -> dict:
    return news_heat_mod.news_heat()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave K: Superinvestor / Smart-Money Clone Tracker (13F)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/superinvestors")
def superinvestors() -> dict:
    return superinvestors_mod.superinvestors()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave K: Volume Profile / Volume-at-Price (VPVR)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/volume-profile/{symbol}")
def volume_profile(symbol: str, lookback_days: int = 120, bins: int = 24) -> dict:
    return volume_profile_mod.volume_profile(symbol, lookback_days, bins)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave K: Social / Retail Sentiment (WSB + StockTwits)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/social-sentiment")
def social_sentiment() -> dict:
    return social_sentiment_mod.social_sentiment()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave L: Implied Forward-Rate Matrix (FWCM)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/forward-rates")
def forward_rates() -> dict:
    return forward_rates_mod.forward_rates()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave L: Carry & Rolldown Curve RV Analyzer (CARRY)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/carry-rolldown")
def carry_rolldown(horizon_months: int = 3) -> dict:
    return carry_rolldown_mod.carry_rolldown(horizon_months)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave L: Global Sovereign Bond Monitor (WB)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/sovereign-bonds")
def sovereign_bonds() -> dict:
    return sovereign_bonds_mod.sovereign_bonds()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave M: Financial Conditions Index Monitor (BFCIUS)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/financial-conditions")
def financial_conditions() -> dict:
    return financial_conditions_mod.financial_conditions()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave M: PMI / Business-Survey Diffusion Aggregator
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/pmi-diffusion")
def pmi_diffusion() -> dict:
    return pmi_diffusion_mod.pmi_diffusion()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave M: Unusual Options Activity Scanner (OMON)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/unusual-options")
def unusual_options() -> dict:
    return unusual_options_mod.unusual_options()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave N: ETF Net-Flow Dashboard
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/etf-flows")
def etf_flows() -> dict:
    return etf_flows_mod.etf_flows()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave N: Dark-Pool / Off-Exchange Short Volume
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/dark-pool")
def dark_pool() -> dict:
    return dark_pool_mod.dark_pool()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave N: 13F Change-Tracking & Hedge-Fund Clustering (HDS)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/holdings-changes")
def holdings_changes() -> dict:
    return holdings_changes_mod.holdings_changes()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave O: Brinson-Fachler Performance Attribution (PORT)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio-attribution")
def portfolio_attribution(portfolio_id: int | None = None) -> dict:
    return attribution_mod.attribution(portfolio_id)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave O: Pre-Trade What-If Portfolio Analytics (PORT)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio-whatif")
def portfolio_whatif(portfolio_id: int | None = None) -> dict:
    return whatif_mod.whatif(portfolio_id)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave O: Marginal & Component VaR per Holding (PORT)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio-component-var")
def portfolio_component_var(portfolio_id: int | None = None) -> dict:
    return component_var_mod.component_var(portfolio_id)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave P: IRS Swap Curve & Vanilla Swap Pricer (IRSB / SWPM)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/swap-curve")
def swap_curve() -> dict:
    return swap_curve_mod.swap_curve()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave P: Hedging & Overlay Designer (HEDG)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/portfolio-hedging")
def portfolio_hedging(portfolio_id: int | None = None) -> dict:
    return hedging_mod.hedging(portfolio_id)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave P: EM Sovereign Risk & Reserves Dashboard (EMBI)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/em-sovereign")
def em_sovereign() -> dict:
    return em_sovereign_mod.em_sovereign()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave Q: Natural-Gas Storage vs 5-Year Band
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/natgas-storage")
def natgas_storage() -> dict:
    return natgas_storage_mod.natgas_storage()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave Q: Heating & Cooling Degree Days (HDD/CDD)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/degree-days")
def degree_days() -> dict:
    return degree_days_mod.degree_days()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave Q: Country / Global Macro Scorecard (ECST)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/macro-scorecard")
def macro_scorecard() -> dict:
    return macro_scorecard_mod.macro_scorecard()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave R: Repo & Money-Market Funding Monitor (RRP)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/repo-funding")
def repo_funding() -> dict:
    return repo_funding_mod.repo_funding()


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave R: Analyst Rating-Change / Upgrade-Downgrade Feed (RATD)
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/rating-changes/{symbol}")
def rating_changes(symbol: str) -> dict:
    return rating_changes_mod.rating_changes(symbol)


# ──────────────────────────────────────────────────────────────────────────
# Bloomberg Wave R: DuPont ROE Decomposition
# ──────────────────────────────────────────────────────────────────────────

@app.get("/api/dupont-roe/{symbol}")
def dupont_roe(symbol: str) -> dict:
    return dupont_roe_mod.dupont_roe(symbol)
