"""Per-sector AI briefing — the moat play for the sector layer.

For a given sector, assemble:
  - ETF returns (1d/1w/1m/ytd)
  - Top + bottom contributors (cap-weighted decomposition)
  - Hidden-weakness flag if triggered
  - Concentration (Herfindahl + top-1)
  - Breadth summary (% above 50ma/200ma, % at 52w high/low)
  - Top correlated macro drivers
  - Recent news headlines (5 latest)
  - Current macro regime

...and stream a 3-section Claude briefing scoped to that sector. Persists
to the same `daily_briefings` table used by the global briefing, keyed by
kind='sector:{sector_id}' so each sector gets one cached briefing per day.

Reuses existing modules so caching wins for the second sector loaded in a
session. Falls back gracefully when ANTHROPIC_API_KEY is absent — emits
the context payload + a "configure key" stub so the UI still renders.
"""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import AsyncIterator

from ..config import settings
from ..data import (
    macro_data,
    news as news_mod,
    sector_breadth,
    sector_decomposition,
    sector_detail,
    sector_macro_drivers,
)
from ..db import engine as db_engine
from ..regime import regime_model

log = logging.getLogger(__name__)


SYSTEM_PROMPT = (
    "You are writing a per-sector briefing for an experienced retail investor "
    "who already knows the basics. Reason across all the data streams in the "
    "user message simultaneously — sector returns, constituent contributions, "
    "breadth, concentration, macro drivers, news headlines, and the current "
    "macro regime — and surface the cross-stream story.\n\n"
    "Write three short paragraphs:\n\n"
    "1. **What's driving the sector right now.** Use specific numbers. Name "
    "the constituent(s) doing the work. If hidden_weakness is non-null, that "
    "is the headline — call out the masking names by ticker and explain that "
    "breadth is hiding behind a few mega-caps.\n\n"
    "2. **Where this fits in the macro regime.** Cite the strongest correlated "
    "macro driver and what its current level implies. Is the sector trading "
    "consistent with the regime, or detaching? Be concrete.\n\n"
    "3. **What to watch.** One specific catalyst from the news, earnings, or "
    "macro tape that would shift the read. Not advice — observation.\n\n"
    "No filler. No 'consult a professional.' No 'past performance.' Plain "
    "prose, short sentences, specific tickers and numbers."
)


# ── Context assembly ────────────────────────────────────────────────────────

def _windowed_returns(ret_map: dict, keys: list[str]) -> dict:
    """Compact a returns map down to just the windows we care about."""
    return {k: ret_map.get(k) for k in keys}


def _safe_call(fn, *args, **kwargs):
    """Run a callable, log + return None on exception. Keeps context assembly
    from collapsing if one sub-feature is broken."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        log.warning("Sector briefing sub-fetch %s failed: %s", fn.__name__, exc)
        return None


def assemble_context(sector_id: str) -> dict:
    """Pull every signal-bearing input in parallel and bundle into a flat dict.

    All sub-modules use shared yfinance/FRED caches so a second call for the
    same sector inside the 1h TTL is near-instant.
    """
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")
    sec = sector_detail.SECTORS[sector_id]
    etf = sec["etf"]

    # Spread the slow IO across threads.
    with ThreadPoolExecutor(max_workers=6) as pool:
        f_decomp   = pool.submit(_safe_call, sector_decomposition.sector_decomposition, sector_id)
        f_drivers  = pool.submit(_safe_call, sector_macro_drivers.sector_macro_drivers, sector_id, etf)
        f_breadth  = pool.submit(_safe_call, sector_breadth.sector_breadth, sector_id, list(sec["key_stocks"]))
        f_news     = pool.submit(_safe_call,
                                  lambda: news_mod.fetch_news_feed(list(sec["key_stocks"]), per_ticker=2, overall=10))
        f_macro    = pool.submit(_safe_call, macro_data.fetch_all, 90)
        # ETF returns come for free from sector_detail's overview path.
        f_overview = pool.submit(_safe_call, sector_detail.sector_overview)
        for fut in as_completed([f_decomp, f_drivers, f_breadth, f_news, f_macro, f_overview]):
            pass  # drain

    decomp = f_decomp.result()
    drivers = f_drivers.result()
    breadth = f_breadth.result()
    news_payload = f_news.result()
    all_macro = f_macro.result() or {}
    overview = f_overview.result()

    # Find this sector's overview row for the canonical ETF returns.
    etf_returns_pct: dict = {}
    if overview:
        for s in overview.get("sectors", []):
            if s.get("id") == sector_id:
                ret_map = s.get("returns", {})
                etf_returns_pct = {
                    k: (v.get("abs") if isinstance(v, dict) else v)
                    for k, v in ret_map.items()
                }
                break

    # Compact decomposition: top 3 contributors + top 3 detractors for 1m.
    top_contributors: list[dict] = []
    bottom_contributors: list[dict] = []
    hidden_weakness: dict | None = None
    concentration: dict | None = None
    if decomp:
        concentration = decomp.get("concentration")
        # Use 1m as the headline window for the briefing.
        constituents = decomp.get("constituents", [])
        with_1m = [
            {
                "symbol":           c["symbol"],
                "weight_pct":       c["weight_pct"],
                "return_1m_pct":    c["returns_pct"].get("1m"),
                "contribution_1m_pct": c["contributions_pct"].get("1m"),
            }
            for c in constituents
            if c["contributions_pct"].get("1m") is not None
        ]
        with_1m.sort(key=lambda r: r["contribution_1m_pct"], reverse=True)
        top_contributors = with_1m[:3]
        bottom_contributors = with_1m[-3:][::-1]
        # Hidden weakness on 1m (or 1w if 1m clean).
        hw_map = decomp.get("hidden_weakness", {})
        for w in ("1m", "1w", "ytd"):
            if hw_map.get(w):
                hidden_weakness = {**hw_map[w], "window": w}
                break

    # Top 3 macro drivers by |correlation|.
    top_drivers: list[dict] = []
    if drivers:
        ranked = sorted(
            [d for d in drivers.get("drivers", []) if d.get("correlation") is not None],
            key=lambda d: abs(d["correlation"]),
            reverse=True,
        )[:3]
        top_drivers = [
            {
                "id":          d["id"],
                "label":       d["label"],
                "correlation": d["correlation"],
                "expected":    d.get("direction"),
                "desc":        d.get("desc"),
            }
            for d in ranked
        ]

    # Breadth summary — only the headline stats.
    breadth_summary: dict | None = None
    if breadth and breadth.get("summary"):
        s = breadth["summary"]
        breadth_summary = {
            "above_50ma_pct":            s.get("above_50ma_pct"),
            "above_200ma_pct":           s.get("above_200ma_pct"),
            "at_52w_high_pct":           s.get("at_52w_high_pct"),
            "at_52w_low_pct":            s.get("at_52w_low_pct"),
            "avg_dist_from_52w_high_pct": s.get("avg_dist_from_52w_high_pct"),
            "stock_count":               breadth.get("stock_count"),
        }

    # Recent news — just title + publisher + tickers + date.
    recent_news: list[dict] = []
    if news_payload and news_payload.get("items"):
        for n in news_payload["items"][:5]:
            recent_news.append({
                "title":     n.get("title"),
                "publisher": n.get("publisher"),
                "tickers":   n.get("tickers", []),
                "published": n.get("published"),
            })

    # Current macro regime so the briefing can place the sector in context.
    regime_state: dict = {}
    try:
        vix = all_macro.get("^VIX", [])
        y2  = all_macro.get("DGS2", [])
        y10 = all_macro.get("DGS10", [])
        regime_state = regime_model.detect_current(vix, y2, y10).to_dict()
    except Exception as exc:
        log.warning("Sector briefing regime detect failed: %s", exc)

    return {
        "sector_id":          sector_id,
        "sector_name":        sec["name"],
        "etf":                etf,
        "etf_returns_pct":    _windowed_returns(etf_returns_pct, ["1d", "1w", "1m", "3m", "6m", "1y"]),
        "concentration":      concentration,
        "top_contributors_1m": top_contributors,
        "bottom_contributors_1m": bottom_contributors,
        "hidden_weakness":    hidden_weakness,
        "breadth":            breadth_summary,
        "top_macro_drivers":  top_drivers,
        "recent_news":        recent_news,
        "regime":             regime_state,
        "as_of":              date.today().isoformat(),
    }


def _format_user_message(context: dict) -> str:
    return (
        f"Per-sector briefing context for {context['sector_name']} ({context['etf']}). "
        "Reason across all of it. Specific tickers, specific numbers, "
        "three short paragraphs per the system instructions.\n\n"
        "```json\n"
        + json.dumps(context, indent=2, default=str)
        + "\n```"
    )


# ── Streaming ───────────────────────────────────────────────────────────────

async def stream_sector_briefing(sector_id: str) -> AsyncIterator[tuple[str, str]]:
    """Yields (event_type, json_data) tuples. Matches the daily briefing
    transport so the frontend SSE reader stays uniform.
    """
    try:
        context = assemble_context(sector_id)
    except ValueError as exc:
        yield ("error", json.dumps({"error": str(exc)}))
        yield ("done", json.dumps({"persisted": False}))
        return
    except Exception as exc:
        log.exception("sector briefing context assembly failed")
        yield ("error", json.dumps({"error": f"context assembly failed: {exc}"}))
        yield ("done", json.dumps({"persisted": False}))
        return

    # Emit the structured context first so the UI can render the "what's in
    # the prompt" sidebar before any tokens arrive.
    yield ("context", json.dumps(context, default=str))

    if not settings.has_anthropic:
        yield ("token", json.dumps({"text":
            "[Sector briefing unavailable — ANTHROPIC_API_KEY not configured. "
            "The structured context above is what would be fed to Claude. "
            "Set the key in .env to enable AI-authored sector briefings.]"
        }))
        yield ("done", json.dumps({"persisted": False}))
        return

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        yield ("token", json.dumps({"text": "[anthropic SDK not installed]"}))
        yield ("done", json.dumps({"persisted": False}))
        return

    full_text = ""
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    try:
        async with client.messages.stream(
            model=settings.claude_model,
            max_tokens=900,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": _format_user_message(context)}],
        ) as stream:
            async for text in stream.text_stream:
                full_text += text
                yield ("token", json.dumps({"text": text}))
    except Exception as exc:
        log.exception("sector briefing Claude call failed")
        yield ("token", json.dumps({"text": f"\n\n[briefing interrupted: {type(exc).__name__}]"}))
        yield ("done", json.dumps({"persisted": False, "error": str(exc)}))
        return

    # Persist (kind keys off the sector_id so each sector gets its own daily row).
    try:
        with db_engine.conn() as c:
            c.execute(
                """
                INSERT INTO daily_briefings (date, kind, regime_label, summary, context_json, generated_at, source)
                VALUES (?, ?, ?, ?, ?, now(), 'claude')
                ON CONFLICT (date, kind) DO UPDATE SET
                    regime_label = EXCLUDED.regime_label,
                    summary      = EXCLUDED.summary,
                    context_json = EXCLUDED.context_json,
                    generated_at = now()
                """,
                [
                    date.today().isoformat(),
                    f"sector:{sector_id}",
                    (context.get("regime") or {}).get("label", ""),
                    full_text,
                    json.dumps(context, default=str),
                ],
            )
    except Exception as exc:
        log.warning("persist sector_briefing failed: %s", exc)
        yield ("done", json.dumps({"persisted": False, "error": str(exc)}))
        return
    yield ("done", json.dumps({"persisted": True}))


# ── Cached read ──────────────────────────────────────────────────────────────

def get_cached_briefing(sector_id: str, target_date: date | None = None) -> dict | None:
    target = (target_date or date.today()).isoformat()
    row = db_engine.fetchone(
        """
        SELECT date, kind, regime_label, summary, context_json, generated_at
        FROM daily_briefings
        WHERE date = ? AND kind = ?
        """,
        [target, f"sector:{sector_id}"],
    )
    if not row:
        return None
    return {
        "date":         str(row[0]),
        "sector_id":    sector_id,
        "regime_label": row[2],
        "summary":      row[3],
        "context":      json.loads(row[4]) if row[4] else None,
        "generated_at": str(row[5]) if row[5] else None,
    }
