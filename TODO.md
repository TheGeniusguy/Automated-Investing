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

## 1. P0 - Critical hygiene (repo is NOT fresh-clone-safe)

- [ ] **Commit the untracked dependency files.** ~26 backend modules under
      `backend/app/data` + `app/regime` and ~23 frontend components under
      `frontend/src/components` are imported by `main.py` / `TerminalShell.tsx`
      but were never committed. A fresh `git clone` will fail to import the app
      and fail to build the frontend. Stage and commit them (Wave 3-5 sector
      panels, technical analysis, macro dashboards, etc.) in coherent commits.
      This is the highest-priority item: nothing else is truly shippable until
      the working tree and the repo agree.
- [ ] Resolve the one modified-but-uncommitted file
      (`frontend/src/components/SectorDetailPanel.tsx`) - confirm intent, then
      commit.
- [ ] **CI gate**: add a GitHub Actions (or equivalent) workflow that runs
      `pip install -r backend/requirements.txt`, `pytest`, `bun install`, and
      `bun run build` on every push, so the fresh-clone contract stays enforced.

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
