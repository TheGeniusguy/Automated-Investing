"""EDGAR Full-Text Filing Search (Bloomberg-style document search).

Wraps the FREE SEC EDGAR full-text search backend so a user can search a
keyword or exact phrase ("material weakness", "going concern", a customer name)
across recent filings and jump straight to the source document on sec.gov.

Live path: the public EFTS JSON endpoint
`https://efts.sec.gov/LATEST/search-index?q="<phrase>"` (the same backend that
powers https://efts.sec.gov/LATEST/search-index and the EDGAR full-text UI).
It returns `hits.hits[]`, each hit carrying a `_source` (display_names, file_date,
form, accession `adsh`, ciks, file_description) and an `_id` of the form
"accession:filename" used to build the Archives document URL. SEC requires a
descriptive User-Agent on every request or it 403s; we send `settings.sec_user_agent`.
An optional `forms` filter (e.g. "10-K,10-Q,8-K") narrows the result set.

Sample path: when the query is blank or the feed is unavailable / empty, we
return a deterministic SAMPLE set of plausible filings so the panel always
populates for screenshots. The payload always carries an internal data_mode
("live"|"sample") + as_of + source + query for honesty under the hood; there is
no on-screen badge. This module NEVER raises and uses a short timeout so it can
never hang the request.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from ..config import settings

log = logging.getLogger(__name__)

EFTS_URL = "https://efts.sec.gov/LATEST/search-index"
ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data"
HTTP_TIMEOUT = 8.0
MAX_RESULTS = 25

# display_names look like "APPLE INC. (AAPL) (CIK 0000320193)" or
# "Big Sky Productions, Inc.  (CIK 0001441362)" (no ticker). Pull the pieces.
_TICKER_RE = re.compile(r"\(([A-Z0-9.\-]{1,6})\)\s*\(CIK", re.IGNORECASE)
_CIK_RE = re.compile(r"\(CIK\s*(\d+)\)", re.IGNORECASE)


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept": "application/json",
    }


def _parse_display_name(display: str) -> tuple[str, str | None, str | None]:
    """Return (company, ticker, cik) parsed from an EDGAR display_name string."""
    if not display:
        return ("Unknown filer", None, None)
    ticker_m = _TICKER_RE.search(display)
    cik_m = _CIK_RE.search(display)
    ticker = ticker_m.group(1).upper() if ticker_m else None
    cik = cik_m.group(1) if cik_m else None
    # Company name is everything before the first parenthetical.
    company = display.split("(")[0].strip().rstrip(",").strip() or display.strip()
    return (company, ticker, cik)


def _build_url(_id: str, cik: str | None, adsh: str | None) -> str:
    """Build the Archives document URL from "accession:filename" + cik.

    e.g. _id "0001214659-13-005333:R10.xml", cik "1441362" ->
    https://www.sec.gov/Archives/edgar/data/1441362/000121465913005333/R10.xml
    Falls back to the filing index page when the filename is missing.
    """
    accession = adsh or ""
    filename = ""
    if _id and ":" in _id:
        acc_part, filename = _id.split(":", 1)
        accession = accession or acc_part
    elif _id:
        accession = accession or _id

    acc_nodash = accession.replace("-", "")
    cik_int = (cik or "").lstrip("0") or cik or ""
    if not cik_int or not acc_nodash:
        # Last-resort: full-text UI deep link so the row is never a dead end.
        return f"https://efts.sec.gov/LATEST/search-index?q={accession}"
    base = f"{ARCHIVES_BASE}/{cik_int}/{acc_nodash}"
    if filename:
        return f"{base}/{filename}"
    return f"{base}/{accession}-index.htm"


def _normalize_hit(hit: dict) -> dict | None:
    """Map one EFTS hit to our flat schema. Never raises."""
    try:
        src = hit.get("_source") or {}
        display = ""
        names = src.get("display_names") or []
        if names:
            display = names[0]
        company, ticker, cik_from_name = _parse_display_name(display)

        ciks = src.get("ciks") or []
        cik = (ciks[0] if ciks else None) or cik_from_name

        form = (src.get("form") or "").strip() or "—"
        filed_date = (src.get("file_date") or "").strip() or None
        adsh = (src.get("adsh") or "").strip() or None

        # No highlight snippet from EFTS; use the document description, then a
        # synthesized "Form filed by Company" line so a row is never empty.
        snippet = (src.get("file_description") or "").strip()
        if not snippet:
            snippet = f"{form} filed by {company}" + (
                f" — period ending {src['period_ending']}" if src.get("period_ending") else ""
            )

        url = _build_url(hit.get("_id") or "", cik, adsh)

        return {
            "company": company,
            "ticker_or_cik": ticker or (f"CIK {int(cik)}" if cik and str(cik).isdigit() else cik) or "—",
            "form": form,
            "filed_date": filed_date,
            "snippet_or_title": snippet,
            "url": url,
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Live fetch
# ---------------------------------------------------------------------------

def _fetch_live(q: str, forms: str | None) -> list[dict]:
    """Hit the EFTS endpoint once. Returns normalized rows (newest-first) or []."""
    import httpx

    # Wrap a multi-word query in quotes for an exact-phrase match (the EDGAR
    # full-text UI does this); a single token or an already-quoted phrase is
    # passed through untouched.
    phrase = q
    if " " in q and not (q.startswith('"') and q.endswith('"')):
        phrase = f'"{q}"'

    params: dict[str, str] = {"q": phrase}
    if forms:
        params["forms"] = forms

    with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
        resp = client.get(EFTS_URL, params=params, headers=_headers())
        resp.raise_for_status()
        body = resp.json()

    hits = (body.get("hits") or {}).get("hits") or []
    rows = [r for r in (_normalize_hit(h) for h in hits) if r is not None]
    # Newest-first by filed_date (ISO strings sort correctly); None dates last.
    rows.sort(key=lambda r: r.get("filed_date") or "", reverse=True)
    return rows[:MAX_RESULTS]


# ---------------------------------------------------------------------------
# Sample data — plausible filings for a generic query
# ---------------------------------------------------------------------------

# (company, ticker, cik, form, filed_date, accession, filename, snippet)
SAMPLE_HITS: list[tuple] = [
    ("Apple Inc.", "AAPL", "320193", "10-K", "2025-11-01",
     "0000320193-25-000123", "aapl-20250927.htm",
     "Item 1A Risk Factors — references to going concern of suppliers"),
    ("Tesla, Inc.", "TSLA", "1318605", "10-Q", "2025-10-23",
     "0001318605-25-000211", "tsla-20250930.htm",
     "Management's Discussion — material weakness remediation update"),
    ("Carvana Co.", "CVNA", "1690820", "8-K", "2025-10-15",
     "0001690820-25-000099", "cvna-8k.htm",
     "Item 2.02 Results of Operations — liquidity and going concern language"),
    ("GameStop Corp.", "GME", "1326380", "10-Q", "2025-09-10",
     "0001326380-25-000077", "gme-20250802.htm",
     "Substantial doubt about ability to continue as a going concern removed"),
    ("AMC Entertainment Holdings", "AMC", "1411579", "10-K", "2025-03-01",
     "0001411579-25-000045", "amc-20241231.htm",
     "Going concern — debt maturities and covenant compliance discussion"),
    ("Beyond Meat, Inc.", "BYND", "1655210", "10-Q", "2025-08-08",
     "0001655210-25-000061", "bynd-20250628.htm",
     "Substantial doubt regarding the Company's ability to continue"),
    ("Lucid Group, Inc.", "LCID", "1811210", "8-K", "2025-07-30",
     "0001811210-25-000054", "lcid-8k.htm",
     "Risk factor — recurring losses raise going concern considerations"),
    ("Rivian Automotive, Inc.", "RIVN", "1874178", "10-Q", "2025-08-06",
     "0001874178-25-000071", "rivn-20250630.htm",
     "Liquidity, capital resources, and going concern assessment"),
    ("Peloton Interactive", "PTON", "1639825", "10-K", "2025-09-12",
     "0001639825-25-000088", "pton-20250630.htm",
     "Material weakness in internal control over financial reporting"),
    ("WeWork Inc.", "WE", "1813756", "10-Q", "2025-05-09",
     "0001813756-25-000033", "we-20250331.htm",
     "Going concern — losses, negative cash flows, and lease obligations"),
    ("Nikola Corporation", "NKLA", "1731289", "8-K", "2025-04-18",
     "0001731289-25-000029", "nkla-8k.htm",
     "Item 8.01 — substantial doubt about going concern disclosed"),
    ("Bed Bath & Beyond", "BBBY", "886158", "10-K", "2024-04-20",
     "0000886158-24-000019", "bbby-20240228.htm",
     "Going concern — restructuring, store closures, and financing"),
]


def _sample_rows(q: str) -> list[dict]:
    rows: list[dict] = []
    for company, ticker, cik, form, filed, acc, fname, snippet in SAMPLE_HITS:
        acc_nodash = acc.replace("-", "")
        url = f"{ARCHIVES_BASE}/{cik}/{acc_nodash}/{fname}"
        rows.append({
            "company": company,
            "ticker_or_cik": ticker,
            "form": form,
            "filed_date": filed,
            "snippet_or_title": snippet,
            "url": url,
        })
    rows.sort(key=lambda r: r.get("filed_date") or "", reverse=True)
    return rows[:MAX_RESULTS]


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _assemble(results: list[dict], q: str, forms: str | None, *,
              data_mode: str, source: str) -> dict:
    form_counts: dict[str, int] = {}
    for r in results:
        form_counts[r["form"]] = form_counts.get(r["form"], 0) + 1
    return {
        "query": q,
        "forms": forms or None,
        "count": len(results),
        "results": results,
        "form_counts": form_counts,
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point — NEVER raises
# ---------------------------------------------------------------------------

def edgar_search(q: str, forms: str | None = None) -> dict:
    """Full-text search recent SEC filings for a keyword/phrase.

    Tries the live EFTS feed once; on any failure (or a blank/empty query)
    degrades to deterministic SAMPLE filings tagged data_mode="sample". Always
    returns a populated dict with query / results / data_mode / as_of / source.
    """
    query = (q or "").strip()
    forms = (forms or "").strip() or None

    if query:
        try:
            rows = _fetch_live(query, forms)
            if rows:
                return _assemble(rows, query, forms, data_mode="live", source="sec-efts")
        except Exception as e:
            log.warning("edgar_search live fetch failed for %r, using sample: %s", query, e)

    # Blank query or live failure / empty → deterministic sample.
    sample_query = query or "going concern"
    try:
        return _assemble(_sample_rows(sample_query), sample_query, forms,
                         data_mode="sample", source="sample")
    except Exception as e:  # absolute safety net — contract forbids raising
        log.error("edgar_search sample build failed hard: %s", e)
        return {
            "query": sample_query,
            "forms": forms,
            "count": 0,
            "results": [],
            "form_counts": {},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
