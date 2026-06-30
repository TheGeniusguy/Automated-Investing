"""Insider cluster-buy signal -- Bloomberg ``INSI`` style Form-4 cluster detector.

Most insider feeds show one transaction at a time. The real conviction signal is a
*cluster*: several distinct insiders (and ideally a mix of C-suite + directors) buying
the same name on the open market inside a short window. Coordinated, dollar-weighted
buying like that has historically been the highest-signal slice of Form 4 flow.

This module groups recent OPEN-MARKET BUY transactions (Form 4 purchase code ``P`` --
option exercises / sells / awards excluded) by symbol within a rolling window, flags any
name with ``buyer_count >= 2``, and scores conviction from three legs:

  - buyer count (more independent insiders = stronger),
  - aggregate dollar value committed, and
  - a role weight (C-suite buying counts more than a 10% holder topping up).

Each cluster row carries the per-buyer detail so the panel can expand it. Rows are ranked
by conviction descending and capped at ~20.

Reused source
-------------
The transaction feed is the already-shipped market-wide Unusual Whales insider firehose,
``data/unusual_whales.fetch_market_insiders`` (the same feed powering the "Market
Insiders" panel). We do NOT build a new feed -- we take its normalized buy transactions
and cluster them. That function already degrades gracefully (no key / upstream failure ->
empty, ``degraded: true``, never raises), and we mirror its never-raises + data_mode /
as_of / source style here. When no live clusters are available we return a rich,
deterministic SAMPLE of plausible clusters so the panel always renders fully populated.

Smoke test:
    cd backend && .venv/bin/python -c "from app.data.insider_clusters import \
insider_clusters; d=insider_clusters(); print(d['data_mode'], len(d.get('clusters',[])), \
[(c['symbol'],c['buyer_count']) for c in d.get('clusters',[])[:5]])"
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

# Rolling window for what counts as a cluster, and the row cap.
WINDOW_DAYS = 30
MIN_BUYERS = 2
MAX_ROWS = 20


def _now_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _as_float(v) -> float:
    try:
        if v is None:
            return 0.0
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _parse_date(v) -> date | None:
    """Best-effort parse of the firehose date strings (ISO, with or without time)."""
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%m/%d/%Y"):
        try:
            return datetime.strptime(s[: len(fmt) + 4], fmt).date()
        except ValueError:
            continue
    # Last resort: take the leading YYYY-MM-DD.
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


# ── Role classification + weighting ──────────────────────────────────────────
# C-suite buying is the loudest signal, directors next, then officers / 10% holders.

def _classify_role(txn: dict) -> tuple[str, float]:
    """Return (role_label, role_weight) for one buy transaction."""
    title = (txn.get("insider_title") or "").strip()
    tl = title.lower()
    is_director = bool(txn.get("is_director"))
    is_officer = bool(txn.get("is_officer"))
    is_ten_pct = bool(txn.get("is_ten_pct"))

    csuite_terms = (
        "chief", "ceo", "cfo", "coo", "cto", "president", "chair", "chairman",
        "chairwoman", "managing director", "founder",
    )
    if any(term in tl for term in csuite_terms):
        return (title or "C-Suite", 3.0)
    if is_director or "director" in tl:
        return (title or "Director", 2.0)
    if is_officer or any(t in tl for t in ("vp", "vice president", "officer", "secretary", "treasurer")):
        return (title or "Officer", 1.5)
    if is_ten_pct or "10%" in tl or "ten percent" in tl:
        return (title or "10% Owner", 1.0)
    return (title or "Insider", 1.0)


def _conviction(buyer_count: int, total_value: float, role_weight: float,
                distinct_roles: int) -> float:
    """Blend buyer count + aggregate dollars + role weight into a 0-100 score.

    Deterministic and monotone in each leg: more buyers, more dollars, heavier
    roles and more role diversity all raise the score.
    """
    # Buyer count: 2 buyers -> ~30, saturates as the crowd grows.
    count_leg = min(buyer_count, 8) * 7.5
    # Dollar leg: $1M -> ~7, ~$25M saturates at 35 (log-ish via a soft cap).
    import math
    dollar_leg = min(35.0, 12.0 * math.log10(max(total_value, 1.0) / 1.0e5 + 1.0))
    # Role weight leg: C-suite-heavy clusters get a lift; diversity of roles adds a touch.
    role_leg = min(20.0, role_weight * 2.0) + min(6.0, (distinct_roles - 1) * 3.0)
    score = count_leg + dollar_leg + role_leg
    return round(max(0.0, min(100.0, score)), 1)


def _signal(score: float) -> str:
    if score >= 75:
        return "high_conviction"
    if score >= 55:
        return "strong"
    if score >= 40:
        return "notable"
    return "emerging"


# ── Clustering ───────────────────────────────────────────────────────────────

def _build_clusters(buys: list[dict], *, today: date) -> list[dict]:
    """Group open-market buys by symbol inside the rolling window and flag clusters."""
    cutoff = today - timedelta(days=WINDOW_DAYS)

    by_symbol: dict[str, list[dict]] = {}
    for t in buys:
        sym = (t.get("ticker") or t.get("symbol") or "").strip().upper()
        if not sym:
            continue
        d = _parse_date(t.get("txn_date") or t.get("filing_date"))
        # Keep undated rows (firehose is recent); drop anything clearly outside window.
        if d is not None and d < cutoff:
            continue
        value = _as_float(t.get("value"))
        if value <= 0:
            # Reconstruct from shares * price if value missing.
            value = _as_float(t.get("shares")) * _as_float(t.get("price"))
        by_symbol.setdefault(sym, []).append({**t, "_date": d, "_value": value})

    clusters: list[dict] = []
    for sym, rows in by_symbol.items():
        # Distinct insiders, keyed by name; merge same-name multi-buys, take largest title.
        buyers_by_name: dict[str, dict] = {}
        for r in rows:
            name = (r.get("insider_name") or "").strip() or "Unknown insider"
            role_label, role_weight = _classify_role(r)
            existing = buyers_by_name.get(name)
            if existing is None or role_weight > existing["role_weight"]:
                base = existing or {"value": 0.0, "company": r.get("company")}
                buyers_by_name[name] = {
                    "name": name,
                    "role": role_label,
                    "role_weight": role_weight,
                    "date": (r["_date"].isoformat() if r["_date"] else None),
                    "value": base["value"] + r["_value"],
                    "company": r.get("company") or base.get("company"),
                }
            else:
                existing["value"] += r["_value"]
                # Keep the earliest known buy date for the buyer.
                if r["_date"] and (existing["date"] is None or r["_date"].isoformat() < existing["date"]):
                    existing["date"] = r["_date"].isoformat()

        if len(buyers_by_name) < MIN_BUYERS:
            continue

        buyers = sorted(buyers_by_name.values(), key=lambda b: b["value"], reverse=True)
        total_value = round(sum(b["value"] for b in buyers), 2)
        role_weight = sum(b["role_weight"] for b in buyers)
        distinct_roles = len({b["role"] for b in buyers})
        dates = sorted([b["date"] for b in buyers if b["date"]])
        first_date = dates[0] if dates else None
        last_date = dates[-1] if dates else None
        score = _conviction(len(buyers), total_value, role_weight, distinct_roles)

        clusters.append({
            "symbol": sym,
            "company": buyers[0].get("company"),
            "buyer_count": len(buyers),
            "distinct_roles": distinct_roles,
            "total_dollar_value": total_value,
            "first_date": first_date,
            "last_date": last_date,
            "conviction_score": score,
            "signal": _signal(score),
            "buyers": [
                {"name": b["name"], "role": b["role"], "date": b["date"],
                 "value": round(b["value"], 2)}
                for b in buyers
            ],
        })

    clusters.sort(key=lambda c: (c["conviction_score"], c["total_dollar_value"]), reverse=True)
    return clusters[:MAX_ROWS]


def _summary(clusters: list[dict]) -> dict:
    if not clusters:
        return {
            "cluster_count": 0,
            "total_buyers": 0,
            "total_dollar_value": 0.0,
            "strongest": None,
        }
    top = clusters[0]
    return {
        "cluster_count": len(clusters),
        "total_buyers": sum(c["buyer_count"] for c in clusters),
        "total_dollar_value": round(sum(c["total_dollar_value"] for c in clusters), 2),
        "strongest": {
            "symbol": top["symbol"],
            "buyer_count": top["buyer_count"],
            "total_dollar_value": top["total_dollar_value"],
            "conviction_score": top["conviction_score"],
        },
    }


# ── Sample fallback ──────────────────────────────────────────────────────────
# Rich, deterministic, plausible small/mid-cap clusters so the panel renders fully
# populated when the firehose has no key / no data. Real-looking names + coherent dollars.

def _sample_clusters(today: date) -> list[dict]:
    d = today

    def iso(days_ago: int) -> str:
        return (d - timedelta(days=days_ago)).isoformat()

    raw: list[dict] = [
        {
            "symbol": "CRGY", "company": "Crescent Energy",
            "buyers": [
                {"name": "David C. Rockecharlie", "role": "CEO", "date": iso(3), "value": 1_480_000.0},
                {"name": "Brandi Kendall", "role": "CFO", "date": iso(3), "value": 612_000.0},
                {"name": "John C. Goff", "role": "Chairman", "date": iso(6), "value": 2_350_000.0},
                {"name": "Andrew L. Cozby", "role": "Director", "date": iso(8), "value": 188_000.0},
            ],
        },
        {
            "symbol": "MGEE", "company": "MGE Energy",
            "buyers": [
                {"name": "Jeffrey M. Keebler", "role": "President & CEO", "date": iso(5), "value": 845_000.0},
                {"name": "Charles Schrock", "role": "Director", "date": iso(7), "value": 410_000.0},
                {"name": "Lynn K. Hobbie", "role": "EVP", "date": iso(9), "value": 226_000.0},
            ],
        },
        {
            "symbol": "AVAV", "company": "AeroVironment",
            "buyers": [
                {"name": "Wahid Nawabi", "role": "Chairman & CEO", "date": iso(2), "value": 1_120_000.0},
                {"name": "Kevin P. McDonnell", "role": "CFO", "date": iso(4), "value": 305_000.0},
                {"name": "Catharine Merigold", "role": "Director", "date": iso(10), "value": 142_000.0},
            ],
        },
        {
            "symbol": "SFNC", "company": "Simmons First National",
            "buyers": [
                {"name": "George A. Makris Jr.", "role": "Chairman", "date": iso(4), "value": 720_000.0},
                {"name": "Jay D. Burchfield", "role": "Director", "date": iso(6), "value": 168_000.0},
                {"name": "Mark C. Saer", "role": "Director", "date": iso(11), "value": 96_000.0},
            ],
        },
        {
            "symbol": "PRGO", "company": "Perrigo",
            "buyers": [
                {"name": "Patrick Lockwood-Taylor", "role": "President & CEO", "date": iso(7), "value": 980_000.0},
                {"name": "Eric Scaff", "role": "CFO", "date": iso(9), "value": 247_000.0},
            ],
        },
        {
            "symbol": "CALX", "company": "Calix",
            "buyers": [
                {"name": "Carl Russo", "role": "Executive Chairman", "date": iso(8), "value": 540_000.0},
                {"name": "Cory Sindelar", "role": "CFO", "date": iso(8), "value": 168_000.0},
                {"name": "Kevin DeNuccio", "role": "Director", "date": iso(13), "value": 110_000.0},
            ],
        },
        {
            "symbol": "HAYW", "company": "Hayward Holdings",
            "buyers": [
                {"name": "Kevin Holleran", "role": "President & CEO", "date": iso(10), "value": 612_000.0},
                {"name": "Eifion Jones", "role": "CFO", "date": iso(12), "value": 184_000.0},
            ],
        },
        {
            "symbol": "BKU", "company": "BankUnited",
            "buyers": [
                {"name": "Rajinder P. Singh", "role": "Chairman & CEO", "date": iso(9), "value": 1_050_000.0},
                {"name": "Leslie N. Lunak", "role": "CFO", "date": iso(11), "value": 222_000.0},
                {"name": "Lynne Patterson", "role": "Director", "date": iso(15), "value": 88_000.0},
            ],
        },
        {
            "symbol": "KSS", "company": "Kohl's",
            "buyers": [
                {"name": "Ashley Buchanan", "role": "CEO", "date": iso(12), "value": 760_000.0},
                {"name": "Jill Timm", "role": "CFO", "date": iso(14), "value": 198_000.0},
            ],
        },
        {
            "symbol": "TALO", "company": "Talos Energy",
            "buyers": [
                {"name": "Joseph A. Mills", "role": "Interim CEO", "date": iso(13), "value": 430_000.0},
                {"name": "Sergio L. Maiworm", "role": "CFO", "date": iso(16), "value": 126_000.0},
                {"name": "Charles M. Sledge", "role": "Director", "date": iso(18), "value": 74_000.0},
            ],
        },
    ]

    clusters: list[dict] = []
    for item in raw:
        buyers_in = item["buyers"]
        buyers = []
        role_weight = 0.0
        for b in buyers_in:
            _, w = _classify_role({"insider_title": b["role"]})
            role_weight += w
            buyers.append({"name": b["name"], "role": b["role"], "date": b["date"],
                           "value": round(b["value"], 2)})
        buyers.sort(key=lambda x: x["value"], reverse=True)
        total_value = round(sum(b["value"] for b in buyers), 2)
        distinct_roles = len({b["role"] for b in buyers})
        dates = sorted(b["date"] for b in buyers)
        score = _conviction(len(buyers), total_value, role_weight, distinct_roles)
        clusters.append({
            "symbol": item["symbol"],
            "company": item["company"],
            "buyer_count": len(buyers),
            "distinct_roles": distinct_roles,
            "total_dollar_value": total_value,
            "first_date": dates[0],
            "last_date": dates[-1],
            "conviction_score": score,
            "signal": _signal(score),
            "buyers": buyers,
        })

    clusters.sort(key=lambda c: (c["conviction_score"], c["total_dollar_value"]), reverse=True)
    return clusters[:MAX_ROWS]


# ── Public entrypoint ────────────────────────────────────────────────────────

def insider_clusters() -> dict:
    """Detect insider cluster-buys from the shipped market insider firehose. Never raises."""
    today = datetime.now(timezone.utc).date()

    clusters: list[dict] = []
    live_used = False
    source = "sample"
    try:
        # Reuse the shipped Unusual Whales market-wide insider firehose; ask for buys.
        from .unusual_whales import fetch_market_insiders

        feed = fetch_market_insiders(limit=400, direction="buy")
        if isinstance(feed, dict) and not feed.get("degraded"):
            txns = feed.get("transactions") or []
            buys = [
                t for t in txns
                if isinstance(t, dict)
                and str(t.get("txn_code") or "").strip().upper() == "P"
                and (t.get("direction") in (None, "buy"))
            ]
            if buys:
                clusters = _build_clusters(buys, today=today)
                if clusters:
                    live_used = True
                    source = "unusual_whales"
    except Exception as e:  # never raise from a data fetcher
        log.warning("insider_clusters live path failed, using sample: %s", e)

    if not clusters:
        clusters = _sample_clusters(today)
        data_mode = "sample"
        source = "sample"
    else:
        # Live clusters present. We tag "mixed" only if we fell short of a useful board
        # and topped up with sample rows; here the live path stands alone -> "live".
        data_mode = "live" if live_used else "sample"

    return {
        "clusters": clusters,
        "summary": _summary(clusters),
        "window_days": WINDOW_DAYS,
        "min_buyers": MIN_BUYERS,
        "data_mode": data_mode,
        "as_of": _now_z(),
        "source": source,
    }
