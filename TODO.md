# TODO

Outstanding work for Automated-Investing. Organized by priority. Tick `[x]`
as items ship; add new ones at the bottom of their section.

> **Wave 2 (shipped 2026-05-16):** Sector Rotation panel, Technical Indicators
> v1, Screener, Watchlists (DB-backed multi).
>
> **Wave 3 (shipped 2026-05-16):** Enhanced Technical Analysis (20 indicators,
> multi-timeframe, composite signal strength, multi-pane chart, drawings —
> trend line / hline / vline / fib retracement / rectangle / text — persisted
> to DuckDB). Events Calendar (hardcoded recurring schedule, FOMC dates,
> filter by impact + category, market-impact notes).
>
> **Wave 5 (shipped 2026-05-16):** Mile-deep Macro. **8 new backend modules**
> (yield_curve, inflation, recession, nowcast, series_stats, macro_pins,
> regime_model_v2). **27 new API routes** (yield curve dashboard with full
> 11-maturity nominal+real curves + historical replay + NY Fed Estrella-Mishkin
> recession probability + term premium proxy; inflation dashboard with
> CPI/PCE/Sticky/PPI YoY/3m-ann/6m-ann/MoM-ann momentum + breakeven curve +
> 10Y nominal/real/breakeven decomposition + Fed-target classification;
> recession composite with Sahm Rule + NY Fed + LEI proxy + claims YoY +
> IP YoY + real retail YoY + composite Z; Atlanta Fed GDPNow scrape +
> internal 6-component nowcast; series_stats with 10 transforms — level,
> YoY, MoM, 3m/6m-ann, log diff, rolling z, percentile, detrend — plus
> descriptive stats; catalog-wide heatmap; **5-state regime model**
> (risk_on/early_cycle/late_cycle/risk_off/recession) with probability
> vector + 7 driver attribution; macro pinboards CRUD + snapshot).
> **7 new frontend panels** (YieldCurvePanel with SVG curve + historical
> overlay + recession dial + spreads + butterflies + term premium;
> InflationDashboard with regime header + 7 series cards + breakeven curve +
> decomposition; RecessionDashboard with composite meter + 6 indicator
> cards + GDPNow + nowcast composite; MacroHeatmap full-catalog colored
> grid with 4 transform modes; MacroSeriesDetail drill-down with 9
> transforms + 4 window options + stats bar; MacroPinboard custom user
> dashboards; RegimeV2Panel 5-state probability bar + driver table).
> All wired into TerminalShell. Frontend tsc CLEAN, backend 92 routes.

> **Wave 4 (shipped 2026-05-16):** TA deep-build. **32 indicators total**
> (+ SuperTrend, Aroon, Vortex, Hull MA, KAMA, VWMA, TRIX, Ultimate Osc,
> Awesome Osc, CMF, Chaikin Osc, Anchored VWAP, RSI/MACD divergence
> detection, auto support/resistance). **12 drawing tools** (+ parallel
> channel, fib extension, fib time zones, risk/reward box, arrow, anchored
> VWAP anchor). Drawing properties dialog (color/style/width/label).
> Snap-to-OHLC toggle. Lock drawings toggle. 4 chart types (candle / Heikin
> Ashi / line / area). Log vs linear scale. Symbol comparison overlay.
> Crosshair sync across panes. Cursor info bar showing all enabled
> indicator values. Per-indicator parameter sliders. Layout persistence
> per (symbol, timeframe) via `chart_layouts` table. Event markers on price
> chart (filings + earnings + macro releases).

---

## 0. Setup (one-time, unlocks live data)

- [ ] **Register a free FRED API key**
      → https://fredaccount.stlouisfed.org/apikeys (takes ~30 seconds)
- [ ] **Add `ANTHROPIC_API_KEY`** to `.env`
      → https://console.anthropic.com/
- [ ] **Create `.env`** if it doesn't exist:
  ```bash
  cp .env.example .env
  # then edit FRED_API_KEY and ANTHROPIC_API_KEY
  ```
- [ ] **Restart backend** after setting keys; macro tiles + Claude briefing
      + chat all light up.

Without keys, the terminal still runs in degraded mode: yfinance + EDGAR
flow live, but FRED macro tiles show `—` and Claude surfaces show
"configure key" messages.

---

## 1. High-impact data expansions

- [ ] **EIA Open Data API** (free key) for per-region energy intelligence:
      Permian/Bakken/Eagle Ford production, rig counts, refinery utilization
      by PADD, electricity generation by source
- [ ] **BLS API direct integration** for state-/MSA-level employment,
      industry-level wages, occupation data
- [ ] **Treasury Direct fiscal data**: auctions calendar, foreign-held
      Treasury debt, daily Treasury statement
- [ ] **CoinGecko crypto depth**: top-250 coins, DeFi TVL, fear/greed
      index, funding rates
- [ ] **Census Bureau API**: advance retail sales, construction spending,
      housing characteristics
- [ ] **FINRA short interest** (biweekly): days-to-cover, squeeze candidates

## 2. Intelligence layer improvements

- [x] ~~**Macro nowcasting composite**~~ — shipped in Wave 5 (Atlanta Fed
      GDPNow scrape + 6-component internal z-score composite)
- [x] ~~**Leading indicator dashboard**~~ — shipped in Wave 5 (LEI proxy in
      recession dashboard: claims-inv + permits + new orders + SPX + curve)
- [x] ~~**Historical pattern detection**~~ — partially shipped via 5y rolling
      z-score + percentile ranks per series; full regime-similarity search still deferred
- [ ] **APScheduler daily refresh** of all 130 FRED series so the macro
      explorer opens instantly
- [ ] **Pre-compute daily briefing** at 7am local — wakes up ready to read
      with coffee
- [ ] **News + sentiment persisted to DuckDB** → trend lines of per-ticker
      sentiment over weeks/months
- [ ] **Insider transaction analytics**: aggregate Form 4 buys/sells per
      ticker over rolling windows, detect insider clusters
- [ ] **13F institutional positioning panel**: every fund manager's
      quarterly holdings disclosure (free via EDGAR)
- [ ] **Historical pattern detection**: "find regimes like today's" across
      the accumulated macro history in DuckDB
- [ ] **Macro nowcasting composite**: combine CFNAI + ISM + employment +
      retail into a real-time GDP-tracking gauge
- [ ] **Leading indicator dashboard**: yield curve / claims / housing
      starts / consumer sentiment — the classic recession trifecta

## 3. New panels worth building

- [ ] **Sector Rotation panel**: relative strength across the 11 XL*
      sectors over 1m / 3m / 6m / 1y windows
- [ ] **Earnings Season Heat Map**: calendar grid showing all S&P
      companies' earnings dates with surprise + reaction visualization
- [ ] **Technical Indicators** layer: RSI, MACD, Bollinger, MA crossovers
      computed locally from `prices_daily`
- [ ] **Single-Ticker "Why is X moving?"** analyzer: pulls today's price
      action + sector move + news + filings → Claude one-paragraph synthesis
- [ ] **Screener**: SQL over DuckDB — "stocks with revenue YoY > 25%,
      gross margin > 50%, no insider sales in 90d"
- [ ] **Trade Journal**: persist decisions + theses, pattern-match own
      thinking over time
- [ ] **Calendar Aggregator**: earnings + economic releases + Fed meetings
      + dividend ex-dates in one timeline

## 4. Productionization

- [ ] **Custom watchlists** beyond hardcoded defaults — per-user storage
- [ ] **Alerts engine**: push to OS notifications / Slack / email when
      regime changes, correlation breaks, material 8-K, etc.
- [ ] **Mobile companion**: daily briefing email or PWA so the terminal
      works on phone
- [ ] **Authentication** if ever multi-user
- [ ] **Cloud deploy** option (Docker / fly.io / Render) for non-local
      access
- [ ] **HMM regime model** (gated on NBER validation per design doc) —
      upgrade from the current rule-based 3-state classifier

## 5. Polish / nice-to-haves

- [ ] Code-split the frontend bundle (current ~530KB → smaller chunks)
- [ ] Per-tile drill-down chart in the Macro Explorer (full TradingView
      chart for any FRED series, not just the sparkline)
- [ ] Save & restore panel layout per user
- [ ] Dark/light theme toggle (currently dark only by design)
- [ ] Keyboard shortcuts for common navigation
- [ ] Export panel snapshots as PNG / share links

## 6. Technical Analysis follow-ons (still deferred after Wave 4)

- [x] ~~Symbol comparison overlay~~ — shipped in Wave 4
- [x] ~~Snap-to-OHLC for drawings~~ — shipped in Wave 4 (toggle)
- [x] ~~Drawing properties dialog~~ — shipped in Wave 4
- [x] ~~More drawing tools~~ — shipped in Wave 4 (parallel channel,
      fib extension, fib time zones, arrow, risk/reward, anchored VWAP)
- [x] ~~Save chart layout per symbol~~ — shipped in Wave 4 (chart_layouts)
- [x] ~~Crosshair sync across sub-panes~~ — shipped in Wave 4
- [x] ~~Indicator parameter UI~~ — shipped in Wave 4 (slider per indicator
      with `period`)
- [x] ~~News + earnings markers on the price chart~~ — shipped in Wave 4
      (`/api/chart-events` + setMarkers on series)
- [ ] **Drag-to-move drawing endpoints** — click an anchor circle and drag
      to reposition without redrawing
- [ ] **Multi-select drawings** — shift-click to select multiple, then
      group operations (bulk delete, recolor, copy/paste)
- [ ] **Drawing templates / favorites** — save your common drawing setup
      (color + style + label pattern) for one-click reuse
- [ ] **Layer ordering** — bring forward / send backward / bring to front
- [ ] **Pitchfork (Andrews + Schiff + modified)** — 3-point median + parallel
- [ ] **Gann Fan + Gann Box** — for the Gann-trading crowd
- [ ] **Elliott Wave labeling** — 5-wave numbering with auto-projections
- [ ] **Replay mode** — step through history bar-by-bar with playback
      controls so you can practice reading the chart without lookahead
      bias
- [ ] **Volume Profile (VPVR)** — horizontal histogram of volume-at-price
      for the visible window; POC + value area
- [ ] **Volume by Time** — intraday cumulative volume curve
- [ ] **Renko bars / Point-and-Figure / Range bars** — non-time-based bar
      types
- [ ] **Indicator alerts** — fire OS notification when RSI crosses 30/70,
      MACD bull/bear cross, price crosses a saved drawing line
- [ ] **Drawing-based alerts** — alert when price hits a saved trend line
      or horizontal line
- [ ] **Backtest layer** — "what if I bought on golden cross and sold on
      death cross" → overlay equity curve, win-rate, sharpe
- [ ] **Pre-computed signal-strength history** — persist daily composite
      score to DuckDB, show as a sub-pane line chart, divergence with price
- [ ] **Compare across timeframes** — split-screen showing daily + weekly
      + monthly of the same symbol for HTF/LTF analysis
- [ ] **Right-click contextual menu on drawings** — Edit / Duplicate /
      Lock / Delete / Bring to front (currently only single right-click
      delete; left-click → properties dialog)
- [ ] **Magnet mode** — broader snap than OHLC: snap to swing pivots,
      Fibonacci levels of nearby drawings, support/resistance levels
- [ ] **Trade Journal annotations on chart** — drop a journal entry at
      the cursor location (already have trade_journal table)
- [ ] **Multi-symbol matrix view** — small multiples of the same indicator
      across a watchlist
- [ ] **Pattern recognition** — detect head & shoulders, double top/bottom,
      triangles, flags, cup-and-handle (requires CV-style scan)
- [ ] **Auto-trendlines** — algorithmically draw trendlines from swing
      pivots, label by significance
- [ ] **AI screenshot analysis** — send the chart PNG + drawing list to
      Claude with prompt "what setup is this?" (needs ANTHROPIC_API_KEY)
- [ ] **Indicator parameter optimization** — sweep period values, show
      which gave the best backtest result on the loaded symbol
- [ ] **Custom indicator builder** — composite of 2+ indicators with
      thresholds, persist as a user indicator
- [ ] **Bar-by-bar inspect mode** — pinned tooltip stays visible while
      you arrow-key through bars

## 7. Events Calendar follow-ons (deferred from Wave 3)

- [ ] **BLS release calendar scrape** — replace hardcoded recurrence with
      actual BLS-published release schedule for accurate dates (no key
      needed; BLS publishes the schedule as a public HTML page)
- [ ] **Earnings calendar in events panel** — yfinance earnings data
      (already wired via `data/earnings.py`) folded in as `earnings`
      category
- [ ] **Federal Reserve speeches calendar** — Fed governors give
      speeches almost weekly; scrape federalreserve.gov/newsevents
- [ ] **Treasury auctions** — Treasury Direct public auctions calendar
- [ ] **Holidays + half-days** — US market holidays affect liquidity
- [ ] **Event impact study** — for each event type, show historical SPX
      / VIX move in the 1h / 1d window after the release (mining
      DuckDB price history)
- [ ] **Add to watchlist alerts** — surface "tomorrow's catalysts for
      tickers you watch" alongside the calendar
- [ ] **AI-generated commentary** per event (needs ANTHROPIC_API_KEY) —
      what to watch in the print given current regime

## 8. Sector/Subsector depth (queued from session 2026-05-22)

### Mile-deep sector intelligence (session 2026-05-22)

- [x] **Sector-specific KPIs** — shipped. Per-sector curated metrics (Rule of 40 for tech,
      EV/EBITDA for O&G, P/B + ROE for banks, inventory days for semis, etc.).
      `/api/sectors/{id}/kpis` returns sector medians + per-stock breakdown.
      KPI card strip + breakdown table rendered in SectorDetailPanel.

- [x] **Macro correlation per sector** — which FRED series drives each sector.
      For each sector, compute rolling 90-day correlation between sector ETF returns
      and a curated set of FRED series (e.g. DGS10 + oil for energy, 10Y for utilities,
      ISM for industrials). Surface as a sortable table in the sector drill-down.
      Backend: `/api/sectors/{id}/macro-drivers`. Frontend: collapsible card below KPIs.

- [x] **Sector-filtered news + earnings calendar** — in the sector drill-down,
      show only news and upcoming earnings for that sector's key stocks.
      Backend: filter existing `/api/news/feed` and `/api/earnings/overview` by ticker list.
      Or add `?tickers=AAPL,MSFT,...` params to those endpoints.
      Frontend: two collapsible panels at the bottom of SectorDetailPanel.

- [x] **Relative strength momentum chart** — rolling 20-day and 60-day RS of
      the sector ETF vs SPY (RS = sector / SPY, normalized to 1.0 at window start).
      Show as a two-line chart. Backend: compute from existing price cache.
      Endpoint: `/api/sectors/{id}/relative-strength?window=20`.
      Frontend: small chart above the stocks table in SectorDetailPanel.

- [x] **Supply chain / related sectors map** — static adjacency graph per sector
      showing upstream/downstream dependencies (e.g. semis -> tech, energy -> industrials,
      materials -> clean energy). Render as an SVG node-link diagram or a simple
      "related sectors" pill grid with ETF tickers. No new data needed -- purely
      editorial config in a Python dict.

## 9. Mile-deep sector intelligence — next build queue (session 2026-05-22)

Items below are prioritized; build in order.

- [ ] **Sector Breadth Indicators** (building now) — for each sector's key stocks,
      compute % above 50MA, % above 200MA, % at 52w highs, % at 52w lows,
      average distance from 52w high. Surface as a stat bar in SectorDetailPanel.
      Backend: `/api/sectors/{id}/breadth`. No new DB tables needed.

- [x] **Peer Comparison Chart** — side-by-side YTD performance line chart for all
      stocks in the sector (normalized to 100 at Jan 1). Highlights the best/worst
      performer. Backend: `/api/sectors/{id}/peer-comparison`. Frontend: SectorPeerChart
      with color-coded multi-line chart + scrollable legend showing YTD % per symbol.

- [ ] **Regime-Based Playbook** (building now) — using 5-state regime history + ETF
      price data, compute average sector return per regime state, annualized. Show
      beat rate vs SPY per regime, highlight current regime.
      Backend: `/api/sectors/{id}/regime-playbook`. Frontend: table in SectorDetailPanel.

- [ ] **Historical Seasonality** — average monthly return per calendar month for the
      sector ETF over the last 10 years. Show as a 12-bar chart colored green/red.
      Backend: simple groupby on cached price data. No new endpoints needed beyond
      `/api/sectors/{id}/seasonality`.

- [ ] **Valuation Percentile** — for each sector KPI (P/E, EV/EBITDA, P/S),
      show where today's reading sits vs the 5-year history of the sector median.
      "Cheap / Fair / Expensive" label + percentile rank. Requires accumulating
      sector medians over time (new DuckDB table or rolling from fundamentals).

- [ ] **Earnings Season Aggregator** — during earnings season, show the sector's
      beat rate (EPS + revenue), average earnings surprise %, and guidance trend
      for the current quarter. Backend: use existing per-ticker earnings data.

- [ ] **Sub-industry Performance** — within a sector, break down by GICS sub-industry
      (e.g. within tech: semiconductors vs software vs hardware vs cloud infra).
      Show each sub-group's YTD return. Requires a static sub-industry → tickers map.

- [ ] **Options Flow per Sector ETF** — put/call ratio, IV rank, largest open interest
      strikes for the sector ETF (XLK, XLE, etc.). Reuse existing `options.py`
      fetcher with the ETF symbol.

- [ ] **Sector Concentration + Top Holdings** — pie chart of top 10 constituent
      weights for each sector ETF (sourced from yfinance `.info` or a static config).
      Show how top-heavy the sector is.

- [ ] **Dividend Growth Tracker** — for dividend-paying sectors (utilities, REITs,
      consumer staples, financials), show trailing 5-year dividend CAGR per stock,
      yield vs 10Y Treasury spread, payout ratio.

- [ ] **Rotation Radar** — a 2D scatter of 20D momentum (x) vs 60D momentum (y)
      for all 11 sectors simultaneously. Visual "rotation clock" showing which
      sectors are leading/lagging/turning.

- [ ] **Regime → Sector Allocation Matrix** — across all 5 regime states, show the
      historically optimal sector allocation (which 3 sectors outperform each regime
      the most). Export as a reference card for portfolio construction.

- [ ] **Sector Correlation Matrix** — rolling 60D pairwise correlation heatmap across
      all 11 sectors. Highlights diversification opportunities and crowded trades.

### Quick UX wins for sector drill-down

- [ ] **Search / filter bar** across all sector panels (filter stocks by name/ticker)
- [ ] **Sector comparison toggle** — view any two sectors side-by-side in one panel
- [ ] **Pin sector** — bookmark a sector for fast access without scrolling the sidebar
- [ ] **Last-updated timestamps** on each collapsible card so you know data freshness

## 10. Wave 3+ feature backlog (from prior sessions)

These items were surfaced in earlier sessions and remain on the build queue.

- [ ] **Insider Transaction analytics** — aggregate Form 4 buys/sells per
      ticker via existing `sec_edgar.py`; detect insider clusters
- [ ] **13F Institutional Positioning panel** — quarterly holdings
      disclosures from EDGAR
- [ ] **Trade Journal UI** — table already in schema (`trade_journal`);
      needs CRUD panel with thesis + post-mortem fields
- [ ] **Alerts engine** — regime-change, correlation-breakdown,
      material-8K, indicator-trigger alerts via browser Notification API
- [ ] **Historical pattern detection** — "find regimes like today's"
      similarity search across DuckDB macro history
- [ ] **PWA / mobile companion** — manifest + service worker + responsive
      panel layouts so the terminal works on phone
- [ ] **Authentication** — local-first multi-user model
- [ ] **Cloud deploy option** — Dockerfile + fly.io / Render config so
      it's reachable beyond localhost
