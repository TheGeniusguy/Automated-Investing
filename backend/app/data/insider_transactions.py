"""Insider transactions module -- SEC Form 4 parsing and analytics.

Pulls Form 4 filings from EDGAR, parses the XML to extract individual
transactions (purchases, sales, exercises, awards), persists to DuckDB,
and computes analytics:
  - Per-ticker insider activity (buys vs sells, net shares, dollar value)
  - Cluster detection (3+ insiders buying within N days = strong signal)
  - Rolling insider sentiment (buy/sell ratio over time)

All data is free from SEC EDGAR. No API key needed.
"""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from typing import Optional

import httpx

from ..config import settings
from ..db import engine as db_engine
from . import cache, sec_edgar

log = logging.getLogger(__name__)

FORM4_XML_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_no_dashes}/{primary_doc}"
SUBMISSIONS_TTL = 60 * 60  # 1h


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept": "application/xml, application/json",
    }


def _parse_form4_xml(xml_text: str, accession: str, symbol: str,
                     cik: str, filing_date: str, source_url: str) -> list[dict]:
    """Parse a Form 4 XML document into transaction rows."""
    txns = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        log.warning("Failed to parse Form 4 XML for %s", accession)
        return []

    # Namespace handling -- EDGAR Form 4 XML uses a default namespace.
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    # Reporting owner info.
    owner_el = root.find(f"{ns}reportingOwner")
    if owner_el is None:
        return []

    owner_id = owner_el.find(f"{ns}reportingOwnerId")
    owner_rel = owner_el.find(f"{ns}reportingOwnerRelationship")

    insider_name = ""
    if owner_id is not None:
        name_el = owner_id.find(f"{ns}rptOwnerName")
        insider_name = name_el.text.strip() if name_el is not None and name_el.text else ""

    insider_title = ""
    is_director = False
    is_officer = False
    is_ten_pct = False
    if owner_rel is not None:
        title_el = owner_rel.find(f"{ns}officerTitle")
        insider_title = title_el.text.strip() if title_el is not None and title_el.text else ""
        dir_el = owner_rel.find(f"{ns}isDirector")
        is_director = dir_el is not None and dir_el.text and dir_el.text.strip() in ("1", "true")
        off_el = owner_rel.find(f"{ns}isOfficer")
        is_officer = off_el is not None and off_el.text and off_el.text.strip() in ("1", "true")
        ten_el = owner_rel.find(f"{ns}isTenPercentOwner")
        is_ten_pct = ten_el is not None and ten_el.text and ten_el.text.strip() in ("1", "true")
        if not insider_title and is_director:
            insider_title = "Director"

    # Non-derivative transactions (most common: open-market buys/sells).
    for table_name in ["nonDerivativeTable", "derivativeTable"]:
        table = root.find(f"{ns}{table_name}")
        if table is None:
            continue
        tag = "nonDerivativeTransaction" if "nonDerivative" in table_name else "derivativeTransaction"
        for txn_el in table.findall(f"{ns}{tag}"):
            row = _parse_txn_element(txn_el, ns, accession, symbol, cik,
                                     insider_name, insider_title,
                                     is_director, is_officer, is_ten_pct,
                                     filing_date, source_url)
            if row:
                txns.append(row)

    return txns


def _text(el, path: str, ns: str) -> Optional[str]:
    child = el.find(f"{ns}{path}")
    if child is not None and child.text:
        return child.text.strip()
    return None


def _parse_txn_element(txn_el, ns: str, accession: str, symbol: str,
                       cik: str, insider_name: str, insider_title: str,
                       is_director: bool, is_officer: bool, is_ten_pct: bool,
                       filing_date: str, source_url: str) -> Optional[dict]:
    """Parse one <nonDerivativeTransaction> or <derivativeTransaction>."""
    amounts = txn_el.find(f"{ns}transactionAmounts")
    coding = txn_el.find(f"{ns}transactionCoding")
    post = txn_el.find(f"{ns}postTransactionAmounts")

    if amounts is None:
        return None

    txn_code = _text(coding, "transactionCode", ns) if coding is not None else None
    if not txn_code:
        return None

    shares_str = _text(amounts, "transactionShares/value", ns)
    price_str = _text(amounts, "transactionPricePerShare/value", ns)
    txn_date_str = _text(txn_el, "transactionDate/value", ns)

    shares = float(shares_str) if shares_str else None
    price = float(price_str) if price_str else None

    # Determine sign from acquisition/disposition.
    ad_el = amounts.find(f"{ns}transactionAcquiredDisposedCode")
    ad_code = None
    if ad_el is not None:
        ad_val = ad_el.find(f"{ns}value")
        ad_code = ad_val.text.strip() if ad_val is not None and ad_val.text else None

    # For dispositions (sells), shares are reported positive but represent outflow.
    # We keep shares positive and use txn_code to determine direction.

    shares_after = None
    if post is not None:
        sa_str = _text(post, "sharesOwnedFollowingTransaction/value", ns)
        shares_after = float(sa_str) if sa_str else None

    ownership_el = txn_el.find(f"{ns}ownershipNature")
    ownership_type = None
    if ownership_el is not None:
        ownership_type = _text(ownership_el, "directOrIndirectOwnership/value", ns)

    total_value = None
    if shares is not None and price is not None and price > 0:
        total_value = shares * price

    return {
        "accession": accession,
        "symbol": symbol,
        "cik": cik,
        "insider_name": insider_name,
        "insider_title": insider_title,
        "is_director": is_director,
        "is_officer": is_officer,
        "is_ten_pct": is_ten_pct,
        "txn_date": txn_date_str,
        "txn_code": txn_code,
        "shares": shares,
        "price_per_share": price,
        "total_value": total_value,
        "shares_after": shares_after,
        "ownership_type": ownership_type,
        "filing_date": filing_date,
        "form_type": "4",
        "source_url": source_url,
    }


# ── Ingestion ────────────────────────────────────────────────────────────

def ingest_insider_transactions(tickers: list[str], days: int = 365) -> dict:
    """Fetch Form 4 filings for the given tickers and parse into insider_transactions."""
    cik_map = sec_edgar.resolve_ciks(tickers)
    total_txns = 0
    errors = []

    for ticker, cik in cik_map.items():
        try:
            filings = sec_edgar.fetch_filings_for_ticker(
                ticker, cik, days=days, forms=["4"], limit=50,
            )
            for f in filings:
                # Check if already ingested.
                existing = db_engine.fetchone(
                    "SELECT 1 FROM insider_transactions WHERE accession = ? LIMIT 1",
                    [f["accession"]],
                )
                if existing:
                    continue

                # Fetch the XML.
                try:
                    url = f["url"]
                    # Form 4 XML URL -- try the .xml variant.
                    xml_url = url
                    if url.endswith(".htm") or url.endswith(".html"):
                        xml_url = url.rsplit(".", 1)[0] + ".xml"

                    with httpx.Client(timeout=15.0, headers=_headers(), follow_redirects=True) as c:
                        r = c.get(xml_url)
                        if r.status_code != 200:
                            # Try original URL.
                            r = c.get(url)
                        if r.status_code != 200:
                            continue
                        xml_text = r.text

                    txns = _parse_form4_xml(
                        xml_text, f["accession"], ticker, cik,
                        f["filing_date"], url,
                    )
                    for txn in txns:
                        try:
                            db_engine.execute(
                                """
                                INSERT INTO insider_transactions
                                (accession, symbol, cik, insider_name, insider_title,
                                 is_director, is_officer, is_ten_pct,
                                 txn_date, txn_code, shares, price_per_share, total_value,
                                 shares_after, ownership_type, filing_date, form_type, source_url)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT DO NOTHING
                                """,
                                [
                                    txn["accession"], txn["symbol"], txn["cik"],
                                    txn["insider_name"], txn["insider_title"],
                                    txn["is_director"], txn["is_officer"], txn["is_ten_pct"],
                                    txn["txn_date"], txn["txn_code"],
                                    txn["shares"], txn["price_per_share"], txn["total_value"],
                                    txn["shares_after"], txn["ownership_type"],
                                    txn["filing_date"], txn["form_type"], txn["source_url"],
                                ],
                            )
                            total_txns += 1
                        except Exception as e:
                            log.warning("Insert failed for %s txn: %s", ticker, e)

                except Exception as e:
                    log.warning("Failed to fetch Form 4 XML for %s/%s: %s", ticker, f["accession"], e)

        except Exception as e:
            errors.append(f"{ticker}: {e}")
            log.warning("Insider ingest failed for %s: %s", ticker, e)

    return {
        "tickers": list(cik_map.keys()),
        "transactions_ingested": total_txns,
        "errors": errors,
    }


# ── Query / analytics ────────────────────────────────────────────────────

def ticker_summary(symbol: str, days: int = 365) -> dict:
    """Insider activity summary for one ticker."""
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    symbol = symbol.upper()

    # All transactions.
    rows = db_engine.fetchall(
        """
        SELECT insider_name, insider_title, is_director, is_officer, is_ten_pct,
               txn_date, txn_code, shares, price_per_share, total_value,
               shares_after, ownership_type, filing_date, source_url
        FROM insider_transactions
        WHERE symbol = ? AND txn_date >= ?
        ORDER BY txn_date DESC
        """,
        [symbol, cutoff],
    )

    transactions = []
    buy_count = 0
    sell_count = 0
    buy_value = 0.0
    sell_value = 0.0
    buy_shares = 0.0
    sell_shares = 0.0

    for r in rows:
        txn = {
            "insider_name": r[0],
            "insider_title": r[1],
            "is_director": r[2],
            "is_officer": r[3],
            "is_ten_pct": r[4],
            "txn_date": str(r[5]) if r[5] else None,
            "txn_code": r[6],
            "shares": r[7],
            "price_per_share": r[8],
            "total_value": r[9],
            "shares_after": r[10],
            "ownership_type": r[11],
            "filing_date": str(r[12]) if r[12] else None,
            "source_url": r[13],
        }
        transactions.append(txn)

        code = r[6]
        shares = r[7] or 0
        value = r[9] or 0

        if code == "P":  # Purchase
            buy_count += 1
            buy_value += value
            buy_shares += shares
        elif code == "S":  # Sale
            sell_count += 1
            sell_value += value
            sell_shares += shares

    # Cluster detection: 3+ unique insiders buying within 30 days.
    clusters = _detect_clusters(symbol, days=days)

    # Unique insiders.
    unique_buyers = set()
    unique_sellers = set()
    for t in transactions:
        if t["txn_code"] == "P":
            unique_buyers.add(t["insider_name"])
        elif t["txn_code"] == "S":
            unique_sellers.add(t["insider_name"])

    return {
        "symbol": symbol,
        "days": days,
        "transactions": transactions,
        "summary": {
            "total_transactions": len(transactions),
            "buy_count": buy_count,
            "sell_count": sell_count,
            "buy_value": buy_value,
            "sell_value": sell_value,
            "buy_shares": buy_shares,
            "sell_shares": sell_shares,
            "net_value": buy_value - sell_value,
            "net_shares": buy_shares - sell_shares,
            "unique_buyers": len(unique_buyers),
            "unique_sellers": len(unique_sellers),
            "buy_sell_ratio": (buy_count / sell_count) if sell_count > 0 else (float("inf") if buy_count > 0 else 0),
        },
        "clusters": clusters,
    }


def _detect_clusters(symbol: str, days: int = 365, window_days: int = 30,
                     min_insiders: int = 3) -> list[dict]:
    """Find windows where N+ distinct insiders bought within window_days."""
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    buys = db_engine.fetchall(
        """
        SELECT DISTINCT insider_name, txn_date
        FROM insider_transactions
        WHERE symbol = ? AND txn_code = 'P' AND txn_date >= ?
        ORDER BY txn_date
        """,
        [symbol.upper(), cutoff],
    )
    if len(buys) < min_insiders:
        return []

    clusters = []
    for i, (name, d) in enumerate(buys):
        window_end = str(date.fromisoformat(str(d)) + timedelta(days=window_days))
        insiders_in_window = set()
        for j in range(i, len(buys)):
            if str(buys[j][1]) <= window_end:
                insiders_in_window.add(buys[j][0])
            else:
                break
        if len(insiders_in_window) >= min_insiders:
            clusters.append({
                "start_date": str(d),
                "end_date": window_end,
                "insider_count": len(insiders_in_window),
                "insiders": sorted(insiders_in_window),
                "signal": "strong_buy" if len(insiders_in_window) >= 5 else "buy",
            })

    # Deduplicate overlapping clusters -- keep the one with most insiders.
    if not clusters:
        return []
    deduped = [clusters[0]]
    for c in clusters[1:]:
        if c["start_date"] > deduped[-1]["end_date"]:
            deduped.append(c)
        elif c["insider_count"] > deduped[-1]["insider_count"]:
            deduped[-1] = c
    return deduped


def multi_ticker_summary(tickers: list[str], days: int = 180) -> dict:
    """Quick overview across multiple tickers for a dashboard view."""
    results = []
    for ticker in tickers:
        s = ticker_summary(ticker, days=days)
        results.append({
            "symbol": s["symbol"],
            "summary": s["summary"],
            "cluster_count": len(s["clusters"]),
            "latest_cluster": s["clusters"][0] if s["clusters"] else None,
        })

    # Sort by net value (most buying first).
    results.sort(key=lambda r: r["summary"]["net_value"], reverse=True)
    return {"tickers": tickers, "days": days, "results": results}


TXN_CODE_LABELS = {
    "P": "Purchase",
    "S": "Sale",
    "A": "Award/Grant",
    "D": "Disposition to Issuer",
    "F": "Tax Withholding",
    "M": "Exercise/Conversion",
    "C": "Conversion",
    "G": "Gift",
    "J": "Other",
    "K": "Equity Swap",
    "V": "Voluntary Report",
    "W": "Will/Inheritance",
}
