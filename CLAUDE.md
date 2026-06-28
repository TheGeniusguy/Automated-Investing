# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The canonical design doc lives at
> `~/.gstack/projects/TheGeniusguy-Automated-Investing/Work-main-design-*.md`
> (problem statement, premises, architecture, accepted/deferred scope).
> Read it before making non-trivial design decisions.

## What this is

A personal Bloomberg-style market intelligence terminal with a Claude reasoning layer. The differentiator is **cross-stream synthesis** — every Claude call sees the regime state + all macro series + portfolio context in a single prompt and reasons across them. The terminal UI is the surface; the AI layer is the moat.

Two app surfaces, one repo:

- `backend/` — FastAPI service that pulls macro data, classifies the regime, and streams Claude briefings as SSE.
- `frontend/` — React + Vite terminal UI with draggable/resizable panels.

## Feature surfaces added 2026-06

Three build waves landed on top of the original macro/regime/portfolio core. All
new surfaces follow the same contract: a self-contained backend module, a route
in `main.py`, a typed client method, and a panel wired into `TerminalShell` +
`Sidebar`.

**Unusual Whales feeds** (`data/unusual_whales.py`): market-wide news + insider
firehose. `GET /api/news/market`, `/api/insiders/market`. Panels: `MarketNewsPanel`,
`MarketInsidersPanel`. Needs `UNUSUAL_WHALES_API_KEY` (optional; degrades).

**v2 analytics** ("Analytics" sidebar section):
- `portfolio/metrics_ext.py` - 20 extra performance metrics + a computable-metric
  catalog. `GET /api/analytics/advanced`, `/catalog`. See `docs/derivable-metrics.md`.
- `paper/` - paper trading with commission/slippage fills, FIFO-derived positions,
  execution analytics. Self-seeding "Demo Book". `/api/paper/portfolios[...]`.
- `portfolio/weighted.py` - model-portfolio attribution + rebalance. `/api/weighted/*`.
- `data/etf_tracking.py` - ETF expense/AUM/sector/overlap. `GET /api/etf/track`.
- `proforma/` - IB 3-statement (ties exactly) + DCF/WACC + comps + scenario/tornado.
  `GET /api/proforma`. Panel `ProFormaPanel` (the showpiece).
- `data/econ_deep.py` - 9 categories, ~85 FRED series. `GET /api/economy/deep`.

**Bloomberg Wave C** (parity features):
- `data/options_greeks.py` - Black-Scholes greeks, vol surface, GEX, max-pain.
  `GET /api/options/{greeks,surface,gex,max-pain}/{symbol}`.
- `data/rate_path.py` - FedWatch implied rate path. `GET /api/rates/{path,probabilities}`.
- `backtest/` - rule-based strategy backtester. `GET /api/backtest/strategies`, `POST /run`.
- `data/bond_analytics.py` - bond price/duration/convexity/DV01. `GET /api/bonds/universe`, `POST /analyze`.
- `data/cot_positioning.py` - CFTC COT net positioning + index. `GET /api/cot/{markets,{market}}`.

**Bloomberg Waves D + E** (shipped): FX carry/forwards/vol (`data/fx_analytics.py`,
`/api/fx/*`), commodities term structure (`data/commodities_curve.py`,
`/api/commodities/curves`), analyst estimates/revisions (`data/estimates.py`,
`/api/estimates/{symbol}`), credit & CDS curves (`data/credit_curves.py`,
`/api/credit/*`), alerts engine (`alerts/`, `/api/alerts/*`), economic surprise
index (`data/econ_surprise.py`, `/api/econ-surprise`), seasonality
(`data/seasonality.py`, `/api/seasonality/{symbol}`), factor/style analysis
(`data/factor_analysis.py`, `/api/factors/{symbol}`), Monte Carlo risk
(`data/montecarlo.py`, `/api/montecarlo/{symbol}`), short interest/squeeze
(`data/short_interest.py`, `/api/short-interest/{symbol}`). One panel each, same
sample-data policy. This brings the total to 15 Bloomberg parity features across
Waves C/D/E (23 new feature surfaces overall).

### Sample-data policy (deliberate)
These surfaces are built for a marketing portfolio and must look fully populated.
When a live key/feed is unavailable they return rich SAMPLE data with NO on-screen
badge (clean screenshots). Integrity is kept under the hood: sample values live in
`SAMPLE_*` constants / `sample_data.py` modules, every payload carries an internal
`data_mode` ("live" | "sample") + `as_of` + `source`, and live data is always
preferred when available. Do not surface a sample badge in the UI; do not delete
the `data_mode` field.

### Design system
The terminal was re-themed to Anthropic's visual language: warm "ink" palette with
a clay accent (token VALUES changed, names kept), Hanken Grotesk UI + Newsreader
serif display (free stand-ins for Styrene/Tiempos; swap path in `frontend/index.html`),
JetBrains Mono for tabular columns, rounded elevated panels via the shared
`.panel`/`.stat-figure` classes in `index.css`.

## Commands

### Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload          # http://127.0.0.1:8000
.venv/bin/uvicorn app.main:app --host 0.0.0.0    # network-visible
```

Smoke-test imports (no test suite yet):

```bash
cd backend
.venv/bin/python -c "from app.main import app; print('OK')"
.venv/bin/python -m py_compile app/portfolio/*.py app/etf/*.py   # syntax check
```

Representative curl smoke tests:

```bash
curl -s 127.0.0.1:8000/api/health
curl -s 127.0.0.1:8000/api/regime/current
curl -s '127.0.0.1:8000/api/macro/series?days=30'
curl -s '127.0.0.1:8000/api/macro/series/%5EVIX?days=30'   # url-encode ^

# Portfolio tracker
curl -X POST 127.0.0.1:8000/api/portfolio \
  -H 'Content-Type: application/json' \
  -d '{"name":"Main","cash_balance":100000}'
curl -s 127.0.0.1:8000/api/portfolio/1/positions
curl -s '127.0.0.1:8000/api/portfolio/compare?ids=1,2&days=365'
curl -s '127.0.0.1:8000/api/etf/compare?symbols=SPY,QQQ,IWM&days=252'

# AI (SSE — use -N)
curl -N 127.0.0.1:8000/api/briefing/stream
curl -N -X POST 127.0.0.1:8000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"query":"why is gold ripping today"}'
```

### Frontend

```bash
cd frontend
bun install
bun dev       # → http://localhost:5173 (Vite proxies /api/* to 127.0.0.1:8000)
bun run build # tsc -b && vite build — type-checks too; always run before committing
bun lint
```

### Caches and stores

- **`backend/cache.db`** (sqlite TTL cache) — short-lived fetch cache. Delete after upgrading yfinance or when suspecting stale data:
  ```bash
  rm backend/cache.db backend/cache.db-journal 2>/dev/null
  ```
- **`backend/data/market.duckdb`** (DuckDB, gitignored) — persistent analytical store. Schema in `backend/app/db/schema.sql`, applied automatically on startup. Safe to delete; schema re-applies and universe rebuilds in ~15s.

## Configuration

Copy `.env.example` to `.env` at repo root. Run uvicorn from inside `backend/` (pydantic-settings loads `.env` relative to CWD).

Keys are **optional** — graceful degradation is a contract:

- `FRED_API_KEY` missing → yield curve series return `[]`, regime degrades to "transition"
- `ANTHROPIC_API_KEY` missing → briefing streams a "configure key" message instead of failing

Never change data fetchers to raise on missing keys.

## Architecture

### Data flow

```
External streams              Backend layers                      Frontend panels
─────────────────             ──────────────                      ───────────────
yfinance                      data/*  fetchers                    Macro Regime Tracker
FRED (130 series)               └── sqlite TTL cache             Regime Journal / Stress Test
SEC EDGAR                                                         Correlation Detector
EIA energy                    ingest/*                            SEC Filings
AIS shipping                    └── DuckDB store                  Financial DB / Fundamentals
News / options /                                                  News / Options / Earnings
  earnings feeds              regime/    classifier               Daily Briefing / Chat
                              portfolio/ tracker + analytics      Portfolio Tracker
                              etf/       comparison engine        ETF Comparison
                              briefing/  claude_briefing          Macro Explorer
                              chat/      terminal_chat            Energy / Shipping
```

### Backend module map

**`backend/app/`**

| Module | Purpose |
|--------|---------|
| `config.py` | pydantic-settings; `has_fred` / `has_anthropic` gate degraded branches |
| `main.py` | FastAPI app, ~138 routes. `_regime_inputs()` is the shared gather fn for all regime endpoints |
| `db/engine.py` | Per-call DuckDB connections (single-threaded). Use `db.fetchall()`, `db.fetchone()`, `db.execute()`. **Always use `now()` not `current_timestamp`** inside `ON CONFLICT DO UPDATE SET` — DuckDB parses the latter as a column ref |
| `db/schema.sql` | All table definitions. Applied on startup. Sequences use `nextval('seq')`, not `AUTOINCREMENT` |
| `data/macro_data.py` | FRED + yfinance fetchers. `fetch_arbitrary_ticker()` is the universal price-history entrypoint (cached, yfinance fallback). For windows >2y yfinance uses start/end dates, not `period=` |
| `data/cache.py` | sqlite TTL cache. `get_stale()` returns anything — used as fallback when upstream fails |
| `regime/regime_model.py` | Rule-based 3-regime classifier (risk_on / risk_off / transition) keyed off VIX + 2Y/10Y spread |
| `regime/stress_test.py` | Collapses regime history into segments, computes compound returns per ticker × regime |
| `correlations/correlation_model.py` | Rolling-window pairwise correlation + breakdown detector |
| `briefing/claude_briefing.py` | On-demand briefing: assembles regime + macro context, streams via Anthropic SDK |
| `briefing/daily_briefing.py` | Pre-computed daily briefing (cached + history). Same prompt shape |
| `chat/terminal_chat.py` | Ask-the-Terminal: streams Claude response conditioned on regime + macro context |

**Portfolio module (`app/portfolio/`)**

The transaction log is the source of truth. Positions are always computed, never stored.

| File | Purpose |
|------|---------|
| `positions.py` | FIFO lot tracking. `compute_positions(txns)` → `(open_positions, total_realized, cash_delta)`. Commission is deducted once from total gross P&L per sell (not per lot). |
| `valuation.py` | `enrich_positions(positions, cash_balance)` — fetches live prices via `yf.Ticker().info` (one call/symbol), falls back to `fetch_arbitrary_ticker`. Returns per-position dict + portfolio summary. |
| `analytics.py` | `build_equity_curve()` replays txn log against historical prices. `compute_performance_metrics()` returns Sharpe, Sortino (correct semi-deviation: `sqrt(mean(min(r-rf,0)²))`), Calmar, alpha, beta, R² via OLS (`lstsq`), max drawdown with dates, rolling returns. |
| `risk.py` | `compute_portfolio_risk()` — VaR/CVaR (empirical percentile), annualized vol, per-position betas, pairwise correlation matrix, factor OLS exposures vs SPY/QQQ/IWM/HYG/GLD/TLT, Herfindahl. |
| `comparison.py` | `compare_portfolios(ids, days)` — normalizes all NAV curves to 100, computes pairwise portfolio correlations. |
| `fundamentals.py` | `enrich_fundamentals(symbols)` — maps yfinance `.info` to 25 fundamental fields. Margin/growth/yield fields are `* 100` (stored as decimals in yfinance). |
| `dividends.py` | `compute_dividend_income(enriched_positions)` — annual income, yield, monthly projection. `exDividendDate` is unix timestamp → ISO date. |
| `crud.py` | DuckDB CRUD for `user_portfolios` and `portfolio_transactions`. Uses `RETURNING id` pattern for inserts. |

**ETF module (`app/etf/`)**

| File | Purpose |
|------|---------|
| `compare.py` | `compare_tickers(symbols, lookback_days, benchmark)` — full institutional comparison: normalized curves, 16 per-ticker metrics (including up/down capture ratio), monthly returns heatmap, OLS factor exposures, rolling windows, yfinance metadata. |

### Portfolio API routes

```
GET    /api/portfolio                          list portfolios
POST   /api/portfolio                          create {name, description?, cash_balance?}
DELETE /api/portfolio/{id}
GET    /api/portfolio/{id}/overview            value, P&L, summary metrics
GET    /api/portfolio/{id}/positions           all positions with live market data
GET    /api/portfolio/{id}/performance?days=   equity curve + rolling returns + metrics
GET    /api/portfolio/{id}/risk?days=          VaR, CVaR, correlation, factor exposure
GET    /api/portfolio/{id}/fundamentals        PE, margins, growth, ROE per symbol
GET    /api/portfolio/{id}/dividends           income, yield, calendar
GET    /api/portfolio/{id}/allocation          sector breakdown
GET    /api/portfolio/{id}/transactions        history
POST   /api/portfolio/{id}/transactions        add {symbol, trade_date, trade_type, quantity, price, commission?, notes?}
DELETE /api/portfolio/{id}/transactions/{tid}
GET    /api/portfolio/compare?ids=1,2&days=    side-by-side portfolio comparison
GET    /api/etf/compare?symbols=SPY,QQQ&days=  ETF/ticker comparison engine
```

### Frontend architecture

**API layer**

- `api/client.ts` — `getJSON<T>(path)` for REST, `streamSSE()` for SSE (uses `fetch` streaming — `EventSource` can't carry POST bodies). Exports `api`, `portfolioApi`, `etfApi` namespaces.
- `api/types.ts` — hand-maintained mirror of backend response shapes. **Update both sides together; there is no codegen.**

**Shell**

- `components/TerminalShell.tsx` — `react-grid-layout` v1.5 with `draggableHandle=".panel-header"`. Adding a panel requires a `Layout` entry in the `LAYOUT` array and a `<div key="..." data-panel-key="...">` child. Sidebar nav items live in `Sidebar.tsx`'s `NAV_SECTIONS` array.

**Portfolio panels (`components/portfolio/`)**

Eight-tab panel under `PortfolioPanel.tsx`:

| Tab | Component | Data source |
|-----|-----------|-------------|
| Overview | `PortfolioOverviewTab` | `/overview` + `/allocation` |
| Positions | `PortfolioPositionsTab` | `/positions` — sortable 18-col table |
| Performance | `PortfolioPerformanceTab` | `/performance` — TradingView equity curve + rolling returns table |
| Risk | `PortfolioRiskTab` | `/risk` — VaR cards, CSS correlation heatmap, factor bars |
| Fundamentals | `PortfolioFundamentalsTab` | `/fundamentals` — sticky-first-col scrollable table |
| Dividends | `PortfolioDividendsTab` | `/dividends` |
| Compare | `PortfolioCompareTab` | `/compare` — multi-portfolio overlay chart, best/worst metrics |
| Transactions | `PortfolioTransactionsTab` | `/transactions` — add form + history |

**ETF panel**

`ETFComparePanel.tsx` — standalone panel. Five presets (US Equity / Fixed Income / Factors / Commodities / Sectors). TradingView chart + 16-row metrics table + monthly heatmap + factor exposure bars + correlation matrix.

**Charts**

All time-series charts use **TradingView Lightweight Charts** (`createChart`, `addSeries(LineSeries, ...)`, `UTCTimestamp`). Pattern: `useRef` for container, `useEffect` creates chart + `ResizeObserver`, cleanup calls `chart.remove()`.

### Styling

Tailwind with custom palette in `tailwind.config.js`. Reusable classes in `src/index.css` under `@layer components`: `.panel`, `.panel-header`, `.panel-body`, `.pill`, `.text-2xs`. New panels must use these classes. P&L color convention: `text-green-400` positive, `text-red-400` negative.

## Known gotchas

- **react-grid-layout v2** is an incompatible API rewrite. Pinned to `^1.5.0` + `react-resizable ^3.0.5`. Do not bump.
- **yfinance** silently returns empty DataFrames when Yahoo's response shape drifts. Require `>=1.3.0` with `curl_cffi`. If data goes empty, upgrade first and delete `cache.db`.
- **DuckDB `current_timestamp`** — parsed as a column ref inside `ON CONFLICT DO UPDATE SET`. Always use `now()`.
- **DuckDB sequences** — use `nextval('seq_name')` as default, not `AUTOINCREMENT`. `RETURNING id` works for inserts.
- **Tailwind ordering** — `@import` lines in `index.css` must precede `@tailwind` directives or PostCSS errors.
- **Cache poisoning** — empty `[]` responses from partial outages get cached at full TTL. Delete `cache.db` when debugging missing data.
- **Portfolio math invariants** — commission on sells is deducted once from gross P&L (not per lot). Sortino denominator uses all N days (`sqrt(mean(min(r-rf,0)²))`), not just down-day count. R² is computed via `numpy.linalg.lstsq`, not approximated from Jensen's alpha. YTD return anchors to the last close on or before Dec 31, not Jan 1.
- **SSE endpoints** — use `curl -N` to disable buffering. The frontend uses `fetch` streaming (not `EventSource`) so POST bodies work.

## Conventions

- **`WIP:` commits** — gstack continuous-checkpoint mode is active. `/ship` squashes into clean conventional commits.
- **Graceful degradation** — every data fetcher must handle missing API keys and upstream failures without raising. Frontend renders "needs config" / empty states from `[]` / `null` payloads.
- **No stored positions** — portfolio positions are always derived from the transaction log via FIFO. Never persist computed positions.
- **DuckDB is single-connection per call** — do not hold connections open across requests. Use `db.conn()` context manager for writes, `db.fetchall()` / `db.fetchone()` for reads.
- **`fetch_arbitrary_ticker()` is the price entrypoint** — all historical price fetching (portfolio analytics, risk, ETF comparison) goes through this function. It handles the sqlite cache, yfinance fallback, and the >2y date-range switch automatically.
