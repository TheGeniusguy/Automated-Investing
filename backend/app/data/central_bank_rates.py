"""Global Central-Bank Policy-Rate Monitor (Bloomberg WIRP / CBQ).

A world board of policy rates across developed and emerging markets. For the
Fed (and any bank whose policy rate is freely available on FRED) we attempt a
live fetch via app.data.macro_data.fetch_series; for the rest - most global
central-bank rates are NOT freely on FRED - we use a curated, realistic
CURRENT-level table. The module degrades gracefully: any live failure falls
back to the curated level, and the whole entry point is wrapped so it NEVER
raises. Every payload is tagged with data_mode / as_of / source for honesty
under the hood.

Each bank carries: policy_rate, last move (bps + date), days_since_change,
real_rate (policy minus curated CPI yoy), next_meeting_date, a hawkish/neutral/
dovish/cutting/hiking bias, and a short rate_history path for sparklines.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timezone

log = logging.getLogger(__name__)

# FRED series for the few policy rates that ARE freely available.
# DFEDTARU = Federal Funds Target Range, Upper Limit.
FED_FRED_SERIES = "DFEDTARU"


# ---------------------------------------------------------------------------
# Curated current-level table. Levels reflect recent (mid-2026) policy stances.
# rate            = current policy rate, percent
# cpi_yoy         = curated headline CPI year-over-year, percent (for real rate)
# last_move_bps   = size + sign of the most recent change (+ = hike, - = cut)
# last_move_date  = ISO date of that change
# next_meeting    = ISO date of the next scheduled decision
# bias            = forward stance label
# fred            = optional FRED series id to try for a live override
# ---------------------------------------------------------------------------

DM_BANKS: list[dict] = [
    {
        "bank": "Federal Reserve", "country": "United States", "flag_emoji": "\U0001F1FA\U0001F1F8",
        "currency": "USD", "rate": 4.50, "cpi_yoy": 2.6, "last_move_bps": -25,
        "last_move_date": "2025-12-10", "next_meeting": "2026-07-29",
        "bias": "Neutral", "fred": FED_FRED_SERIES,
    },
    {
        "bank": "European Central Bank", "country": "Euro Area", "flag_emoji": "\U0001F1EA\U0001F1FA",
        "currency": "EUR", "rate": 2.15, "cpi_yoy": 2.1, "last_move_bps": -25,
        "last_move_date": "2026-03-12", "next_meeting": "2026-07-24",
        "bias": "Neutral",
    },
    {
        "bank": "Bank of England", "country": "United Kingdom", "flag_emoji": "\U0001F1EC\U0001F1E7",
        "currency": "GBP", "rate": 4.00, "cpi_yoy": 3.1, "last_move_bps": -25,
        "last_move_date": "2026-05-08", "next_meeting": "2026-08-07",
        "bias": "Cutting",
    },
    {
        "bank": "Bank of Japan", "country": "Japan", "flag_emoji": "\U0001F1EF\U0001F1F5",
        "currency": "JPY", "rate": 0.75, "cpi_yoy": 2.8, "last_move_bps": 25,
        "last_move_date": "2026-01-24", "next_meeting": "2026-07-31",
        "bias": "Hiking",
    },
    {
        "bank": "Swiss National Bank", "country": "Switzerland", "flag_emoji": "\U0001F1E8\U0001F1ED",
        "currency": "CHF", "rate": 0.00, "cpi_yoy": 0.4, "last_move_bps": -25,
        "last_move_date": "2026-03-20", "next_meeting": "2026-09-25",
        "bias": "Dovish",
    },
    {
        "bank": "Bank of Canada", "country": "Canada", "flag_emoji": "\U0001F1E8\U0001F1E6",
        "currency": "CAD", "rate": 2.75, "cpi_yoy": 2.3, "last_move_bps": -25,
        "last_move_date": "2026-04-15", "next_meeting": "2026-07-30",
        "bias": "Neutral",
    },
    {
        "bank": "Reserve Bank of Australia", "country": "Australia", "flag_emoji": "\U0001F1E6\U0001F1FA",
        "currency": "AUD", "rate": 3.60, "cpi_yoy": 2.9, "last_move_bps": -25,
        "last_move_date": "2026-05-20", "next_meeting": "2026-07-08",
        "bias": "Cutting",
    },
    {
        "bank": "Reserve Bank of New Zealand", "country": "New Zealand", "flag_emoji": "\U0001F1F3\U0001F1FF",
        "currency": "NZD", "rate": 3.00, "cpi_yoy": 2.4, "last_move_bps": -25,
        "last_move_date": "2026-05-28", "next_meeting": "2026-07-09",
        "bias": "Cutting",
    },
    {
        "bank": "Sveriges Riksbank", "country": "Sweden", "flag_emoji": "\U0001F1F8\U0001F1EA",
        "currency": "SEK", "rate": 1.75, "cpi_yoy": 1.9, "last_move_bps": -25,
        "last_move_date": "2026-01-29", "next_meeting": "2026-08-20",
        "bias": "Neutral",
    },
    {
        "bank": "Norges Bank", "country": "Norway", "flag_emoji": "\U0001F1F3\U0001F1F4",
        "currency": "NOK", "rate": 4.00, "cpi_yoy": 2.7, "last_move_bps": -25,
        "last_move_date": "2026-03-19", "next_meeting": "2026-08-13",
        "bias": "Neutral",
    },
]

EM_BANKS: list[dict] = [
    {
        "bank": "People's Bank of China", "country": "China", "flag_emoji": "\U0001F1E8\U0001F1F3",
        "currency": "CNY", "rate": 2.90, "cpi_yoy": 0.6, "last_move_bps": -10,
        "last_move_date": "2026-04-21", "next_meeting": "2026-07-21",
        "bias": "Dovish",
    },
    {
        "bank": "Banco de Mexico", "country": "Mexico", "flag_emoji": "\U0001F1F2\U0001F1FD",
        "currency": "MXN", "rate": 7.75, "cpi_yoy": 3.8, "last_move_bps": -50,
        "last_move_date": "2026-05-15", "next_meeting": "2026-08-07",
        "bias": "Cutting",
    },
    {
        "bank": "Banco Central do Brasil", "country": "Brazil", "flag_emoji": "\U0001F1E7\U0001F1F7",
        "currency": "BRL", "rate": 14.25, "cpi_yoy": 4.6, "last_move_bps": 25,
        "last_move_date": "2026-03-19", "next_meeting": "2026-07-30",
        "bias": "Hawkish",
    },
    {
        "bank": "Reserve Bank of India", "country": "India", "flag_emoji": "\U0001F1EE\U0001F1F3",
        "currency": "INR", "rate": 5.50, "cpi_yoy": 3.2, "last_move_bps": -50,
        "last_move_date": "2026-06-06", "next_meeting": "2026-08-06",
        "bias": "Neutral",
    },
    {
        "bank": "Central Bank of Turkey", "country": "Turkiye", "flag_emoji": "\U0001F1F9\U0001F1F7",
        "currency": "TRY", "rate": 43.00, "cpi_yoy": 33.5, "last_move_bps": -250,
        "last_move_date": "2026-06-12", "next_meeting": "2026-07-24",
        "bias": "Cutting",
    },
    {
        "bank": "South African Reserve Bank", "country": "South Africa", "flag_emoji": "\U0001F1FF\U0001F1E6",
        "currency": "ZAR", "rate": 7.00, "cpi_yoy": 3.4, "last_move_bps": -25,
        "last_move_date": "2026-05-29", "next_meeting": "2026-07-31",
        "bias": "Neutral",
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[:8], 16)


def _days_since(iso_date: str) -> int:
    try:
        d = date.fromisoformat(iso_date)
        return max((date.today() - d).days, 0)
    except Exception:
        return 0


def _rate_history(bank: str, current_rate: float, last_move_bps: int) -> list[dict]:
    """Synthesize a short, deterministic 2-3yr quarterly policy-rate path that
    ENDS at the current rate. Direction is inferred from the recent move so the
    sparkline tells a coherent story (hiking cycle rises into the level, cutting
    cycle falls into it). Sampled, not exact - good enough for a sparkline."""
    n = 11  # ~11 quarterly points (~2.5 years)
    seed = _seed(bank)
    # Magnitude of the multi-year swing, in percentage points, biased by region.
    swing = max(abs(current_rate) * 0.55, 1.0)
    if last_move_bps > 0:
        # hiking: started lower, climbed
        start = max(current_rate - swing, 0.0)
    elif last_move_bps < 0:
        # cutting: started higher, eased down
        start = current_rate + swing
    else:
        start = current_rate

    out: list[dict] = []
    today = date.today()
    for i in range(n):
        frac = i / (n - 1)
        base = start + (current_rate - start) * frac
        # small deterministic plateau wobble so the curve has policy-step texture
        wobble = (((seed >> (i % 7)) & 0x7) - 3) * 0.04
        val = base + (wobble if 0 < i < n - 1 else 0.0)
        if last_move_bps >= 0:
            val = max(val, 0.0)
        # approximate quarter spacing going backwards from today
        months_back = (n - 1 - i) * 3
        y = today.year - (months_back // 12)
        m = today.month - (months_back % 12)
        if m <= 0:
            m += 12
            y -= 1
        out.append({"date": f"{y:04d}-{m:02d}-01", "rate": round(val, 2)})
    out[-1]["rate"] = round(current_rate, 2)
    return out


def _try_live_rate(fred_series: str | None) -> float | None:
    """Best-effort live policy rate from FRED. Returns None on any issue."""
    if not fred_series:
        return None
    try:
        from .macro_data import fetch_series
        pts = fetch_series(fred_series, days=120)
        for p in reversed(pts or []):
            if p.get("value") is not None:
                return round(float(p["value"]), 2)
    except Exception as e:
        log.warning("central-bank live rate fetch failed for %s: %s", fred_series, e)
    return None


def _build_bank(spec: dict) -> tuple[dict, bool]:
    """Build a single bank entry. Returns (entry, used_live)."""
    rate = float(spec["rate"])
    used_live = False
    live = _try_live_rate(spec.get("fred"))
    if live is not None and live > 0:
        rate = live
        used_live = True

    cpi = float(spec["cpi_yoy"])
    real_rate = round(rate - cpi, 2)
    last_bps = int(spec["last_move_bps"])

    return {
        "bank": spec["bank"],
        "country": spec["country"],
        "flag_emoji": spec["flag_emoji"],
        "currency": spec["currency"],
        "policy_rate": round(rate, 2),
        "cpi_yoy": round(cpi, 2),
        "last_move_bps": last_bps,
        "last_move_date": spec["last_move_date"],
        "days_since_change": _days_since(spec["last_move_date"]),
        "real_rate": real_rate,
        "next_meeting_date": spec["next_meeting"],
        "bias": spec["bias"],
        "rate_history": _rate_history(spec["bank"], rate, last_bps),
        "data_mode": "live" if used_live else "sample",
    }, used_live


def _summarize(banks: list[dict]) -> dict:
    hiking = sum(1 for b in banks if b["last_move_bps"] > 0)
    cutting = sum(1 for b in banks if b["last_move_bps"] < 0)
    holding = sum(1 for b in banks if b["last_move_bps"] == 0)
    rates = [b["policy_rate"] for b in banks]
    avg = round(sum(rates) / len(rates), 2) if rates else 0.0

    highest = max(banks, key=lambda b: b["real_rate"]) if banks else None
    lowest = min(banks, key=lambda b: b["real_rate"]) if banks else None

    def _rr(b: dict | None) -> dict | None:
        if not b:
            return None
        return {
            "bank": b["bank"],
            "country": b["country"],
            "flag_emoji": b["flag_emoji"],
            "real_rate": b["real_rate"],
            "policy_rate": b["policy_rate"],
        }

    return {
        "count_total": len(banks),
        "count_hiking": hiking,
        "count_holding": holding,
        "count_cutting": cutting,
        "global_avg_rate": avg,
        "highest_real_rate": _rr(highest),
        "lowest_real_rate": _rr(lowest),
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def central_bank_rates() -> dict:
    """World board of central-bank policy rates. See module docstring.

    Always returns a populated dict tagged with data_mode / as_of / source.
    Never raises - falls back to the fully curated table on any failure.
    """
    try:
        return _central_bank_rates()
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("central_bank_rates failed hard, returning sample: %s", e)
        return _central_bank_rates_sample()


def _central_bank_rates() -> dict:
    banks: list[dict] = []
    any_live = False
    for spec in [*DM_BANKS, *EM_BANKS]:
        entry, used_live = _build_bank(spec)
        any_live = any_live or used_live
        banks.append(entry)

    return {
        "banks": banks,
        "summary": _summarize(banks),
        "data_mode": "live" if any_live else "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "FRED + curated central-bank schedule" if any_live else "curated central-bank schedule",
    }


def _central_bank_rates_sample() -> dict:
    """Pure curated path - no live attempts. Used as the last-resort fallback."""
    banks: list[dict] = []
    for spec in [*DM_BANKS, *EM_BANKS]:
        rate = float(spec["rate"])
        cpi = float(spec["cpi_yoy"])
        last_bps = int(spec["last_move_bps"])
        banks.append({
            "bank": spec["bank"],
            "country": spec["country"],
            "flag_emoji": spec["flag_emoji"],
            "currency": spec["currency"],
            "policy_rate": round(rate, 2),
            "cpi_yoy": round(cpi, 2),
            "last_move_bps": last_bps,
            "last_move_date": spec["last_move_date"],
            "days_since_change": _days_since(spec["last_move_date"]),
            "real_rate": round(rate - cpi, 2),
            "next_meeting_date": spec["next_meeting"],
            "bias": spec["bias"],
            "rate_history": _rate_history(spec["bank"], rate, last_bps),
            "data_mode": "sample",
        })
    return {
        "banks": banks,
        "summary": _summarize(banks),
        "data_mode": "sample",
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "curated central-bank schedule",
    }
