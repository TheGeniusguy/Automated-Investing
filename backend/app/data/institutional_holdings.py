"""13F Institutional Holdings -- quarterly position data from SEC EDGAR.

Large institutional investment managers ($100M+ AUM) file 13F-HR quarterly,
disclosing every US equity position. This module:
  - Fetches 13F-HR filings for tracked fund managers
  - Parses the XML information table
  - Persists to DuckDB
  - Computes analytics: top holders, QoQ changes, new/exited positions

Major filers tracked by default (CIKs):
  Berkshire Hathaway, Bridgewater, Citadel, Renaissance, Soros,
  Appaloosa, Tiger Global, Pershing Square, Elliott, Third Point, etc.

All data is free from SEC EDGAR. No API key needed.
"""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from datetime import date, timedelta

import httpx

from ..config import settings
from ..db import engine as db_engine
from . import cache, sec_edgar

log = logging.getLogger(__name__)

# Top institutional filers to track -- (name, CIK).
# These file 13F-HR quarterly and are widely followed.
TOP_FILERS: list[dict] = [
    {"name": "Berkshire Hathaway",     "cik": "0001067983"},
    {"name": "Bridgewater Associates", "cik": "0001350694"},
    {"name": "Citadel Advisors",       "cik": "0001423053"},
    {"name": "Renaissance Technologies","cik": "0001037389"},
    {"name": "Soros Fund Management",  "cik": "0001029160"},
    {"name": "Appaloosa Management",   "cik": "0001656456"},
    {"name": "Pershing Square",        "cik": "0001336528"},
    {"name": "Elliott Investment Mgmt","cik": "0001048445"},
    {"name": "Third Point",            "cik": "0001040273"},
    {"name": "Baupost Group",          "cik": "0001061768"},
    {"name": "Viking Global",          "cik": "0001103804"},
    {"name": "Coatue Management",      "cik": "0001535392"},
    {"name": "D.E. Shaw",              "cik": "0001009207"},
    {"name": "Two Sigma",              "cik": "0001179392"},
    {"name": "Point72",                "cik": "0001603466"},
    {"name": "Millennium Management",  "cik": "0001273087"},
    {"name": "Tiger Global",           "cik": "0001167483"},
    {"name": "Druckenmiller (Duquesne)","cik": "0001536411"},
    {"name": "Greenlight Capital",     "cik": "0001079114"},
    {"name": "Lone Pine Capital",      "cik": "0001061165"},
]

EDGAR_13F_TABLE_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nd}/{doc}"

# CUSIP -> ticker map (built from instruments table or yfinance).
_cusip_cache: dict[str, str] = {}


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept": "application/xml, application/json",
    }


def _cusip_to_ticker(cusip: str) -> str | None:
    """Best-effort CUSIP to ticker resolution from our instruments table."""
    if cusip in _cusip_cache:
        return _cusip_cache[cusip]
    # Try DuckDB instruments table (has CIK, not CUSIP, but we can match by name).
    # For now, return None and let the caller use name_of_issuer for display.
    return None


def _find_13f_info_table(submissions: dict) -> list[dict]:
    """From a submissions payload, find 13F-HR filings and their info table documents."""
    recent = (submissions or {}).get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])

    results = []
    for i, form in enumerate(forms):
        if form not in ("13F-HR", "13F-HR/A"):
            continue
        results.append({
            "accession": accessions[i] if i < len(accessions) else "",
            "filing_date": filing_dates[i] if i < len(filing_dates) else "",
            "primary_doc": primary_docs[i] if i < len(primary_docs) else "",
        })
        if len(results) >= 4:  # Last 4 quarters.
            break
    return results


def _parse_13f_xml(xml_text: str, filer_cik: str, filer_name: str,
                   filing_date: str, accession: str) -> list[dict]:
    """Parse 13F information table XML into holding rows."""
    holdings = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        log.warning("Failed to parse 13F XML for %s", filer_name)
        return []

    # Determine namespace.
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    # Try to find infoTable entries.
    info_tables = root.findall(f".//{ns}infoTable")
    if not info_tables:
        # Try without namespace.
        info_tables = root.findall(".//infoTable")
    if not info_tables:
        # Some files use different element names.
        info_tables = root.findall(f".//{ns}InfoTable")

    for entry in info_tables:
        def txt(path: str) -> str | None:
            # Try with namespace, then without.
            el = entry.find(f"{ns}{path}")
            if el is None:
                el = entry.find(path)
            return el.text.strip() if el is not None and el.text else None

        name = txt("nameOfIssuer")
        cusip = txt("cusip")
        value_str = txt("value")
        shares_str = txt("shrsOrPrnAmt/{ns}sshPrnamt".format(ns=ns)) or txt("shrsOrPrnAmt/sshPrnamt")
        share_type = txt("shrsOrPrnAmt/{ns}sshPrnamtType".format(ns=ns)) or txt("shrsOrPrnAmt/sshPrnamtType")
        put_call = txt("putCall")
        inv_disc = txt("investmentDiscretion")
        vote_sole = txt("votingAuthority/{ns}Sole".format(ns=ns)) or txt("votingAuthority/Sole")
        vote_shared = txt("votingAuthority/{ns}Shared".format(ns=ns)) or txt("votingAuthority/Shared")
        vote_none = txt("votingAuthority/{ns}None".format(ns=ns)) or txt("votingAuthority/None")

        # Resolve CUSIP to ticker if possible.
        ticker = _cusip_to_ticker(cusip) if cusip else None

        # Infer report_date from filing_date (13F covers the prior quarter end).
        report_date = _infer_quarter_end(filing_date)

        holdings.append({
            "filer_cik": filer_cik,
            "filer_name": filer_name,
            "symbol": ticker,
            "cusip": cusip,
            "name_of_issuer": name,
            "share_class": share_type,
            "shares": int(shares_str) if shares_str else None,
            "value_x1000": int(value_str) if value_str else None,
            "put_call": put_call,
            "investment_discretion": inv_disc,
            "voting_sole": int(vote_sole) if vote_sole else None,
            "voting_shared": int(vote_shared) if vote_shared else None,
            "voting_none": int(vote_none) if vote_none else None,
            "report_date": report_date,
            "filing_date": filing_date,
            "accession": accession,
        })

    return holdings


def _infer_quarter_end(filing_date_str: str) -> str:
    """13F-HR is due 45 days after quarter end. Infer which quarter."""
    try:
        fd = date.fromisoformat(filing_date_str)
    except (ValueError, TypeError):
        return filing_date_str

    # Quarter ends: 3/31, 6/30, 9/30, 12/31.
    # If filed in Jan-Feb, it covers Q4 prior year.
    # If filed in Apr-May, it covers Q1.
    # If filed in Jul-Aug, it covers Q2.
    # If filed in Oct-Nov, it covers Q3.
    if fd.month <= 2 or (fd.month == 3 and fd.day <= 15):
        return f"{fd.year - 1}-12-31"
    elif fd.month <= 5 or (fd.month == 6 and fd.day <= 15):
        return f"{fd.year}-03-31"
    elif fd.month <= 8 or (fd.month == 9 and fd.day <= 15):
        return f"{fd.year}-06-30"
    else:
        return f"{fd.year}-09-30"


# ── Ingestion ────────────────────────────────────────────────────────────

def ingest_13f_for_filer(filer_cik: str, filer_name: str, limit: int = 2) -> dict:
    """Fetch and parse the most recent 13F-HR filings for one fund manager."""
    cache_key = f"sec:sub:{filer_cik}"
    payload = cache.get(cache_key)

    if payload is None:
        try:
            url = f"https://data.sec.gov/submissions/CIK{filer_cik}.json"
            with httpx.Client(timeout=15.0, headers=_headers(), follow_redirects=True) as c:
                r = c.get(url)
                r.raise_for_status()
                payload = r.json()
            cache.set(cache_key, payload, 3600)
        except Exception as e:
            log.warning("13F submissions fetch failed for %s: %s", filer_name, e)
            return {"filer": filer_name, "holdings_ingested": 0, "error": str(e)}

    filings_meta = _find_13f_info_table(payload)[:limit]
    total = 0

    for fm in filings_meta:
        acc = fm["accession"]
        # Check if already ingested.
        existing = db_engine.fetchone(
            "SELECT 1 FROM institutional_holdings WHERE accession = ? LIMIT 1",
            [acc],
        )
        if existing:
            continue

        # Find the information table XML in the filing index.
        acc_nd = acc.replace("-", "")
        cik_int = str(int(filer_cik))
        index_url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nd}/"

        try:
            with httpx.Client(timeout=15.0, headers=_headers(), follow_redirects=True) as c:
                # Try to find the infotable XML.
                idx_r = c.get(index_url + "index.json")
                if idx_r.status_code == 200:
                    idx_data = idx_r.json()
                    items = idx_data.get("directory", {}).get("item", [])
                    xml_doc = None
                    for item in items:
                        name = item.get("name", "").lower()
                        if "infotable" in name and name.endswith(".xml"):
                            xml_doc = item["name"]
                            break
                        elif name.endswith(".xml") and "13f" in name:
                            xml_doc = item["name"]

                    if xml_doc:
                        xml_r = c.get(f"{index_url}{xml_doc}")
                        if xml_r.status_code == 200:
                            holdings = _parse_13f_xml(
                                xml_r.text, filer_cik, filer_name,
                                fm["filing_date"], acc,
                            )
                            for h in holdings:
                                try:
                                    db_engine.execute(
                                        """
                                        INSERT INTO institutional_holdings
                                        (filer_cik, filer_name, symbol, cusip, name_of_issuer,
                                         share_class, shares, value_x1000, put_call,
                                         investment_discretion, voting_sole, voting_shared,
                                         voting_none, report_date, filing_date, accession)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                        ON CONFLICT DO NOTHING
                                        """,
                                        [
                                            h["filer_cik"], h["filer_name"], h["symbol"],
                                            h["cusip"], h["name_of_issuer"], h["share_class"],
                                            h["shares"], h["value_x1000"], h["put_call"],
                                            h["investment_discretion"], h["voting_sole"],
                                            h["voting_shared"], h["voting_none"],
                                            h["report_date"], h["filing_date"], h["accession"],
                                        ],
                                    )
                                    total += 1
                                except Exception as e:
                                    log.warning("Insert holding failed: %s", e)
        except Exception as e:
            log.warning("13F XML fetch failed for %s/%s: %s", filer_name, acc, e)

    return {"filer": filer_name, "cik": filer_cik, "holdings_ingested": total}


def ingest_all_top_filers(limit_per_filer: int = 1) -> dict:
    """Ingest latest 13F for all tracked fund managers."""
    results = []
    for filer in TOP_FILERS:
        r = ingest_13f_for_filer(filer["cik"], filer["name"], limit=limit_per_filer)
        results.append(r)
    total = sum(r.get("holdings_ingested", 0) for r in results)
    return {"filers": len(TOP_FILERS), "total_holdings": total, "results": results}


# ── Query / analytics ────────────────────────────────────────────────────

def top_holders(symbol: str | None = None, name_pattern: str | None = None,
                limit: int = 20) -> dict:
    """Top institutional holders of a stock (by value or shares).
    If symbol is unknown (CUSIP-only), match by name_of_issuer pattern."""
    if symbol:
        rows = db_engine.fetchall(
            """
            SELECT filer_name, filer_cik, shares, value_x1000, report_date, filing_date
            FROM institutional_holdings
            WHERE (symbol = ? OR UPPER(name_of_issuer) LIKE ?)
            AND report_date = (
                SELECT MAX(report_date) FROM institutional_holdings
                WHERE symbol = ? OR UPPER(name_of_issuer) LIKE ?
            )
            ORDER BY value_x1000 DESC NULLS LAST
            LIMIT ?
            """,
            [symbol.upper(), f"%{symbol.upper()}%",
             symbol.upper(), f"%{symbol.upper()}%", limit],
        )
    elif name_pattern:
        rows = db_engine.fetchall(
            """
            SELECT filer_name, filer_cik, shares, value_x1000, report_date, filing_date
            FROM institutional_holdings
            WHERE UPPER(name_of_issuer) LIKE ?
            ORDER BY value_x1000 DESC NULLS LAST
            LIMIT ?
            """,
            [f"%{name_pattern.upper()}%", limit],
        )
    else:
        return {"holders": [], "query": None}

    holders = [
        {
            "filer_name": r[0],
            "filer_cik": r[1],
            "shares": r[2],
            "value_x1000": r[3],
            "report_date": str(r[4]) if r[4] else None,
            "filing_date": str(r[5]) if r[5] else None,
        }
        for r in rows
    ]
    return {"symbol": symbol, "holders": holders}


def filer_portfolio(filer_cik: str, report_date: str | None = None,
                    limit: int = 50) -> dict:
    """Full portfolio for one fund manager as of a quarter."""
    if report_date:
        rows = db_engine.fetchall(
            """
            SELECT name_of_issuer, cusip, symbol, shares, value_x1000,
                   put_call, report_date, filing_date
            FROM institutional_holdings
            WHERE filer_cik = ? AND report_date = ?
            ORDER BY value_x1000 DESC NULLS LAST
            LIMIT ?
            """,
            [filer_cik, report_date, limit],
        )
    else:
        rows = db_engine.fetchall(
            """
            SELECT name_of_issuer, cusip, symbol, shares, value_x1000,
                   put_call, report_date, filing_date
            FROM institutional_holdings
            WHERE filer_cik = ? AND report_date = (
                SELECT MAX(report_date) FROM institutional_holdings WHERE filer_cik = ?
            )
            ORDER BY value_x1000 DESC NULLS LAST
            LIMIT ?
            """,
            [filer_cik, filer_cik, limit],
        )

    filer_name = None
    holdings = []
    for r in rows:
        if filer_name is None:
            fn = db_engine.fetchone(
                "SELECT DISTINCT filer_name FROM institutional_holdings WHERE filer_cik = ? LIMIT 1",
                [filer_cik],
            )
            filer_name = fn[0] if fn else filer_cik
        holdings.append({
            "name_of_issuer": r[0],
            "cusip": r[1],
            "symbol": r[2],
            "shares": r[3],
            "value_x1000": r[4],
            "put_call": r[5],
            "report_date": str(r[6]) if r[6] else None,
            "filing_date": str(r[7]) if r[7] else None,
        })

    # Total portfolio value.
    total_value = sum(h["value_x1000"] or 0 for h in holdings) * 1000

    return {
        "filer_cik": filer_cik,
        "filer_name": filer_name or filer_cik,
        "report_date": rows[0][6] if rows else None,
        "holdings": holdings,
        "total_value": total_value,
        "position_count": len(holdings),
    }


def filer_changes(filer_cik: str) -> dict:
    """QoQ position changes for a filer: new buys, exits, increases, decreases."""
    # Get the two most recent quarter dates.
    dates = db_engine.fetchall(
        """
        SELECT DISTINCT report_date FROM institutional_holdings
        WHERE filer_cik = ?
        ORDER BY report_date DESC
        LIMIT 2
        """,
        [filer_cik],
    )
    if len(dates) < 2:
        return {"filer_cik": filer_cik, "changes": [], "note": "Need 2+ quarters of data"}

    current_q = str(dates[0][0])
    prior_q = str(dates[1][0])

    current = {
        r[0]: {"shares": r[1], "value": r[2], "name": r[3]}
        for r in db_engine.fetchall(
            """
            SELECT cusip, shares, value_x1000, name_of_issuer
            FROM institutional_holdings
            WHERE filer_cik = ? AND report_date = ?
            """,
            [filer_cik, current_q],
        )
    }
    prior = {
        r[0]: {"shares": r[1], "value": r[2], "name": r[3]}
        for r in db_engine.fetchall(
            """
            SELECT cusip, shares, value_x1000, name_of_issuer
            FROM institutional_holdings
            WHERE filer_cik = ? AND report_date = ?
            """,
            [filer_cik, prior_q],
        )
    }

    changes = []
    all_cusips = set(current.keys()) | set(prior.keys())
    for cusip in all_cusips:
        cur = current.get(cusip)
        prev = prior.get(cusip)
        name = (cur or prev or {}).get("name", "")
        cur_shares = (cur or {}).get("shares", 0) or 0
        prev_shares = (prev or {}).get("shares", 0) or 0
        cur_val = ((cur or {}).get("value", 0) or 0) * 1000
        prev_val = ((prev or {}).get("value", 0) or 0) * 1000

        if cur and not prev:
            change_type = "new_position"
        elif prev and not cur:
            change_type = "exited"
        elif cur_shares > prev_shares:
            change_type = "increased"
        elif cur_shares < prev_shares:
            change_type = "decreased"
        else:
            change_type = "unchanged"

        share_delta = cur_shares - prev_shares
        share_delta_pct = (share_delta / prev_shares * 100) if prev_shares else None

        changes.append({
            "cusip": cusip,
            "name_of_issuer": name,
            "change_type": change_type,
            "current_shares": cur_shares,
            "prior_shares": prev_shares,
            "share_delta": share_delta,
            "share_delta_pct": share_delta_pct,
            "current_value": cur_val,
            "prior_value": prev_val,
        })

    # Sort: new positions first, then by absolute value change.
    type_order = {"new_position": 0, "exited": 1, "increased": 2, "decreased": 3, "unchanged": 4}
    changes.sort(key=lambda c: (type_order.get(c["change_type"], 5), -abs(c["share_delta"])))

    filer_name_row = db_engine.fetchone(
        "SELECT DISTINCT filer_name FROM institutional_holdings WHERE filer_cik = ? LIMIT 1",
        [filer_cik],
    )

    return {
        "filer_cik": filer_cik,
        "filer_name": filer_name_row[0] if filer_name_row else filer_cik,
        "current_quarter": current_q,
        "prior_quarter": prior_q,
        "changes": changes,
        "summary": {
            "new_positions": sum(1 for c in changes if c["change_type"] == "new_position"),
            "exited": sum(1 for c in changes if c["change_type"] == "exited"),
            "increased": sum(1 for c in changes if c["change_type"] == "increased"),
            "decreased": sum(1 for c in changes if c["change_type"] == "decreased"),
            "unchanged": sum(1 for c in changes if c["change_type"] == "unchanged"),
        },
    }


def list_tracked_filers() -> list[dict]:
    """Return the list of tracked institutional filers with ingestion status."""
    result = []
    for filer in TOP_FILERS:
        row = db_engine.fetchone(
            """
            SELECT COUNT(*), MAX(report_date), MAX(filing_date)
            FROM institutional_holdings
            WHERE filer_cik = ?
            """,
            [filer["cik"]],
        )
        result.append({
            "name": filer["name"],
            "cik": filer["cik"],
            "holdings_count": int(row[0]) if row else 0,
            "latest_quarter": str(row[1]) if row and row[1] else None,
            "latest_filing": str(row[2]) if row and row[2] else None,
        })
    return result
