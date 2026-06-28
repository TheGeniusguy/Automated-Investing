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

- [ ] **1. Relative Valuation Comps Grid (RV) `RV`** [HIGH / medium effort] - Ticker-centric peer table auto-selecting a comp set, lining up P/E, fwd P/E, EV/EBITDA, EV/Sales, P/B, FCF yield, margins and growth vs peer-median with premium/discount columns, computed from yfinance .info multiples.
      _Why this rank:_ The single most iconic Bloomberg screen; instantly recognizable, demos in seconds, fully buildable from free multiples.
- [ ] **2. Global Central-Bank Policy-Rate Monitor (merged WIRP/CBQ) `WIRP`** [HIGH / medium effort] - Board of every major policy rate (Fed/ECB/BoE/BoJ/SNB/BoC/RBA/PBOC plus EM: Banxico/BCB/RBI) with current level, last move, days since change, real (inflation-adjusted) rate, next-meeting date and market-implied bias; from FRED/BIS series with sample fallback. Merges the duplicate FX-EM and Economics requests.
      _Why this rank:_ Visually striking world board, one of the most-shared macro views; merges two domain requests into one high-WOW panel.
- [ ] **3. Treasury Auction Calendar & Results** [HIGH / low effort] - Upcoming and historical bill/note/bond/TIPS/FRN auctions with bid-to-cover, high yield, tail vs WI, and indirect/direct/dealer allotment, pulled live from the free TreasuryDirect Auctions API.
      _Why this rank:_ Live free API, low effort, and 'real auction data updating' is a credibility-establishing WOW for a terminal.
- [ ] **4. Central-Bank Balance Sheet & Net-Liquidity Monitor `FARBAST`** [HIGH / low effort] - Fed total assets (WALCL) minus TGA minus RRP = the closely-watched 'net liquidity', plus QT runoff pace and reserve balances over time; today WALCL is only a raw catalog series with no liquidity calc.
      _Why this rank:_ Famous macro chart traders obsess over; trivial FRED arithmetic on series we already have, big perceived sophistication.
- [ ] **5. Per-Ticker NLP News Sentiment Scoring `NSTM`** [HIGH / low effort] - Score every yfinance headline+summary with a financial lexicon (Loughran-McDonald + VADER) for a per-ticker bull/bear score, rolling sentiment trend, and most-positive/negative articles; today we only echo a third-party tag and compute nothing.
      _Why this rank:_ Turns an existing news feed into proprietary analytics at low cost; sentiment color-coding reads as advanced AI.

### Wave I (ranks 6-10)

- [ ] **6. Earnings-Quality Scorecard (F/Z/M-Score)** [HIGH / medium effort] - Piotroski F-Score, Altman Z-Score, Beneish M-Score, and an accruals ratio from EDGAR financials to flag accounting red flags, distress, and earnings-manipulation likelihood per ticker.
      _Why this rank:_ Distinctive forensic-accounting differentiator; a single 'red flag' verdict screen is highly demo-able.
- [ ] **7. Market-Wide Fear/Greed Sentiment Index `NSTM`** [med / low effort] - Aggregate per-headline sentiment across the watchlist/index universe into a single -100..+100 market-mood gauge with history and breadth (% of tickers net-positive), reusing the lexicon scoring from the per-ticker engine.
      _Why this rank:_ Extremely shareable, marketing-friendly gauge; near-free once the per-ticker sentiment engine (rank 5) exists.
- [ ] **8. Crack Spreads & Refining Margins (3-2-1) `CRK`** [HIGH / low effort] - 3-2-1 / 5-3-2 crack spread and gasoline/distillate refining margins computed live from CL/RB/HO front-month futures (2*RB + 1*HO - 3*CL per bbl) with historical band and seasonality context.
      _Why this rank:_ Pure arithmetic on futures we already pull; a recognizable energy-desk staple with high signal.
- [ ] **9. Inter-Commodity Spreads & Ratios** [HIGH / low effort] - Gold/silver, gold/oil, WTI-Brent, gas/oil BTU ratio and soybean board crush, each derived arithmetically from yfinance front-month futures with percentile/z-score history.
      _Why this rank:_ Several classic desk spreads from data on hand; cheap breadth across the commodity complex.
- [ ] **10. Taylor Rule / Policy-Rule Estimator `TAYL`** [HIGH / low effort] - Taylor, balanced-approach and inertial rule-implied fed funds from the inflation gap and unemployment/output gap, overlaid on the actual rate with restrictive/accommodative labeling; fully from FRED (PCEPILFE, UNRATE, NROU).
      _Why this rank:_ Low-effort, high-IQ macro screen that visibly 'judges' the Fed; great talking-point in demos.

### Further backlog (ranks 11-40)

- [ ] **11. Corporate OAS Term-Structure by Rating `SPRD`** [HIGH / low effort] - Option-adjusted spread surface across AAA-CCC and IG-vs-HY with historical percentile/z-score and spread-per-turn-of-duration, from ICE BofA OAS series on FRED (BAMLC0A*, BAMLH0A*).
      _Why this rank:_ Core credit-RV view, free FRED data, low lift; deepens the existing credit/CDS curves meaningfully.
- [ ] **12. Breakeven Inflation & TIPS Real-Yield Curve `BEI`** [HIGH / low effort] - Full term structure of breakevens (5Y/10Y/30Y, 5y5y fwd) and TIPS real yields (DFII5/10/30, T5YIE/T10YIE/T5YIFR from FRED) with real-vs-nominal curve and carry decomposition, deeper than the headline inflation dashboard.
      _Why this rank:_ High-value rates screen, all free FRED series, minimal build on top of existing inflation work.
- [ ] **13. REER & PPP Fair-Value Monitor `REER`** [HIGH / low effort] - Trade-weighted REER per currency from FRED BIS series with z-score vs its 10y mean plus a PPP fair-value band, flagging rich/cheap currencies in real terms.
      _Why this rank:_ Low effort, distinct from spot FX already shipped; 'which currency is cheap' is an instant hook.
- [ ] **14. Single-Name CDS Pricer (CDSW) `CDSW`** [HIGH / low effort] - Marks a CDS to market: par-spread to/from upfront points off the existing credit-triangle survival curve, with CS01/DV01, accrued and PnL for a chosen notional and coupon (100/500).
      _Why this rank:_ Reuses the shipped survival curve; a working pricer signals derivatives credibility at low cost.
- [ ] **15. News-Heat / Abnormal News-Volume Detector `NH`** [HIGH / low effort] - Rolling article counts per ticker with z-score spike flags so an unusual coverage burst surfaces before the price moves; pure count statistics over the existing news feed.
      _Why this rank:_ Cheap statistic over data we already cache; a leading 'something is happening' alert reads as predictive.
- [ ] **16. Superinvestor / Smart-Money Clone Tracker** [HIGH / medium effort] - Tracks famous managers (Berkshire, Pershing, Scion, etc.) by CIK from 13F filings, showing top positions, latest-quarter moves and a cloneable model portfolio weighted by reported market values.
      _Why this rank:_ Huge marketing pull ('clone Buffett'); free EDGAR data, instantly viral demo content.
- [ ] **17. Volume Profile (VPVR / Volume-at-Price) `GP`** [HIGH / medium effort] - Horizontal volume-by-price histogram over a visible/fixed range surfacing Point of Control and Value Area High/Low (70%) and HVN/LVN, approximated by distributing each bar's volume across its high-low span from free OHLCV.
      _Why this rank:_ Visually striking pro-charting feature retail tools charge for; strong screenshot WOW from free data.
- [ ] **18. Social / Retail Sentiment (WSB + StockTwits)** [HIGH / medium effort] - StockTwits public stream and Reddit r/wallstreetbets/r/stocks mention counts for mention-velocity and bull/bear ratio per ticker, with deterministic sample fallback when endpoints rate-limit.
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
