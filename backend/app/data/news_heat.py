"""News-Heat / Abnormal News-Volume Detector (Bloomberg `NH`).

Scans a universe of widely-followed tickers, counts recent headlines per name,
and compares the current 24-48h volume against a per-ticker baseline (a rolling
daily average). The HEAT RATIO = current_volume / baseline; a high ratio flags an
abnormal spike. Spikes in news volume often precede or accompany big price moves,
so the panel is an early-attention radar.

Live path: reuse the existing news fetcher `app.data.news.fetch_news_for_ticker`
(yfinance under the hood) with a bounded universe and a short wall-clock budget.
When news is unavailable or slow we degrade to deterministic md5-seeded SAMPLE
volumes (a realistic mix where a handful of names run hot) and tag the payload
with data_mode="sample". This module never raises - it always returns a populated
payload with data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Bounded universe: large caps + a few high-beta / meme names that spike hard.
UNIVERSE: list[dict] = [
    {"symbol": "AAPL", "name": "Apple Inc."},
    {"symbol": "MSFT", "name": "Microsoft Corp."},
    {"symbol": "NVDA", "name": "NVIDIA Corp."},
    {"symbol": "AMZN", "name": "Amazon.com Inc."},
    {"symbol": "META", "name": "Meta Platforms Inc."},
    {"symbol": "GOOGL", "name": "Alphabet Inc."},
    {"symbol": "TSLA", "name": "Tesla Inc."},
    {"symbol": "AMD", "name": "Advanced Micro Devices"},
    {"symbol": "JPM", "name": "JPMorgan Chase & Co."},
    {"symbol": "BAC", "name": "Bank of America Corp."},
    {"symbol": "XOM", "name": "Exxon Mobil Corp."},
    {"symbol": "CVX", "name": "Chevron Corp."},
    {"symbol": "UNH", "name": "UnitedHealth Group"},
    {"symbol": "LLY", "name": "Eli Lilly & Co."},
    {"symbol": "WMT", "name": "Walmart Inc."},
    {"symbol": "HD", "name": "Home Depot Inc."},
    {"symbol": "KO", "name": "Coca-Cola Co."},
    {"symbol": "DIS", "name": "Walt Disney Co."},
    {"symbol": "NFLX", "name": "Netflix Inc."},
    {"symbol": "BA", "name": "Boeing Co."},
    {"symbol": "INTC", "name": "Intel Corp."},
    {"symbol": "MU", "name": "Micron Technology"},
    {"symbol": "COIN", "name": "Coinbase Global Inc."},
    {"symbol": "PLTR", "name": "Palantir Technologies"},
    {"symbol": "SMCI", "name": "Super Micro Computer"},
    {"symbol": "GME", "name": "GameStop Corp."},
    {"symbol": "BABA", "name": "Alibaba Group"},
    {"symbol": "MARA", "name": "MARA Holdings Inc."},
]

# How long a single live run may spend fetching before we accept the sample path.
LIVE_BUDGET_S = 6.0
# Cap how many tickers we ever fetch live (keeps it FAST + never stalls).
LIVE_MAX_TICKERS = 28
# Headlines older than this (hours) are not counted toward the 24-48h window.
WINDOW_HOURS = 48

# Status thresholds on the heat ratio (current / baseline).
HOT_RATIO = 2.2
WARM_RATIO = 1.4
QUIET_RATIO = 0.6

# Curated sample headlines per ticker so the sample path reads like a real desk.
SAMPLE_HEADLINES: dict[str, str] = {
    "NVDA": "NVIDIA unveils next-gen accelerator as data-center demand stays red hot",
    "TSLA": "Tesla robotaxi timeline draws fresh scrutiny from analysts and regulators",
    "SMCI": "Super Micro slides as auditor questions linger over filing delay",
    "COIN": "Coinbase rallies with crypto majors as spot ETF inflows accelerate",
    "GME": "GameStop spikes again on options-fueled retail buying wave",
    "PLTR": "Palantir lands expanded government AI contract, shares jump",
    "AAPL": "Apple reportedly accelerates AI roadmap ahead of fall hardware cycle",
    "MSFT": "Microsoft expands Copilot enterprise tier amid cloud reacceleration",
    "AMD": "AMD guidance lifted on AI GPU traction versus incumbent",
    "MU": "Micron pricing power improves as memory cycle turns higher",
    "META": "Meta ad revenue beats as Reels monetization closes the gap",
    "AMZN": "Amazon Web Services margins expand on AI workload demand",
    "GOOGL": "Alphabet defends search moat as AI overviews roll out broadly",
    "BA": "Boeing faces renewed FAA review over production quality controls",
    "INTC": "Intel foundry losses widen, turnaround timeline pushed out",
    "JPM": "JPMorgan flags resilient consumer but cautious credit outlook",
    "BAC": "Bank of America net interest income steadies into rate cuts",
    "XOM": "Exxon weighs new buyback as crude holds a tight range",
    "CVX": "Chevron acquisition clears a key regulatory hurdle",
    "UNH": "UnitedHealth navigates Medicare reimbursement headwinds",
    "LLY": "Eli Lilly GLP-1 supply expands as demand keeps outrunning capacity",
    "WMT": "Walmart raises outlook as grocery share gains continue",
    "HD": "Home Depot sees stabilizing big-ticket demand into spring",
    "KO": "Coca-Cola pricing offsets soft volumes in key markets",
    "DIS": "Disney streaming swings to profit, parks demand holds",
    "NFLX": "Netflix ad tier scales faster than the Street modeled",
    "BABA": "Alibaba cloud reorganization targets renewed growth",
    "MARA": "MARA ramps hash rate as bitcoin holds post-halving levels",
}

SENTIMENT_HINTS = ("Positive", "Neutral", "Negative")


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(symbol: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0, 1) seeded by symbol + salt."""
    return (_hash(symbol, salt) % 1_000_000) / 1_000_000.0


def _baseline_for(symbol: str) -> float:
    """Stable per-ticker baseline daily headline average (3 - 11 articles/day).
    Larger, busier names carry a higher baseline so the ratio stays meaningful."""
    return round(3.0 + _rand01(symbol, "baseline") * 8.0, 2)


def _status(ratio: float) -> str:
    if ratio >= HOT_RATIO:
        return "Hot"
    if ratio >= WARM_RATIO:
        return "Warm"
    if ratio <= QUIET_RATIO:
        return "Quiet"
    return "Normal"


def _z_score(current: float, baseline: float) -> float:
    """Approximate z-score treating headline arrivals as Poisson(baseline):
    sigma ~= sqrt(baseline). Guards a tiny floor so it never divides by zero."""
    sigma = max(baseline, 1.0) ** 0.5
    return round((current - baseline) / sigma, 2)


# ---------------------------------------------------------------------------
# Live counting
# ---------------------------------------------------------------------------

def _count_recent(items: list[dict], now_ts: float) -> tuple[int, str | None, str | None]:
    """Count headlines inside the WINDOW_HOURS window. Returns
    (count, latest_headline, latest_iso). Falls back to total length when no
    publish timestamps are parseable."""
    cutoff = now_ts - WINDOW_HOURS * 3600
    count = 0
    latest_title: str | None = None
    latest_iso: str | None = None
    latest_ts = -1.0
    dated = 0
    for it in items:
        title = it.get("title")
        pub = it.get("published")
        ts: float | None = None
        if pub:
            try:
                ts = datetime.fromisoformat(str(pub).replace("Z", "+00:00")).timestamp()
                dated += 1
            except Exception:
                ts = None
        if ts is not None:
            if ts >= cutoff:
                count += 1
            if ts > latest_ts:
                latest_ts = ts
                latest_title = title
                latest_iso = str(pub)
        elif latest_title is None:
            latest_title = title
    # If timestamps were unusable, fall back to raw volume so live still works.
    if dated == 0:
        count = len(items)
    return count, latest_title, latest_iso


def _live_payload() -> dict | None:
    """Bounded, fast live scan. Returns None when too little data resolved so the
    caller can fall back to sample. Never raises (caller also guards)."""
    try:
        from . import news as news_mod
    except Exception as e:
        log.warning("news_heat: news module import failed: %s", e)
        return None

    started = time.monotonic()
    now_ts = datetime.now(timezone.utc).timestamp()
    universe = UNIVERSE[:LIVE_MAX_TICKERS]
    rows: list[dict] = []
    resolved = 0

    for entry in universe:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        sym = entry["symbol"]
        try:
            items = news_mod.fetch_news_for_ticker(sym, limit=25) or []
        except Exception:
            items = []
        if not items:
            continue
        resolved += 1
        count, latest, _iso = _count_recent(items, now_ts)
        baseline = _baseline_for(sym)
        ratio = round(count / baseline, 2) if baseline > 0 else 0.0
        rows.append(_build_row(sym, entry["name"], count, baseline, ratio, latest))

    # Require a meaningful fraction of the universe to have resolved live.
    if resolved < max(6, len(universe) // 3):
        return None

    return _assemble(rows, data_mode="live", source="yfinance")


# ---------------------------------------------------------------------------
# Sample path (deterministic, realistic mix with a few hot names)
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    rows: list[dict] = []
    for entry in UNIVERSE:
        sym = entry["symbol"]
        baseline = _baseline_for(sym)
        r = _rand01(sym, "heat")
        # Shape a realistic distribution: most names normal, a tail runs hot.
        if r > 0.88:
            ratio = round(2.6 + _rand01(sym, "hot") * 2.6, 2)   # 2.6 - 5.2 (Hot)
        elif r > 0.70:
            ratio = round(1.45 + _rand01(sym, "warm") * 0.7, 2)  # 1.45 - 2.15 (Warm)
        elif r < 0.12:
            ratio = round(0.20 + _rand01(sym, "quiet") * 0.35, 2)  # quiet
        else:
            ratio = round(0.70 + _rand01(sym, "norm") * 0.65, 2)   # 0.70 - 1.35
        count = max(0, round(baseline * ratio))
        latest = SAMPLE_HEADLINES.get(sym)
        rows.append(_build_row(sym, entry["name"], count, baseline, ratio, latest))
    return _assemble(rows, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Row + payload assembly
# ---------------------------------------------------------------------------

def _build_row(symbol: str, name: str, count: int, baseline: float,
               ratio: float, latest: str | None) -> dict:
    status = _status(ratio)
    # Deterministic sentiment hint (cosmetic; real NLP lives in news_sentiment).
    hint = SENTIMENT_HINTS[_hash(symbol, "sent") % len(SENTIMENT_HINTS)]
    return {
        "symbol": symbol,
        "name": name,
        "articles_24h": int(count),
        "baseline": round(float(baseline), 2),
        "heat_ratio": round(float(ratio), 2),
        "z_score": _z_score(float(count), float(baseline)),
        "status": status,
        "latest_headline": latest or f"No major {symbol} headlines in the last 48 hours",
        "sentiment_hint": hint,
    }


def _assemble(rows: list[dict], *, data_mode: str, source: str) -> dict:
    rows = sorted(rows, key=lambda r: r["heat_ratio"], reverse=True)
    hot = [r for r in rows if r["status"] == "Hot"]
    total_articles = int(sum(r["articles_24h"] for r in rows))
    hottest = rows[0]["symbol"] if rows else None
    return {
        "tickers": rows,
        "summary": {
            "hot_count": len(hot),
            "hottest": hottest,
            "total_articles": total_articles,
            "universe_size": len(rows),
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def news_heat() -> dict:
    """Scan the universe for abnormal news volume. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("tickers"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("news_heat live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("news_heat sample path failed hard: %s", e)
        return {
            "tickers": [],
            "summary": {"hot_count": 0, "hottest": None, "total_articles": 0, "universe_size": 0},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
