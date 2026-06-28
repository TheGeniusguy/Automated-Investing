"""Fed Rate Path / WIRP - CME-FedWatch-style implied policy path.

Backs out the market-implied federal funds rate at each scheduled FOMC meeting
over the rolling 12 months, then buckets the implied move into a
{cut, hold, hike} probability ladder per meeting (the recognizable FedWatch
grid). Also reports the terminal rate and how many 25bp cuts are priced.

Data sourcing (graceful degradation is a hard contract - never raises):
  - Current target is anchored to FRED "DFEDTARU" (upper bound of the target
    range) via macro_data.fetch_series, fallback 5.50.
  - A live Fed Funds futures front contract ("ZQ=F") is attempted to anchor the
    near end of the strip; when present the path is tagged "mixed".
  - The full meeting strip is a deterministic seeded sample (stable screenshots)
    so the panel is always fully populated. All hardcoded numbers live in
    SAMPLE_* constants below.

Every payload carries data_mode ("live" | "sample" | "mixed"), as_of (ISO-8601 Z)
and source for honesty under the hood. No badge is rendered by the UI.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import calendar as econ_calendar
from .macro_data import fetch_arbitrary_ticker, fetch_series

log = logging.getLogger(__name__)

# Policy step size (25 basis points) and the fallback target upper bound.
STEP = 0.25
FALLBACK_TARGET_UPPER = 5.50
# Width of the target range -> mid is upper minus half the range.
TARGET_RANGE_WIDTH = 0.25

# Deterministic seed so the synthetic strip (and therefore screenshots) is stable.
SAMPLE_SEED = 20260628
# Total easing priced across the rolling 12 months, in rate points (100bps).
SAMPLE_TOTAL_CUT = 1.00
SAMPLE_SOURCE = "rate-path-sample"


# ---------------------------------------------------------------------------
# Core math
# ---------------------------------------------------------------------------

def implied_rate_from_future(price: float) -> float:
    """Implied average EFFR for the contract month: 100 - futures price.

    Fed Funds futures (ZQ) settle to 100 minus the average daily effective
    federal funds rate over the contract month.
    """
    try:
        return round(100.0 - float(price), 4)
    except Exception:
        return float("nan")


def step_probabilities(curr_mid: float, expected_rate: float, step: float = STEP) -> dict:
    """Three-bucket {cut, hold, hike} ladder for one meeting.

    Linear bracket: the distance between the anchor (curr_mid) and the
    meeting-implied rate (expected_rate), in units of one policy step, is split
    between "hold" and the directional bucket. A move of a full step (or more)
    in one direction puts all the mass in that direction; no move leaves it all
    in hold. Probabilities always sum to 1.
    """
    try:
        delta = float(expected_rate) - float(curr_mid)
    except Exception:
        delta = 0.0
    if step <= 0:
        step = STEP

    magnitude = min(abs(delta) / step, 1.0)  # clamp: a >1 step move is still one direction
    hold = 1.0 - magnitude
    hike = magnitude if delta > 0 else 0.0
    cut = magnitude if delta < 0 else 0.0

    # Normalize defensively (handles delta == 0 cleanly: hold = 1).
    total = hold + hike + cut
    if total <= 0:
        hold, hike, cut = 1.0, 0.0, 0.0
        total = 1.0
    return {
        "cut": round(cut / total, 4),
        "hold": round(hold / total, 4),
        "hike": round(hike / total, 4),
    }


def build_path(meetings: list, futures_strip: list, current_mid: float | None = None) -> dict:
    """Per-FOMC implied rate -> bucketed probabilities + summary.

    Args:
        meetings: list of FOMC decision dates (datetime.date) in chronological order.
        futures_strip: parallel list of meeting-implied target mid rates (floats),
            one per meeting (e.g. month-weighted blend of the bracketing ZQ
            contracts). Must be the same length as `meetings`.
        current_mid: the current target-range midpoint used as the anchor for the
            first meeting. Falls back to the first strip value when omitted.

    Returns:
        {implied_path: [{date, implied_rate, cut, hold, hike}], terminal_rate,
         cuts_priced_12m, current_mid}
    """
    n = min(len(meetings), len(futures_strip))
    if n == 0:
        return {
            "implied_path": [],
            "terminal_rate": round(float(current_mid or FALLBACK_TARGET_UPPER - TARGET_RANGE_WIDTH / 2), 4),
            "cuts_priced_12m": 0.0,
            "current_mid": round(float(current_mid or FALLBACK_TARGET_UPPER - TARGET_RANGE_WIDTH / 2), 4),
        }

    if current_mid is None:
        current_mid = float(futures_strip[0])
    current_mid = float(current_mid)

    implied_path: list[dict] = []
    anchor = current_mid
    for i in range(n):
        meeting = meetings[i]
        expected = float(futures_strip[i])
        probs = step_probabilities(anchor, expected, STEP)
        mdate = meeting.isoformat() if hasattr(meeting, "isoformat") else str(meeting)
        implied_path.append({
            "date": mdate,
            "implied_rate": round(expected, 4),
            "cut": probs["cut"],
            "hold": probs["hold"],
            "hike": probs["hike"],
        })
        # Next meeting is measured off this meeting's expected (cumulative path).
        anchor = expected

    terminal_rate = round(float(futures_strip[n - 1]), 4)
    # Positive => net cuts priced over the horizon, expressed in 25bp increments.
    cuts_priced_12m = round((current_mid - terminal_rate) / STEP, 2)
    return {
        "implied_path": implied_path,
        "terminal_rate": terminal_rate,
        "cuts_priced_12m": cuts_priced_12m,
        "current_mid": round(current_mid, 4),
    }


# ---------------------------------------------------------------------------
# Data assembly (current target, FOMC dates, futures strip)
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _current_target() -> tuple[float, float, str, str]:
    """Return (upper, mid, data_mode, source) for the current target range.

    Anchors to FRED DFEDTARU (upper bound). Falls back to FALLBACK_TARGET_UPPER.
    """
    upper = FALLBACK_TARGET_UPPER
    mode = "sample"
    source = "fallback-target"
    try:
        pts = fetch_series("DFEDTARU", days=14)
        vals = [p.get("value") for p in (pts or []) if p.get("value") is not None]
        if vals:
            upper = float(vals[-1])
            mode = "live"
            source = "fred:DFEDTARU"
    except Exception as e:  # never raise
        log.warning("rate_path: DFEDTARU fetch failed (%s) - using fallback", e)
    mid = upper - TARGET_RANGE_WIDTH / 2.0
    return round(upper, 4), round(mid, 4), mode, source


def _rolling_fomc_dates(months: int = 12) -> list:
    """Scheduled FOMC decision dates over the next `months`, chronologically.

    Pulls from calendar.FOMC_MEETINGS (decision = meeting end date).
    """
    today = date.today()
    horizon = today + timedelta(days=int(months * 30.5) + 1)
    out: list = []
    try:
        for year in range(today.year, horizon.year + 1):
            for _start, end in econ_calendar.FOMC_MEETINGS.get(year, []):
                if today <= end <= horizon:
                    out.append(end)
    except Exception as e:  # never raise
        log.warning("rate_path: FOMC date assembly failed (%s)", e)
    out.sort()
    return out


def _sample_strip(meetings: list, current_mid: float) -> list:
    """Deterministic seeded meeting-implied rate strip anchored to current_mid.

    A gently easing path (markets priced ~100bps of cuts over the horizon) with
    tiny jitter. Seeded so screenshots are stable.
    """
    n = len(meetings)
    if n == 0:
        return []
    rng = np.random.default_rng(SAMPLE_SEED)
    # Cumulative easing builds from 0 to SAMPLE_TOTAL_CUT across the horizon.
    cumulative = np.linspace(0.0, SAMPLE_TOTAL_CUT, n + 1)[1:]
    jitter = rng.normal(0.0, 0.02, n)
    strip = current_mid - cumulative + jitter
    # Keep monotone-ish and inside a sane band.
    strip = np.clip(strip, 0.25, current_mid + 0.25)
    return [round(float(x), 4) for x in strip]


def _live_front_anchor(strip: list, current_mid: float) -> tuple[list, bool]:
    """Best-effort: anchor the near end of the strip to the live ZQ front month.

    Returns (strip, used_live). Never raises.
    """
    if not strip:
        return strip, False
    try:
        pts = fetch_arbitrary_ticker("ZQ=F", 5)
        vals = [p.get("value") for p in (pts or []) if p.get("value") is not None]
        if not vals:
            return strip, False
        implied = implied_rate_from_future(vals[-1])
        if implied != implied or not (0.0 <= implied <= 10.0):  # NaN / out-of-range guard
            return strip, False
        # Sanity gate: the front month should reflect roughly the current target.
        # If it diverges by more than two steps (stale anchor / bad print), keep
        # the coherent sample path instead of producing an implausible jump.
        if abs(implied - current_mid) > 2 * STEP:
            return strip, False
        # Blend the live front implied rate into the first meeting, then let the
        # synthetic easing carry the tail relative to that anchor.
        adjusted = list(strip)
        delta = implied - adjusted[0]
        # Soft pull of the whole strip toward the live front (decaying weight).
        for i in range(len(adjusted)):
            w = max(0.0, 1.0 - i / max(1, len(adjusted)))
            adjusted[i] = round(adjusted[i] + delta * w, 4)
        return adjusted, True
    except Exception as e:  # never raise
        log.warning("rate_path: ZQ front anchor failed (%s)", e)
        return strip, False


def _assemble() -> dict:
    """Gather everything once: current target, meetings, strip, built path."""
    upper, mid, target_mode, target_source = _current_target()
    meetings = _rolling_fomc_dates(12)
    strip = _sample_strip(meetings, mid)
    strip, used_live = _live_front_anchor(strip, mid)

    if used_live and target_mode == "live":
        data_mode = "mixed"
        source = f"{target_source}+zq-front; strip:{SAMPLE_SOURCE}"
    elif used_live:
        data_mode = "mixed"
        source = f"zq-front; strip:{SAMPLE_SOURCE}"
    elif target_mode == "live":
        data_mode = "mixed"
        source = f"{target_source}; strip:{SAMPLE_SOURCE}"
    else:
        data_mode = "sample"
        source = SAMPLE_SOURCE

    built = build_path(meetings, strip, current_mid=mid)
    return {
        "built": built,
        "upper": upper,
        "mid": mid,
        "data_mode": data_mode,
        "source": source,
    }


# ---------------------------------------------------------------------------
# Module entrypoints
# ---------------------------------------------------------------------------

def rate_path() -> dict:
    """Implied policy path + summary cards. Never raises."""
    try:
        a = _assemble()
        built = a["built"]
        return {
            "implied_path": built["implied_path"],
            "terminal_rate": built["terminal_rate"],
            "cuts_priced": built["cuts_priced_12m"],
            "current_target": a["upper"],
            "data_mode": a["data_mode"],
            "as_of": _now_iso(),
            "source": a["source"],
        }
    except Exception as e:  # hard contract: never raise
        log.warning("rate_path() degraded fully (%s)", e)
        mid = FALLBACK_TARGET_UPPER - TARGET_RANGE_WIDTH / 2.0
        return {
            "implied_path": [],
            "terminal_rate": round(mid, 4),
            "cuts_priced": 0.0,
            "current_target": FALLBACK_TARGET_UPPER,
            "data_mode": "sample",
            "as_of": _now_iso(),
            "source": SAMPLE_SOURCE,
        }


def rate_probabilities() -> dict:
    """Per-meeting hold/hike/cut probability ladder. Never raises."""
    try:
        a = _assemble()
        built = a["built"]
        meetings = [
            {
                "date": row["date"],
                "hold": row["hold"],
                "hike": row["hike"],
                "cut": row["cut"],
                "implied_rate": row["implied_rate"],
            }
            for row in built["implied_path"]
        ]
        return {
            "meetings": meetings,
            "data_mode": a["data_mode"],
            "as_of": _now_iso(),
            "source": a["source"],
        }
    except Exception as e:  # hard contract: never raise
        log.warning("rate_probabilities() degraded fully (%s)", e)
        return {
            "meetings": [],
            "data_mode": "sample",
            "as_of": _now_iso(),
            "source": SAMPLE_SOURCE,
        }
