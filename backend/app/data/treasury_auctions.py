"""Treasury Auction Calendar & Results (Bloomberg-style auction monitor).

Live path: the FREE U.S. Treasury Fiscal Data "auctions_query" endpoint, which
returns recent Bill/Note/Bond/TIPS/FRN auction records (stop yields, bid-to-cover,
offering + accepted amounts, coupons). When that feed is unavailable we degrade to
rich, deterministic SAMPLE auctions seeded with hashlib.md5 so the panel is always
fully populated for screenshots. This module never raises - it always returns a
populated dict tagged with data_mode / as_of / source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger(__name__)

FISCAL_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/"
    "accounting/od/auctions_query?sort=-auction_date&page[size]=60"
)
HTTP_TIMEOUT = 6.0

# Security types we recognize from the feed (others pass through verbatim).
KNOWN_TYPES = ("Bill", "Note", "Bond", "TIPS", "FRN", "CMB")


# ---------------------------------------------------------------------------
# SAMPLE data - deterministic synthetic auction tape. Realistic terms + a stop
# yield band per tenor; bid-to-cover + amounts seeded per (type, term, date).
# ---------------------------------------------------------------------------

# (security_type, term, approx stop yield %, coupon %, offering $B)
SAMPLE_TENORS: list[tuple[str, str, float, float | None, float]] = [
    ("Bill", "4-Week", 4.31, None, 80.0),
    ("Bill", "8-Week", 4.30, None, 75.0),
    ("Bill", "13-Week", 4.27, None, 81.0),
    ("Bill", "17-Week", 4.24, None, 60.0),
    ("Bill", "26-Week", 4.16, None, 72.0),
    ("Bill", "52-Week", 3.98, None, 46.0),
    ("Note", "2-Year", 3.84, 3.75, 69.0),
    ("Note", "3-Year", 3.81, 3.75, 58.0),
    ("Note", "5-Year", 3.92, 3.875, 70.0),
    ("Note", "7-Year", 4.07, 4.0, 44.0),
    ("Note", "10-Year", 4.27, 4.25, 39.0),
    ("Bond", "20-Year", 4.68, 4.625, 16.0),
    ("Bond", "30-Year", 4.49, 4.5, 22.0),
    ("TIPS", "5-Year", 1.62, 1.625, 21.0),
    ("TIPS", "10-Year", 2.04, 2.0, 18.0),
    ("TIPS", "30-Year", 2.31, 2.25, 8.0),
    ("FRN", "2-Year", 4.29, None, 28.0),
]

# Forward issuance schedule (upcoming auctions): (type, term, days_from_today, offering $B)
SAMPLE_UPCOMING: list[tuple[str, str, int, float]] = [
    ("Bill", "13-Week", 2, 81.0),
    ("Bill", "26-Week", 2, 72.0),
    ("Note", "2-Year", 3, 69.0),
    ("Note", "5-Year", 4, 70.0),
    ("Note", "7-Year", 5, 44.0),
    ("Bond", "30-Year", 8, 22.0),
    ("TIPS", "10-Year", 9, 18.0),
]


def _seed(*parts: str) -> int:
    return int(hashlib.md5("|".join(parts).encode()).hexdigest()[:8], 16)


def _jitter(seed: int, lo: float, hi: float) -> float:
    """Deterministic value in [lo, hi] from an integer seed."""
    frac = (seed % 10_000) / 10_000.0
    return lo + (hi - lo) * frac


def _prev_business_days(n: int) -> list[str]:
    """The last `n` weekday dates ending today, oldest first."""
    out: list[str] = []
    d = date.today()
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return list(reversed(out))


def _term_to_days(term: str) -> int:
    """Best-effort tenor -> days for maturity math on sample rows."""
    t = term.lower()
    try:
        num = float("".join(ch for ch in t.split("-")[0] if ch.isdigit() or ch == "."))
    except ValueError:
        num = 1.0
    if "week" in t:
        return int(num * 7)
    if "month" in t:
        return int(num * 30)
    if "year" in t:
        return int(num * 365)
    return 30


# ---------------------------------------------------------------------------
# Live fetch + normalization
# ---------------------------------------------------------------------------

def _to_float(val) -> float | None:
    if val is None or val == "" or val == "null":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _norm_type(raw: str) -> str:
    if not raw:
        return "Other"
    for t in KNOWN_TYPES:
        if raw.strip().lower() == t.lower():
            return t
    return raw.strip().title()


def _normalize_record(rec: dict) -> dict | None:
    """Map a raw Fiscal Data auction record to our flat schema. Never raises."""
    try:
        sec_type = _norm_type(rec.get("security_type", ""))
        term = (rec.get("security_term") or "").strip() or None
        orig_term = (rec.get("original_security_term") or "").strip() or term
        auction_date = (rec.get("auction_date") or "").strip() or None
        if not auction_date:
            return None
        issue_date = (rec.get("issue_date") or "").strip() or None
        maturity_date = (rec.get("maturity_date") or "").strip() or None

        # High rate: prefer yield, then investment rate, then discount rate.
        high_rate = _to_float(rec.get("high_yield"))
        if high_rate is None:
            high_rate = _to_float(rec.get("high_investment_rate"))
        if high_rate is None:
            high_rate = _to_float(rec.get("high_discount_rate"))

        btc = _to_float(rec.get("bid_to_cover_ratio"))
        offering = _to_float(rec.get("offering_amt"))
        accepted = _to_float(rec.get("total_accepted"))
        coupon = _to_float(rec.get("interest_rate"))

        return {
            "security_type": sec_type,
            "term": term,
            "original_term": orig_term,
            "auction_date": auction_date,
            "issue_date": issue_date,
            "maturity_date": maturity_date,
            "high_rate": round(high_rate, 3) if high_rate is not None else None,
            "bid_to_cover": round(btc, 2) if btc is not None else None,
            "offering_amt_b": round(offering / 1e9, 2) if offering is not None else None,
            "accepted_amt_b": round(accepted / 1e9, 2) if accepted is not None else None,
            "coupon": round(coupon, 3) if coupon is not None else None,
        }
    except Exception:
        return None


def _fetch_live() -> list[dict]:
    """Hit the Fiscal Data auctions endpoint once. Returns normalized rows or []."""
    import httpx

    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        resp = client.get(FISCAL_URL)
        resp.raise_for_status()
        body = resp.json()
    raw = body.get("data") or []
    rows = [r for r in (_normalize_record(rec) for rec in raw) if r is not None]
    return rows


# ---------------------------------------------------------------------------
# Sample construction
# ---------------------------------------------------------------------------

def _sample_rows() -> list[dict]:
    """Deterministic recent auction tape across all tenors over recent weeks."""
    rows: list[dict] = []
    # Spread the tenor list across the last ~25 business days for a realistic tape.
    biz = _prev_business_days(25)
    for i, (sec_type, term, base_yld, coupon, offering) in enumerate(SAMPLE_TENORS):
        adate = biz[-(1 + (i % len(biz)))]
        seed = _seed(sec_type, term, adate)
        high_rate = round(base_yld + _jitter(seed, -0.06, 0.06), 3)
        btc = round(_jitter(_seed("btc", term, adate), 2.10, 2.95), 2)
        accepted = round(offering * _jitter(_seed("acc", term, adate), 0.96, 1.0), 2)
        a = date.fromisoformat(adate)
        issue = (a + timedelta(days=2)).isoformat()
        maturity = (a + timedelta(days=_term_to_days(term))).isoformat()
        rows.append({
            "security_type": sec_type,
            "term": term,
            "original_term": term,
            "auction_date": adate,
            "issue_date": issue,
            "maturity_date": maturity,
            "high_rate": high_rate,
            "bid_to_cover": btc,
            "offering_amt_b": round(offering, 2),
            "accepted_amt_b": accepted,
            "coupon": coupon,
        })
    return rows


def _sample_upcoming() -> list[dict]:
    rows: list[dict] = []
    today = date.today()
    for sec_type, term, offset, offering in SAMPLE_UPCOMING:
        adate = today + timedelta(days=offset)
        # skip weekends forward
        while adate.weekday() >= 5:
            adate += timedelta(days=1)
        issue = adate + timedelta(days=2)
        maturity = adate + timedelta(days=_term_to_days(term))
        rows.append({
            "security_type": sec_type,
            "term": term,
            "original_term": term,
            "auction_date": adate.isoformat(),
            "issue_date": issue.isoformat(),
            "maturity_date": maturity.isoformat(),
            "high_rate": None,
            "bid_to_cover": None,
            "offering_amt_b": round(offering, 2),
            "accepted_amt_b": None,
            "coupon": None,
        })
    rows.sort(key=lambda r: r["auction_date"])
    return rows


# ---------------------------------------------------------------------------
# Summary + assembly
# ---------------------------------------------------------------------------

def _stop_for(rows: list[dict], type_match: tuple[str, ...], original_term: str) -> float | None:
    """Latest high_rate for a given on-the-run tenor (rows sorted desc already).

    Matches on original_security_term so reopenings (e.g. a 10-Year note that
    auctions as "9-Year 11-Month") still resolve to the right benchmark tenor.
    """
    for r in rows:
        ot = r.get("original_term") or r.get("term") or ""
        if r["security_type"] in type_match and ot == original_term:
            if r.get("high_rate") is not None:
                return r["high_rate"]
    return None


def _build_summary(recent: list[dict]) -> dict:
    btcs = [r["bid_to_cover"] for r in recent if r.get("bid_to_cover") is not None]
    avg_btc = round(sum(btcs) / len(btcs), 2) if btcs else None

    counts: dict[str, int] = {}
    for r in recent:
        counts[r["security_type"]] = counts.get(r["security_type"], 0) + 1

    return {
        "latest_2y_stop": _stop_for(recent, ("Note",), "2-Year"),
        "latest_10y_stop": _stop_for(recent, ("Note",), "10-Year"),
        "latest_30y_stop": _stop_for(recent, ("Bond",), "30-Year"),
        "avg_bid_to_cover": avg_btc,
        "count_by_type": counts,
        "recent_count": len(recent),
    }


def _assemble(rows: list[dict], upcoming: list[dict], *, data_mode: str, source: str) -> dict:
    # Sort by auction_date desc.
    rows = sorted(rows, key=lambda r: r.get("auction_date") or "", reverse=True)
    today = date.today().isoformat()

    # Split: anything not yet issued (issue_date >= today) is upcoming.
    derived_upcoming: list[dict] = []
    recent: list[dict] = []
    for r in rows:
        issue = r.get("issue_date")
        if issue and issue >= today and r.get("high_rate") is None:
            derived_upcoming.append(r)
        else:
            recent.append(r)

    # Prefer an explicit upcoming schedule when provided; otherwise use derived.
    all_upcoming = (upcoming or []) + derived_upcoming
    # de-dupe by (type, term, auction_date)
    seen = set()
    deduped_upcoming = []
    for r in all_upcoming:
        key = (r["security_type"], r.get("term"), r["auction_date"])
        if key in seen:
            continue
        seen.add(key)
        deduped_upcoming.append(r)
    deduped_upcoming.sort(key=lambda r: r["auction_date"])

    return {
        "recent": recent,
        "upcoming": deduped_upcoming,
        "summary": _build_summary(recent),
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def treasury_auctions() -> dict:
    """Return recent + upcoming Treasury auctions with a summary.

    Never raises. Tries the live Fiscal Data feed once; on any failure degrades
    to deterministic SAMPLE auctions tagged data_mode="sample".
    """
    try:
        rows = _fetch_live()
        if rows and len(rows) >= 5:
            # Real feed has no forward schedule; upcoming is derived purely from
            # records whose issue_date is still in the future (kept honest - no
            # synthetic rows mixed into the live tape).
            return _assemble(rows, [], data_mode="live",
                             source="treasury.fiscaldata")
    except Exception as e:
        log.warning("treasury_auctions live fetch failed, using sample: %s", e)

    try:
        return _assemble(_sample_rows(), _sample_upcoming(), data_mode="sample",
                         source="sample")
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("treasury_auctions sample build failed hard: %s", e)
        return {
            "recent": [],
            "upcoming": [],
            "summary": {
                "latest_2y_stop": None, "latest_10y_stop": None,
                "latest_30y_stop": None, "avg_bid_to_cover": None,
                "count_by_type": {}, "recent_count": 0,
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
