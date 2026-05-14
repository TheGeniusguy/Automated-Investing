"""Ask the Terminal — conversational surface over every other panel.

Builds a structured terminal context (regime, correlations, VIX term,
upcoming earnings, recent filings, top news) and joins it to the user's
prior chat history. The full context is re-assembled on every user turn so
freshness stays high; conversation history is the user's responsibility.

The frontend keeps the conversation in component state and sends it as
[{role: "user"|"assistant", content}] each turn — Claude maintains coherence
across the whole transcript.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import AsyncIterator

from pydantic import BaseModel

from ..config import settings
from ..correlations import correlation_model
from ..data import earnings as earnings_mod
from ..data import macro_data
from ..data import news as news_mod
from ..data import options as options_mod
from ..data import sec_edgar
from ..data import watchlist
from ..regime import regime_model

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are the conversational surface of a personal Bloomberg-style "
    "market intelligence terminal. The user can ask you anything about "
    "markets, their portfolio, or what's happening today. You have access "
    "to a structured snapshot of the terminal's live state — regime, "
    "correlations, VIX, earnings, filings, news — provided in the FIRST "
    "user message of every turn. Reason across all of it; cite specific "
    "numbers. Speak like a sharp colleague: direct, plain, concrete. "
    "If asked something you can't answer from the snapshot, say so. "
    "Don't hedge; don't recite generic financial advice; don't add "
    "compliance boilerplate."
)


class ChatMessage(BaseModel):
    role: str       # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


def assemble_terminal_snapshot() -> dict:
    """A tight context payload — keep it under ~3k tokens so the chat budget
    is mostly for reasoning."""
    vix = macro_data.fetch_series("^VIX", days=30)
    y2  = macro_data.fetch_series("DGS2",  days=30)
    y10 = macro_data.fetch_series("DGS10", days=30)
    regime = regime_model.detect_current(vix, y2, y10).to_dict()

    try:
        corr = correlation_model.compute_correlations(recent_days=30, baseline_days=365)
        breakdowns = corr.get("breakdowns", [])[:10]
    except Exception:
        breakdowns = []

    try:
        vix_term = options_mod.vix_term_structure()
    except Exception:
        vix_term = None

    try:
        e_overview = earnings_mod.fetch_overview(watchlist.DEFAULT_EQUITIES_WATCHLIST)
        upcoming = []
        for r in e_overview.get("results", [])[:8]:
            d = r.get("next_earnings")
            if d:
                upcoming.append({
                    "symbol": r["symbol"], "date": d,
                    "eps_estimate": r.get("eps_estimate"),
                    "beat_rate": r["stats"].get("beat_rate"),
                    "avg_reaction": r["stats"].get("avg_reaction_1d"),
                })
    except Exception:
        upcoming = []

    try:
        filings = sec_edgar.fetch_filings_batch(
            watchlist.DEFAULT_EQUITIES_WATCHLIST, days=5, forms=["8-K"],
            limit_per_ticker=5, overall_limit=20,
        )
        recent_filings = [
            {"ticker": f["ticker"], "date": f["filing_date"], "items": f["items"]}
            for f in filings.get("filings", [])[:15]
        ]
    except Exception:
        recent_filings = []

    try:
        news_feed = news_mod.fetch_news_feed(
            watchlist.DEFAULT_EQUITIES_WATCHLIST[:8], per_ticker=2, overall=8,
        )
        top_news = [
            {"title": n["title"], "publisher": n["publisher"],
             "tickers": n["tickers"], "published": n["published"]}
            for n in news_feed.get("items", [])[:8]
        ]
    except Exception:
        top_news = []

    return {
        "as_of":          datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "regime":         regime,
        "vix_term":       vix_term,
        "breakdowns":     breakdowns,
        "upcoming_earnings": upcoming,
        "recent_8k":      recent_filings,
        "top_news":       top_news,
    }


def _format_snapshot_message(snapshot: dict) -> str:
    return (
        "Live terminal snapshot (machine-readable). Use it to answer the user's "
        "next question.\n\n```json\n"
        + json.dumps(snapshot, indent=2, default=str)
        + "\n```"
    )


async def stream_chat(messages: list[ChatMessage]) -> AsyncIterator[tuple[str, str]]:
    """Stream Claude's reply to the latest user turn.

    Always re-injects the terminal snapshot as the first user message
    of each request so freshness is per-turn.
    """
    snapshot = assemble_terminal_snapshot()
    yield ("snapshot", json.dumps({"as_of": snapshot["as_of"]}))

    if not settings.has_anthropic:
        yield ("token", json.dumps({"text":
            "[Chat unavailable — ANTHROPIC_API_KEY not configured. "
            "Set it in .env and restart the backend.]"}))
        yield ("done", "{}")
        return

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        yield ("token", json.dumps({"text": "[anthropic SDK not installed]"}))
        yield ("done", "{}")
        return

    # Prepend the snapshot as a "user" turn so Claude sees it before answering.
    history: list[dict] = [
        {"role": "user",      "content": _format_snapshot_message(snapshot)},
        {"role": "assistant", "content": "Got it — snapshot loaded. What would you like to know?"},
    ]
    for m in messages:
        if m.role not in ("user", "assistant"):
            continue
        history.append({"role": m.role, "content": m.content})

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    try:
        async with client.messages.stream(
            model=settings.claude_model,
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            messages=history,
        ) as stream:
            async for text in stream.text_stream:
                yield ("token", json.dumps({"text": text}))
    except Exception as e:
        log.exception("chat stream failed")
        yield ("token", json.dumps({"text": f"\n\n[stream interrupted: {type(e).__name__}]"}))
    yield ("done", "{}")
