# TODO - Automated-Investing (Enterprise Roadmap)

The single source of truth for outstanding work. Organized by priority, then by
area. Tick `[x]` when an item ships; keep this file honest about real state.

This roadmap is built around five quality pillars. Every feature, old or new,
is held to all five:

1. **Correct calculations** - every number is derived by a documented formula,
   not approximated, and is covered by a test that recomputes it independently.
2. **Exhaustive tests** - math and data-shaping logic have unit tests; routes
   have smoke tests; the frontend type-checks clean.
3. **Centralized data** - one fetch path per source (`fetch_arbitrary_ticker`
   for prices, `fetch_series` for FRED, the DuckDB store for persistence). No
   ad-hoc fetchers scattered through panels.
4. **Correctly wired** - backend route, frontend type, client method, panel,
   shell layout, and sidebar entry all line up; nothing orphaned.
5. **Grandpa-readable, mile-deep** - every tab explains itself in plain language
   at a glance, while still exposing the full institutional depth underneath.

---

## 0. Status snapshot - shipped this cycle

- [x] **Backend pytest suite** locking portfolio math invariants (FIFO
      commission-once, Sortino all-N denominator, R^2 via lstsq, YTD prior-Dec
      anchoring, VaR/CVaR/Herfindahl). Tests recompute each formula
      independently. `cd backend && .venv/bin/python -m pytest -q` -> 48 passed.
- [x] **Cross-asset surfaces**: Crypto (overview + compare), FX (cross-rate
      matrix + DXY), Fixed Income (Treasury curve + bond-ETF table). New
      "Cross-Asset" sidebar section.
- [x] **Command palette (Cmd/Ctrl-K)** backed by a centralized `/api/search`
      over the instruments table + FRED catalog + panel targets.
- [x] **Single-ticker dossier** fusing price, profile, fundamentals,
      technicals, news, filings, and options for one symbol (each section
      degrades independently).
- [x] **Background scheduler** (APScheduler): nightly FRED refresh + 7am daily
      briefing pre-bake, started only from the FastAPI startup hook.
- [x] **Data-health observability**: `/api/data-health` reports per-source
      freshness (real DuckDB max-timestamp probes), cache stats, and live
      scheduler job status; surfaced in the DB Status panel.
- [x] **Portfolio follow-ons**: tax (realized lots, ST/LT split, wash-sale
      flags, TLH candidates), target-allocation rebalancing, regime-stress over
      actual holdings, broker-agnostic CSV import with preview. 12 new tests.
- [x] **Cross-asset investment comparator**: model a real-estate deal, a
      stock/ETF position, or a custom cash-flow investment and compare them
      apples-to-apples (IRR via Actual/365 XIRR, CAGR, total return, equity
      multiple) with normalized growth curves on one chart. Pure engine, 16
      hand-verified finance tests.

---

## 1. Production-readiness audit (2026-05-27)

A full backend / frontend / data / test audit found the project is feature-rich
but not yet production-grade. The systemic flaw: failures and missing data are
silently rendered as plausible-but-empty results, so a user cannot tell "the
source is down" or "never populated" from "the real answer is zero." Items
below are the fix, in priority order.

### Hygiene (done)
- [x] Commit the ~49 untracked dependency files so the repo is fresh-clone-safe
      (committed 2026-05-27).
- [x] Resolve the modified `SectorDetailPanel.tsx` (committed).
- [ ] **CI gate**: GitHub Actions running `pip install -r backend/requirements.txt`,
      `pytest`, `bun install`, `bun run build` on every push.

### P0 - blocks "production-grade"
- [x] **Data pipeline now runs.** Nightly 03:30 scheduler job +
      `POST /api/ingest/prices/universe` (background) backfill the bounded
      watchlist+holdings universe into `prices_daily`, writing an `etl_runs` row
      per symbol. Verified: data-health flips prices + etl_runs to "fresh".
      (Fundamentals/filings ingest still on-demand only - see follow-up below.)
- [x] **Dead analytical surfaces fixed.** New read-only `app/data/ohlcv.py`
      (DuckDB-first, cached+timeout-bounded live yfinance fallback, short
      negative-cache TTL); `indicators` routes through it, so Technical Analysis,
      the dossier technicals, and the composite signal compute live on a cold
      store. (`sector_rotation` already had a fallback; `screener` is universe-SQL
      and now warms via the ingest job.)
- [x] **Per-panel error boundaries** added: each of the ~36 panels is isolated
      behind an `ErrorBoundary` card with retry; top-level reload backstop in
      `App.tsx`.
- [ ] **No authentication on any route** (incl. destructive `DELETE` + ingest),
      while CLAUDE.md documents `--host 0.0.0.0`. Add an API-key/bearer
      dependency on mutating + ingest routes; default-bind localhost. NOTE:
      for a localhost-only personal tool this is lower-urgency; gate before any
      network/cloud exposure.
- [ ] Follow-up: extend the nightly ingest to fundamentals + filings so the
      screener's fundamental columns and the filings surfaces also populate.

### P1 - quality and correctness
- [ ] **Make failure visible, not silent.** Add a `degraded` / `errors[]` field
      to data payloads; stop the ~148 `except Exception` blocks from returning
      bare `{}`/`[]`.
- [ ] **Stop caching empty responses** at full TTL (`macro_data.py`) - use a
      short negative-cache TTL so a transient outage is not frozen for an hour.
- [ ] **Stop fabricating prices.** `valuation.py:70` substitutes `avg_cost` when
      a quote fetch fails, reporting a fake flat portfolio. Mark the position
      `stale`/null instead.
- [ ] **yfinance hardening**: per-call timeouts (none today), a shared bounded
      executor, retry/backoff, and rate limiting (slowapi). A few concurrent
      users currently risk threadpool exhaustion or a Yahoo IP ban.
- [ ] **Serialize DuckDB writes.** `engine.py` opens a fresh connection per call
      with no lock while ThreadPoolExecutors write concurrently; DuckDB is
      single-writer. Add a shared write lock / queue.
- [ ] **Runtime validation**: Pydantic models for the 2 raw `dict` bodies +
      bounded query params (backend); zod at the `getJSON` boundary or OpenAPI
      codegen (frontend) so backend shape drift is caught, not a deep
      `undefined` throw.
- [ ] **Frontend load behavior**: ~35 panels mount and fetch simultaneously
      (thundering herd); no `React.lazy`/code-split (920KB single chunk); no
      `AbortController` in `getJSON` (~30 fetchers risk setState-after-unmount).
      Lazy-mount off-screen panels (IntersectionObserver) + `manualChunks`.
- [ ] **Adopt a data-fetching layer** (TanStack Query) or one shared
      `usePanelData` hook to replace ~50 hand-rolled loading/error triads and
      get caching, dedup, and abort for free.

### P2 - polish, accessibility, accuracy of claims
- [ ] **Fix the dead `accent` Tailwind classes.** `tailwind.config.js` defines
      `accent.{amber,green,red,blue}` but no `DEFAULT`, so `text-accent`/
      `bg-accent` emit no CSS. The command palette's selected row
      (`CommandPalette.tsx:174`) has NO visible highlight; dozens of headings
      render the wrong color. Add `accent.DEFAULT` or sweep usages, then add a
      lint/safelist so invalid classes fail the build.
- [ ] **Accessibility** (the "grandpa-readable" goal): only 1 aria attribute
      across 73 components; P&L is color-only (add a +/- glyph); the
      command-palette modal needs `role="dialog"`, focus trap, and focus
      restore; sortable `<th>` need `scope`/`aria-sort`.
- [ ] **AI moat is overclaimed.** CLAUDE.md says every Claude call sees portfolio
      context; the briefing and chat inject regime + macro only. Wire holdings
      into `assemble_context()` (see section 4) or correct the docs.
- [ ] **Architecture debt**: split the 1929-line `main.py` into `APIRouter`s; a
      shared dependency so portfolio routes load + enrich once (today `/overview`
      + `/allocation` double the live-price fan-out); tighten CORS
      (`allow_credentials=True` + wildcard methods/headers); structured logging +
      metrics; scheduler jobs must write an `etl_runs` error row on failure.

---

## 2. Test coverage expansion (pillar 2)

Current suite covers positions, analytics, risk, tax, rebalancing, and the
compare finance engine. Gaps to close:

- [ ] `valuation.enrich_positions` - weighting, day-P&L, summary math (mock
      `_yf_info` + `fetch_arbitrary_ticker`).
- [ ] `dividends.compute_dividend_income` - annual income, yield, monthly
      projection, ex-date parsing.
- [ ] `comparison.compare_portfolios` - NAV normalization + pairwise correlation.
- [ ] `etf.compare.compare_tickers` - capture ratios, factor OLS, monthly heatmap.
- [ ] `regime_model` + `regime/stress_test` - classification thresholds and
      segment collapsing (golden fixtures).
- [ ] `csv_import.parse_csv` - Schwab / Fidelity / IBKR header variants, bad
      rows, accounting-negative parsing.
- [ ] `data_health.health` - freshness thresholds and status classification.
- [ ] Route-level smoke tests via `fastapi.testclient.TestClient` for every
      `/api/*` route (assert 200 + shape), with network fetchers monkeypatched.
- [ ] A pytest marker + fixture convention so no test ever hits live yfinance /
      FRED / EDGAR (keeps the suite fast and deterministic).

---

## 3. Data centralization + quality (pillar 3)

- [ ] **Persist everything analytical to DuckDB**: prices_daily, news, options,
      and fundamentals are fetched live and cached only in the sqlite TTL cache.
      Back them with the DuckDB store so panels open instantly and history
      accrues (the scheduler now exists to drive this).
- [ ] Wire the nightly scheduler job to actually backfill `prices_daily` for the
      full instrument universe (data-health currently shows prices "missing").
- [ ] A single typed "instrument resolver" so symbol normalization (crypto
      `-USD`, FX `=X`, indices `^`) lives in one place, not per module.
- [ ] Cache-poisoning guard: never cache empty `[]` upstream responses at full
      TTL (documented gotcha in CLAUDE.md) - add a short negative-cache TTL.
- [ ] Data-lineage stamps: every payload carries `as_of` + `source` so the UI
      can show freshness per card (extends data-health to the panel level).

---

## 4. AI moat - cross-stream synthesis (the differentiator)

The briefing and chat currently see regime + macro but NOT the user's actual
portfolio. CLAUDE.md claims they do; close that gap.

- [ ] Inject live portfolio holdings + P&L + risk into the briefing and chat
      context so Claude reasons across regime, macro, AND positions.
- [ ] "What changed since yesterday" delta briefing (diff regime / macro /
      portfolio against the prior cached snapshot).
- [ ] Agentic chat with tool-use: let Claude query DuckDB and call endpoints
      itself instead of a static context dump.
- [ ] Per-tab "Explain this to me" button: one Claude call that narrates the
      current panel in plain language (directly serves pillar 5).

---

## 5. Portfolio depth

- [ ] **Options / multi-leg positions (DEFERRED - scoped here deliberately).**
      Adding options touches the test-locked FIFO engine (`positions.py`), the
      valuation pipeline (`enrich_positions` assumes 1 share = 1 unit; options
      need a 100x contract multiplier), the equity-curve replay, and risk. Doing
      it halfway would corrupt equity portfolios, so it was NOT shipped this
      cycle. Correct scoped plan:
      - Schema: add nullable `contract_type` (default 'equity'), `expiry`,
        `multiplier` (default 1) to `portfolio_transactions`.
      - `positions.py`: key FIFO lots by `(symbol, contract_type, expiry)` and
        apply `multiplier` to cash + realized math. Equity path must stay
        byte-identical (multiplier 1, contract_type 'equity') - PROVE IT by
        keeping all existing position tests green AND adding option-specific
        tests BEFORE merging.
      - `valuation.py`: multiplier-aware market value; option mark from the
        options chain with cost-basis fallback.
      - Frontend: optional option fields in the transaction form + an Options
        positions section.
- [ ] Multi-currency holdings (FX-translate to base currency).
- [ ] Benchmark selection beyond SPY/QQQ (let the user pick).
- [ ] Wash-sale: upgrade the simplified flag to a full IRS basis re-allocation
      into the replacement lot (currently flags only).
- [ ] Tax-lot selection method toggle (FIFO vs specific-ID vs HIFO) for
      realized-gain optimization.

---

## 6. Cross-asset comparator depth

- [ ] Save / load comparison scenarios (persist investment specs to DuckDB).
- [ ] Sensitivity sliders: re-run the comparison live as the user drags
      appreciation %, loan rate, or hold period (tornado chart of IRR drivers).
- [ ] After-tax returns toggle (apply the tax module to each leg).
- [ ] Real-estate refinements: depreciation / tax shield, refinance events,
      capex reserves, multi-unit, 1031 exchange modeling.
- [ ] Market leg: include dividend reinvestment from real dividend history.
- [ ] Monte Carlo band: distribution of outcomes, not just a point estimate.

---

## 7. Per-tab "mile deep" enhancements (pillar 5)

Each existing tab should gain a plain-language header and one level more depth.
Representative high-value items:

- [ ] **Crypto**: on-chain metrics, funding rates, DeFi TVL, fear/greed history.
- [ ] **FX**: carry (rate differentials), real-effective-exchange-rate, vol cones.
- [ ] **Fixed Income**: duration / convexity per ETF, a bond ladder builder,
      real vs nominal curve toggle, credit-spread overlay.
- [ ] **Dossier**: peer-comp row, analyst estimates, an "AI: why is X moving?"
      synthesis line.
- [ ] **Sector tabs**: rotation radar (20D vs 60D momentum scatter), sector
      correlation matrix, regime -> sector allocation matrix (queued from prior
      sessions, still open).
- [ ] **Technical Analysis follow-ons** (large standing backlog): drag-to-move
      drawing endpoints, volume profile (VPVR), replay mode, pattern
      recognition, backtest overlay, indicator alerts.
- [ ] **Events Calendar**: real BLS / Fed-speech / Treasury-auction schedules
      (replace hardcoded recurrence), earnings folded in, event-impact study.

---

## 8. Accessibility + UX (pillar 5)

- [ ] A consistent plain-language one-liner at the top of every panel
      (the "grandpa test": a non-expert understands the point in one sentence).
- [ ] Glossary / hover-tooltips on every metric (what is Sortino? what is IRR?).
- [ ] Keyboard navigation across panels; the command palette is the entry point.
- [ ] Save & restore panel layout per user.
- [ ] Light/dark theme toggle (currently dark only).
- [ ] Export a panel snapshot as PNG / shareable link.

---

## 9. Productionization

- [ ] **Code-split the frontend bundle** (now ~920KB; over the 500KB warning).
      Dynamic-import heavy panels (charts, technical analysis).
- [ ] Authentication for multi-user (the auth gate is currently disabled).
- [ ] Cloud deploy option (Dockerfile + fly.io / Render) for non-local access.
- [ ] Mobile / PWA companion (manifest + service worker + responsive layout).
- [ ] Alerts engine: OS / Slack / email on regime change, correlation break,
      material 8-K, indicator trigger, or a drawing-line touch.
- [ ] Structured logging + error surfacing (a global frontend error boundary).

---

## 10. Setup (one-time, unlocks live data)

- [ ] Register a free FRED API key -> https://fredaccount.stlouisfed.org/apikeys
- [ ] Add `ANTHROPIC_API_KEY` to `.env` -> https://console.anthropic.com/
- [ ] `cp .env.example .env`, set both keys, restart the backend.
- [ ] (Optional) EIA, BLS, Census, FINRA, CoinGecko-pro keys for the data
      expansions in section 3.

Without keys the terminal still runs in degraded mode (yfinance + EDGAR live;
FRED macro tiles blank; Claude surfaces show a "configure key" message).

---

## 11. Depth audit (2026-06-28) - maximum-depth pass

Six parallel auditors swept ~50 backend modules and ~60 panels against the brief
"audit what features are thin and lack depth; goal is maximum depth throughout."
Verdict: the numerical engine room is genuinely deep, but the two headline
differentiators the README sells hardest (the AI "cross-stream moat" and the
regime model) are the shallowest things in the repo, and a handful of surfaces
render fabricated data as analysis. Items below are the depth backlog. Some
overlap section 1/4/9 above (cross-referenced); the new specifics are the
fabrication inventory and the structural ceilings.

Depth tiers the audit assigned (for context):
- DEEP (keep, defend): portfolio analytics/risk/tax, yield curve, inflation,
  Sahm, indicators, screener, insider/13F/EDGAR, earnings, ETF compare, finance
  IRR engine, ingest + schema + data-health.
- SHALLOW (real but one-dimensional): regime v2, correlations, options, crypto,
  news, real-estate model, market-leg dividends, rebalancing, most macro overlays.
- THIN (fabricated / placeholder / wrong): the ranked list below.

### 11a. Thinnest features, ranked
- [ ] **(P0) AI layer is a context dump, not a moat, and the portfolio half is
      fabricated.** `claude_briefing.py`, `daily_briefing.py`, `terminal_chat.py`
      assemble one static JSON blob and ask for a single streamed narration: no
      tool-use, no agentic loop, no DuckDB self-querying. The "every Claude call
      sees portfolio context" claim is false - `assemble_context` ships
      `positions or []`, the frontend never sends positions, and the chat system
      prompt (`terminal_chat.py:38-39`) advertises portfolio awareness the context
      (`:171-182`) never supplies. Fix: agentic tool-use loop (`query_series`,
      `get_portfolio_risk`, `run_stress_test`, `compare_tickers` over functions
      that already exist in `app/portfolio/`), a real `_portfolio_context(id)`
      injected into all three prompts, and a "what changed since yesterday" delta
      vs the cached snapshot. Default the reasoning model to Opus 4.8. (See sec 4.)
- [ ] **(P0) Regime classifier (the marquee feature) is two `if` statements with
      an invented confidence score.** `regime_model.py:42-96` keys off VIX>25/<15
      and the 2s10s sign only; "confidence" is `0.6 + 0.4x...` with feel-chosen
      divisors. v2 (`regime_model_v2.py`) adds breadth but every increment is a
      hardcoded constant and `_softmax` over arbitrary points is presented as
      calibrated probabilities. Fix (single highest-leverage upgrade since half
      the app keys off it): fit a Markov-switching / HMM on the 5+ series, derive
      posterior state probabilities + a transition matrix, calibrate weights
      against NBER dates / forward returns.
- [ ] **(P1) Supply-chain map is 100% hand-typed and admits it.**
      `sector_supply_chain.py:14` (`SUPPLY_CHAIN`) is editorial dict edges + prose,
      zero data, docstring says "Purely editorial," yet the frontend renders it as
      authoritative SVG arrows. Fix: derive adjacency from rolling cross-sector
      return correlations (helpers exist in `sector_risk`/`sector_credit`) + BEA
      input-output make-use tables for directional strength; edge thickness =
      measured linkage, recomputed daily.
- [ ] **(P1) Legacy events/econ calendar is a fabricated schedule with wrong
      dates.** `calendar.py:89-289` synthesizes every release from nth-weekday
      rules, hardcodes FOMC only for 2026-27 (zero events any other year), and has
      real bugs: JOLTS on "1st Tuesday" (real one lags ~2 months); Consumer
      Confidence comment says "last Tuesday" but code emits 4th Tuesday. Fix:
      ingest the real BLS release schedule + Treasury auction calendar + Fed speech
      feed (all free) into an `econ_events` table with actual/consensus/prior + an
      event-impact study. NOTE: Wave F shipped a *new* `economic_calendar.py`
      (`/api/econ-calendar`) ECO panel, but it is also a generated schedule - it
      does not fix this legacy module's wrong dates; reconcile the two.
- [x] **(P1) Options panel has no greeks, no max pain, no surface.** `options.py`
      only averaged yfinance IV over 5 strikes. SHIPPED in Wave C:
      `data/options_greeks.py` with Black-Scholes delta/gamma/theta/vega per
      contract, full-chain max-pain, GEX by strike, and the IV surface/skew
      (`GET /api/options/{greeks,surface,gex,max-pain}/{symbol}`). The original
      `options.py` panel remains thin - fold it into / replace it with the new
      Options Analytics surface.
- [ ] **(P1) Valuation silently fabricates prices.** `valuation.py:70` substitutes
      `avg_cost` when a quote fails, reporting a fake flat (P&L~0) position with no
      flag - "the one true price fabrication in the system." Fix: return
      `None`/`stale` with an "unpriced" badge, or last DuckDB close with its date,
      never cost basis. (Also tracked in sec 1 / P1.)

Runners-up (named, lower priority):
- [ ] Recession composite score uses eyeballed scaling constants
      (`recession.py:276-310`).
- [ ] Nowcast internal composite is a z-score average mislabeled a GDP nowcast
      (`nowcast.py:139-157`).
- [ ] Correlations is a single 30d-vs-365d Pearson with a magic 0.15 gate.
- [ ] Real-estate model has no depreciation / tax-shield / refi (see sec 6).
- [ ] Market-leg dividends use flat-yield accrual, not real DRIP (see sec 6).
- [ ] Rebalancing is naive proportional, no optimizer.
- [ ] TLH candidates just sorts losers.

### 11b. Fabricated / hardcoded / wrong-metric inventory (renders as real - most reputationally damaging)
- [ ] Portfolio context in AI prompts: claimed everywhere, always `[]`
      (`claude_briefing.py:62`, `terminal_chat.py:38`). [= 11a P0]
- [ ] Supply-chain graph fully hand-typed, no data
      (`sector_supply_chain.py:14`). [= 11a]
- [ ] Econ calendar dates synthesized; FOMC only 2026-27; several wrong
      (`calendar.py:89-289`). [= 11a]
- [ ] Price on quote failure fabricated from cost basis (`valuation.py:70`).
- [ ] REIT FFO/share aliased to `trailingEps` (FFO != EPS)
      (`real_estate_detail.py:195`).
- [ ] 13F CUSIP->ticker stub returns `None`, falls back to a fragile name `LIKE`
      (`institutional_holdings.py:68`).
- [ ] Composite-signal ADX vote: +1 buy on trend *strength* (directional category
      error, biases bullish) (`indicators.py:948`).
- [ ] "Rolling 90-day" macro drivers are actually full-sample; `DGS10` mislabeled
      "10Y Real" (`sector_macro_drivers.py:244`).
- [ ] 5-state regime playbook but the classifier emits 3 states - 3 rows
      permanently dead (`sector_regime_playbook.py:38`).
- [ ] StatusBar "connected" dot hardcoded green regardless of real health
      (`TerminalShell.tsx:344`).

Explicitly flagged ACCEPTABLE (editorial-but-honest config, not fabrication):
sector universes, KPI selections, credit series catalogs, fund-manager CIK list,
FRED catalog.

### 11c. Cross-cutting ceilings (cap depth everywhere)
- [ ] **Silent failure as a system-wide contract (deepest structural problem).**
      ~169 except blocks backend-wide, ~42 silently return empty payloads; `data/*`
      alone has 84 `except Exception`. A throttled yfinance call -> empty result ->
      recorded `status:"ok"`, indistinguishable from a true zero. No
      `degraded`/`errors[]` envelope. Fix: standard envelope so nothing renders
      empty-as-real. NOTE: all NEW Wave C/D/E/F/G modules already carry
      `data_mode`/`as_of`/`source`; the legacy `data/*` modules still need it.
      (Also sec 1 / P1.)
- [ ] **Frontend infra.** All panels statically imported + eagerly mounted
      (thundering-herd fetch on load); zero `React.lazy`/code-split (single chunk,
      now ~1.24MB, over the 500KB warning); no `AbortController` on REST
      (setState-after-unmount risk); the loading/error/data triad hand-rolled ~50
      times. Fix: shared `useFetch`/TanStack Query hook + IntersectionObserver-gated
      mounting + `manualChunks`. (Also sec 1 / P1 + sec 9.)
- [ ] **Zero auth on ~38 mutating routes** (incl. `/api/ingest/*` and every
      `DELETE`) while CLAUDE.md documents `--host 0.0.0.0`. One
      `Depends(require_token)` on the mutating group; default-bind localhost.
      (Also sec 1 / P0.)
- [ ] **`main.py` monolith** (now ~2400 lines, 150+ routes) with no `APIRouter`
      split; `/overview` + `/allocation` double the live-price fan-out. (Also sec
      1 / P2.)
- [ ] **Cash-flow contamination in portfolio returns.** Deposits/withdrawals enter
      NAV, so a deposit day registers as a huge "return," distorting
      Sharpe/Sortino/vol/alpha (`analytics.py:146-152`). Fix: true time-weighted
      (sub-period chained) + money-weighted (IRR) split.

### 11d. Recommended depth-build sequence (the audit's proposed ordering)
1. [ ] **Honesty pass** (fast, high trust): `degraded`/`errors[]`/`as_of`/`source`
       envelope on legacy modules; fix `valuation.py:70`, REIT FFO field, the ADX
       vote, the macro-driver mislabels, the dead playbook states, the hardcoded
       StatusBar.
2. [ ] **Make the moat real**: agentic tool-use chat + portfolio injection + delta
       briefing.
3. [ ] **Replace the two fabricated surfaces with data**: real econ-release
       ingestion (`econ_events` table) and a computed sector-adjacency graph.
4. [ ] **Deepen the regime model** (HMM / Markov-switching, calibrated
       probabilities).
5. [ ] **Frontend infra refactor** (lazy mount + `useFetch` + abort) and **auth on
       mutations**.
6. [ ] **Per-feature depth**: options greeks/max-pain/GEX (DONE, Wave C), crypto
       on-chain, multi-source news + sentiment, real-estate tax modeling,
       rebalancing optimizer, real dividend calendars.

---

## 12. Bloomberg parity gap backlog (2026-06-28, ultracode audit)

Ten domain auditors swept the Bloomberg Terminal for features we have NOT
shipped; a synthesis pass deduped 125 candidates into the ranked backlog below.
All 40 are buildable now (free/derivable data or honest sample fallback). Tags:
`[impact / build-difficulty]`, Bloomberg mnemonic in parens. Rank 1 = build first.

**Synthesis:** The biggest gaps cluster in four themes: (1) signature single-screen "WOW" panels Bloomberg is famous for but we lack — the RV comps grid, a global central-bank rate board, Treasury auction results, and net-liquidity; (2) free-but-derivable analytics that look expensive — crack/inter-commodity spreads, OAS-by-rating, real-yield/breakeven curves, Taylor Rule, and forward-rate matrices; (3) marketing-viral flow/sentiment tools — Fear/Greed gauge, per-ticker NLP sentiment, news-heat, WSB social sentiment, and a clone-the-superinvestor 13F tracker; and (4) institutional depth — portfolio attribution, component VaR, pre-trade what-if, and a CDS pricer. Build first the low-difficulty, high-WOW screens that demo instantly (RV grid, CB rate board, Treasury auctions, net-liquidity, NLP sentiment) before moving to the medium-effort desk analytics.

Build cadence: **Wave H = ranks 1-5, Wave I = ranks 6-10**, then continue in
waves of five down the list.

### Wave H - next up (ranks 1-5)

- [x] **1. Relative Valuation Comps Grid (RV) `RV`** [HIGH / medium effort] - Ticker-centric peer table auto-selecting a comp set, lining up P/E, fwd P/E, EV/EBITDA, EV/Sales, P/B, FCF yield, margins and growth vs peer-median with premium/discount columns, computed from yfinance .info multiples.
      _Why this rank:_ The single most iconic Bloomberg screen; instantly recognizable, demos in seconds, fully buildable from free multiples.
- [x] **2. Global Central-Bank Policy-Rate Monitor (merged WIRP/CBQ) `WIRP`** [HIGH / medium effort] - Board of every major policy rate (Fed/ECB/BoE/BoJ/SNB/BoC/RBA/PBOC plus EM: Banxico/BCB/RBI) with current level, last move, days since change, real (inflation-adjusted) rate, next-meeting date and market-implied bias; from FRED/BIS series with sample fallback. Merges the duplicate FX-EM and Economics requests.
      _Why this rank:_ Visually striking world board, one of the most-shared macro views; merges two domain requests into one high-WOW panel.
- [x] **3. Treasury Auction Calendar & Results** [HIGH / low effort] - Upcoming and historical bill/note/bond/TIPS/FRN auctions with bid-to-cover, high yield, tail vs WI, and indirect/direct/dealer allotment, pulled live from the free TreasuryDirect Auctions API.
      _Why this rank:_ Live free API, low effort, and 'real auction data updating' is a credibility-establishing WOW for a terminal.
- [x] **4. Central-Bank Balance Sheet & Net-Liquidity Monitor `FARBAST`** [HIGH / low effort] - Fed total assets (WALCL) minus TGA minus RRP = the closely-watched 'net liquidity', plus QT runoff pace and reserve balances over time; today WALCL is only a raw catalog series with no liquidity calc.
      _Why this rank:_ Famous macro chart traders obsess over; trivial FRED arithmetic on series we already have, big perceived sophistication.
- [x] **5. Per-Ticker NLP News Sentiment Scoring `NSTM`** [HIGH / low effort] - Score every yfinance headline+summary with a financial lexicon (Loughran-McDonald + VADER) for a per-ticker bull/bear score, rolling sentiment trend, and most-positive/negative articles; today we only echo a third-party tag and compute nothing.
      _Why this rank:_ Turns an existing news feed into proprietary analytics at low cost; sentiment color-coding reads as advanced AI.

### Wave I (ranks 6-10)

- [x] **6. Earnings-Quality Scorecard (F/Z/M-Score)** [HIGH / medium effort] - Piotroski F-Score, Altman Z-Score, Beneish M-Score, and an accruals ratio from EDGAR financials to flag accounting red flags, distress, and earnings-manipulation likelihood per ticker.
      _Why this rank:_ Distinctive forensic-accounting differentiator; a single 'red flag' verdict screen is highly demo-able.
- [x] **7. Market-Wide Fear/Greed Sentiment Index `NSTM`** [med / low effort] - Aggregate per-headline sentiment across the watchlist/index universe into a single -100..+100 market-mood gauge with history and breadth (% of tickers net-positive), reusing the lexicon scoring from the per-ticker engine.
      _Why this rank:_ Extremely shareable, marketing-friendly gauge; near-free once the per-ticker sentiment engine (rank 5) exists.
- [x] **8. Crack Spreads & Refining Margins (3-2-1) `CRK`** [HIGH / low effort] - 3-2-1 / 5-3-2 crack spread and gasoline/distillate refining margins computed live from CL/RB/HO front-month futures (2*RB + 1*HO - 3*CL per bbl) with historical band and seasonality context.
      _Why this rank:_ Pure arithmetic on futures we already pull; a recognizable energy-desk staple with high signal.
- [x] **9. Inter-Commodity Spreads & Ratios** [HIGH / low effort] - Gold/silver, gold/oil, WTI-Brent, gas/oil BTU ratio and soybean board crush, each derived arithmetically from yfinance front-month futures with percentile/z-score history.
      _Why this rank:_ Several classic desk spreads from data on hand; cheap breadth across the commodity complex.
- [x] **10. Taylor Rule / Policy-Rule Estimator `TAYL`** [HIGH / low effort] - Taylor, balanced-approach and inertial rule-implied fed funds from the inflation gap and unemployment/output gap, overlaid on the actual rate with restrictive/accommodative labeling; fully from FRED (PCEPILFE, UNRATE, NROU).
      _Why this rank:_ Low-effort, high-IQ macro screen that visibly 'judges' the Fed; great talking-point in demos.

### Further backlog (ranks 11-40)

- [x] **11. Corporate OAS Term-Structure by Rating `SPRD`** [HIGH / low effort] - Option-adjusted spread surface across AAA-CCC and IG-vs-HY with historical percentile/z-score and spread-per-turn-of-duration, from ICE BofA OAS series on FRED (BAMLC0A*, BAMLH0A*).
      _Why this rank:_ Core credit-RV view, free FRED data, low lift; deepens the existing credit/CDS curves meaningfully.
- [x] **12. Breakeven Inflation & TIPS Real-Yield Curve `BEI`** [HIGH / low effort] - Full term structure of breakevens (5Y/10Y/30Y, 5y5y fwd) and TIPS real yields (DFII5/10/30, T5YIE/T10YIE/T5YIFR from FRED) with real-vs-nominal curve and carry decomposition, deeper than the headline inflation dashboard.
      _Why this rank:_ High-value rates screen, all free FRED series, minimal build on top of existing inflation work.
- [x] **13. REER & PPP Fair-Value Monitor `REER`** [HIGH / low effort] - Trade-weighted REER per currency from FRED BIS series with z-score vs its 10y mean plus a PPP fair-value band, flagging rich/cheap currencies in real terms.
      _Why this rank:_ Low effort, distinct from spot FX already shipped; 'which currency is cheap' is an instant hook.
- [x] **14. Single-Name CDS Pricer (CDSW) `CDSW`** [HIGH / low effort] - Marks a CDS to market: par-spread to/from upfront points off the existing credit-triangle survival curve, with CS01/DV01, accrued and PnL for a chosen notional and coupon (100/500).
      _Why this rank:_ Reuses the shipped survival curve; a working pricer signals derivatives credibility at low cost.
- [x] **15. News-Heat / Abnormal News-Volume Detector `NH`** [HIGH / low effort] - Rolling article counts per ticker with z-score spike flags so an unusual coverage burst surfaces before the price moves; pure count statistics over the existing news feed.
      _Why this rank:_ Cheap statistic over data we already cache; a leading 'something is happening' alert reads as predictive.
- [x] **16. Superinvestor / Smart-Money Clone Tracker** [HIGH / medium effort] - Tracks famous managers (Berkshire, Pershing, Scion, etc.) by CIK from 13F filings, showing top positions, latest-quarter moves and a cloneable model portfolio weighted by reported market values.
      _Why this rank:_ Huge marketing pull ('clone Buffett'); free EDGAR data, instantly viral demo content.
- [x] **17. Volume Profile (VPVR / Volume-at-Price) `GP`** [HIGH / medium effort] - Horizontal volume-by-price histogram over a visible/fixed range surfacing Point of Control and Value Area High/Low (70%) and HVN/LVN, approximated by distributing each bar's volume across its high-low span from free OHLCV.
      _Why this rank:_ Visually striking pro-charting feature retail tools charge for; strong screenshot WOW from free data.
- [x] **18. Social / Retail Sentiment (WSB + StockTwits)** [HIGH / medium effort] - StockTwits public stream and Reddit r/wallstreetbets/r/stocks mention counts for mention-velocity and bull/bear ratio per ticker, with deterministic sample fallback when endpoints rate-limit.
      _Why this rank:_ Meme-stock zeitgeist appeal; highly marketable even though feeds are rate-limited (honest sample fallback).
- [ ] **19. Implied Forward-Rate Matrix (FWCM) `FWCM`** [HIGH / medium effort] - Bootstraps the spot Treasury curve into a forward-rate grid (1y1y, 2y1y, 5y5y, 1y9y) so users see priced future short rates and compare forwards to spot for curve trades.
      _Why this rank:_ Derived analytically from the curve we already ship; a serious rates-desk tool with little new data.
- [ ] **20. Carry & Rolldown Curve RV Analyzer (CARRY) `CARRY`** [HIGH / medium effort] - Expected carry, rolldown and 3m/6m/12m horizon return for each curve point and common spread/butterfly trades, ranking the richest carry+roll opportunities, derived analytically from the shipped spot curve.
      _Why this rank:_ High-value trade-idea generator built purely on the existing curve; pairs naturally with the forward matrix.
- [ ] **21. Global Sovereign Bond Monitor (WB) `WB`** [HIGH / medium effort] - Grid of 10Y (and 2Y/30Y) government yields across major economies with daily bp moves and spreads-to-Treasury/Bund, from FRED OECD long-term rate series (IRLTLT01*) with sample fallback.
      _Why this rank:_ Another high-impact world board complementing the rate monitor; free FRED data, broad appeal.
- [ ] **22. Financial Conditions Index Monitor `BFCIUS`** [HIGH / medium effort] - Composite tracker combining Chicago Fed NFCI/ANFCI and St. Louis STLFSI with a homemade index of credit spreads, equity vol, USD and real rates to flag tight vs loose regimes, all from FRED.
      _Why this rank:_ Single 'are conditions tight?' gauge is a powerful macro narrative tool; all free series.
- [ ] **23. PMI / Business-Survey Diffusion Aggregator** [HIGH / medium effort] - Aggregates ISM mfg & services and regional Fed surveys (Empire, Philly, Dallas, KC, Richmond) plus S&P Global PMI into a diffusion heatmap with the 50 threshold and a composite forward-activity read from FRED.
      _Why this rank:_ Color-coded expansion/contraction heatmap is a clean WOW; consolidates many FRED series into one view.
- [ ] **24. Unusual Options Activity Scanner (OMON) `OMON`** [HIGH / medium effort] - Structured scanner over the live yfinance option chain flagging volume-to-OI spikes, large premium prints, and call/put premium skew per strike, ranking the day's most unusual contracts.
      _Why this rank:_ 'Smart-money options' angle is highly marketable; builds on the options chain we already have.
- [ ] **25. ETF Net-Flow Dashboard** [HIGH / medium effort] - Estimates daily/weekly net dollar flow per ETF as delta-shares-outstanding times NAV (vs current ETF panel showing only AUM/perf/holdings), ranked by sector and asset class to show where money is rotating.
      _Why this rank:_ 'Where is money flowing' is a compelling rotation story; extends the existing ETF tracker.
- [ ] **26. Dark-Pool & Off-Exchange Short Volume** [HIGH / medium effort] - Daily off-exchange short-sale volume ratio and ATS/dark-pool participation per symbol and aggregate from FINRA's free daily short-volume and weekly OTC/ATS files, flagging hidden accumulation/distribution.
      _Why this rank:_ 'Dark pool' framing is intriguing to retail; genuinely useful signal from free FINRA data.
- [ ] **27. 13F Change-Tracking & Hedge-Fund Clustering (HDS) `HDS`** [HIGH / medium effort] - Quarter-over-quarter delta engine on EDGAR 13F filings (new buys, sold-out, add/trim %) plus a crowding view clustering which managers concentrate in the same names, extending the static 13F holdings panel.
      _Why this rank:_ Turns the static 13F panel into change/crowding signal; reuses data and feeds the superinvestor tracker.
- [ ] **28. Brinson-Fachler Performance Attribution (PORT) `PORT`** [HIGH / medium effort] - Decomposes active return vs benchmark into allocation, selection and interaction effects per GICS sector, using portfolio vs benchmark sector weights and sector-ETF returns as the benchmark proxy.
      _Why this rank:_ Institutional table-stakes that elevates the portfolio module from retail to pro; buildable from sector ETFs.
- [ ] **29. Pre-Trade What-If Portfolio Analytics (PORT) `PORT`** [HIGH / medium effort] - Simulates a proposed buy/sell/rebalance and shows before/after deltas in volatility, VaR, tracking error, factor exposures and concentration so the user sees a trade's risk impact before execution.
      _Why this rank:_ Interactive 'what does this trade do to my risk' is a satisfying live demo; reuses existing risk engines.
- [ ] **30. Marginal & Component VaR per Holding (PORT) `PORT`** [HIGH / medium effort] - Attributes total portfolio VaR/CVaR to each position via marginal VaR and component VaR (summing to total), exposing which names actually drive tail risk beyond the existing concentration HHI.
      _Why this rank:_ Sharpens the shipped VaR with per-name tail-risk attribution; modest extension, strong institutional credibility.
- [ ] **31. IRS Swap Curve & Vanilla Swap Pricer (merged IRSB/SWPM) `IRSB`** [HIGH / medium effort] - Bootstraps a SOFR/swap curve from FRED, prices a fixed-for-floating swap (par rate, PV, DV01) and charts swap spreads vs the Treasury curve; deterministic sample where discontinued USD swap series are unavailable. Merges the Fixed-Income and Credit requests.
      _Why this rank:_ Foundational rates product appearing in two domains; one build serves both, swap spreads add RV depth.
- [ ] **32. Hedging & Overlay Designer (HEDG) `HEDG`** [HIGH / medium effort] - Computes optimal hedge ratios to neutralize portfolio beta/duration/FX with futures/ETFs (min-variance cross-hedge) and prices a protective-put or zero-cost collar overlay with cost and residual-risk impact via the existing Black-Scholes engine.
      _Why this rank:_ Actionable 'how do I hedge this' tool reusing the shipped options engine; high utility, moderate build.
- [ ] **33. EM Sovereign Risk & Reserves Dashboard (EMBI) `EMBI`** [HIGH / medium effort] - Per-country panel of FX reserves (and import-cover adequacy), hard-currency EMBI-style spread, 5y sovereign CDS proxy and external-debt ratios to rank EM crisis vulnerability.
      _Why this rank:_ Crisis-ranking heatmap is a strong narrative panel; broadens coverage beyond DM into EM.
- [ ] **34. Natural-Gas Storage vs 5-Year Band** [med / low effort] - EIA weekly working-gas-in-storage with injection/withdrawal deltas plotted against the 5-year average and min/max seasonal envelope, plus surplus/deficit-to-normal.
      _Why this rank:_ Headline gas-balance chart, free EIA data, low effort; the seasonal-band visual is instantly readable.
- [ ] **35. Heating & Cooling Degree Days (HDD/CDD)** [HIGH / medium effort] - Population-weighted national HDD/CDD from NOAA/FRED with deviation-from-normal, the core weather-demand driver for natural gas and power; seasonally realistic sample fallback.
      _Why this rank:_ Weather-driven energy demand is a unique angle few competitors show; pairs with the gas-storage panel.
- [ ] **36. Country / Global Macro Scorecard (ECST) `ECST`** [HIGH / medium effort] - Cross-country G20/OECD heatmap of GDP growth, CPI, unemployment, policy rate, PMI and current-account balance, color-coded vs history, from FRED international and OECD CLI series with sample fallback.
      _Why this rank:_ A full-world macro heatmap is a flagship 'terminal' visual; complements the rate and PMI boards.
- [ ] **37. Custom Study / Formula Builder (CIXB) `CIXB`** [HIGH / high effort] - A formula language letting users compose synthetic series and custom indicators from price/volume/other tickers (e.g. close(SPY)/close(TLT)*100, ema(rsi(AAPL),5)), evaluated server-side and rendered as a study.
      _Why this rank:_ Power-user differentiator that mirrors Bloomberg's custom-index editor; higher effort but a standout capability.
- [ ] **38. Filing Diff & Redline (10-K/10-Q YoY) (DOC) `DOC`** [HIGH / high effort] - Pulls two consecutive 10-K/10-Q full texts from EDGAR, section-aligns Risk Factors and MD&A, and renders an added/removed redline so material language changes (new risks, dropped disclosures) are visible at a glance.
      _Why this rank:_ 'See exactly what changed in the 10-K' is a memorable demo; higher build effort but free EDGAR data.
- [ ] **39. FX Volatility Surface (RR/BF/Skew) `OVDV`** [HIGH / medium effort] - Full delta-strike vol surface per pair: ATM term structure, 25-delta and 10-delta risk reversals and butterflies, and smile interpolation, extending the existing realized-vol cone into an options-desk skew/sentiment view.
      _Why this rank:_ Options-desk-grade FX view deepening shipped FX analytics; surface visuals impress, sample-backed where quotes are absent.
- [ ] **40. Black-Litterman Allocation with Views (PORT) `PORT`** [HIGH / high effort] - Blends market-implied equilibrium returns (reverse-optimized from cap weights) with user absolute/relative views and confidences for posterior expected returns and constrained optimal weights, far more stable than raw mean-variance.
      _Why this rank:_ Premium optimizer that fixes the brittleness of the shipped mean-variance solver; high effort, placed last among high-impact items.

---

## 13. Full Bloomberg gap inventory - all 125 audited candidates (2026-06-28)

The complete, un-deduped output of the 10 domain auditors (section 12 is the
ranked top-40 synthesis of these). Grouped by domain. Tags: `[impact / difficulty]`,
`status` (missing = nothing yet, partial = thin version exists), Bloomberg mnemonic
in parens where known, `(paid)` if it strictly needs a feed we lack.

### Equities & Research (12)

- [ ] **Relative Valuation Comps Grid (RV) `RV`** [HIGH / medium] _missing_ - Ticker-centric peer comparison table that auto-selects a comp set (sector/industry or user-supplied) and lines up P/E, fwd P/E, EV/EBITDA, EV/Sales, P/B, FCF yield, margins and growth side-by-side with a peer-median and premium/discount column, computed from yfinance .info multiples.
- [ ] **As-Reported Multi-Year Financial Statements (FA) `FA`** [HIGH / high] _partial_ - Full 5-10yr income statement, balance sheet, and cash-flow statement viewer with YoY/CAGR growth and common-size %, pulled from EDGAR XBRL companyfacts (us-gaap tags) rather than yfinance's thin ratio snapshot.
- [ ] **Earnings Quality Scorecard** [HIGH / medium] _missing_ - Computes Piotroski F-Score, Altman Z-Score, Beneish M-Score, and a balance-sheet accruals ratio from EDGAR financials to flag accounting red flags, distress risk, and earnings manipulation likelihood for a ticker.
- [ ] **Company Supply-Chain & Revenue Exposure (SPLC) `SPLC`** [HIGH / high] _partial_ - Company-level (not sector-level) breakdown of revenue by reportable business segment and by geography, parsed from EDGAR XBRL segment/geographic tags, with an honest sample fallback where segment disclosure is sparse; complements the existing editorial sector adjacency map.
- [ ] **ESG & Controversy Dashboard (ESG) `ESG`** [med / low] _missing_ - Surfaces Sustainalytics ESG risk scores (total/environment/social/governance), controversy level, and peer percentile via yfinance .sustainability, with deterministic sample fallback for tickers lacking coverage.
- [ ] **IPO / New-Issue Monitor (IPO) `IPO`** [med / medium] _missing_ - Tracks recent and pipeline IPOs by scanning EDGAR for S-1, 424B, and EFFECT filings, listing issuer, proposed/priced terms, shares, and filing dates, with first-day/aftermarket performance for recently-listed names from yfinance.
- [ ] **Index Weightings & Return Contribution (MEMB/IMAP) `MEMB`** [med / medium] _missing_ - Constituent weights and contribution-to-return for major indices (S&P 500, Nasdaq 100) derived from tracking-ETF holdings (e.g. SPY/QQQ) and component returns, showing which names are driving the index move.
- [ ] **Activist & Beneficial-Ownership Monitor (13D/13G)** [med / medium] _missing_ - Tracks >5% beneficial-ownership stakes and activist positions from EDGAR SC 13D / 13G / 13D-A filings (filer, stake %, date, purpose), distinct from the quarterly 13F institutional snapshot already shipped.
- [ ] **Dilution & Share-Count Trend Tracker** [med / medium] _missing_ - Charts diluted shares outstanding over time, net buyback-vs-issuance, and stock-based-compensation dilution from EDGAR, isolating real per-share value creation/destruction versus the existing yield-focused buyback tracker.
- [ ] **DuPont ROE Decomposition** [med / low] _missing_ - Decomposes return on equity into net margin x asset turnover x equity multiplier (3- and 5-step DuPont) across multiple years from EDGAR financials to show whether returns are margin-, efficiency-, or leverage-driven.
- [ ] **Reverse DCF / Market-Implied Growth** [med / medium] _missing_ - Inverts the existing DCF engine to solve for the revenue/FCF growth rate the current share price implies, then contrasts it against historical and consensus growth to gauge how aggressive the market's expectations are.
- [ ] **Post-Earnings Drift & Surprise Analytics (PEAD) `ERN`** [med / medium] _partial_ - Builds a per-ticker history of EPS/revenue surprise magnitude vs the subsequent 1/5/20-day price drift to quantify how the stock historically reacts to beats and misses, extending the existing surprise-history table into a tradable signal.

### Fixed Income & Rates (12)

- [ ] **Global Sovereign Bond Monitor `WB`** [HIGH / medium] _missing_ - Grid of 10Y (and 2Y/30Y) government bond yields across major economies (US/DE/UK/JP/FR/IT/CA/AU etc.) with daily bp moves and spreads-to-Treasury/Bund, sourced from FRED OECD long-term rate series (IRLTLT01xxxM156N) with sample fallback.
- [ ] **Interest-Rate Swap Curve & Swap Spreads `IRSB`** [HIGH / medium] _missing_ - Par swap rate curve by tenor (1Y-30Y) plus swap spreads (swap minus matched-maturity Treasury) and their history, built off SOFR/Treasury FRED series with a deterministic sample swap curve where the discontinued USD swap series are unavailable.
- [ ] **Treasury Auction Calendar & Results** [HIGH / low] _missing_ - Upcoming and historical Treasury auctions (bill/note/bond/TIPS/FRN) with bid-to-cover, high yield, tail vs WI, and indirect/direct/primary-dealer allotment, pulled live from the free TreasuryDirect Auctions API.
- [ ] **Repo & Money-Market Funding Monitor `RRP`** [med / low] _missing_ - Tracks SOFR, EFFR, OBFR, the ON RRP award rate and take-up volume, IORB, and reserve balances with key funding spreads (SOFR-EFFR, SOFR-IORB) to flag funding stress, all from FRED daily series.
- [ ] **Breakeven Inflation & TIPS Real-Yield Curve `BEI`** [HIGH / low] _partial_ - Dedicated term structure of breakeven inflation (5Y/10Y/30Y, 5y5y forward) and TIPS real yields (DFII5/DFII10/DFII30, T5YIE/T10YIE/T5YIFR from FRED), going deeper than the headline inflation dashboard with a full real-vs-nominal curve and carry decomposition.
- [ ] **Municipal Yield Curve & Muni/Treasury Ratios `BVAL`** [med / medium] _missing_ - AAA muni curve by maturity, muni-to-Treasury yield ratios (the classic relative-value gauge), and taxable-equivalent yield calculator, built from MUB/muni index proxies plus a sample MMD-style curve with honest labeling.
- [ ] **MBS / Agency Current-Coupon Monitor `MTGE`** [med / medium] _missing_ - Agency MBS current-coupon yield, primary-secondary spread, par-coupon stack, and a mortgage-rate vs 10Y nominal-spread series using Freddie Mac PMMS (MORTGAGE30US) from FRED plus a deterministic OAS/coupon-stack sample.
- [ ] **Corporate OAS Term-Structure Monitor (by Rating) `SPRD`** [HIGH / low] _partial_ - Option-adjusted spread surface across rating buckets (AAA/AA/A/BBB/BB/B/CCC) and IG-vs-HY with historical percentile/z-score and spread-per-turn-of-duration, from ICE BofA OAS series on FRED (BAMLC0A*, BAMLH0A*); deeper than the shipped CDS/credit curve view.
- [ ] **Bond Ladder & Cash-Flow Matching Tool** [med / medium] _missing_ - Builds a bond/CD ladder or liability-matched portfolio, projects the dated coupon + principal cash-flow schedule, reinvestment assumptions, and gap-to-liability, with portfolio duration/convexity rollup; pure deterministic math over the live or sample curve.
- [ ] **Carry & Rolldown Curve RV Analyzer `CARRY`** [HIGH / medium] _missing_ - Computes expected carry, rolldown, and total 3m/6m/12m horizon return for each point and common spread/butterfly trades on the Treasury curve, ranking the richest carry+roll opportunities, derived analytically from the shipped spot curve.
- [ ] **Implied Forward-Rate Matrix `FWCM`** [HIGH / medium] _missing_ - Bootstraps the spot Treasury curve into a forward-rate grid (e.g., 1y1y, 2y1y, 5y5y, 1y9y) so users can see what the market prices for future short rates and compare forwards to spot for curve-trade setup.
- [ ] **Treasury Futures CTD & Basis Screen `DLV`** [med / high] _missing_ - For each CME Treasury futures contract (TU/FV/TY/US/WN) identifies the cheapest-to-deliver issue using conversion factors, and shows gross/net basis and implied repo; built on a sample deliverable basket priced off the live curve since contract specs are static and public.

### FX & Emerging Markets (12)

- [ ] **Global Central Bank Policy Rate Monitor `WIRP`** [HIGH / medium] _missing_ - Side-by-side board of every major policy rate (Fed, ECB, BoE, BoJ, SNB, RBA, BoC, Riksbank, Norges, plus EM banks like Banxico/BCB/RBI) with current level, last move, real (inflation-adjusted) rate, and an upcoming-meeting calendar with market-implied hike/cut bias.
- [ ] **Real Effective Exchange Rate (REER) & PPP Fair Value `REER`** [HIGH / low] _missing_ - Trade-weighted REER index per currency from FRED BIS series with z-score vs its own 10y mean plus a purchasing-power-parity fair-value band, flagging which currencies are rich/cheap in real terms.
- [ ] **FX Volatility Surface (RR / BF / Skew Term Structure) `OVDV`** [HIGH / medium] _partial_ - Full delta-strike vol surface per pair: ATM term structure, 25-delta and 10-delta risk reversals and butterflies, and smile interpolation, extending the existing realized vol cone into an options-desk-style skew/sentiment view.
- [ ] **NDF Curve & EM Implied Yields `FRD`** [med / medium] _missing_ - Non-deliverable-forward curve for non-convertible EM crosses (USDBRL, USDINR, USDKRW, USDTWD, USDIDR, USDCNY) with forward points by tenor and the CIP-implied local yield backed out, distinct from the G10 deliverable CIP forwards already shipped.
- [ ] **EM Sovereign Risk & Reserves Dashboard `EMBI`** [HIGH / medium] _missing_ - Per-country panel of FX reserves (and reserves/import-cover adequacy), hard-currency EMBI-style spread, 5y sovereign CDS proxy, and external-debt ratios to rank EM crisis vulnerability.
- [ ] **Currency Carry Basket Index & Backtest** [HIGH / medium] _partial_ - Constructs a tradeable G10/EM carry strategy (long top-3 yielders, short bottom-3, vol-weighted) and returns a cumulative total-return index with Sharpe, max drawdown, and crash-risk stats, going beyond the static carry ranking table already shipped.
- [ ] **FX Correlation Matrix & Rolling Regime `CORR`** [med / low] _missing_ - Rolling pairwise correlation heatmap across the majors plus key EM crosses, with risk-on/risk-off clustering and a rolling correlation-to-DXY (or to risk) timeline to spot regime shifts.
- [ ] **FX Seasonality (Per-Pair Monthly Patterns) `SEAG`** [med / low] _missing_ - Month-of-year and day-of-week average return and hit-rate tables per currency pair from multi-year history, an FX-specific analogue to the equity seasonality tool already shipped.
- [ ] **Cross-Currency Basis Swap Monitor `XCCY`** [med / medium] _missing_ - Tracks the XCCY basis (deviation from covered interest parity) for EURUSD, USDJPY, GBPUSD etc. as a USD-funding-stress gauge, computed as the residual between FX-implied and money-market USD rates.
- [ ] **FX Positioning Sentiment Extremes (IMM) `CFTC`** [med / low] _partial_ - FX-specific view of CFTC IMM net speculative positioning expressed as a percentile/z-score vs 3y history per currency, flagging crowded longs/shorts and contrarian reversal setups, deeper than the generic COT report.
- [ ] **EM Currency Stress / Contagion Index** [med / medium] _missing_ - Composite stress score blending EM FX depreciation momentum, realized vol spike, reserve drawdown, and rate-hike intensity into a single 0-100 gauge with a cross-currency contagion correlation map.
- [ ] **Forward Points & Carry-Roll Grid `FRD`** [med / low] _partial_ - Tenor-by-pair grid (1W to 1Y) of FX forward points, annualized swap yield, and expected roll-down/carry-to-vol ratio for G10 and EM, giving a dedicated forwards desk view versus the single carry number per pair today.

### Commodities & Energy (13)

- [ ] **Crack Spreads & Refining Margins (3-2-1) `CRK`** [HIGH / low] _missing_ - Computes the 3-2-1 / 5-3-2 crack spread and gasoline/distillate refining margins live from CL, RB and HO front-month futures (2*RB + 1*HO - 3*CL, per-bbl), with a historical band and contango/seasonality context.
- [ ] **Inter-Commodity Spreads & Ratios** [HIGH / low] _missing_ - Dashboard of the spreads/ratios desks watch: gold/silver ratio, gold/oil ratio, WTI-Brent spread, gas/oil BTU ratio, and soybean board crush (oil+meal vs beans), each derived arithmetically from yfinance front-month futures with percentile/z-score history.
- [ ] **Natural Gas Storage Report (vs 5-Year Band)** [med / low] _missing_ - EIA weekly working-gas-in-storage with injection/withdrawal deltas plotted against the 5-year average and min/max seasonal envelope, plus surplus/deficit-to-normal — the headline gas-balance signal not in our current inventory tiles.
- [ ] **EIA Petroleum Inventory Surprise + 5-Year Seasonal Band `DOE`** [med / medium] _partial_ - Deepens the existing crude/gasoline/distillate inventory tiles by plotting each stock level against its 5-year seasonal band and computing the weekly draw/build vs the prior-5yr-average change (the surprise that actually moves crude).
- [ ] **Weather: Heating & Cooling Degree Days (HDD/CDD)** [HIGH / medium] _missing_ - Population-weighted national HDD/CDD from NOAA/FRED with deviation-from-normal, the core weather-demand driver for natural gas and power; honest sample fallback generates a seasonally realistic degree-day curve.
- [ ] **USDA Crop Supply/Demand (WASDE) & Stocks-to-Use** [med / medium] _missing_ - Agricultural balance sheet for corn/soybeans/wheat: production, ending stocks and stocks-to-use ratio from the free USDA WASDE/QuickStats feeds, the fundamental anchor under ag futures pricing.
- [ ] **Crop Progress & US Drought Monitor** [med / medium] _missing_ - USDA weekly crop-progress/condition (% good-excellent) and NOAA/USDM drought-coverage by state for the grain belt, mapped to the growing-season calendar — a distinct weather/agronomy panel from price data.
- [ ] **Precious Metals Physical & Mining Complex** [HIGH / medium] _partial_ - Gold/silver ratio, GLD/SLV ETF holdings flows, miner equity complex (GDX/GDXJ/SIL) relative strength, and a gold-vs-10yr-TIPS-real-rate overlay (FRED DFII10) — extends the thin GC/SI spot tiles into the real precious-metals desk view.
- [ ] **Spark & Dark Spreads (Power Generation Margins)** [med / medium] _missing_ - Implied gas-fired (spark) and coal-fired (dark) generation margins using regional power price proxies vs Henry Hub gas and a heat-rate assumption, with CO2-adjusted clean-spark variant; sample fallback when wholesale power prints are unavailable.
- [ ] **Roll-Yield / Carry Total-Return Commodity Index** [med / medium] _partial_ - Turns the existing curve's roll-yield numbers into a backtested excess-vs-spot return series quantifying contango drag/backwardation carry per commodity (GSCI-style), so users see what holding the front contract actually earns over time.
- [ ] **Freight Rates by Vessel Class (Dry-Bulk & Tanker)** [med / medium] _partial_ - Breaks our single shipping proxy into Capesize/Panamax/Supramax dry-bulk and VLCC/BDTI/BCTI tanker rate sub-indices plus container (SCFI/Drewry WCI) levels; deterministic sample series where the free index print is paywalled.
- [ ] **Electricity Generation Mix & Grid Demand** [med / medium] _missing_ - EIA hourly/daily generation-by-fuel (gas, coal, nuclear, wind, solar, hydro) and regional grid demand, surfacing the power-market backdrop driving gas and carbon — uses the free EIA grid-monitor API with sample fallback.
- [ ] **Carbon & Emissions Markets** [low / low] _missing_ - Tracks EU ETS (EUA), California CCA and RGGI allowance prices plus a clean-spark/compliance-cost overlay; built from ETF/futures proxies (KRBN/GRN) and honest sample series where the auction print is unavailable.

### Credit & Derivatives (13)

- [ ] **CDS Index Monitor (CDX & iTraxx) `CDX`** [HIGH / medium] _missing_ - Tracks CDX IG/HY and iTraxx Main/Crossover index spreads, on-the-run series roll, and index-vs-intrinsic (fair-value) skew, proxying levels from LQD/HYG OAS plus FRED ICE BofA indices with honest deterministic sample for the actual index quotes.
- [ ] **Single-Name CDS Pricer / Valuation `CDSW`** [HIGH / low] _missing_ - Marks a CDS contract to market: converts par spread to/from upfront points, prices the protection and premium legs off the existing credit-triangle survival curve, and outputs CS01/DV01, accrued, and PnL for a chosen notional and coupon (100/500).
- [ ] **Structural Default-Risk Model (Merton / Distance-to-Default) `DRSK`** [HIGH / medium] _missing_ - Computes a 1-year default probability and implied credit spread per issuer via a Merton/KMV structural model, solving for asset value and asset vol from yfinance equity cap + option-implied vol against EDGAR-sourced short/long-term liabilities.
- [ ] **Distressed & Stressed-Credit Monitor `DIS`** [HIGH / medium] _missing_ - Screens the HY universe for distressed names (OAS >1000bps / dollar price <70), tracks the trailing HY default rate and recovery assumptions, and flags fallen-angel / rising-star migration using FRED OAS series plus a sample issuer ladder.
- [ ] **Capital Structure & Debt Maturity Wall `DDIS`** [med / medium] _missing_ - Builds a per-issuer debt stack by seniority and a maturity-wall timeline from EDGAR filings, with leverage ladder, weighted coupon, and a refinancing-wall chart to visualize near-term funding risk.
- [ ] **Interest-Rate Swap Curve & IRS Pricer `SWPM`** [med / medium] _missing_ - Bootstraps a SOFR/swap curve from FRED rates, prices a vanilla fixed-for-floating swap (par rate, PV, DV01), and charts swap spreads versus the treasury curve already in fixed-income.
- [ ] **Swaption Volatility Cube `VCUB`** [med / medium] _missing_ - Presents a normal (bp) swaption implied-vol matrix across option expiry x underlying tenor with an ATM vol surface, anchored to the live MOVE index and treasury-vol regime, using an honest deterministic sample where no free quote exists.
- [ ] **Variance & Volatility Swap Pricer** [HIGH / medium] _missing_ - Computes the fair variance/vol-swap strike via log-contract replication over the listed option strip, compares implied vs trailing realized variance, and reports vega/variance notional PnL, reusing the existing options chain and vol surface.
- [ ] **CDS-Bond Basis & Credit Relative Value** [med / medium] _missing_ - Compares an issuer's CDS spread to its cash-bond Z-spread to surface negative/positive basis trades, and plots a rich/cheap scatter of spread per turn of leverage and rating-adjusted spread across the issuer universe.
- [ ] **CLO & Structured-Credit Monitor** [med / low] _missing_ - Shows a CLO tranche stack (AAA down to equity) with tranche spreads, subordination/OC cushion, WARF and WAS, plus a sample ABS/CMBS spread grid, built from honest deterministic sample anchored to HY spread regime.
- [ ] **Exotic Options Pricer (Monte Carlo) `OVML`** [med / medium] _missing_ - Prices barrier, digital, Asian and lookback options plus simple structured-note payoffs via Monte Carlo under GBM, with greeks, using free option-implied vol and risk-free rates from FRED.
- [ ] **Dispersion & Implied-Correlation Monitor** [med / medium] _missing_ - Derives implied correlation by comparing index variance to the variance-weighted basket of constituent single-name vols, signals dispersion-trade rich/cheap, and shows index-tranche base-correlation skew as a sample overlay.
- [ ] **CDS Curve Carry & Roll-Down Analytics** [med / low] _partial_ - Extends the shipped issuer CDS curves with carry, roll-down (slide) PnL, forward spreads and breakeven along the 1/3/5/7/10y term structure to rank curve trades.

### Economics & Central Banks (14)

- [ ] **Central-bank balance sheet & net liquidity monitor `FARBAST`** [HIGH / low] _partial_ - Dedicated dashboard tracking Fed total assets (WALCL), Treasury General Account, and reverse-repo (RRP) to compute the closely-watched 'net liquidity' (WALCL - TGA - RRP), QT runoff pace, and reserve balances over time; currently WALCL exists only as a raw catalog series with no liquidity calc.
- [ ] **Global central-bank policy-rate tracker `CBQ`** [HIGH / medium] _missing_ - Grid of policy rates for Fed, ECB, BOE, BOJ, SNB, BOC, RBA, PBOC with last move, days since change, real policy rate (rate minus core inflation), and next meeting date, pulled from FRED/BIS international rate series with deterministic sample fallback.
- [ ] **Economic forecasts & consensus (ECFC) `ECFC`** [HIGH / medium] _missing_ - Consensus forecast table for GDP, CPI, unemployment and Fed funds by calendar/quarter with high-low ranges and revision arrows, sourced from the Philadelphia Fed Survey of Professional Forecasters series on FRED plus honest sample consensus.
- [ ] **Country / global macro scorecard (ECST) `ECST`** [HIGH / medium] _missing_ - Cross-country heatmap grid (G20/OECD) of GDP growth, CPI, unemployment, policy rate, PMI and current-account balance, color-coded vs history, built from FRED international and OECD CLI series with sample fallback for missing countries.
- [ ] **Fiscal & public-debt monitor `DEBT`** [HIGH / medium] _missing_ - Federal deficit/surplus, debt-to-GDP, net interest expense as share of revenue and GDP, and monthly Treasury receipts/outlays trend from FRED (GFDEBTN, FYFSD, FYOINT) and the Treasury Fiscal Data API, with a debt-ceiling/issuance read.
- [ ] **Trade & balance-of-payments dashboard `ETOT`** [med / medium] _partial_ - Dedicated trade panel: goods/services trade balance trend, exports vs imports momentum, current account as % of GDP, and terms-of-trade, computed from the existing FRED trade series (BOPGSTB, EXPGS, IMPGS) rather than raw single-series tiles.
- [ ] **PMI / business-survey diffusion aggregator** [HIGH / medium] _missing_ - Aggregates ISM manufacturing & services and the regional Fed surveys (Empire, Philly, Dallas, KC, Richmond) plus S&P Global PMI into a diffusion heatmap with the 50 expansion/contraction threshold and a composite forward-activity read from FRED survey series.
- [ ] **Taylor Rule / monetary policy-rule estimator `TAYL`** [HIGH / low] _missing_ - Computes Taylor, balanced-approach and inertial policy-rule implied fed funds from the inflation gap and unemployment/output gap, overlays the actual rate, and labels stance as restrictive/accommodative; fully derivable from FRED (PCEPILFE, UNRATE, NROU).
- [ ] **Financial Conditions Index monitor `BFCIUS`** [HIGH / medium] _missing_ - Composite financial-conditions tracker combining Chicago Fed NFCI/ANFCI and St. Louis Fed STLFSI with a homemade index of credit spreads, equity vol, USD and real rates to flag tight vs loose regimes, all from FRED.
- [ ] **Labor-market deep-dive (JOLTS / Beveridge / wage tracker)** [HIGH / medium] _partial_ - JOLTS openings/quits/hires and quits rate, a Beveridge curve (vacancy rate vs unemployment scatter), the Atlanta Fed wage-growth tracker and NFP sector diffusion, upgrading employment from raw catalog series to a dedicated labor panel.
- [ ] **Demographics & labor-force structure dashboard** [med / medium] _missing_ - Population growth, age cohorts and old-age dependency ratio, prime-age employment-to-population, labor-force participation by age and net immigration, from FRED demographic series plus the Census API with sample fallback.
- [ ] **Money supply & bank-credit monitor** [med / low] _missing_ - M2 growth and velocity, commercial-bank credit and loan growth from the H.8 release, deposit trends and SLOOS lending-standards tightening, presented as a credit-creation/liquidity panel from FRED (M2SL, TOTBKCR, DRTSCILM).
- [ ] **FOMC Summary of Economic Projections (dot plot) `FOMC`** [HIGH / medium] _missing_ - Renders the FOMC dot plot and SEP central-tendency projections for the fed funds rate, GDP, unemployment and PCE across the forecast horizon, distinct from the shipped FedWatch rate-path; built from sample/derivable SEP data since the dots are not a live feed.
- [ ] **Real-time inflation nowcast (Cleveland Fed)** [med / low] _partial_ - Current-month and next-month CPI/PCE nowcast from the Cleveland Fed inflation nowcasting model (scraped/public) blended with breakeven-implied paths, extending the shipped inflation dashboard with a forward print estimate ahead of the BLS release.

### News, Research & Sentiment (12)

- [ ] **NLP news sentiment scoring (per-ticker) `NSTM`** [HIGH / low] _partial_ - Score every yfinance headline+summary with a financial sentiment lexicon (Loughran-McDonald + VADER) to produce a per-ticker bullish/bearish score, rolling sentiment trend, and most-positive/negative articles; we currently only echo Unusual Whales' sentiment tag and compute nothing ourselves.
- [ ] **Market-wide news sentiment index (Fear/Greed gauge) `NSTM`** [med / low] _missing_ - Aggregate per-headline sentiment across the watchlist/index universe into a single -100..+100 market mood gauge with a historical time series and breadth (share of tickers net-positive), derived from the same lexicon scoring over the cached news corpus.
- [ ] **News heat / abnormal news-volume detection `NH`** [HIGH / low] _missing_ - Track rolling article counts per ticker and flag z-score spikes ('news heat') so an unusual burst of coverage surfaces before the price moves; pure count statistics over the existing news feed, no paid feed needed.
- [ ] **Social/retail sentiment (StockTwits + Reddit WSB)** [HIGH / medium] _missing_ - Pull StockTwits public message stream and Reddit r/wallstreetbets/r/stocks mention counts to compute mention velocity and bull/bear ratio per ticker, with an honest deterministic sample fallback when the public endpoints are rate-limited.
- [ ] **Analyst rating-change / upgrade-downgrade feed `RATD`** [med / low] _missing_ - A timeline of broker rating actions (upgrades, downgrades, initiations, price-target changes) from yfinance get_upgrades_downgrades, distinct from our shipped estimates panel, with net-rating-change momentum per ticker.
- [ ] **Earnings-call / 8-K press-release tone & summary (EVTS) `EVTS`** [HIGH / medium] _missing_ - Fetch the free 8-K Item 2.02 earnings-release exhibits from EDGAR and run Claude to produce a call/release summary, management-tone score, and extracted guidance changes; honest sample transcript fallback for tickers without an exhibit.
- [ ] **Filing diff & redline (10-K/10-Q year-over-year) `DOC`** [HIGH / high] _missing_ - Pull two consecutive 10-K/10-Q full texts from EDGAR, section-align (Risk Factors, MD&A), and render an added/removed redline so material language changes (new risks, dropped disclosures) are visible at a glance.
- [ ] **Regulatory & litigation tracker `LITI`** [med / medium] _missing_ - Aggregate SEC litigation-release and administrative-proceeding RSS plus EDGAR 8-K Item 8.01/3.01 and CourtListener (all free) into a per-company regulatory/legal event feed with severity tagging.
- [ ] **Theme / trend detection from news corpus `NI`** [med / medium] _missing_ - Run TF-IDF rising-term and n-gram frequency analysis over the rolling news corpus to surface emerging themes (e.g. 'AI capex', 'GLP-1') and the tickers most associated with each, optionally clustered by Claude.
- [ ] **News event-study / price-reaction analysis `CN`** [med / medium] _missing_ - Join news timestamps to OHLCV to compute abnormal/cumulative returns in a window around each headline, ranking which news categories actually move a given stock and the average drift after positive vs negative coverage.
- [ ] **EDGAR full-text filing search** [med / low] _missing_ - Wrap the free EDGAR full-text search API (efts.sec.gov) so users can search a keyword/phrase ('material weakness', 'going concern', a customer name) across all recent filings and jump to the source document.
- [ ] **Corporate events calendar (investor days, conferences, meetings) `EVTS`** [med / medium] _partial_ - Broaden the shipped earnings calendar into a full corporate-events feed (investor days, shareholder meetings, conference presentations, ex-div) derived from 8-K filings and yfinance calendar, with sample fallback.

### Portfolio & Risk Models (13)

- [ ] **Brinson-Fachler performance attribution `PORT`** [HIGH / medium] _missing_ - Decomposes active return vs a benchmark into allocation, selection, and interaction effects per GICS sector, using portfolio vs benchmark sector weights and sector returns (sector ETF returns from yfinance as benchmark proxy).
- [ ] **Ex-ante tracking error, active risk & active share `PORT`** [HIGH / medium] _missing_ - Predicts forward tracking error from the covariance of active weights (portfolio minus benchmark) and reports active share (0.5*sum|wp-wb|), decomposing active risk into factor vs stock-specific, vs a chosen index ETF.
- [ ] **Multi-factor risk decomposition (Barra-style) with MCTR `PORT`** [HIGH / high] _partial_ - Splits total portfolio variance into systematic factor risk vs idiosyncratic/specific risk and reports marginal & percent contribution to risk (MCTR) per factor and per holding, built from a Fama-French/Carhart-plus-sector factor model regressed on holdings; deepens the existing flat factor-exposure betas.
- [ ] **Marginal & component VaR per holding `PORT`** [HIGH / medium] _partial_ - Attributes total portfolio VaR/CVaR to each position via marginal VaR (d VaR / d weight) and component VaR (summing to total), exposing which names actually drive tail risk rather than just the existing concentration HHI.
- [ ] **Custom scenario / multi-factor shock builder `SCEN`** [HIGH / medium] _partial_ - Lets the user define hypothetical macro shocks (rates +100bp, oil -20%, USD +5%, credit spreads +50bp, equity -10%) and propagates them through per-asset factor sensitivities/betas to a P&L estimate, generalizing the current fixed-scenario stress set into an interactive what-if.
- [ ] **Pre-trade what-if portfolio analytics `PORT`** [HIGH / medium] _missing_ - Simulates a proposed buy/sell/rebalance and shows before/after deltas in volatility, VaR, tracking error, factor exposures, and concentration so the user sees a trade's risk impact prior to execution.
- [ ] **Liquidity risk & days-to-liquidate `LQA`** [med / medium] _missing_ - Estimates liquidation horizon and liquidity-adjusted VaR from each position's value relative to average daily dollar volume (yfinance volume), flagging positions that exceed a participation-rate threshold to unwind.
- [ ] **Hedging & overlay designer `HEDG`** [HIGH / medium] _missing_ - Computes optimal hedge ratios to neutralize portfolio beta/duration/FX with index futures or ETFs (min-variance cross-hedge), and prices a protective-put or zero-cost collar overlay with its cost and residual-risk impact via the existing Black-Scholes engine.
- [ ] **Black-Litterman allocation with investor views `PORT`** [HIGH / high] _missing_ - Blends market-implied equilibrium returns (reverse-optimized from cap weights) with user absolute/relative views and confidences to produce posterior expected returns and constrained optimal weights, a far more stable optimizer than the current raw mean-variance.
- [ ] **Constrained optimizer + Hierarchical Risk Parity & risk budgeting `PORT`** [HIGH / high] _partial_ - Adds real-world constraints (sector caps, position min/max, turnover limit, long-short, transaction costs) plus Lopez de Prado HRP and explicit risk-budget targets, extending the current unconstrained min-var/max-sharpe/risk-parity solver.
- [ ] **Returns-based factor attribution over time `FA`** [HIGH / medium] _partial_ - Turns the existing point-in-time factor betas into a time-series attribution: contribution to realized return from each factor (beta_i * factor_return_i) plus selection/specific residual, with rolling exposure and rolling alpha charts.
- [ ] **Benchmark-relative ratios & up/down capture `PORT`** [med / low] _partial_ - Adds Information Ratio, Treynor, Jensen's alpha, and up-market/down-market capture ratios computed on benchmark-conditioned return buckets, complementing the existing Sharpe/Sortino/Omega suite for a complete risk-adjusted scorecard.
- [ ] **ESG exposure & portfolio carbon footprint (WACI) `ESG`** [med / medium] _missing_ - Aggregates holding-level ESG scores and weighted-average carbon intensity (tCO2e per $M revenue) to a portfolio score with sector/name contributors; uses honest deterministic sample/derivable issuer data where a paid ESG feed is unavailable.

### Charting & Technical (12)

- [ ] **Volume Profile (VPVR / Fixed-Range Volume-at-Price) `GP`** [HIGH / medium] _missing_ - Horizontal histogram of traded volume by price bin over a visible/fixed range, surfacing Point of Control (POC), Value Area High/Low (70%), and high/low-volume nodes; approximated by distributing each bar's volume across its high-low span (free OHLCV).
- [ ] **Market Profile / TPO (Time-Price-Opportunity) `MAP`** [HIGH / high] _missing_ - Letter-based TPO distribution that builds a bell curve of where price spent time per 30-min bracket, deriving the POC, value area, single prints and initial balance; built from yfinance intraday (1m/5m, up to ~60 days) with honest sample fallback.
- [ ] **Point & Figure charting `GPO`** [med / medium] _missing_ - Price-only X/O column chart filtered by box size and reversal amount that removes time/noise and auto-derives horizontal/vertical price objectives and 45-degree trendlines; computed deterministically from daily OHLC.
- [ ] **Auto chart-pattern recognition** [HIGH / high] _missing_ - Detects named geometric formations (head-and-shoulders, double top/bottom, ascending/descending/symmetrical triangles, wedges, flags, cup-and-handle) from swing-pivot geometry and reports neckline/measured-move targets; deterministic on OHLCV.
- [ ] **Candlestick pattern recognition `CNDL`** [med / low] _missing_ - Flags single/multi-bar candle formations (doji, hammer, shooting star, bullish/bearish engulfing, harami, morning/evening star, marubozu) with context filters for trend and confirmation; pure body/wick geometry on OHLC.
- [ ] **Auto-trendline detection** [med / medium] _missing_ - Programmatically fits and ranks sloped support/resistance trendlines and channels by connecting confirmed swing pivots (touch count, recency, break status) instead of requiring manual drawing; complements existing horizontal support_resistance.
- [ ] **Ratio & spread / intermarket overlay charting `GIP`** [HIGH / medium] _missing_ - Charts A/B ratio, A-B spread, or normalized %-rebased multi-security overlays with technicals (MA/RSI/z-score) computed on the synthetic series for intermarket and relative-strength analysis; built from aligned yfinance closes.
- [ ] **Custom study / formula builder `CIXB`** [HIGH / high] _missing_ - A formula language letting users compose synthetic series and custom indicators from price/volume/other tickers (e.g. close(SPY)/close(TLT)*100, ema(rsi(AAPL),5)) evaluated server-side and rendered as a study; mirrors Bloomberg's custom index/study editor.
- [ ] **Gann fans, angles & squares** [med / medium] _missing_ - Gann geometry drawing study (1x1/2x1/1x2 angle fans, Gann box/square-of-nine grid) anchored to a pivot to project time-price support/resistance; pure coordinate geometry layered onto the existing drawings engine.
- [ ] **Renko & Kagi charts** [med / low] _missing_ - Brick/line chart types that plot fixed-magnitude price moves (ATR or fixed box) while ignoring time, isolating trend and filtering chop; derived deterministically from the OHLCV series alongside existing Heikin-Ashi.
- [ ] **Elliott Wave auto-labeling** [med / high] _missing_ - Heuristic impulse/corrective (1-2-3-4-5 / A-B-C) wave count over swing pivots with Fibonacci-ratio validation between legs, presented as a labeled, explicitly-probabilistic interpretation rather than certainty.
- [ ] **Event-anchored VWAP suite `VWAP`** [med / low] _partial_ - Extends the shipped rolling anchored_vwap with VWAP anchored to meaningful events (earnings dates, 52-week high/low, year/quarter start, gap day) plus standard-deviation VWAP bands for mean-reversion zones.

### Flows, Positioning & Alt-Data (12)

- [ ] **ETF Net Flow Dashboard (creations/redemptions) `ETF FLOW`** [HIGH / medium] _partial_ - Estimates daily/weekly net dollar flow per ETF as delta-shares-outstanding times NAV (vs the existing etf_tracking which only shows AUM/perf/holdings), ranked by sector and asset class to show where money is actually rotating.
- [ ] **Asset-Class Fund Flow Monitor (equity/bond/MMF)** [HIGH / medium] _missing_ - Weekly estimated long-term mutual-fund and ETF flows by asset class (domestic equity, international, taxable/muni bond, money-market) sourced from ICI free weekly estimates with FRED money-fund assets, charted as risk-on/risk-off net flow waves.
- [ ] **Dark-Pool & Off-Exchange Short Volume** [HIGH / medium] _missing_ - Daily off-exchange short-sale volume ratio and ATS/dark-pool participation per symbol and aggregate, computed from FINRA's free daily short-volume files and weekly OTC/ATS transparency data to flag hidden accumulation/distribution.
- [ ] **Unusual Options Activity Scanner `OMON`** [HIGH / medium] _partial_ - Structured scanner over the live yfinance option chain flagging volume-to-open-interest spikes, large premium prints, and call/put premium skew per strike (distinct from the UW news feed we surface), ranking the day's most unusual contracts.
- [ ] **CFTC TFF / Disaggregated Positioning Breakdown `COT`** [med / medium] _partial_ - Deeper COT layer splitting the noncommercial bucket into asset-managers, leveraged funds, dealer/intermediary and other-reportables (Traders in Financial Futures / Disaggregated reports) so you see hedge-fund vs real-money positioning, not just the legacy commercial/noncommercial cut we ship.
- [ ] **13F Change Tracking & Hedge-Fund Clustering `HDS`** [HIGH / medium] _partial_ - Quarter-over-quarter delta engine on EDGAR 13F filings (new buys, sold-out, add/trim percentages) plus a consensus/crowding view clustering which managers concentrate in the same names, extending the static 13F holdings panel.
- [ ] **Superinvestor / Smart-Money Clone Tracker** [HIGH / medium] _missing_ - Tracks a curated set of famous managers (Berkshire, Pershing, Scion, etc.) by CIK from their 13F filings, showing top positions, latest-quarter moves, and a cloneable model portfolio with weights derived from reported market values.
- [ ] **Retail vs Institutional Participation Proxy** [med / medium] _missing_ - Per-symbol and market-wide proxy splitting retail vs institutional flow using small/odd-lot trade ratios, off-exchange retail-internalizer volume share, and FINRA short-volume composition, with an honest derived/sample fallback.
- [ ] **Securities Lending / Borrow & Utilization** [med / medium] _partial_ - Dedicated borrow-side panel showing estimated borrow fee, utilization %, and availability over time per symbol, deepening the single estimated-borrow-fee field already inside the squeeze module with a time series and cross-name borrow heatmap.
- [ ] **Alt-Data Proxy Dashboard (satellite/card/web-traffic) `ALTD`** [HIGH / high] _missing_ - Alternative-data proxies for revenue/demand momentum per ticker using free derivable signals (Google Trends search interest, job-posting counts, app-ranking-style proxies) blended into a composite alt-data score, with clearly tagged deterministic sample where a feed is unavailable.
- [ ] **Insider Cluster-Buy Signal `INSI`** [med / low] _partial_ - Form 4 cluster detector flagging names where multiple insiders (or C-suite + directors) buy within a short window, scoring conviction by aggregate dollar value and buyer count, extending the existing single-transaction insider feed.
- [ ] **Cross-Sectional Squeeze Leaderboard** [med / low] _partial_ - Market-wide ranking that runs the existing per-symbol squeeze score across a universe and sorts by composite squeeze pressure (short %, days-to-cover, borrow, momentum), turning the single-name squeeze read into a daily most-squeezable leaderboard.
