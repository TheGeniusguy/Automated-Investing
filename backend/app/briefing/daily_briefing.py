"""Daily briefing — one-paragraph cross-panel synthesis.

Pulls the highest-signal pieces of every other data layer (regime state,
top correlation breakdowns, calendar events, recent material filings) and
asks Claude to synthesize a 200-300 word briefing the user can read with
coffee instead of CNBC.

Persisted to the `daily_briefings` DuckDB table keyed by (date, kind).
First request of the day computes; subsequent requests serve cached.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime
from typing import AsyncIterator

from ..config import settings
from ..correlations import correlation_model
from ..data import earnings as earnings_mod
from ..data import eia_energy
from ..data import macro_data
from ..data import macro_snapshot
from ..data import news as news_mod
from ..data import options as options_mod
from ..data import sec_edgar
from ..data import shipping as shipping_mod
from ..data import watchlist
from ..db import engine as db_engine
from ..regime import regime_model

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are writing a daily market briefing for a sharp retail investor. "
    "You have full-context access to:\n"
    "  - macro regime (rule-based VIX + yield-curve classification)\n"
    "  - yield curves (treasuries 1M–30Y) and credit spreads (HY/IG/CCC OAS)\n"
    "  - inflation reads (CPI, PCE, breakevens, sticky CPI, U-Mich expectations)\n"
    "  - employment (NFP, unemployment, JOLTS, claims, AHE)\n"
    "  - housing (starts, permits, mortgage rates, Case-Shiller)\n"
    "  - manufacturing & consumer (ISM proxies, retail sales, sentiment)\n"
    "  - energy (WTI/Brent/HH gas/gasoline + weekly EIA inventories)\n"
    "  - shipping/freight (rail carloads, truck tonnage, BDRY, CFNAI)\n"
    "  - Fed (DXY, fed funds, balance sheet, RRP)\n"
    "  - correlation-breakdowns, VIX term structure, upcoming earnings, "
    "    recent 8-K filings, top news\n"
    "\n"
    "Write 3 short paragraphs:\n"
    "\n"
    "**1. The setup.** What regime are we in. Cite VIX term structure, "
    "the relevant credit spreads, and the dominant correlation breakdowns. "
    "One concrete sentence on the macro climate.\n"
    "\n"
    "**2. What changed.** The most important piece of new information — "
    "a regime change, a correlation flip, an earnings event with unusual "
    "implied move, a notable 8-K, a fresh inflation/employment print, or "
    "a meaningful energy/freight move. Specific numbers.\n"
    "\n"
    "**3. What to watch.** One concrete thing to monitor today. "
    "Levels, releases, or events. Not advice — observations.\n"
    "\n"
    "No filler. No 'consult a professional.' No 'past performance.' "
    "Plain prose, short sentences, specific numbers."
)


# Highlight series we always include in the briefing context for breadth.
BRIEFING_HIGHLIGHTS: list[str] = [
    # Yields & spreads
    "DGS2", "DGS10", "T10Y2Y", "T10Y3M", "BAMLH0A0HYM2", "BAMLC0A0CM",
    # Inflation
    "CPIAUCSL", "CPILFESL", "PCEPILFE", "T10YIE",
    # Employment
    "PAYEMS", "UNRATE", "ICSA",
    # Activity
    "INDPRO", "RSXFS", "UMCSENT",
    # Housing
    "HOUST", "MORTGAGE30US",
    # Monetary
    "WALCL", "DTWEXBGS",
    # Energy
    "DCOILWTICO", "DCOILBRENTEU", "DHHNGSP", "GASREGW",
    # Freight
    "RAILFRTCARLOADSD11", "TRUCKD11", "CFNAI",
]


def assemble_context() -> dict:
    """Pull a tight, structured snapshot from every panel that has live data."""
    # Regime
    vix = macro_data.fetch_series("^VIX", days=30)
    y2  = macro_data.fetch_series("DGS2",  days=30)
    y10 = macro_data.fetch_series("DGS10", days=30)
    regime = regime_model.detect_current(vix, y2, y10).to_dict()

    # Correlations — top 8 breakdowns
    try:
        corr = correlation_model.compute_correlations(recent_days=30, baseline_days=365)
        top_breakdowns = corr.get("breakdowns", [])[:8]
    except Exception as e:
        log.warning("correlations failed: %s", e)
        top_breakdowns = []

    # VIX term structure
    try:
        vix_term = options_mod.vix_term_structure()
    except Exception as e:
        log.warning("vix_term failed: %s", e)
        vix_term = None

    # Upcoming earnings — only ones within next 14 days
    try:
        e_overview = earnings_mod.fetch_overview(watchlist.DEFAULT_EQUITIES_WATCHLIST)
        today = date.today()
        upcoming: list[dict] = []
        for r in e_overview.get("results", []):
            d_str = r.get("next_earnings")
            if not d_str:
                continue
            try:
                d = datetime.strptime(d_str, "%Y-%m-%d").date()
            except ValueError:
                continue
            if 0 <= (d - today).days <= 14:
                upcoming.append({
                    "symbol":        r["symbol"],
                    "date":          d_str,
                    "in_days":       (d - today).days,
                    "eps_estimate":  r.get("eps_estimate"),
                    "beat_rate":     r["stats"].get("beat_rate"),
                    "avg_reaction":  r["stats"].get("avg_reaction_1d"),
                })
        upcoming.sort(key=lambda x: x["in_days"])
    except Exception as e:
        log.warning("earnings failed: %s", e)
        upcoming = []

    # Recent material filings (8-K only, last 3 days)
    try:
        filings = sec_edgar.fetch_filings_batch(
            watchlist.DEFAULT_EQUITIES_WATCHLIST,
            days=3, forms=["8-K"], limit_per_ticker=5, overall_limit=30,
        )
        recent_filings = filings.get("filings", [])[:15]
    except Exception as e:
        log.warning("filings failed: %s", e)
        recent_filings = []

    # Top news headlines across the equities watchlist (last 24h-ish)
    try:
        news_feed = news_mod.fetch_news_feed(
            watchlist.DEFAULT_EQUITIES_WATCHLIST[:8], per_ticker=3, overall=10,
        )
        top_news = news_feed.get("items", [])[:10]
    except Exception as e:
        log.warning("news failed: %s", e)
        top_news = []

    # Macro highlights — current value + change for ~25 highest-signal indicators
    macro_highlights: list[dict] = []
    for sid in BRIEFING_HIGHLIGHTS:
        try:
            tile = macro_snapshot.snapshot_series(sid, days=180)
            if tile["latest"] is None:
                continue
            macro_highlights.append({
                "id":         tile["id"],
                "label":      tile["label"],
                "unit":       tile["unit"],
                "latest":     tile["latest"],
                "latest_date": tile["latest_date"],
                "delta_pct":  tile["delta_pct"],
                "category":   tile.get("category"),
            })
        except Exception as e:
            log.debug("highlight %s failed: %s", sid, e)

    # Energy + shipping high-level
    try:
        energy_prices    = eia_energy.fetch_section("prices")
        energy_inv       = eia_energy.fetch_section("inventories")
    except Exception:
        energy_prices = energy_inv = {"tiles": []}
    try:
        shipping_dash = shipping_mod.fetch_shipping(days=180)
    except Exception:
        shipping_dash = {"tiles": []}

    return {
        "as_of":             datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "regime":            regime,
        "vix_term":          vix_term,
        "top_breakdowns":    top_breakdowns,
        "macro_highlights":  macro_highlights,
        "energy_prices":     [_compact_tile(t) for t in energy_prices.get("tiles", [])],
        "energy_inventories": [_compact_tile(t) for t in energy_inv.get("tiles", [])],
        "shipping":          [_compact_tile(t) for t in shipping_dash.get("tiles", [])],
        "upcoming_earnings": upcoming,
        "recent_8k":         [
            {"ticker": f["ticker"], "filing_date": f["filing_date"], "items": f["items"], "url": f["url"]}
            for f in recent_filings
        ],
        "top_news": [
            {"title": n["title"], "publisher": n["publisher"], "tickers": n["tickers"], "published": n["published"]}
            for n in top_news
        ],
    }


def _compact_tile(t: dict) -> dict:
    """Trim a snapshot tile down to the fields the LLM actually needs."""
    return {
        "id":         t.get("id"),
        "label":      t.get("label"),
        "unit":       t.get("unit"),
        "latest":     t.get("latest"),
        "latest_date": t.get("latest_date"),
        "delta_pct":  t.get("delta_pct"),
    }


def _format_user_message(context: dict) -> str:
    return (
        "Daily briefing context (machine-readable). Synthesize per the system "
        "instructions.\n\n```json\n"
        + json.dumps(context, indent=2, default=str)
        + "\n```"
    )


async def stream_daily_briefing() -> AsyncIterator[tuple[str, str]]:
    """Yields (event_type, data) tuples. Every payload is JSON-encoded so SSE
    transport stays safe even when token text contains newlines."""
    context = assemble_context()
    yield ("context", json.dumps({
        "regime":            context["regime"],
        "vix_term":          context["vix_term"],
        "top_breakdowns":    context["top_breakdowns"],
        "upcoming_earnings": context["upcoming_earnings"],
        "recent_8k":         context["recent_8k"],
        "top_news":          context["top_news"],
        "as_of":             context["as_of"],
    }))

    if not settings.has_anthropic:
        yield ("token", json.dumps({"text": "[Daily briefing unavailable — ANTHROPIC_API_KEY not configured. "
                                              "Context payload above is what would be fed to Claude.]"}))
        yield ("done", json.dumps({"persisted": False}))
        return

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        yield ("token", json.dumps({"text": "[anthropic SDK not installed]"}))
        yield ("done", "{}")
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
    except Exception as e:
        log.exception("daily briefing Claude call failed")
        yield ("token", json.dumps({"text": f"\n\n[briefing interrupted: {type(e).__name__}]"}))
        yield ("done", json.dumps({"persisted": False, "error": str(e)}))
        return

    # Persist
    try:
        with db_engine.conn() as c:
            c.execute(
                """
                INSERT INTO daily_briefings (date, kind, regime_label, summary, context_json, generated_at, source)
                VALUES (?, 'on_demand', ?, ?, ?, now(), 'claude')
                ON CONFLICT (date, kind) DO UPDATE SET
                    regime_label = EXCLUDED.regime_label,
                    summary      = EXCLUDED.summary,
                    context_json = EXCLUDED.context_json,
                    generated_at = now()
                """,
                [date.today().isoformat(), context["regime"]["label"], full_text, json.dumps(context, default=str)],
            )
    except Exception as e:
        log.warning("persist daily_briefing failed: %s", e)
        yield ("done", json.dumps({"persisted": False, "error": str(e)}))
        return
    yield ("done", json.dumps({"persisted": True}))


def get_cached_briefing(target_date: date | None = None) -> dict | None:
    target = (target_date or date.today()).isoformat()
    row = db_engine.fetchone(
        """
        SELECT date, kind, regime_label, summary, context_json, generated_at
        FROM daily_briefings
        WHERE date = ? AND kind = 'on_demand'
        """,
        [target],
    )
    if not row:
        return None
    return {
        "date":         str(row[0]),
        "kind":         row[1],
        "regime_label": row[2],
        "summary":      row[3],
        "context":      json.loads(row[4]) if row[4] else None,
        "generated_at": str(row[5]) if row[5] else None,
    }


def list_briefings(limit: int = 30) -> list[dict]:
    rows = db_engine.fetchall(
        """
        SELECT date, kind, regime_label, generated_at, length(summary) AS chars
        FROM daily_briefings
        ORDER BY date DESC, generated_at DESC
        LIMIT ?
        """,
        [limit],
    )
    return [
        {
            "date":         str(r[0]),
            "kind":         r[1],
            "regime_label": r[2],
            "generated_at": str(r[3]) if r[3] else None,
            "chars":        int(r[4] or 0),
        }
        for r in rows
    ]
