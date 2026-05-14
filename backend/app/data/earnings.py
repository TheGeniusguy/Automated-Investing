"""Earnings calendar + post-earnings reaction analytics via yfinance.

Two surfaces:

1. **Calendar** — next earnings date per ticker. yfinance exposes this via
   Ticker.calendar (returns a dict in newer versions).

2. **Surprise history** — Ticker.earnings_history (or .income_stmt deltas).
   For each prior earnings event, compute the surprise (actual vs estimate)
   AND the realized price reaction over the next 1 and 5 trading days.

Both feed into the panel: "AAPL reports in 8 days, has beaten in 7 of last 8
quarters with an average +1.4% next-day reaction."
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from . import cache

log = logging.getLogger(__name__)

CALENDAR_TTL = 60 * 60 * 6   # 6h — dates rarely change intraday
HISTORY_TTL  = 60 * 60 * 24  # 24h — historical EPS surprises are stable


def _yf():
    import yfinance as yf
    return yf


# ---------- Calendar ----------

def _parse_date(v) -> str | None:
    if v is None:
        return None
    try:
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        if isinstance(v, (list, tuple)) and v:
            return _parse_date(v[0])
        return str(v)[:10]
    except Exception:
        return None


def fetch_calendar(symbol: str) -> dict:
    cache_key = f"earnings:cal:{symbol}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    yf = _yf()
    out: dict = {"symbol": symbol.upper(), "next_earnings": None, "eps_estimate": None, "revenue_estimate": None, "error": None}
    try:
        t = yf.Ticker(symbol)
        cal = t.calendar
        if isinstance(cal, dict):
            out["next_earnings"]    = _parse_date(cal.get("Earnings Date"))
            out["eps_estimate"]     = _avg(cal.get("Earnings Average") or cal.get("EPS Estimate"))
            out["revenue_estimate"] = _avg(cal.get("Revenue Average") or cal.get("Revenue Estimate"))
    except Exception as e:
        log.warning("calendar fetch failed for %s: %s", symbol, e)
        out["error"] = str(e)
    cache.set(cache_key, out, CALENDAR_TTL)
    return out


def _avg(v) -> float | None:
    if v is None:
        return None
    try:
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, (list, tuple)) and v:
            xs = [float(x) for x in v if x is not None]
            return sum(xs) / len(xs) if xs else None
    except Exception:
        return None
    return None


# ---------- Surprise history ----------

def _price_at(history_df, date_str: str) -> float | None:
    if history_df is None or history_df.empty:
        return None
    try:
        idx_dates = [d.strftime("%Y-%m-%d") for d in history_df.index]
        # Snap to the next available trading day on/after date_str
        for i, d in enumerate(idx_dates):
            if d >= date_str:
                return float(history_df["Close"].iloc[i])
        return None
    except Exception:
        return None


def fetch_surprise_history(symbol: str, *, limit: int = 12) -> dict:
    cache_key = f"earnings:hist:{symbol}:{limit}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    yf = _yf()
    symbol = symbol.upper().strip()
    out: dict = {"symbol": symbol, "events": [], "stats": {}, "error": None}

    try:
        t = yf.Ticker(symbol)
        # earnings_dates is the richer surface (past + upcoming, with surprise%).
        # Columns: 'EPS Estimate', 'Reported EPS', 'Surprise(%)' as percentage
        # (e.g. 3.49 means +3.49%, NOT 0.0349).
        eh = getattr(t, "earnings_dates", None)
        if eh is None or (hasattr(eh, "empty") and eh.empty):
            # Fall back to earnings_history if dates isn't available
            eh = getattr(t, "earnings_history", None)
            using_dates = False
        else:
            using_dates = True
        if eh is None or (hasattr(eh, "empty") and eh.empty):
            cache.set(cache_key, out, HISTORY_TTL)
            return out

        # Need ~2y of close history to compute next-day / +5d reactions
        df = t.history(period="2y", auto_adjust=False)

        events: list[dict] = []
        for idx, row in eh.iterrows():
            evt_date = _parse_date(idx)
            if not evt_date:
                continue
            if using_dates:
                est  = _f(row.get("EPS Estimate"))
                act  = _f(row.get("Reported EPS"))
                surp_raw = _f(row.get("Surprise(%)"))
                surp_pct = (surp_raw / 100.0) if surp_raw is not None else None
            else:
                est  = _f(row.get("epsEstimate"))
                act  = _f(row.get("epsActual"))
                # earnings_history's surprisePercent is already a decimal
                surp_pct = _f(row.get("surprisePercent"))
            if surp_pct is None and est is not None and act is not None and est != 0:
                surp_pct = (act - est) / abs(est)

            # Reactions only meaningful for past events (act not null)
            if act is None:
                reaction_1d = reaction_5d = None
            else:
                p_event = _price_at(df, evt_date)
                p_next  = _price_at(df, _date_offset(evt_date, 1))
                p_5d    = _price_at(df, _date_offset(evt_date, 5))
                reaction_1d = (p_next / p_event - 1.0) if (p_event and p_next) else None
                reaction_5d = (p_5d / p_event   - 1.0) if (p_event and p_5d)   else None

            events.append({
                "date":        evt_date,
                "estimate":    est,
                "actual":      act,
                "surprise_pct": surp_pct,
                "reaction_1d": reaction_1d,
                "reaction_5d": reaction_5d,
            })
            if len(events) >= limit:
                break

        # Stats: beat rate, avg surprise %, avg next-day reaction — only over past events
        past = [e for e in events if e["actual"] is not None]
        beats = [e for e in past if e["surprise_pct"] is not None and e["surprise_pct"] > 0]
        reactions = [e["reaction_1d"] for e in past if e["reaction_1d"] is not None]
        avg_react = (sum(reactions) / len(reactions)) if reactions else None
        surprises = [e["surprise_pct"] for e in past if e["surprise_pct"] is not None]
        avg_surp  = (sum(surprises) / len(surprises)) if surprises else None
        stats = {
            "n":               len(past),
            "beat_rate":       (len(beats) / len(past)) if past else None,
            "avg_surprise":    avg_surp,
            "avg_reaction_1d": avg_react,
        }
        out["events"] = events
        out["stats"]  = stats
    except Exception as e:
        log.warning("surprise_history failed for %s: %s", symbol, e)
        out["error"] = str(e)

    cache.set(cache_key, out, HISTORY_TTL)
    return out


def _date_offset(date_str: str, days: int) -> str:
    d = datetime.strptime(date_str, "%Y-%m-%d").date() + timedelta(days=days)
    return d.isoformat()


def _f(v) -> float | None:
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


# ---------- Batch ----------

def fetch_overview(tickers: list[str]) -> dict:
    """Return calendar + summary stats per ticker, sorted by next earnings ASC."""
    results: list[dict] = []
    for sym in tickers:
        if not sym.strip():
            continue
        cal  = fetch_calendar(sym)
        hist = fetch_surprise_history(sym, limit=8)
        results.append({
            **cal,
            "stats":  hist.get("stats", {}),
            "events": hist.get("events", []),
        })

    # Sort: tickers with upcoming earnings first, then by date asc, unknowns last
    def _sort_key(r):
        d = r.get("next_earnings")
        return (0, d) if d else (1, "")
    results.sort(key=_sort_key)

    return {
        "tickers":    [r["symbol"] for r in results],
        "results":    results,
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
