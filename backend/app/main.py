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
from .data import macro_data
from .regime import regime_model

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

app = FastAPI(
    title="Automated-Investing Terminal",
    description="Personal Bloomberg + AI macro intelligence layer.",
    version="0.1.0",
)

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
    """Return all 5 v1 macro series."""
    data = macro_data.fetch_all(days=days)
    return {
        "days": days,
        "meta": macro_data.SERIES_META,
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
    try:
        vix, y2, y10 = _regime_inputs(days=30)
    except Exception as e:
        raise HTTPException(503, f"Failed to fetch regime inputs: {e}") from e
    state = regime_model.detect_current(vix, y2, y10)
    return state.to_dict()


@app.get("/api/regime/history")
def get_regime_history(days: int = 365) -> dict:
    try:
        vix, y2, y10 = _regime_inputs(days=days)
    except Exception as e:
        raise HTTPException(503, f"Failed to fetch regime inputs: {e}") from e
    history = regime_model.regime_history(vix, y2, y10)
    transitions = regime_model.find_transitions(history, limit=5)
    return {
        "days": days,
        "history": history,
        "recent_transitions": transitions,
    }


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
