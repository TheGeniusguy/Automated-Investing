"""Dividend & Buyback / Shareholder Yield Tracker (Bloomberg `DVD`).

Market-wide shareholder-yield intelligence: an upcoming/recent dividend
calendar across well-known payers, recent buyback authorizations, and a
total-shareholder-yield ranking (dividend yield + buyback yield).

There is no free, reliable live corporate-actions feed, so this surface is
built from a curated, deterministic SAMPLE dataset. Synthetic figures are
seeded with `hashlib.md5` so output is stable across calls. The public entry
point `dividends_tracker()` wraps everything in try/except and ALWAYS returns a
populated payload tagged with data_mode / as_of / source. It never raises.

NOTE: distinct from app.portfolio.dividends (per-portfolio income). This is the
market-wide tracker. Module `dividends_tracker`, route `/api/dividends-tracker`.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

SOURCE = "curated"


# ---------------------------------------------------------------------------
# Curated payer universe. amount = quarterly cash dividend per share (USD).
# forward_yield / payout_ratio are percent. growth_streak_years = consecutive
# years of dividend increases. five_yr_cagr is percent dividend-growth CAGR.
# ---------------------------------------------------------------------------

SAMPLE_PAYERS: list[dict] = [
    {"symbol": "KO", "name": "Coca-Cola Co.", "amount": 0.485, "frequency": "Quarterly", "forward_yield": 3.05, "payout_ratio": 68.4, "growth_streak_years": 62, "five_yr_cagr": 4.1},
    {"symbol": "PEP", "name": "PepsiCo Inc.", "amount": 1.355, "frequency": "Quarterly", "forward_yield": 3.28, "payout_ratio": 71.2, "growth_streak_years": 52, "five_yr_cagr": 6.8},
    {"symbol": "JNJ", "name": "Johnson & Johnson", "amount": 1.24, "frequency": "Quarterly", "forward_yield": 3.12, "payout_ratio": 56.7, "growth_streak_years": 62, "five_yr_cagr": 5.5},
    {"symbol": "PG", "name": "Procter & Gamble Co.", "amount": 1.0065, "frequency": "Quarterly", "forward_yield": 2.41, "payout_ratio": 59.8, "growth_streak_years": 68, "five_yr_cagr": 5.9},
    {"symbol": "XOM", "name": "Exxon Mobil Corp.", "amount": 0.99, "frequency": "Quarterly", "forward_yield": 3.42, "payout_ratio": 49.6, "growth_streak_years": 42, "five_yr_cagr": 2.4},
    {"symbol": "CVX", "name": "Chevron Corp.", "amount": 1.71, "frequency": "Quarterly", "forward_yield": 4.55, "payout_ratio": 58.1, "growth_streak_years": 38, "five_yr_cagr": 6.2},
    {"symbol": "JPM", "name": "JPMorgan Chase & Co.", "amount": 1.40, "frequency": "Quarterly", "forward_yield": 2.06, "payout_ratio": 27.3, "growth_streak_years": 14, "five_yr_cagr": 10.4},
    {"symbol": "HD", "name": "Home Depot Inc.", "amount": 2.30, "frequency": "Quarterly", "forward_yield": 2.49, "payout_ratio": 60.2, "growth_streak_years": 15, "five_yr_cagr": 11.7},
    {"symbol": "MCD", "name": "McDonald's Corp.", "amount": 1.77, "frequency": "Quarterly", "forward_yield": 2.42, "payout_ratio": 57.4, "growth_streak_years": 49, "five_yr_cagr": 8.1},
    {"symbol": "ABBV", "name": "AbbVie Inc.", "amount": 1.64, "frequency": "Quarterly", "forward_yield": 3.58, "payout_ratio": 51.9, "growth_streak_years": 53, "five_yr_cagr": 7.3},
    {"symbol": "T", "name": "AT&T Inc.", "amount": 0.2775, "frequency": "Quarterly", "forward_yield": 5.18, "payout_ratio": 46.8, "growth_streak_years": 1, "five_yr_cagr": -8.5},
    {"symbol": "VZ", "name": "Verizon Communications", "amount": 0.6775, "frequency": "Quarterly", "forward_yield": 6.34, "payout_ratio": 58.9, "growth_streak_years": 18, "five_yr_cagr": 2.0},
    {"symbol": "O", "name": "Realty Income Corp.", "amount": 0.2685, "frequency": "Monthly", "forward_yield": 5.62, "payout_ratio": 75.4, "growth_streak_years": 30, "five_yr_cagr": 3.6},
    {"symbol": "MMM", "name": "3M Co.", "amount": 0.73, "frequency": "Quarterly", "forward_yield": 2.04, "payout_ratio": 41.3, "growth_streak_years": 1, "five_yr_cagr": -9.8},
    {"symbol": "IBM", "name": "International Business Machines", "amount": 1.67, "frequency": "Quarterly", "forward_yield": 3.06, "payout_ratio": 64.7, "growth_streak_years": 29, "five_yr_cagr": 0.8},
    {"symbol": "PFE", "name": "Pfizer Inc.", "amount": 0.43, "frequency": "Quarterly", "forward_yield": 6.05, "payout_ratio": 88.2, "growth_streak_years": 15, "five_yr_cagr": 2.7},
    {"symbol": "MO", "name": "Altria Group Inc.", "amount": 1.02, "frequency": "Quarterly", "forward_yield": 7.84, "payout_ratio": 79.1, "growth_streak_years": 55, "five_yr_cagr": 4.4},
    {"symbol": "CSCO", "name": "Cisco Systems Inc.", "amount": 0.40, "frequency": "Quarterly", "forward_yield": 2.71, "payout_ratio": 47.6, "growth_streak_years": 14, "five_yr_cagr": 4.9},
    {"symbol": "TXN", "name": "Texas Instruments Inc.", "amount": 1.36, "frequency": "Quarterly", "forward_yield": 2.78, "payout_ratio": 73.5, "growth_streak_years": 21, "five_yr_cagr": 12.1},
    {"symbol": "AVGO", "name": "Broadcom Inc.", "amount": 0.59, "frequency": "Quarterly", "forward_yield": 1.18, "payout_ratio": 44.2, "growth_streak_years": 14, "five_yr_cagr": 14.6},
    {"symbol": "LMT", "name": "Lockheed Martin Corp.", "amount": 3.30, "frequency": "Quarterly", "forward_yield": 2.86, "payout_ratio": 46.1, "growth_streak_years": 22, "five_yr_cagr": 7.4},
    {"symbol": "CAT", "name": "Caterpillar Inc.", "amount": 1.41, "frequency": "Quarterly", "forward_yield": 1.62, "payout_ratio": 28.9, "growth_streak_years": 31, "five_yr_cagr": 8.3},
    {"symbol": "WMT", "name": "Walmart Inc.", "amount": 0.235, "frequency": "Quarterly", "forward_yield": 1.04, "payout_ratio": 35.7, "growth_streak_years": 52, "five_yr_cagr": 3.0},
    {"symbol": "TGT", "name": "Target Corp.", "amount": 1.12, "frequency": "Quarterly", "forward_yield": 3.34, "payout_ratio": 49.8, "growth_streak_years": 53, "five_yr_cagr": 9.1},
    {"symbol": "LOW", "name": "Lowe's Cos. Inc.", "amount": 1.15, "frequency": "Quarterly", "forward_yield": 1.92, "payout_ratio": 38.4, "growth_streak_years": 62, "five_yr_cagr": 18.2},
    {"symbol": "ADP", "name": "Automatic Data Processing", "amount": 1.50, "frequency": "Quarterly", "forward_yield": 2.05, "payout_ratio": 58.6, "growth_streak_years": 49, "five_yr_cagr": 11.9},
]

# Buyback authorizations: amount_b = $B authorized; pct_of_mktcap percent.
SAMPLE_BUYBACKS: list[dict] = [
    {"symbol": "AAPL", "name": "Apple Inc.", "amount_b": 110.0, "pct_of_mktcap": 3.2, "announced_date": "2026-05-02", "note": "Largest single authorization on record."},
    {"symbol": "GOOGL", "name": "Alphabet Inc.", "amount_b": 70.0, "pct_of_mktcap": 3.4, "announced_date": "2026-04-24", "note": "First buyback raise alongside maiden dividend."},
    {"symbol": "META", "name": "Meta Platforms Inc.", "amount_b": 50.0, "pct_of_mktcap": 3.6, "announced_date": "2026-04-30", "note": "Adds to existing repurchase program."},
    {"symbol": "MSFT", "name": "Microsoft Corp.", "amount_b": 60.0, "pct_of_mktcap": 1.9, "announced_date": "2026-03-18", "note": "Renews prior $60B program at completion."},
    {"symbol": "NVDA", "name": "NVIDIA Corp.", "amount_b": 50.0, "pct_of_mktcap": 1.6, "announced_date": "2026-06-04", "note": "Board adds to $25B remaining capacity."},
    {"symbol": "JPM", "name": "JPMorgan Chase & Co.", "amount_b": 30.0, "pct_of_mktcap": 5.1, "announced_date": "2026-05-14", "note": "Post-CCAR capital return expansion."},
    {"symbol": "XOM", "name": "Exxon Mobil Corp.", "amount_b": 20.0, "pct_of_mktcap": 4.2, "announced_date": "2026-02-02", "note": "$20B/yr pace through 2027."},
    {"symbol": "BAC", "name": "Bank of America Corp.", "amount_b": 25.0, "pct_of_mktcap": 7.4, "announced_date": "2026-05-21", "note": "New authorization after stress test."},
    {"symbol": "WFC", "name": "Wells Fargo & Co.", "amount_b": 30.0, "pct_of_mktcap": 12.6, "announced_date": "2026-04-15", "note": "Asset-cap removal frees capital return."},
    {"symbol": "CVX", "name": "Chevron Corp.", "amount_b": 15.0, "pct_of_mktcap": 4.9, "announced_date": "2026-01-31", "note": "Top end of $10-20B annual guidance."},
    {"symbol": "ORCL", "name": "Oracle Corp.", "amount_b": 16.0, "pct_of_mktcap": 3.0, "announced_date": "2026-03-11", "note": "Replenishes near-exhausted program."},
    {"symbol": "HD", "name": "Home Depot Inc.", "amount_b": 15.0, "pct_of_mktcap": 4.1, "announced_date": "2026-02-25", "note": "Resumes buybacks post-acquisition pause."},
    {"symbol": "V", "name": "Visa Inc.", "amount_b": 25.0, "pct_of_mktcap": 4.6, "announced_date": "2026-04-22", "note": "Class A common repurchase authorization."},
    {"symbol": "CSCO", "name": "Cisco Systems Inc.", "amount_b": 15.0, "pct_of_mktcap": 6.2, "announced_date": "2026-02-12", "note": "Raises total authorization to $40B."},
]

# Total-shareholder-yield candidates: blends dividend yield + net buyback yield.
# div_yield / buyback_yield are percent; total_yield computed below.
SAMPLE_YIELD_NAMES: list[dict] = [
    {"symbol": "MO", "name": "Altria Group Inc.", "div_yield": 7.84, "buyback_yield": 1.9},
    {"symbol": "MET", "name": "MetLife Inc.", "div_yield": 2.86, "buyback_yield": 6.8},
    {"symbol": "AIG", "name": "American International Group", "div_yield": 1.94, "buyback_yield": 7.9},
    {"symbol": "HPQ", "name": "HP Inc.", "div_yield": 3.41, "buyback_yield": 6.4},
    {"symbol": "T", "name": "AT&T Inc.", "div_yield": 5.18, "buyback_yield": 2.1},
    {"symbol": "VZ", "name": "Verizon Communications", "div_yield": 6.34, "buyback_yield": 0.4},
    {"symbol": "CVX", "name": "Chevron Corp.", "div_yield": 4.55, "buyback_yield": 4.9},
    {"symbol": "XOM", "name": "Exxon Mobil Corp.", "div_yield": 3.42, "buyback_yield": 4.2},
    {"symbol": "WFC", "name": "Wells Fargo & Co.", "div_yield": 2.28, "buyback_yield": 9.1},
    {"symbol": "BAC", "name": "Bank of America Corp.", "div_yield": 2.41, "buyback_yield": 5.7},
    {"symbol": "JPM", "name": "JPMorgan Chase & Co.", "div_yield": 2.06, "buyback_yield": 4.3},
    {"symbol": "IBM", "name": "International Business Machines", "div_yield": 3.06, "buyback_yield": 1.1},
    {"symbol": "AAPL", "name": "Apple Inc.", "div_yield": 0.44, "buyback_yield": 3.2},
    {"symbol": "META", "name": "Meta Platforms Inc.", "div_yield": 0.33, "buyback_yield": 3.6},
    {"symbol": "LOW", "name": "Lowe's Cos. Inc.", "div_yield": 1.92, "buyback_yield": 5.5},
    {"symbol": "TGT", "name": "Target Corp.", "div_yield": 3.34, "buyback_yield": 3.8},
]


# ---------------------------------------------------------------------------
# Deterministic seeding helpers
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _is_business_day(d: date) -> bool:
    return d.weekday() < 5


def _shift_business(d: date, n: int) -> date:
    """Move forward n business days from d."""
    step = 1 if n >= 0 else -1
    remaining = abs(n)
    while remaining > 0:
        d += timedelta(days=step)
        if _is_business_day(d):
            remaining -= 1
    return d


def _ex_date_for(symbol: str, frequency: str, today: date) -> date:
    """Deterministic ex-date in a window straddling today (recent or upcoming),
    seeded per symbol so the calendar is stable but spread out."""
    seed = _seed(f"exdate:{symbol}")
    # Spread across roughly a -10 .. +45 calendar-day window.
    offset = (seed % 56) - 10
    d = today + timedelta(days=offset)
    # Land on a business day.
    while not _is_business_day(d):
        d += timedelta(days=1)
    return d


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def _build_calendar(today: date) -> list[dict]:
    rows: list[dict] = []
    for p in SAMPLE_PAYERS:
        ex = _ex_date_for(p["symbol"], p["frequency"], today)
        # Pay date is typically ~2-4 weeks after ex-date.
        pay = _shift_business(ex, 18 + (_seed("pay:" + p["symbol"]) % 6))
        rows.append({
            "symbol": p["symbol"],
            "name": p["name"],
            "ex_date": ex.isoformat(),
            "pay_date": pay.isoformat(),
            "amount": round(float(p["amount"]), 4),
            "frequency": p["frequency"],
            "forward_yield": round(float(p["forward_yield"]), 2),
            "payout_ratio": round(float(p["payout_ratio"]), 1),
            "growth_streak_years": int(p["growth_streak_years"]),
            "five_yr_cagr": round(float(p["five_yr_cagr"]), 1),
        })
    rows.sort(key=lambda r: r["ex_date"])
    return rows


def _build_buybacks() -> list[dict]:
    rows = [
        {
            "symbol": b["symbol"],
            "name": b["name"],
            "amount_b": round(float(b["amount_b"]), 1),
            "pct_of_mktcap": round(float(b["pct_of_mktcap"]), 1),
            "announced_date": b["announced_date"],
            "note": b["note"],
        }
        for b in SAMPLE_BUYBACKS
    ]
    rows.sort(key=lambda r: r["announced_date"], reverse=True)
    return rows


def _build_shareholder_yield() -> list[dict]:
    rows = []
    for n in SAMPLE_YIELD_NAMES:
        dy = round(float(n["div_yield"]), 2)
        by = round(float(n["buyback_yield"]), 2)
        rows.append({
            "symbol": n["symbol"],
            "name": n["name"],
            "div_yield": dy,
            "buyback_yield": by,
            "total_yield": round(dy + by, 2),
        })
    rows.sort(key=lambda r: r["total_yield"], reverse=True)
    return rows


def _build_summary(calendar: list[dict], buybacks: list[dict], today: date) -> dict:
    aristocrats = sum(1 for r in calendar if r["growth_streak_years"] >= 25)
    avg_fwd = (
        round(sum(r["forward_yield"] for r in calendar) / len(calendar), 2)
        if calendar else 0.0
    )
    total_buyback_b = round(sum(b["amount_b"] for b in buybacks), 1)

    today_iso = today.isoformat()
    upcoming = [r for r in calendar if r["ex_date"] >= today_iso]
    next_event = upcoming[0] if upcoming else (calendar[0] if calendar else None)
    next_ex = None
    if next_event is not None:
        next_ex = {
            "symbol": next_event["symbol"],
            "name": next_event["name"],
            "ex_date": next_event["ex_date"],
            "amount": next_event["amount"],
            "forward_yield": next_event["forward_yield"],
        }
    return {
        "aristocrats_count": aristocrats,
        "avg_forward_yield": avg_fwd,
        "total_buyback_authorizations_b": total_buyback_b,
        "buyback_count": len(buybacks),
        "calendar_count": len(calendar),
        "next_ex_date": next_ex,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def dividends_tracker() -> dict:
    """Market-wide dividend + buyback + shareholder-yield tracker.

    Always returns a populated payload. Never raises.

    Top-level keys: calendar, buybacks, shareholder_yield, summary,
    data_mode, as_of, source.
    """
    try:
        today = date.today()
        calendar = _build_calendar(today)
        buybacks = _build_buybacks()
        shareholder_yield = _build_shareholder_yield()
        summary = _build_summary(calendar, buybacks, today)
        return {
            "calendar": calendar,
            "buybacks": buybacks,
            "shareholder_yield": shareholder_yield,
            "summary": summary,
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": SOURCE,
        }
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("dividends_tracker failed hard, returning minimal sample: %s", e)
        return {
            "calendar": [],
            "buybacks": [],
            "shareholder_yield": [],
            "summary": {
                "aristocrats_count": 0,
                "avg_forward_yield": 0.0,
                "total_buyback_authorizations_b": 0.0,
                "buyback_count": 0,
                "calendar_count": 0,
                "next_ex_date": None,
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": SOURCE,
        }
