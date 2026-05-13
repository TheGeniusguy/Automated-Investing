"""Cross-stream Claude briefing — the intelligence layer.

Assembles the full macro context (regime state + 5 series + optional positions)
into a single Claude prompt and streams the response back to the caller.

This is the differentiator. Bloomberg shows you the data; Claude reasons across
all of it simultaneously.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from ..config import settings
from ..data.macro_data import SERIES_META, SeriesPoint

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a sharp, plain-spoken macro market analyst writing for an "
    "experienced retail investor. Reason across all the data streams in the "
    "user message simultaneously — yields, spreads, vol, dollar, and the "
    "computed regime — and surface connections that a single-chart view would "
    "miss. Be specific. Cite actual numbers. No filler, no hedging, no "
    "'consult a professional' boilerplate. Three short paragraphs:\n"
    "\n"
    "1. **What regime we're in and why.** Name the regime. Cite the specific "
    "numbers (VIX level, curve spread, HY spread) that drive that read.\n"
    "\n"
    "2. **What history says about this regime.** Which sectors have "
    "historically led / lagged when these conditions hold. Be concrete about "
    "the historical episodes you're pattern-matching to.\n"
    "\n"
    "3. **Early warning signals for the next transition.** Which of the macro "
    "series would be the first to move if this regime is about to end, and "
    "what level would tip you off."
)


def _trim_series(points: list[SeriesPoint], keep: int = 30) -> list[SeriesPoint]:
    """Keep the most recent N points to keep the prompt compact."""
    return points[-keep:] if len(points) > keep else points


def assemble_context(
    regime_state: dict,
    macro_data: dict[str, list[SeriesPoint]],
    positions: list[dict] | None = None,
) -> dict:
    """Build the structured user payload the prompt template references."""
    return {
        "regime_state": regime_state,
        "macro_data": {
            series_id: {
                "label": SERIES_META.get(series_id, {}).get("label", series_id),
                "unit": SERIES_META.get(series_id, {}).get("unit", ""),
                "recent": _trim_series(points),
            }
            for series_id, points in macro_data.items()
        },
        "positions": positions or [],
    }


def _format_user_message(context: dict) -> str:
    """JSON payload + a short instruction. Claude reasons better when it sees
    the data structure clearly rather than buried in prose.
    """
    return (
        "Here is the full macro context. Reason across all of it.\n\n"
        "```json\n"
        + json.dumps(context, indent=2, default=str)
        + "\n```\n\n"
        "Write the three-paragraph briefing per the system instructions."
    )


async def stream_briefing(context: dict) -> AsyncIterator[str]:
    """Stream Claude's briefing token-by-token. Yields plain text chunks.

    Falls back to a single error message yield if the API key is missing
    or the call fails — the SSE layer formats those for the frontend.
    """
    if not settings.has_anthropic:
        yield (
            "[briefing unavailable — ANTHROPIC_API_KEY not configured. "
            "Set it in .env to enable the intelligence layer.]"
        )
        return

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        yield "[briefing unavailable — anthropic SDK not installed]"
        return

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    user_message = _format_user_message(context)

    try:
        async with client.messages.stream(
            model=settings.claude_model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        ) as stream:
            async for text in stream.text_stream:
                yield text
    except Exception as e:
        log.exception("Claude streaming failed")
        yield f"\n\n[briefing interrupted: {type(e).__name__}]"
