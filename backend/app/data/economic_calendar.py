"""Economic Calendar engine (Bloomberg `ECO` equivalent).

Builds a forward-looking US macroeconomic release schedule spanning roughly the
trailing one week through the forward four weeks. Each release carries its
consensus, prior, and (for dates already in the past) a deterministic `actual`,
plus an importance tier so the UI can make the market-movers jump out.

This surface is fully GENERATED - there is no free, real-time consensus-vs-actual
release feed wired in - so the schedule is synthesized on realistic cadences:
Nonfarm Payrolls on the first Friday, CPI mid-month, weekly Jobless Claims every
Thursday, FOMC on the actual 2025-26 meeting dates, PCE near month-end, and so on.
Every synthetic number is seeded deterministically off the event name + date via
hashlib.md5 (the canonical pattern in etf_tracking.py) so the payload is stable
across calls and looks great in a screenshot. The module NEVER raises and tags
itself honestly under the hood with data_mode / as_of / source.
"""
from __future__ import annotations

import calendar as _calmod
import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

SOURCE = "generated-schedule"

# Window: trailing ~1 week through forward ~4 weeks.
TRAILING_DAYS = 7
FORWARD_DAYS = 28

# ---------------------------------------------------------------------------
# Release profiles. center/prior anchor the level, `spread` scales the small
# month-to-month drift, `surprise` scales the actual-vs-consensus miss (only
# applied to past dates). decimals + unit drive formatting. importance gates the
# visual emphasis. FOMC/CPI/NFP/PCE/GDP are High by contract.
# ---------------------------------------------------------------------------

PROFILES: dict[str, dict] = {
    "Nonfarm Payrolls":        {"unit": "K",   "center": 175.0, "spread": 25.0, "surprise": 45.0, "decimals": 0, "importance": "High"},
    "Unemployment Rate":       {"unit": "%",   "center": 4.1,   "spread": 0.1,  "surprise": 0.1,  "decimals": 1, "importance": "Medium"},
    "Avg Hourly Earnings MoM": {"unit": "%",   "center": 0.3,   "spread": 0.1,  "surprise": 0.1,  "decimals": 1, "importance": "Medium"},
    "CPI MoM":                 {"unit": "%",   "center": 0.2,   "spread": 0.1,  "surprise": 0.1,  "decimals": 1, "importance": "High"},
    "Core CPI MoM":            {"unit": "%",   "center": 0.3,   "spread": 0.05, "surprise": 0.1,  "decimals": 1, "importance": "High"},
    "PPI MoM":                 {"unit": "%",   "center": 0.2,   "spread": 0.1,  "surprise": 0.15, "decimals": 1, "importance": "Medium"},
    "Retail Sales MoM":        {"unit": "%",   "center": 0.4,   "spread": 0.2,  "surprise": 0.3,  "decimals": 1, "importance": "Medium"},
    "Initial Jobless Claims":  {"unit": "K",   "center": 222.0, "spread": 8.0,  "surprise": 12.0, "decimals": 0, "importance": "Medium"},
    "ISM Manufacturing PMI":   {"unit": "idx", "center": 49.2,  "spread": 1.0,  "surprise": 1.2,  "decimals": 1, "importance": "Medium"},
    "ISM Services PMI":        {"unit": "idx", "center": 52.6,  "spread": 1.0,  "surprise": 1.3,  "decimals": 1, "importance": "Medium"},
    "GDP QoQ Ann.":            {"unit": "%",   "center": 2.3,   "spread": 0.3,  "surprise": 0.4,  "decimals": 1, "importance": "High"},
    "Core PCE MoM":            {"unit": "%",   "center": 0.2,   "spread": 0.05, "surprise": 0.1,  "decimals": 1, "importance": "High"},
    "PCE MoM":                 {"unit": "%",   "center": 0.2,   "spread": 0.1,  "surprise": 0.1,  "decimals": 1, "importance": "High"},
    "Consumer Confidence":     {"unit": "idx", "center": 101.5, "spread": 3.0,  "surprise": 3.5,  "decimals": 1, "importance": "Medium"},
    "UMich Sentiment":         {"unit": "idx", "center": 70.0,  "spread": 2.5,  "surprise": 3.0,  "decimals": 1, "importance": "Low"},
    "Housing Starts":          {"unit": "M",   "center": 1.36,  "spread": 0.05, "surprise": 0.07, "decimals": 2, "importance": "Low"},
    "Building Permits":        {"unit": "M",   "center": 1.40,  "spread": 0.05, "surprise": 0.07, "decimals": 2, "importance": "Low"},
    "Durable Goods Orders":    {"unit": "%",   "center": 0.5,   "spread": 0.6,  "surprise": 1.5,  "decimals": 1, "importance": "Medium"},
    "JOLTS Job Openings":      {"unit": "M",   "center": 7.7,   "spread": 0.2,  "surprise": 0.3,  "decimals": 1, "importance": "Medium"},
}

# Real 2025-26 FOMC decision dates (second day of each two-day meeting), 14:00 ET.
FOMC_DECISION_DATES = [
    date(2025, 1, 29), date(2025, 3, 19), date(2025, 5, 7), date(2025, 6, 18),
    date(2025, 7, 30), date(2025, 9, 17), date(2025, 10, 29), date(2025, 12, 10),
    date(2026, 1, 28), date(2026, 3, 18), date(2026, 4, 29), date(2026, 6, 17),
    date(2026, 7, 29), date(2026, 9, 16), date(2026, 11, 4), date(2026, 12, 16),
]
FOMC_TARGET = "4.25-4.50%"  # held range across the relevant window


# ---------------------------------------------------------------------------
# Deterministic synthetic helpers (md5-seeded, stable across calls).
# ---------------------------------------------------------------------------

def _unit(key: str) -> float:
    """Stable float in [0, 1) seeded off `key`."""
    h = hashlib.md5(key.encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def _signed(key: str) -> float:
    """Stable float in [-1, 1) seeded off `key`."""
    return _unit(key) * 2.0 - 1.0


def _fmt(value: float, unit: str, decimals: int) -> str:
    if unit == "K":
        return f"{value:.0f}K"
    if unit == "M":
        return f"{value:.{decimals}f}M"
    if unit == "%":
        return f"{value:.{decimals}f}%"
    return f"{value:.{decimals}f}"


def _values(name: str, iso: str, is_past: bool) -> dict:
    """Return consensus/prior/actual (strings or None) + unit for an occurrence."""
    if name == "FOMC Rate Decision":
        return {
            "consensus": FOMC_TARGET,
            "prior": FOMC_TARGET,
            "actual": FOMC_TARGET if is_past else None,
            "unit": "%",
        }
    p = PROFILES[name]
    unit, dec = p["unit"], p["decimals"]
    consensus = p["center"] + _signed(f"{name}|{iso}|c") * p["spread"]
    prior = p["center"] + _signed(f"{name}|{iso}|p") * p["spread"]
    actual = None
    if is_past:
        actual_val = consensus + _signed(f"{name}|{iso}|a") * p["surprise"]
        actual = _fmt(actual_val, unit, dec)
    return {
        "consensus": _fmt(consensus, unit, dec),
        "prior": _fmt(prior, unit, dec),
        "actual": actual,
        "unit": unit,
    }


# ---------------------------------------------------------------------------
# Calendar-date helpers.
# ---------------------------------------------------------------------------

def _first_weekday(year: int, month: int, weekday: int) -> date:
    """First date in month whose weekday() == weekday (Mon=0..Sun=6)."""
    d = date(year, month, 1)
    return d + timedelta(days=(weekday - d.weekday()) % 7)


def _nth_business_day(year: int, month: int, n: int) -> date:
    """nth business day (Mon-Fri) of the month, n starting at 1."""
    d = date(year, month, 1)
    count = 0
    while True:
        if d.weekday() < 5:
            count += 1
            if count == n:
                return d
        d += timedelta(days=1)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last_day = _calmod.monthrange(year, month)[1]
    d = date(year, month, last_day)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def _month_iter(start: date, end: date):
    """Yield (year, month) for every month touched by [start, end]."""
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m, y = 1, y + 1


def _prev_month_abbr(year: int, month: int) -> str:
    pm = month - 1 or 12
    py = year if month != 1 else year - 1
    return date(py, pm, 1).strftime("%b")


def _quarter_label(d: date) -> str:
    """Quarter being estimated by a GDP release on date d (data lags ~1 quarter)."""
    ref = d - timedelta(days=90)
    q = (ref.month - 1) // 3 + 1
    return f"Q{q} {ref.year}"


# ---------------------------------------------------------------------------
# Schedule builder.
# ---------------------------------------------------------------------------

def _build_events(today: date, win_start: date, win_end: date) -> list[dict]:
    raw: list[tuple[date, str, str, str]] = []  # (date, time_et, name, period)

    def add(d: date, time_et: str, name: str, period: str) -> None:
        if win_start <= d <= win_end:
            raw.append((d, time_et, name, period))

    for year, month in _month_iter(win_start, win_end):
        prev_abbr = _prev_month_abbr(year, month)
        cur_abbr = date(year, month, 1).strftime("%b")

        # ISM on the 1st / 3rd business day (10:00), reports prior month.
        add(_nth_business_day(year, month, 1), "10:00", "ISM Manufacturing PMI", prev_abbr)
        add(_nth_business_day(year, month, 3), "10:00", "ISM Services PMI", prev_abbr)

        # JOLTS - first business week, ~5th business day (10:00), lags one extra month.
        jolts_abbr = _prev_month_abbr(year, month - 1 or 12)
        add(_nth_business_day(year, month, 5), "10:00", "JOLTS Job Openings", jolts_abbr)

        # Employment report - first Friday (08:30), reports prior month.
        nfp_day = _first_weekday(year, month, 4)  # Friday
        add(nfp_day, "08:30", "Nonfarm Payrolls", prev_abbr)
        add(nfp_day, "08:30", "Unemployment Rate", prev_abbr)
        add(nfp_day, "08:30", "Avg Hourly Earnings MoM", prev_abbr)

        # Inflation - CPI ~12th, PPI ~13th (08:30), report prior month.
        add(date(year, month, 12), "08:30", "CPI MoM", prev_abbr)
        add(date(year, month, 12), "08:30", "Core CPI MoM", prev_abbr)
        add(date(year, month, 13), "08:30", "PPI MoM", prev_abbr)

        # Retail Sales ~16th (08:30).
        add(date(year, month, 16), "08:30", "Retail Sales MoM", prev_abbr)

        # Housing Starts + Building Permits ~18th (08:30).
        add(date(year, month, 18), "08:30", "Housing Starts", prev_abbr)
        add(date(year, month, 18), "08:30", "Building Permits", prev_abbr)

        # UMich prelim ~ second Friday (10:00), reports current month.
        add(_first_weekday(year, month, 4) + timedelta(days=7), "10:00", "UMich Sentiment", cur_abbr)

        # Durable Goods ~25th (08:30).
        add(date(year, month, 25), "08:30", "Durable Goods Orders", prev_abbr)

        # Consumer Confidence - last Tuesday (10:00), current month.
        add(_last_weekday(year, month, 1), "10:00", "Consumer Confidence", cur_abbr)

        # GDP + PCE near month-end (08:30). GDP on last Thursday, PCE last business day.
        gdp_day = _last_weekday(year, month, 3)  # Thursday
        add(gdp_day, "08:30", "GDP QoQ Ann.", _quarter_label(gdp_day))
        pce_day = _last_weekday(year, month, 4)  # Friday ~ Fed's preferred gauge day
        add(pce_day, "08:30", "Core PCE MoM", prev_abbr)
        add(pce_day, "08:30", "PCE MoM", prev_abbr)

    # Weekly Initial Jobless Claims - every Thursday (08:30).
    d = win_start
    while d <= win_end:
        if d.weekday() == 3:  # Thursday
            ref_sat = d - timedelta(days=5)
            period = f"Week of {ref_sat.strftime('%b')} {ref_sat.day}"
            add(d, "08:30", "Initial Jobless Claims", period)
        d += timedelta(days=1)

    # FOMC rate decisions (14:00).
    for fd in FOMC_DECISION_DATES:
        add(fd, "14:00", "FOMC Rate Decision", f"{fd.strftime('%b')} Meeting")

    # Materialize with values + importance.
    events: list[dict] = []
    for d, time_et, name, period in raw:
        iso = d.isoformat()
        is_past = d < today
        vals = _values(name, iso, is_past)
        importance = (
            "High" if name == "FOMC Rate Decision" else PROFILES[name]["importance"]
        )
        events.append({
            "date": iso,
            "time_et": time_et,
            "event": name,
            "period": period,
            "importance": importance,
            "consensus": vals["consensus"],
            "prior": vals["prior"],
            "actual": vals["actual"],
            "unit": vals["unit"],
        })

    events.sort(key=lambda e: (e["date"], e["time_et"], e["event"]))
    return events


def economic_calendar() -> dict:
    """US macroeconomic release schedule, trailing ~1wk through forward ~4wks.

    Returns a dict with keys:
      events           - flat list sorted by (date asc, time, event)
      by_day           - [{date, weekday, events:[...]}] day-grouped agenda
      next_high_impact - {event, date, time_et} for the next High release >= today
      data_mode        - "sample" (fully generated)
      as_of            - ISO-8601 Z timestamp
      source           - "generated-schedule"

    Never raises.
    """
    now = datetime.now(timezone.utc)
    as_of = now.isoformat()
    try:
        today = now.date()
        win_start = today - timedelta(days=TRAILING_DAYS)
        win_end = today + timedelta(days=FORWARD_DAYS)
        events = _build_events(today, win_start, win_end)

        # Day-grouped agenda.
        by_day: list[dict] = []
        seen: dict[str, dict] = {}
        for ev in events:
            grp = seen.get(ev["date"])
            if grp is None:
                grp = {
                    "date": ev["date"],
                    "weekday": datetime.fromisoformat(ev["date"]).strftime("%a"),
                    "events": [],
                }
                seen[ev["date"]] = grp
                by_day.append(grp)
            grp["events"].append(ev)

        # Next high-impact release on or after today.
        today_iso = today.isoformat()
        next_high = None
        for ev in events:
            if ev["importance"] == "High" and ev["date"] >= today_iso:
                next_high = {
                    "event": ev["event"],
                    "date": ev["date"],
                    "time_et": ev["time_et"],
                }
                break

        return {
            "events": events,
            "by_day": by_day,
            "next_high_impact": next_high,
            "data_mode": "sample",
            "as_of": as_of,
            "source": SOURCE,
        }
    except Exception:  # pragma: no cover - defensive; generated path should not fail
        log.exception("economic_calendar generation failed; returning minimal payload")
        return {
            "events": [],
            "by_day": [],
            "next_high_impact": None,
            "data_mode": "sample",
            "as_of": as_of,
            "source": SOURCE,
        }
