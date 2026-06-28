"""Per-ticker NLP news sentiment scoring (Bloomberg NSTM).

Pulls recent headlines for a symbol (reusing the existing yfinance news
fetcher where possible) and scores each headline with a compact, inline
financial sentiment lexicon. No external NLP dependency (no nltk / vader);
the lexicon and negation handling live in this module.

Graceful degradation: every public path is wrapped in try/except and falls
back to deterministic, md5-seeded SAMPLE headlines so the function ALWAYS
returns a populated payload and NEVER raises.
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Inline financial sentiment lexicon
# --------------------------------------------------------------------------
POSITIVE_WORDS = {
    "beat", "beats", "surge", "surges", "surged", "upgrade", "upgrades",
    "upgraded", "record", "strong", "strength", "growth", "grows", "grew",
    "outperform", "outperforms", "rally", "rallies", "rallied", "bullish",
    "raises", "raised", "raise", "tops", "topped", "jumps", "jumped", "jump",
    "gains", "gained", "gain", "profit", "profits", "profitable", "expands",
    "expansion", "soar", "soars", "soared", "climb", "climbs", "climbed",
    "rebound", "rebounds", "rebounded", "boost", "boosts", "boosted",
    "wins", "win", "won", "approval", "approved", "breakthrough", "optimistic",
    "optimism", "accelerates", "accelerating", "robust", "exceeds", "exceeded",
    "momentum", "buyback", "buybacks", "dividend", "rises", "rose", "rise",
    "higher", "positive", "upbeat", "demand", "expanding", "leading", "leads",
    "milestone", "lucrative", "outpace", "outpaced", "secures", "secured",
}

NEGATIVE_WORDS = {
    "miss", "misses", "missed", "plunge", "plunges", "plunged", "downgrade",
    "downgrades", "downgraded", "weak", "weakness", "weakens", "decline",
    "declines", "declined", "lawsuit", "lawsuits", "probe", "probes",
    "investigation", "cuts", "cut", "slumps", "slump", "slumped", "falls",
    "fell", "fall", "loss", "losses", "bearish", "warns", "warn", "warned",
    "warning", "halts", "halt", "halted", "recall", "recalls", "recalled",
    "bankruptcy", "bankrupt", "layoffs", "layoff", "fraud", "default",
    "defaults", "drops", "dropped", "drop", "tumbles", "tumbled", "tumble",
    "sinks", "sank", "sink", "slides", "slid", "slide", "crash", "crashes",
    "crashed", "sued", "sues", "fine", "fined", "penalty", "delays", "delayed",
    "delay", "lower", "negative", "concern", "concerns", "risk", "risks",
    "shortfall", "disappoints", "disappointing", "selloff", "sell-off",
    "underperform", "underperforms", "scandal", "subpoena", "resigns",
    "resigned", "shutdown", "glut", "oversupply", "downturn", "slowdown",
    "struggles", "struggling", "pressured", "pressure", "headwinds",
}

# Words that flip the polarity of the following sentiment word.
NEGATORS = {"not", "no", "never", "without", "fails", "failed", "fail",
            "lacks", "lack", "isn't", "isnt", "won't", "wont", "doesn't",
            "doesnt", "didn't", "didnt", "less", "neither", "nor"}

_TOKEN_RE = re.compile(r"[a-z'\-]+")


def _classify_score(score: float) -> tuple[str, str]:
    """Map a [-1, 1] headline score to (label, tone)."""
    if score > 0.15:
        return "Bullish", "positive"
    if score < -0.15:
        return "Bearish", "negative"
    return "Neutral", "neutral"


def _score_text(text: str) -> float:
    """Score a headline (title + summary) to a value in [-1, 1].

    Simple lexicon hit-count with one-token-back negation flipping.
    """
    if not text:
        return 0.0
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        return 0.0

    pos = 0.0
    neg = 0.0
    for i, tok in enumerate(tokens):
        polarity = 0
        if tok in POSITIVE_WORDS:
            polarity = 1
        elif tok in NEGATIVE_WORDS:
            polarity = -1
        if polarity == 0:
            continue
        # Negation: look back up to 2 tokens for a negator.
        window = tokens[max(0, i - 2):i]
        if any(w in NEGATORS for w in window):
            polarity = -polarity
        if polarity > 0:
            pos += 1
        else:
            neg += 1

    total = pos + neg
    if total == 0:
        return 0.0
    raw = (pos - neg) / total
    # Soften single-hit headlines slightly so a lone word isn't a hard +/-1.
    if total == 1:
        raw *= 0.6
    return max(-1.0, min(1.0, raw))


# --------------------------------------------------------------------------
# Deterministic SAMPLE headlines
# --------------------------------------------------------------------------
_SAMPLE_TEMPLATES = [
    ("{sym} beats quarterly estimates as revenue surges to record high", "MarketWatch", "positive"),
    ("Analysts upgrade {sym} on strong demand and robust margin growth", "Barron's", "positive"),
    ("{sym} shares rally after company raises full-year guidance", "Reuters", "positive"),
    ("{sym} announces $10B buyback program, dividend boost", "Bloomberg", "positive"),
    ("{sym} stock climbs as new product launch tops expectations", "CNBC", "positive"),
    ("{sym} expands into new markets, momentum builds for next quarter", "Seeking Alpha", "positive"),
    ("{sym} holds steady ahead of earnings as investors weigh outlook", "Yahoo Finance", "neutral"),
    ("{sym} names new CFO in planned leadership transition", "Reuters", "neutral"),
    ("Wall Street mixed on {sym} as macro picture stays uncertain", "MarketWatch", "neutral"),
    ("{sym} misses revenue forecast, shares plunge in late trading", "Bloomberg", "negative"),
    ("Analysts downgrade {sym} citing weak demand and margin pressure", "Barron's", "negative"),
    ("{sym} faces regulatory probe, stock slides on the news", "Reuters", "negative"),
    ("{sym} warns of slowdown, announces layoffs amid cost cuts", "CNBC", "negative"),
    ("{sym} drops after lawsuit alleges accounting concerns", "Financial Times", "negative"),
]


def _seed_int(symbol: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{symbol}{salt}".encode()).hexdigest()[:8], 16)


def _sample_articles(symbol: str) -> list[dict]:
    """Deterministic, md5-seeded headline selection for a symbol."""
    sym = symbol.upper()
    seed = _seed_int(sym, "nstm")
    n = 8 + (seed % 4)  # 8..11 headlines
    now = datetime.now(timezone.utc)
    articles = []
    for i in range(n):
        idx = (seed >> (i % 8)) % len(_SAMPLE_TEMPLATES)
        title_t, publisher, _tone = _SAMPLE_TEMPLATES[idx]
        title = title_t.format(sym=sym)
        # Spread dates over the last ~10 days, deterministically.
        hours_back = ((seed >> i) % 240) + i * 4
        dt = now - timedelta(hours=hours_back)
        articles.append({
            "title": title,
            "summary": "",
            "publisher": publisher,
            "published": dt.isoformat(),
            "url": f"https://example.com/{sym.lower()}/news/{i}",
        })
    return articles


# --------------------------------------------------------------------------
# Live fetch (reuse existing news module, else yfinance directly)
# --------------------------------------------------------------------------
def _fetch_live(symbol: str) -> list[dict]:
    """Return normalized raw articles or [] on any failure."""
    # 1) Reuse the existing project news fetcher.
    try:
        from . import news as news_mod
        fn = getattr(news_mod, "fetch_news_for_ticker", None)
        if callable(fn):
            items = fn(symbol, limit=25) or []
            out = []
            for it in items:
                out.append({
                    "title": it.get("title") or "",
                    "summary": it.get("summary") or "",
                    "publisher": it.get("publisher") or "",
                    "published": it.get("published"),
                    "url": it.get("url") or "",
                })
            out = [a for a in out if a["title"]]
            if out:
                return out
    except Exception as e:  # noqa: BLE001
        log.warning("news_sentiment: project news fetch failed for %s: %s", symbol, e)

    # 2) Fall back to yfinance directly.
    try:
        import yfinance as yf
        raw = yf.Ticker(symbol).news or []
        out = []
        for r in raw:
            content = r.get("content") if isinstance(r.get("content"), dict) else r
            title = content.get("title") or r.get("title")
            if not title:
                continue
            prov = content.get("provider")
            publisher = prov.get("displayName") if isinstance(prov, dict) else (
                content.get("publisher") or r.get("publisher") or "")
            cu = content.get("canonicalUrl")
            url = cu.get("url") if isinstance(cu, dict) else (
                content.get("link") or r.get("link") or "")
            summary = content.get("summary") or r.get("summary") or ""
            published = None
            unix_t = r.get("providerPublishTime")
            if unix_t:
                try:
                    published = datetime.fromtimestamp(int(unix_t), tz=timezone.utc).isoformat()
                except Exception:
                    published = None
            if published is None:
                published = content.get("pubDate") or content.get("displayTime")
            out.append({
                "title": title,
                "summary": summary,
                "publisher": publisher,
                "published": published,
                "url": url,
            })
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("news_sentiment: yfinance news fetch failed for %s: %s", symbol, e)
        return []


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _parse_date(published) -> datetime:
    """Best-effort parse of an ISO-ish published value → aware UTC datetime."""
    if isinstance(published, datetime):
        dt = published
    elif isinstance(published, str) and published:
        s = published.strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(s)
        except Exception:
            try:
                dt = datetime.fromisoformat(s[:19])
            except Exception:
                dt = datetime.now(timezone.utc)
    else:
        dt = datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _build_trend(articles: list[dict]) -> list[dict]:
    """Rolling daily mean sentiment over the headline dates, oldest-first."""
    buckets: dict[str, list[float]] = {}
    for a in articles:
        day = _parse_date(a.get("published")).date().isoformat()
        buckets.setdefault(day, []).append(a["score"])
    trend = [
        {"date": day, "score": round(sum(v) / len(v) * 100.0, 1)}
        for day, v in buckets.items()
    ]
    trend.sort(key=lambda x: x["date"])
    return trend


# --------------------------------------------------------------------------
# Public entrypoint
# --------------------------------------------------------------------------
def news_sentiment(symbol: str) -> dict:
    """Score recent news headlines for `symbol`. Never raises."""
    sym = (symbol or "AAPL").upper().strip() or "AAPL"
    as_of = datetime.now(timezone.utc).isoformat()
    data_mode = "live"
    source = "yfinance news"

    try:
        raw = _fetch_live(sym)
        if not raw:
            raw = _sample_articles(sym)
            data_mode = "sample"
            source = "sample"

        articles: list[dict] = []
        pos_c = neg_c = neu_c = 0
        for a in raw:
            title = a.get("title") or ""
            text = (title + " " + (a.get("summary") or "")).strip()
            score = round(_score_text(text), 3)
            label, tone = _classify_score(score)
            if tone == "positive":
                pos_c += 1
            elif tone == "negative":
                neg_c += 1
            else:
                neu_c += 1
            dt = _parse_date(a.get("published"))
            articles.append({
                "title": title,
                "publisher": a.get("publisher") or "",
                "date": dt.isoformat(),
                "url": a.get("url") or "",
                "score": score,
                "tone": tone,
            })

        if not articles:
            # Defensive: should not happen given sample fallback above.
            raise ValueError("no articles after scoring")

        mean = sum(a["score"] for a in articles) / len(articles)
        sentiment_score = round(mean * 100.0, 1)
        overall_label, _ = _classify_score(mean)

        trend = _build_trend(articles)

        articles.sort(key=lambda x: x["date"], reverse=True)
        most_positive = max(articles, key=lambda x: x["score"])
        most_negative = min(articles, key=lambda x: x["score"])

        return {
            "symbol": sym,
            "sentiment_score": sentiment_score,
            "label": overall_label,
            "positive_count": pos_c,
            "negative_count": neg_c,
            "neutral_count": neu_c,
            "trend": trend,
            "articles": articles,
            "most_positive": most_positive,
            "most_negative": most_negative,
            "data_mode": data_mode,
            "as_of": as_of,
            "source": source,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("news_sentiment: full fallback for %s: %s", sym, e)
        # Last-resort deterministic sample so we never raise / return empty.
        raw = _sample_articles(sym)
        articles = []
        pos_c = neg_c = neu_c = 0
        for a in raw:
            score = round(_score_text(a["title"]), 3)
            label, tone = _classify_score(score)
            if tone == "positive":
                pos_c += 1
            elif tone == "negative":
                neg_c += 1
            else:
                neu_c += 1
            articles.append({
                "title": a["title"],
                "publisher": a["publisher"],
                "date": _parse_date(a["published"]).isoformat(),
                "url": a["url"],
                "score": score,
                "tone": tone,
            })
        mean = sum(x["score"] for x in articles) / len(articles) if articles else 0.0
        trend = _build_trend(articles)
        articles.sort(key=lambda x: x["date"], reverse=True)
        return {
            "symbol": sym,
            "sentiment_score": round(mean * 100.0, 1),
            "label": _classify_score(mean)[0],
            "positive_count": pos_c,
            "negative_count": neg_c,
            "neutral_count": neu_c,
            "trend": trend,
            "articles": articles,
            "most_positive": max(articles, key=lambda x: x["score"]) if articles else None,
            "most_negative": min(articles, key=lambda x: x["score"]) if articles else None,
            "data_mode": "sample",
            "as_of": as_of,
            "source": "sample",
        }
