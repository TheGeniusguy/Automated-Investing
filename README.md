# Automated-Investing

Personal market intelligence terminal with an AI reasoning layer.

A Bloomberg-style multi-panel terminal (React + TypeScript + Tailwind +
TradingView Lightweight Charts) wired to a FastAPI backend that pulls macro
data from FRED and yfinance, classifies the current macro regime, and streams
a Claude-authored cross-stream briefing as Server-Sent Events.

See `~/.gstack/projects/TheGeniusguy-Automated-Investing/Work-main-design-*.md`
for the full design doc (problem, premises, architecture).

## Quick start

```bash
# 1. Drop API keys into .env
cp .env.example .env
# Edit .env — add FRED_API_KEY (free, https://fredaccount.stlouisfed.org/apikeys)
# and ANTHROPIC_API_KEY (https://console.anthropic.com/).

# 2. Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload

# 3. Frontend (separate terminal)
cd frontend
bun install
bun dev   # → http://localhost:5173
```

The frontend proxies `/api/*` to the backend at `127.0.0.1:8000`.

Without keys the terminal still runs — VIX and DXY come through yfinance,
the regime panel shows a "configure key" state, the Claude pane shows a
graceful message. Drop the keys in, restart the backend, and the missing
panels fill in.

## What's built (v1)

Panel 1 — **Macro Regime Tracker**:
- 5 macro charts: 2Y / 10Y Treasury, HY OAS spread, VIX, DXY
- Rule-based regime classifier (`risk_on` / `risk_off` / `transition`)
  driven by VIX level + yield curve shape
- Regime Diagnosis card with live inputs
- Claude Briefing pane that streams a 3-paragraph cross-stream analysis
  over SSE — reasons across all 5 series simultaneously

Backend endpoints:
- `GET /api/health`
- `GET /api/macro/series?days=90`
- `GET /api/macro/series/{id}?days=90`
- `GET /api/regime/current`
- `GET /api/regime/history?days=365`
- `POST /api/briefing/stream` (SSE)
- `GET /api/briefing/stream` (SSE, easier for curl)

## What's next (per design doc)

- Panel 2: **Regime Journal** — backward-looking pattern archaeology against
  your portfolio positions
- HMM regime model (currently rule-based; HMM upgrade gated on NBER validation)
- Brokerage API integration for live position input
- Additional panels: earnings, sector flows, sentiment

## Repo layout

```
Automated-Investing/
├── README.md
├── .env.example          # FRED_API_KEY, ANTHROPIC_API_KEY, etc.
├── backend/              # FastAPI + macro data + regime + Claude briefing
│   ├── requirements.txt
│   └── app/
│       ├── main.py       # routes
│       ├── config.py     # pydantic-settings, .env loader
│       ├── data/
│       │   ├── cache.py        # sqlite TTL cache with stale-fallback
│       │   └── macro_data.py   # FRED + yfinance fetchers
│       ├── regime/
│       │   └── regime_model.py # rule-based classifier
│       └── briefing/
│           └── claude_briefing.py  # streaming Claude call
└── frontend/             # React + Vite + Tailwind + Lightweight Charts
    └── src/
        ├── App.tsx
        ├── index.css     # Tailwind + terminal theme
        ├── api/
        │   ├── client.ts   # REST + SSE client
        │   └── types.ts
        └── components/
            ├── TerminalShell.tsx
            ├── MacroRegimeTracker.tsx
            ├── MacroChart.tsx
            ├── RegimeBadge.tsx
            └── BriefingPane.tsx
```
