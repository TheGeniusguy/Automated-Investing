"""SEC EDGAR client — pulls filings for an equities watchlist.

EDGAR endpoints used:
  - company_tickers.json:        ticker → CIK mapping (refreshed ~daily by SEC)
  - submissions/CIK<10>.json:    recent filings for one company

EDGAR enforces a User-Agent on every request and a 10 req/sec global limit
per IP. We're nowhere near that ceiling — typical use is ~15 tickers × 1 call.

All responses are cached in the sqlite TTL store:
  - Ticker/CIK map: 24h (mapping itself changes slowly)
  - Submissions:    1h  (filings drop in real time but daily-grained is fine
                        for an intraday "tape" — clearing cache forces fresh)
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Iterable

import httpx

from ..config import settings
from . import cache

log = logging.getLogger(__name__)

EDGAR_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"

TICKERS_TTL = 60 * 60 * 24     # 24h
SUBMISSIONS_TTL = 60 * 60      # 1h


# Form-type metadata for the frontend. Order = display order in filters.
FORM_TYPES: dict[str, dict[str, str]] = {
    "8-K":      {"label": "Material event",        "color": "amber"},
    "10-K":     {"label": "Annual report",         "color": "blue"},
    "10-Q":     {"label": "Quarterly report",      "color": "blue"},
    "4":        {"label": "Insider transaction",   "color": "green"},
    "SC 13G":   {"label": "Beneficial ownership",  "color": "muted"},
    "SC 13D":   {"label": "Activist filing",       "color": "red"},
    "DEF 14A":  {"label": "Proxy statement",       "color": "muted"},
    "S-1":      {"label": "IPO registration",      "color": "green"},
    "13F-HR":   {"label": "Institutional holdings","color": "muted"},
}

DEFAULT_FORMS = list(FORM_TYPES.keys())


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept":     "application/json",
        # EDGAR is sensitive to encoding negotiation — keep it simple.
    }


# ---------- Ticker → CIK map ----------

def load_ticker_to_cik() -> dict[str, str]:
    """Return a mapping of UPPERCASE ticker → zero-padded 10-digit CIK."""
    cached = cache.get("sec:ticker_cik")
    if isinstance(cached, dict) and cached:
        return cached

    try:
        with httpx.Client(timeout=15.0, headers=_headers(), follow_redirects=True) as c:
            r = c.get(EDGAR_TICKERS_URL)
            r.raise_for_status()
            raw = r.json()
    except Exception as e:
        log.warning("EDGAR ticker map fetch failed: %s", e)
        stale = cache.get_stale("sec:ticker_cik")
        return stale if isinstance(stale, dict) else {}

    # company_tickers.json is keyed by integer string with shape
    #   { "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ... }
    out: dict[str, str] = {}
    for v in raw.values():
        ticker = (v.get("ticker") or "").upper()
        cik = v.get("cik_str")
        if not ticker or cik is None:
            continue
        out[ticker] = f"{int(cik):010d}"

    cache.set("sec:ticker_cik", out, TICKERS_TTL)
    return out


def resolve_ciks(tickers: list[str]) -> dict[str, str]:
    """Look up CIKs for a list of tickers. Unknown tickers are silently
    dropped — most of those are non-US (ETFs / futures / crypto) which don't
    file with the SEC."""
    mapping = load_ticker_to_cik()
    # EDGAR uses dot-style (BRK.B) where Yahoo uses dash (BRK-B). Try both.
    out: dict[str, str] = {}
    for t in tickers:
        u = t.upper().strip()
        if not u:
            continue
        cik = mapping.get(u) or mapping.get(u.replace("-", "."))
        if cik:
            out[u] = cik
    return out


# ---------- Filings fetcher ----------

def _filing_url(cik: str, accession_no_dashes: str, primary_document: str) -> str:
    # CIK without leading zeros in the path
    cik_int = str(int(cik))
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_no_dashes}/{primary_document}"


def fetch_filings_for_ticker(
    ticker: str,
    cik: str,
    *,
    days: int = 30,
    forms: list[str] | None = None,
    limit: int = 40,
) -> list[dict]:
    """Return recent filings for one company, newest-first."""
    cache_key = f"sec:sub:{cik}"
    payload = cache.get(cache_key)

    if payload is None:
        try:
            with httpx.Client(timeout=15.0, headers=_headers(), follow_redirects=True) as c:
                r = c.get(EDGAR_SUBMISSIONS_URL.format(cik=cik))
                r.raise_for_status()
                payload = r.json()
            cache.set(cache_key, payload, SUBMISSIONS_TTL)
        except Exception as e:
            log.warning("EDGAR submissions fetch failed for %s (CIK %s): %s", ticker, cik, e)
            stale = cache.get_stale(cache_key)
            if stale is None:
                return []
            payload = stale

    recent = (payload or {}).get("filings", {}).get("recent", {}) or {}
    accession   = recent.get("accessionNumber",   [])
    form        = recent.get("form",              [])
    filing_date = recent.get("filingDate",        [])
    primary_doc = recent.get("primaryDocument",   [])
    primary_desc = recent.get("primaryDocDescription", []) or [""] * len(accession)
    report_date = recent.get("reportDate",        []) or [""] * len(accession)
    items       = recent.get("items",             []) or [""] * len(accession)

    cutoff = (date.today() - timedelta(days=days)).isoformat()
    forms_filter = set(forms) if forms else None

    out: list[dict] = []
    for i, acc in enumerate(accession):
        f = form[i] if i < len(form) else ""
        fdate = filing_date[i] if i < len(filing_date) else ""
        if fdate < cutoff:
            continue
        if forms_filter and f not in forms_filter:
            continue
        acc_clean = acc.replace("-", "")
        doc = primary_doc[i] if i < len(primary_doc) else ""
        out.append({
            "ticker":        ticker,
            "cik":           cik,
            "accession":     acc,
            "form":          f,
            "filing_date":   fdate,
            "report_date":   report_date[i] if i < len(report_date) else "",
            "description":   primary_desc[i] if i < len(primary_desc) else "",
            "items":         items[i] if i < len(items) else "",
            "url":           _filing_url(cik, acc_clean, doc),
            "form_label":    FORM_TYPES.get(f, {}).get("label", ""),
        })
        if len(out) >= limit:
            break
    return out


def fetch_filings_batch(
    tickers: Iterable[str],
    *,
    days: int = 30,
    forms: list[str] | None = None,
    limit_per_ticker: int = 20,
    overall_limit: int = 200,
) -> dict:
    """Fetch filings across multiple tickers, sorted by filing_date desc."""
    tickers_list = [t.upper() for t in tickers if t.strip()]
    cik_map = resolve_ciks(tickers_list)

    all_filings: list[dict] = []
    unresolved: list[str] = [t for t in tickers_list if t not in cik_map]

    for ticker, cik in cik_map.items():
        try:
            all_filings.extend(
                fetch_filings_for_ticker(
                    ticker, cik,
                    days=days, forms=forms, limit=limit_per_ticker,
                )
            )
        except Exception as e:
            log.warning("filing fetch failed for %s: %s", ticker, e)

    all_filings.sort(key=lambda f: f["filing_date"], reverse=True)
    all_filings = all_filings[:overall_limit]

    return {
        "filings":    all_filings,
        "fetched_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "days":       days,
        "tickers":    tickers_list,
        "resolved":   list(cik_map.keys()),
        "unresolved": unresolved,
        "forms":      forms or list(FORM_TYPES.keys()),
        "form_meta":  FORM_TYPES,
    }
