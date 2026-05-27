"""GDP nowcasting — Wave 5.

Two complementary nowcasts:

  1. **Atlanta Fed GDPNow** — scraped from the public Atlanta Fed page.
     This is the model-driven Q-over-Q SAAR estimate the financial press
     quotes. Updated several times per month as inputs flow in. No API key.

  2. **Internal composite** — equal-weighted Z-scores across the high-frequency
     activity indicators that move first when growth turns. Each Z-score is
     standardized over a 10y history and converted to a contribution to a
     0-centered growth pulse.

Components for the internal composite:
    - Nonfarm Payrolls 3m MA YoY change
    - Industrial Production YoY
    - Real Retail Sales YoY
    - ISM-proxy via new orders (AMTMNO YoY)
    - Initial Claims (inverted, 4w MA YoY)
    - Conference Board confidence proxy via UMCSENT
"""
from __future__ import annotations

import logging
import math
import re
from datetime import datetime

import httpx

from . import cache, macro_data

log = logging.getLogger(__name__)


ATLANTA_FED_URL = "https://www.atlantafed.org/cqer/research/gdpnow"
TTL = 60 * 60 * 4   # 4 hours — model updates roughly twice a week


def _z(values: list[float]) -> float | None:
    """Z-score of the LAST value vs the full history."""
    if len(values) < 24:
        return None
    mu = sum(values) / len(values)
    var = sum((v - mu) ** 2 for v in values) / len(values)
    sd = math.sqrt(var) if var > 0 else 1.0
    return (values[-1] - mu) / sd


def _yoy_pct(series: list[dict]) -> list[dict]:
    pts = [p for p in series if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 13:
        return []
    out: list[dict] = []
    for i in range(12, len(pts)):
        prev = pts[i - 12]["value"]
        cur = pts[i]["value"]
        if prev is None or prev == 0:
            continue
        out.append({"date": pts[i]["date"], "value": (cur / prev - 1.0) * 100.0})
    return out


def atlanta_fed_gdpnow() -> dict:
    """Scrape the Atlanta Fed GDPNow page. Cached for 4h."""
    cached = cache.get("nowcast:gdpnow")
    if cached is not None:
        return cached

    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as client:
            r = client.get(ATLANTA_FED_URL)
            r.raise_for_status()
            text = r.text
    except Exception as e:
        log.warning("Atlanta Fed scrape failed: %s", e)
        stale = cache.get_stale("nowcast:gdpnow")
        return stale if stale else {"value": None, "quarter": None, "source": "Atlanta Fed", "summary": "Unreachable"}

    # The page has line(s) like:
    #   "Latest estimate: 2.4 percent — December 19, 2025"
    # or  "The GDPNow model estimate for real GDP growth ... is 2.4 percent on December 19, 2025."
    val_match = re.search(
        r"(?:Latest estimate|GDPNow model estimate[^.]*?is)\s*[:\-]?\s*"
        r"(-?\d+\.\d+)\s*percent",
        text, re.IGNORECASE,
    )
    date_match = re.search(
        r"((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})",
        text,
    )

    value = float(val_match.group(1)) if val_match else None
    asof  = date_match.group(1) if date_match else None
    # Quarter guess: look near the value for "Q1 2026" or "fourth-quarter"
    q_match = re.search(r"\b(Q[1-4]\s+\d{4})\b", text)
    quarter = q_match.group(1) if q_match else None

    payload = {
        "value":   value,
        "asof":    asof,
        "quarter": quarter,
        "source":  "Atlanta Fed GDPNow",
        "url":     ATLANTA_FED_URL,
        "summary": (f"GDPNow estimates {value:.2f}% SAAR" if value is not None else "GDPNow unreachable"),
    }
    cache.set("nowcast:gdpnow", payload, TTL)
    return payload


def _component(series_id: str, *, transform: str = "yoy") -> dict:
    """Build one composite component: latest, history, z."""
    days = 365 * 12
    raw = macro_data.fetch_series(series_id, days=days)
    if transform == "yoy":
        series = _yoy_pct(raw)
    elif transform == "level":
        series = [p for p in raw if p["value"] is not None]
    elif transform == "yoy_inv":
        yoy = _yoy_pct(raw)
        series = [{"date": p["date"], "value": -p["value"]} for p in yoy]
    else:
        raise ValueError(f"unknown transform: {transform}")

    values = [p["value"] for p in series]
    z = _z(values)
    latest = series[-1] if series else None
    return {
        "series_id": series_id,
        "transform": transform,
        "latest":    latest["value"] if latest else None,
        "latest_date": latest["date"] if latest else None,
        "z":         None if z is None else round(z, 3),
        "history":   series[-(12 * 10):],
    }


def composite() -> dict:
    """Internal nowcast: equal-weight Z-scores of 6 high-frequency activity components."""
    components = [
        {"label": "Payrolls YoY (PAYEMS)",     **_component("PAYEMS", transform="yoy")},
        {"label": "Industrial Production YoY", **_component("INDPRO", transform="yoy")},
        {"label": "Real Retail Sales YoY",     **_component("RSAFS",  transform="yoy")},
        {"label": "Mfg New Orders YoY",        **_component("AMTMNO", transform="yoy")},
        {"label": "Initial Claims YoY (inv.)", **_component("ICSA",   transform="yoy_inv")},
        {"label": "U-Mich Sentiment YoY",      **_component("UMCSENT",transform="yoy")},
    ]
    zs = [c["z"] for c in components if c["z"] is not None]
    score = None if not zs else round(sum(zs) / len(zs), 3)

    summary = _composite_summary(score)
    return {
        "components": components,
        "composite_z": score,
        "summary":     summary,
    }


def _composite_summary(z: float | None) -> str:
    if z is None:
        return "Insufficient data."
    if z > 1.0:
        return f"Strong above-trend growth ({z:+.2f}σ)"
    if z > 0.3:
        return f"Moderate above-trend growth ({z:+.2f}σ)"
    if z > -0.3:
        return f"Trend growth ({z:+.2f}σ)"
    if z > -1.0:
        return f"Below-trend growth ({z:+.2f}σ)"
    return f"Recession-adjacent growth ({z:+.2f}σ)"


def dashboard() -> dict:
    return {
        "atlanta_fed": atlanta_fed_gdpnow(),
        "composite":   composite(),
    }
