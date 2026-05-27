"""Economic events calendar — no API key required.

Computes upcoming and recent macroeconomic releases by combining:
  1. Hardcoded recurring-release schedule (BLS CPI, NFP, BEA GDP, FOMC, etc.)
     with cadence rules so we generate dates programmatically.
  2. yfinance earnings calendar (already wired via data/earnings.py).
  3. Federal Reserve FOMC meeting dates (hardcoded; meetings are announced
     years in advance and rarely change).

Each event carries an impact tier (high / medium / low), category, and a
one-line market-impact note. The frontend renders these as a weekly grid.
"""
from __future__ import annotations

import calendar as pycal
import logging
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from typing import Iterable, Optional

log = logging.getLogger(__name__)


# ─── Event taxonomy ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Event:
    date: str                  # YYYY-MM-DD
    time: str | None           # HH:MM ET, when known; None for "morning" etc.
    name: str
    category: str              # inflation | employment | growth | monetary_policy | housing | sentiment | trade | earnings
    impact: str                # high | medium | low
    source: str                # BLS | BEA | Federal Reserve | Census | NAHB | Conference Board | etc.
    description: str
    market_impact: str         # short note on how markets typically react


CATEGORIES = ("inflation", "employment", "growth", "monetary_policy",
              "housing", "sentiment", "trade", "earnings")
IMPACTS    = ("high", "medium", "low")


# ─── Date helpers ──────────────────────────────────────────────────────────

def _first_business_day(year: int, month: int) -> date:
    d = date(year, month, 1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _nth_friday(year: int, month: int, n: int) -> date:
    """1st Friday, 2nd Friday, etc."""
    d = date(year, month, 1)
    while d.weekday() != 4:
        d += timedelta(days=1)
    return d + timedelta(days=7 * (n - 1))


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """weekday: Mon=0..Sun=6. nth occurrence."""
    d = date(year, month, 1)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d + timedelta(days=7 * (n - 1))


def _add_business_days(d: date, n: int) -> date:
    """Add n business days (skipping weekends; doesn't account for federal holidays)."""
    cur = d
    while n > 0:
        cur += timedelta(days=1)
        if cur.weekday() < 5:
            n -= 1
    return cur


# ─── Recurring release rules ───────────────────────────────────────────────
# Each rule emits events for any month in the requested window. The rules
# encode the typical release cadence; actual dates can shift by 1-2 days
# (the BLS publishes a release calendar but to avoid an API key we use
# canonical rules + accept ±1 business-day drift).

def _emit_monthly(year: int, month: int) -> list[Event]:
    """All monthly recurring releases for (year, month)."""
    out: list[Event] = []

    # CPI — typically released 2nd Wednesday of the month, 8:30 ET, for prior month.
    cpi_day = _nth_weekday(year, month, 2, 2)  # 2nd Wednesday
    out.append(Event(
        date=cpi_day.isoformat(), time="08:30",
        name="CPI (Consumer Price Index)",
        category="inflation", impact="high", source="BLS",
        description=f"{pycal.month_name[(month - 1) or 12]} CPI release.",
        market_impact="Hot reading → bonds sell off, dollar strengthens, growth stocks weaken. "
                      "Cool reading → rate-cut bets, growth + small-caps rally.",
    ))

    # PPI — usually day after CPI.
    out.append(Event(
        date=_add_business_days(cpi_day, 1).isoformat(), time="08:30",
        name="PPI (Producer Price Index)",
        category="inflation", impact="high", source="BLS",
        description=f"{pycal.month_name[(month - 1) or 12]} PPI release.",
        market_impact="Pipeline inflation signal; confirms or contradicts CPI direction.",
    ))

    # NFP / Employment Situation — 1st Friday of the month, 8:30 ET.
    nfp_day = _nth_friday(year, month, 1)
    out.append(Event(
        date=nfp_day.isoformat(), time="08:30",
        name="Non-Farm Payrolls / Employment Situation",
        category="employment", impact="high", source="BLS",
        description="Headline jobs, unemployment rate, average hourly earnings.",
        market_impact="Strong number → 10y yield up, rate-cut bets fade, dollar strengthens, "
                      "cyclicals rally vs defensives. Weak number → opposite.",
    ))

    # ADP Employment Report — Wednesday before NFP.
    adp_day = nfp_day - timedelta(days=2)
    out.append(Event(
        date=adp_day.isoformat(), time="08:15",
        name="ADP Employment Report",
        category="employment", impact="medium", source="ADP",
        description="Private payrolls preview ahead of NFP.",
        market_impact="Sets short-term expectations for NFP day; large miss can move yields.",
    ))

    # JOLTS — typically released ~30 days after the reference month, first week.
    jolts_day = _nth_weekday(year, month, 1, 1)  # 1st Tuesday
    out.append(Event(
        date=jolts_day.isoformat(), time="10:00",
        name="JOLTS (Job Openings & Labor Turnover)",
        category="employment", impact="medium", source="BLS",
        description="Job openings, quits, layoffs.",
        market_impact="Fed watches quits rate as wage-pressure proxy.",
    ))

    # Retail Sales — mid-month, 8:30 ET.
    retail_day = _nth_weekday(year, month, 1, 3)  # 3rd Tuesday-ish
    out.append(Event(
        date=retail_day.isoformat(), time="08:30",
        name="Retail Sales",
        category="growth", impact="high", source="Census Bureau",
        description="Headline + control-group retail spending for prior month.",
        market_impact="Control group feeds into GDP nowcast. Strong → growth re-rate.",
    ))

    # ISM Manufacturing PMI — 1st business day of the month, 10:00 ET.
    ism_mfg = _first_business_day(year, month)
    out.append(Event(
        date=ism_mfg.isoformat(), time="10:00",
        name="ISM Manufacturing PMI",
        category="growth", impact="high", source="ISM",
        description="Diffusion index; 50 = expansion vs contraction line.",
        market_impact="Below 50 reinforces slowdown narrative; new orders + prices-paid sub-indices "
                      "feed inflation + growth views.",
    ))

    # ISM Services PMI — 3rd business day of the month.
    ism_svc = _add_business_days(ism_mfg, 2)
    out.append(Event(
        date=ism_svc.isoformat(), time="10:00",
        name="ISM Services PMI",
        category="growth", impact="high", source="ISM",
        description="Services sector activity diffusion index.",
        market_impact="Services drive ~70% of US GDP. Strong reading supports soft-landing thesis.",
    ))

    # Existing Home Sales — typically 3rd or 4th Wednesday.
    ehs_day = _nth_weekday(year, month, 2, 4)
    out.append(Event(
        date=ehs_day.isoformat(), time="10:00",
        name="Existing Home Sales",
        category="housing", impact="medium", source="NAR",
        description="Closed sales of pre-owned single-family homes, condos.",
        market_impact="Rate-sensitivity bellwether; affects homebuilders + REITs.",
    ))

    # New Home Sales — late month.
    nhs_day = _nth_weekday(year, month, 3, 4)
    out.append(Event(
        date=nhs_day.isoformat(), time="10:00",
        name="New Home Sales",
        category="housing", impact="medium", source="Census Bureau",
        description="New single-family home sales.",
        market_impact="Forward-looking on construction + mortgage activity.",
    ))

    # PCE Inflation — last business day of the month.
    last = date(year, month, pycal.monthrange(year, month)[1])
    while last.weekday() >= 5:
        last -= timedelta(days=1)
    out.append(Event(
        date=last.isoformat(), time="08:30",
        name="Core PCE Inflation",
        category="inflation", impact="high", source="BEA",
        description="Fed's preferred inflation gauge.",
        market_impact="The single most-watched inflation print for Fed reaction function. "
                      "Above-consensus → hawkish repricing; below → dovish.",
    ))

    # Consumer Confidence — last Tuesday.
    cc_day = _nth_weekday(year, month, 1, 4)
    out.append(Event(
        date=cc_day.isoformat(), time="10:00",
        name="Conference Board Consumer Confidence",
        category="sentiment", impact="medium", source="Conference Board",
        description="Headline + present situation + expectations indices.",
        market_impact="Expectations sub-index leads spending; drop foreshadows recession risk.",
    ))

    # U Mich Sentiment — preliminary mid-month, final at month-end.
    umich_prelim = _nth_friday(year, month, 2)
    out.append(Event(
        date=umich_prelim.isoformat(), time="10:00",
        name="U Michigan Consumer Sentiment (Preliminary)",
        category="sentiment", impact="medium", source="U Michigan",
        description="Includes 1y + 5-10y inflation expectations.",
        market_impact="Inflation expectations sub-index is closely watched by Fed.",
    ))

    return out


def _emit_quarterly(year: int, month: int) -> list[Event]:
    """Quarterly releases that fall in this month."""
    out: list[Event] = []
    # GDP — three estimates per quarter, late-month releases for advance / 2nd / 3rd.
    # Advance: ~end of month one (Jan/Apr/Jul/Oct after quarter-end).
    quarter_end_month = month
    if month in (1, 4, 7, 10):
        # Late-month advance GDP estimate
        gdp_day = _nth_weekday(year, month, 3, 4)  # last-ish Thursday
        out.append(Event(
            date=gdp_day.isoformat(), time="08:30",
            name="GDP (Advance Estimate)",
            category="growth", impact="high", source="BEA",
            description="First reading of prior quarter's GDP.",
            market_impact="Big surprises move 10y yield + dollar + growth-vs-value pairs.",
        ))
    if month in (2, 5, 8, 11):
        gdp_day = _nth_weekday(year, month, 3, 4)
        out.append(Event(
            date=gdp_day.isoformat(), time="08:30",
            name="GDP (Second Estimate)",
            category="growth", impact="medium", source="BEA",
            description="Revised GDP for the most-recent completed quarter.",
            market_impact="Smaller than advance estimate; mostly relevant on large revisions.",
        ))
    if month in (3, 6, 9, 12):
        gdp_day = _nth_weekday(year, month, 3, 4)
        out.append(Event(
            date=gdp_day.isoformat(), time="08:30",
            name="GDP (Third Estimate)",
            category="growth", impact="low", source="BEA",
            description="Final GDP estimate for the most-recent completed quarter.",
            market_impact="Rarely moves markets unless revision exceeds 0.5 pp.",
        ))
    return out


# ─── Known FOMC meeting dates ──────────────────────────────────────────────
# Eight scheduled meetings per year. Dates announced by Fed in advance.
# Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
# Update annually.

FOMC_MEETINGS: dict[int, list[tuple[date, date]]] = {
    2026: [
        (date(2026, 1, 27), date(2026, 1, 28)),
        (date(2026, 3, 17), date(2026, 3, 18)),
        (date(2026, 4, 28), date(2026, 4, 29)),
        (date(2026, 6, 16), date(2026, 6, 17)),
        (date(2026, 7, 28), date(2026, 7, 29)),
        (date(2026, 9, 15), date(2026, 9, 16)),
        (date(2026, 11, 3),  date(2026, 11, 4)),
        (date(2026, 12, 15), date(2026, 12, 16)),
    ],
    2027: [
        (date(2027, 1, 26), date(2027, 1, 27)),
        (date(2027, 3, 16), date(2027, 3, 17)),
        (date(2027, 4, 27), date(2027, 4, 28)),
        (date(2027, 6, 15), date(2027, 6, 16)),
        (date(2027, 7, 27), date(2027, 7, 28)),
        (date(2027, 9, 21), date(2027, 9, 22)),
        (date(2027, 11, 2), date(2027, 11, 3)),
        (date(2027, 12, 14), date(2027, 12, 15)),
    ],
}


def _emit_fomc(year: int) -> list[Event]:
    meetings = FOMC_MEETINGS.get(year, [])
    out: list[Event] = []
    for start, end in meetings:
        out.append(Event(
            date=end.isoformat(), time="14:00",
            name="FOMC Rate Decision + Statement",
            category="monetary_policy", impact="high", source="Federal Reserve",
            description=f"Two-day FOMC meeting ({start.isoformat()} to {end.isoformat()}). "
                        "Rate decision + statement at 14:00 ET; press conference at 14:30 ET.",
            market_impact="Biggest event-driven volatility event in markets. Statement "
                          "language, dot-plot, and Powell's press conference can all move "
                          "every asset class. Watch yields + dollar + risk assets.",
        ))
    return out


# ─── Public API ────────────────────────────────────────────────────────────

def events_in_range(start: date, end: date) -> list[dict]:
    """All events in [start, end] inclusive."""
    raw: list[Event] = []
    cur = date(start.year, start.month, 1)
    while cur <= end:
        raw.extend(_emit_monthly(cur.year, cur.month))
        raw.extend(_emit_quarterly(cur.year, cur.month))
        # Move to next month.
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    # FOMC meetings for any year that intersects the range.
    for y in range(start.year, end.year + 1):
        raw.extend(_emit_fomc(y))

    filtered: list[Event] = [e for e in raw if start.isoformat() <= e.date <= end.isoformat()]
    filtered.sort(key=lambda e: (e.date, e.time or ""))
    return [asdict(e) for e in filtered]


def week_view(reference_date: Optional[date] = None) -> dict:
    """Events for the week containing `reference_date` (defaults to today).

    Week starts Monday, ends Sunday.
    """
    today = reference_date or date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    events = events_in_range(monday, sunday)

    # Group by day for easier rendering.
    days: dict[str, list[dict]] = {(monday + timedelta(days=i)).isoformat(): [] for i in range(7)}
    for e in events:
        if e["date"] in days:
            days[e["date"]].append(e)

    return {
        "start":  monday.isoformat(),
        "end":    sunday.isoformat(),
        "days":   [
            {
                "date":   day,
                "weekday": pycal.day_name[(monday + timedelta(days=i)).weekday()],
                "events": days[day],
            }
            for i, day in enumerate(sorted(days.keys()))
        ],
        "summary": {
            "total":  len(events),
            "high":   sum(1 for e in events if e["impact"] == "high"),
            "medium": sum(1 for e in events if e["impact"] == "medium"),
            "low":    sum(1 for e in events if e["impact"] == "low"),
        },
    }


def upcoming(days_forward: int = 14) -> dict:
    """Convenience: events in the next N days."""
    today = date.today()
    end   = today + timedelta(days=days_forward)
    events = events_in_range(today, end)
    return {
        "start":  today.isoformat(),
        "end":    end.isoformat(),
        "events": events,
        "summary": {
            "total":  len(events),
            "high":   sum(1 for e in events if e["impact"] == "high"),
            "medium": sum(1 for e in events if e["impact"] == "medium"),
            "low":    sum(1 for e in events if e["impact"] == "low"),
        },
    }
