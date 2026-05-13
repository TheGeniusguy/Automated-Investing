# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The canonical design doc lives at
> `~/.gstack/projects/TheGeniusguy-Automated-Investing/Work-main-design-*.md`
> (problem statement, premises, architecture, accepted/deferred scope).
> Read it before making non-trivial design decisions.

## What this is

A personal Bloomberg-style market intelligence terminal with a Claude reasoning
layer. The differentiator is **cross-stream synthesis** — every Claude call sees
the regime state + all macro series + portfolio context in a single prompt and
reasons across them. The terminal UI is the surface; the AI layer is the moat.

Two app surfaces, one repo:

- `backend/` — FastAPI service that pulls macro data, classifies the regime, and
  streams Claude briefings as SSE.
- `frontend/` — React + Vite terminal UI with draggable/resizable panels.

## Commands

### Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload          # http://127.0.0.1:8000
.venv/bin/uvicorn app.main:app --host 0.0.0.0    # network-visible
```

Hit individual endpoints for debugging:

```bash
curl -s 127.0.0.1:8000/api/health
curl -s '127.0.0.1:8000/api/macro/series?days=30'
curl -s '127.0.0.1:8000/api/macro/series/%5EVIX?days=30'   # url-encode ^
curl -s 127.0.0.1:8000/api/regime/current
curl -s 127.0.0.1:8000/api/regime/history?days=3650
curl -s '127.0.0.1:8000/api/journal/spx?days=3650'
curl -s -X POST 127.0.0.1:8000/api/portfolio/stress-test \
  -H 'Content-Type: application/json' \
  -d '{"positions":[{"ticker":"AAPL","weight":0.5},{"ticker":"SPY","weight":0.5}],"days":3650}'
curl -N 127.0.0.1:8000/api/briefing/stream        # SSE — use -N to disable curl buffering
```

There is no formal test suite yet. Smoke-test by importing the app:

```bash
.venv/bin/python -c "from app.main import app; print('OK')"
```

### Frontend

```bash
cd frontend
bun install
bun dev       # → http://localhost:5173 (Vite proxies /api/* to 127.0.0.1:8000)
bun run build # tsc -b && vite build — type-checks too
bun lint
```

### Cache

The backend writes `backend/cache.db` (sqlite). Delete it to force-refresh data:

```bash
rm backend/cache.db backend/cache.db-journal 2>/dev/null
```

This is the right move whenever a fetcher behaviour changes — e.g. after a
`yfinance` upgrade — because empty payloads cached during a failure mode will be
served as "fresh" until their TTL expires.

## Configuration

Copy `.env.example` to `.env` at the repo root. The backend's pydantic-settings
loader reads it from `backend/`'s working directory; running uvicorn from
inside `backend/` is the supported path.

Keys are **optional**:

- `FRED_API_KEY` missing → DGS2 / DGS10 / HY-spread series return `[]` and the
  regime classifier degrades to "transition" (it can't see the curve).
- `ANTHROPIC_API_KEY` missing → briefing endpoint streams a graceful
  "configure key" message instead of failing.

Graceful degradation is a contract, not a quirk. Don't change the data layer
to raise on missing keys; the frontend renders "needs config" states off the
empty payloads.

## Architecture

### Data flow

```
yfinance ──┐                                                            ┌── React panels
FRED ──────┤── macro_data.fetch_series (sqlite cache, stale-fallback) ──┤
           │                                                            │
           ├── regime_model.detect_current / regime_history ────────────┤── RegimeBadge / RegimeJournal
           │                                                            │
           └── stress_test.stress_test (per-position × per-regime) ─────┴── PortfolioStressTest

claude_briefing.assemble_context ── Anthropic SDK streaming ── SSE ──── BriefingPane
```

### Backend layout

`backend/app/`:

- `config.py` — pydantic-settings; the `has_fred` / `has_anthropic` properties
  drive the degraded-state branches throughout the codebase.
- `data/cache.py` — sqlite TTL cache. `get()` honors TTL; `get_stale()` returns
  anything (used as a fallback when an upstream fetch fails).
- `data/macro_data.py` — fetchers for FRED + yfinance.
  `SERIES_META` is the source of truth for which tickers Panel 1 renders.
  `PANEL1_SERIES` excludes SPX so the macro grid stays at 5; `^GSPC` is only
  served via the per-series route and the journal endpoint.
  `fetch_arbitrary_ticker()` lets the stress-test pull any user-supplied
  ticker through the same cache. For windows >2y the yfinance call switches
  to start/end dates because yfinance's `period=` is unreliable past ~5y.
- `regime/regime_model.py` — rule-based classifier. The design doc gates HMM
  on NBER-recession validation; until that passes, this is the only path.
  Three regimes (risk_on / risk_off / transition) keyed off VIX level and
  the 2Y/10Y spread.
- `regime/stress_test.py` — collapses per-day regime history into segments,
  computes compound returns per ticker × per regime, plus weighted aggregate.
- `briefing/claude_briefing.py` — assembles a single structured context dict
  and calls `client.messages.stream`. The prompt structure is documented in
  the design doc; keep it stable so any future evals can compare runs.
- `main.py` — FastAPI routes. `_regime_inputs()` is the gather function used
  by every regime endpoint.

### Frontend layout

`frontend/src/`:

- `api/client.ts` — REST helpers and the `streamBriefing` SSE parser (uses
  `fetch` streaming because EventSource won't carry the POST body for
  positions).
- `api/types.ts` — mirrors backend response shapes. Update both sides
  together; there's no codegen.
- `components/TerminalShell.tsx` — top-level layout. `react-grid-layout` v1.5
  with `draggableHandle=".panel-header"` so only the header drags. Adding a
  panel means adding a `Layout` entry and rendering a `<div key="...">`
  child.
- `components/MacroRegimeTracker.tsx` — Panel 1.
- `components/RegimeJournal.tsx` — Panel 2 (SPX timeline + transitions list +
  stress test).
- `components/RegimeTimelineChart.tsx` — TradingView line chart with a flexbox
  "regime ribbon" beneath it. The ribbon's segment widths are weighted to the
  SPX date span, not the chart's pan/zoom — we rely on `fitContent()` so the
  two stay aligned.

### Styling

Tailwind with a custom `terminal` / `accent` / `regime` palette in
`tailwind.config.js`. Reusable classes live under `@layer components` in
`src/index.css` — `.panel`, `.panel-header`, `.panel-body`, `.pill`. New
panels should compose these so the look stays consistent.

## Things that have bitten us

- **react-grid-layout v2** is an incompatible API rewrite. We're pinned to
  `^1.5.0` plus `react-resizable ^3.0.5` plus `@types/react-grid-layout ^1.3.5`.
  Don't bump to v2 without a rewrite plan.
- **yfinance** silently returns empty DataFrames when Yahoo's response shape
  drifts — older releases (≤0.2.x) currently hit this. We require `>=1.3.0`
  with `curl_cffi`. If yfinance starts returning empty data, upgrade first
  and clear the cache before debugging anything else.
- **Tailwind ordering** — `@import` lines in `index.css` must precede
  `@tailwind` directives or PostCSS errors.
- **Cache poisoning during dev** — an empty `[]` returned during a
  partial-outage gets cached with full TTL. Always delete `cache.db` when
  in doubt.

## Conventions

- The `WIP:` prefix is in use on commits because gstack's continuous-checkpoint
  mode is on. They include a `[gstack-context]` block recording decisions and
  remaining work. `/ship` is the canonical way to land — it squashes these
  into clean conventional commits.
- Don't add features beyond what the design doc lists for v1 unless we're
  expanding the doc first. Panels 3+ (earnings / flows / sentiment) are
  explicitly deferred until the intelligence layer's value is proven.
