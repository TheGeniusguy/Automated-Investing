"""M&A / Deals Monitor engine (Bloomberg `MA` function equivalent).

Builds a market-wide feed of merger & acquisition deals plus summary analytics:
total announced deal value, count by status, average premium, the single largest
deal, and a by-sector rollup. This surface is inherently curated - there is no
free, reliable live M&A feed - so the data is a RICH, realistic illustrative
SAMPLE set held in the clearly-named SAMPLE_DEALS constant. The deals are
plausible but illustrative, NOT a claim about real current transactions.

This module never raises. It always returns a populated payload tagged with
data_mode / as_of / source for honesty under the hood. If a live enrichment
path is ever wired in and fails, it degrades silently to the sample set.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

SOURCE = "curated"


# ---------------------------------------------------------------------------
# SAMPLE data (clearly namespaced). Illustrative M&A transactions across
# sectors. deal_value_b is in $B, premium_pct is the bid premium to the
# target's undisturbed price, target_price is the implied price/share.
# These are plausible-but-illustrative, not real current deals.
# ---------------------------------------------------------------------------

SAMPLE_DEALS: list[dict] = [
    {
        "acquirer": "Synopsys", "acquirer_ticker": "SNPS",
        "target": "Ansys", "target_ticker": "ANSS",
        "sector": "Technology", "deal_value_b": 35.0, "premium_pct": 29.4,
        "consideration": "Cash & Stock", "status": "Pending",
        "announce_date": "2026-05-28", "expected_close": "2026-12-15",
        "target_price": 390.00,
        "headline": "Synopsys to acquire Ansys in $35B chip-design and simulation tie-up.",
    },
    {
        "acquirer": "ExxonMobil", "acquirer_ticker": "XOM",
        "target": "Permian Basin Resources", "target_ticker": "PBR",
        "sector": "Energy", "deal_value_b": 28.6, "premium_pct": 18.2,
        "consideration": "Stock", "status": "Pending",
        "announce_date": "2026-06-19", "expected_close": "2027-01-31",
        "target_price": 142.50,
        "headline": "ExxonMobil expands Permian footprint with $28.6B all-stock deal.",
    },
    {
        "acquirer": "Capital One", "acquirer_ticker": "COF",
        "target": "Discover Financial", "target_ticker": "DFS",
        "sector": "Financials", "deal_value_b": 35.3, "premium_pct": 26.6,
        "consideration": "Stock", "status": "Completed",
        "announce_date": "2026-02-14", "expected_close": "2026-05-20",
        "target_price": 142.20,
        "headline": "Capital One closes $35.3B Discover acquisition, creating a payments giant.",
    },
    {
        "acquirer": "Novo Nordisk", "acquirer_ticker": "NVO",
        "target": "Cardior Bio", "target_ticker": "CRDB",
        "sector": "Health Care", "deal_value_b": 11.4, "premium_pct": 41.8,
        "consideration": "Cash", "status": "Announced",
        "announce_date": "2026-06-24", "expected_close": "2026-11-30",
        "target_price": 88.75,
        "headline": "Novo Nordisk buys Cardior Bio for $11.4B to widen cardiometabolic pipeline.",
    },
    {
        "acquirer": "Cisco Systems", "acquirer_ticker": "CSCO",
        "target": "Arista Edge", "target_ticker": "AEDG",
        "sector": "Technology", "deal_value_b": 9.8, "premium_pct": 33.1,
        "consideration": "Cash", "status": "Announced",
        "announce_date": "2026-06-22", "expected_close": "2026-12-05",
        "target_price": 64.20,
        "headline": "Cisco to acquire Arista Edge for $9.8B in networking-AI push.",
    },
    {
        "acquirer": "BlackRock", "acquirer_ticker": "BLK",
        "target": "Global Infra Partners", "target_ticker": "GIP",
        "sector": "Financials", "deal_value_b": 12.5, "premium_pct": 0.0,
        "consideration": "Cash & Stock", "status": "Completed",
        "announce_date": "2026-01-12", "expected_close": "2026-04-30",
        "target_price": 0.0,
        "headline": "BlackRock completes $12.5B Global Infrastructure Partners buyout.",
    },
    {
        "acquirer": "Chevron", "acquirer_ticker": "CVX",
        "target": "Hess Energy", "target_ticker": "HES",
        "sector": "Energy", "deal_value_b": 53.0, "premium_pct": 10.3,
        "consideration": "Stock", "status": "Pending",
        "announce_date": "2026-03-08", "expected_close": "2026-10-15",
        "target_price": 171.00,
        "headline": "Chevron-Hess $53B merger awaits Guyana arbitration ruling.",
    },
    {
        "acquirer": "Mars Inc.", "acquirer_ticker": "PRIV",
        "target": "Kellanova", "target_ticker": "K",
        "sector": "Consumer Staples", "deal_value_b": 35.9, "premium_pct": 33.0,
        "consideration": "Cash", "status": "Pending",
        "announce_date": "2026-04-03", "expected_close": "2027-02-28",
        "target_price": 83.50,
        "headline": "Mars to take Kellanova private in $35.9B snacking megadeal.",
    },
    {
        "acquirer": "Home Depot", "acquirer_ticker": "HD",
        "target": "SRS Distribution", "target_ticker": "SRSD",
        "sector": "Consumer Discretionary", "deal_value_b": 18.3, "premium_pct": 21.5,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-01-29", "expected_close": "2026-06-12",
        "target_price": 0.0,
        "headline": "Home Depot closes $18.3B SRS Distribution deal to court pros.",
    },
    {
        "acquirer": "IBM", "acquirer_ticker": "IBM",
        "target": "HashiCorp Labs", "target_ticker": "HCPL",
        "sector": "Technology", "deal_value_b": 6.4, "premium_pct": 42.6,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-02-26", "expected_close": "2026-05-30",
        "target_price": 35.00,
        "headline": "IBM completes $6.4B HashiCorp Labs purchase to bolster hybrid cloud.",
    },
    {
        "acquirer": "Johnson & Johnson", "acquirer_ticker": "JNJ",
        "target": "Shockwave Medical", "target_ticker": "SWAV",
        "sector": "Health Care", "deal_value_b": 13.1, "premium_pct": 17.0,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-03-04", "expected_close": "2026-06-18",
        "target_price": 335.00,
        "headline": "J&J wraps $13.1B Shockwave Medical buy to expand cardiovascular line.",
    },
    {
        "acquirer": "Diamondback Energy", "acquirer_ticker": "FANG",
        "target": "Endeavor Resources", "target_ticker": "ENDR",
        "sector": "Energy", "deal_value_b": 26.0, "premium_pct": 9.1,
        "consideration": "Cash & Stock", "status": "Completed",
        "announce_date": "2026-02-12", "expected_close": "2026-05-28",
        "target_price": 0.0,
        "headline": "Diamondback closes $26B Endeavor merger, a Permian powerhouse.",
    },
    {
        "acquirer": "Salesforce", "acquirer_ticker": "CRM",
        "target": "Informatica", "target_ticker": "INFA",
        "sector": "Technology", "deal_value_b": 8.0, "premium_pct": 30.2,
        "consideration": "Cash", "status": "Pending",
        "announce_date": "2026-05-27", "expected_close": "2026-11-20",
        "target_price": 25.00,
        "headline": "Salesforce to buy Informatica for $8B to deepen data-management stack.",
    },
    {
        "acquirer": "T-Mobile US", "acquirer_ticker": "TMUS",
        "target": "UScellular", "target_ticker": "USM",
        "sector": "Communication Services", "deal_value_b": 4.4, "premium_pct": 15.8,
        "consideration": "Cash", "status": "Pending",
        "announce_date": "2026-04-28", "expected_close": "2027-01-15",
        "target_price": 0.0,
        "headline": "T-Mobile to absorb UScellular wireless assets in $4.4B deal.",
    },
    {
        "acquirer": "Verizon", "acquirer_ticker": "VZ",
        "target": "Frontier Communications", "target_ticker": "FYBR",
        "sector": "Communication Services", "deal_value_b": 20.0, "premium_pct": 43.7,
        "consideration": "Cash", "status": "Pending",
        "announce_date": "2026-05-05", "expected_close": "2027-03-31",
        "target_price": 38.50,
        "headline": "Verizon to acquire Frontier for $20B to extend fiber reach.",
    },
    {
        "acquirer": "Blackstone", "acquirer_ticker": "BX",
        "target": "AirTrunk Data Centers", "target_ticker": "ATDC",
        "sector": "Real Estate", "deal_value_b": 16.1, "premium_pct": 0.0,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-01-22", "expected_close": "2026-04-09",
        "target_price": 0.0,
        "headline": "Blackstone closes $16.1B AirTrunk data-center platform takeover.",
    },
    {
        "acquirer": "Nvidia", "acquirer_ticker": "NVDA",
        "target": "Run:ai Systems", "target_ticker": "RNAI",
        "sector": "Technology", "deal_value_b": 0.7, "premium_pct": 38.0,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-03-19", "expected_close": "2026-05-11",
        "target_price": 0.0,
        "headline": "Nvidia closes Run:ai acquisition to optimize GPU orchestration.",
    },
    {
        "acquirer": "Pfizer", "acquirer_ticker": "PFE",
        "target": "Arena Oncology", "target_ticker": "ARNO",
        "sector": "Health Care", "deal_value_b": 14.7, "premium_pct": 36.5,
        "consideration": "Cash", "status": "Announced",
        "announce_date": "2026-06-25", "expected_close": "2027-01-20",
        "target_price": 52.40,
        "headline": "Pfizer to buy Arena Oncology for $14.7B, betting on solid-tumor ADCs.",
    },
    {
        "acquirer": "JPMorgan Chase", "acquirer_ticker": "JPM",
        "target": "First Republic Wealth", "target_ticker": "FRCW",
        "sector": "Financials", "deal_value_b": 10.6, "premium_pct": 12.3,
        "consideration": "Cash & Stock", "status": "Pending",
        "announce_date": "2026-06-10", "expected_close": "2026-12-22",
        "target_price": 0.0,
        "headline": "JPMorgan to acquire First Republic Wealth unit for $10.6B.",
    },
    {
        "acquirer": "Broadcom", "acquirer_ticker": "AVGO",
        "target": "Tower Networks", "target_ticker": "TWRN",
        "sector": "Technology", "deal_value_b": 7.2, "premium_pct": 24.0,
        "consideration": "Cash & Stock", "status": "Terminated",
        "announce_date": "2026-02-08", "expected_close": "2026-09-30",
        "target_price": 0.0,
        "headline": "Broadcom-Tower Networks $7.2B deal collapses on antitrust pushback.",
    },
    {
        "acquirer": "Adobe", "acquirer_ticker": "ADBE",
        "target": "Figma", "target_ticker": "FIGM",
        "sector": "Technology", "deal_value_b": 20.0, "premium_pct": 0.0,
        "consideration": "Cash & Stock", "status": "Terminated",
        "announce_date": "2026-01-05", "expected_close": "2026-07-01",
        "target_price": 0.0,
        "headline": "Adobe-Figma $20B merger terminated amid EU and UK objections.",
    },
    {
        "acquirer": "Caterpillar", "acquirer_ticker": "CAT",
        "target": "Komatsu Mining Sys", "target_ticker": "KMSY",
        "sector": "Industrials", "deal_value_b": 9.3, "premium_pct": 22.7,
        "consideration": "Cash", "status": "Announced",
        "announce_date": "2026-06-17", "expected_close": "2027-02-10",
        "target_price": 0.0,
        "headline": "Caterpillar to buy Komatsu Mining Systems for $9.3B in autonomy bet.",
    },
    {
        "acquirer": "Mastercard", "acquirer_ticker": "MA",
        "target": "Recorded Future", "target_ticker": "RECF",
        "sector": "Technology", "deal_value_b": 2.7, "premium_pct": 19.5,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-03-12", "expected_close": "2026-06-02",
        "target_price": 0.0,
        "headline": "Mastercard closes $2.7B Recorded Future deal to boost fraud defense.",
    },
    {
        "acquirer": "Marathon Petroleum", "acquirer_ticker": "MPC",
        "target": "Gulf Coast Midstream", "target_ticker": "GCMS",
        "sector": "Energy", "deal_value_b": 6.8, "premium_pct": 14.4,
        "consideration": "Cash & Stock", "status": "Announced",
        "announce_date": "2026-06-20", "expected_close": "2026-12-30",
        "target_price": 0.0,
        "headline": "Marathon to acquire Gulf Coast Midstream for $6.8B in logistics play.",
    },
    {
        "acquirer": "Eli Lilly", "acquirer_ticker": "LLY",
        "target": "Morphic Holding", "target_ticker": "MORF",
        "sector": "Health Care", "deal_value_b": 3.2, "premium_pct": 79.0,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-02-20", "expected_close": "2026-05-15",
        "target_price": 57.00,
        "headline": "Eli Lilly closes $3.2B Morphic deal to add oral integrin therapies.",
    },
    {
        "acquirer": "PepsiCo", "acquirer_ticker": "PEP",
        "target": "Siete Foods", "target_ticker": "SIET",
        "sector": "Consumer Staples", "deal_value_b": 1.2, "premium_pct": 27.3,
        "consideration": "Cash", "status": "Completed",
        "announce_date": "2026-03-26", "expected_close": "2026-06-08",
        "target_price": 0.0,
        "headline": "PepsiCo wraps $1.2B Siete Foods buy to widen better-for-you snacks.",
    },
]


# ---------------------------------------------------------------------------
# Summary analytics
# ---------------------------------------------------------------------------

def _round(v: float, n: int = 1) -> float:
    return round(float(v), n)


def _build_summary(deals: list[dict]) -> dict:
    count = len(deals)
    total_value = sum(d.get("deal_value_b") or 0.0 for d in deals)

    count_by_status: dict[str, int] = {}
    for d in deals:
        st = d.get("status") or "Unknown"
        count_by_status[st] = count_by_status.get(st, 0) + 1

    premiums = [d["premium_pct"] for d in deals if d.get("premium_pct")]
    avg_premium = sum(premiums) / len(premiums) if premiums else 0.0

    largest = max(deals, key=lambda d: d.get("deal_value_b") or 0.0) if deals else None

    sector_rollup: dict[str, dict] = {}
    for d in deals:
        sec = d.get("sector") or "Other"
        bucket = sector_rollup.setdefault(sec, {"sector": sec, "count": 0, "value_b": 0.0})
        bucket["count"] += 1
        bucket["value_b"] += d.get("deal_value_b") or 0.0
    by_sector = sorted(sector_rollup.values(), key=lambda s: s["value_b"], reverse=True)
    for s in by_sector:
        s["value_b"] = _round(s["value_b"])

    return {
        "total_value_b": _round(total_value),
        "deal_count": count,
        "count_by_status": count_by_status,
        "avg_premium_pct": _round(avg_premium),
        "largest_deal": {
            "headline": largest["headline"] if largest else None,
            "value_b": _round(largest["deal_value_b"]) if largest else 0.0,
            "acquirer": largest["acquirer"] if largest else None,
            "target": largest["target"] if largest else None,
        },
        "by_sector": by_sector,
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def deals_monitor() -> dict:
    """Return the market-wide M&A deals feed + summary analytics.

    Never raises. Always returns a populated dict with top-level keys:
    deals, summary, data_mode, as_of, source. Deals are sorted by
    announce_date descending.
    """
    try:
        deals = [dict(d) for d in SAMPLE_DEALS]
        deals.sort(key=lambda d: d.get("announce_date") or "", reverse=True)
        summary = _build_summary(deals)
        return {
            "deals": deals,
            "summary": summary,
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": SOURCE,
        }
    except Exception as e:  # absolute safety net - the contract forbids raising
        log.warning("deals_monitor failed hard, returning minimal payload: %s", e)
        fallback = [dict(d) for d in SAMPLE_DEALS]
        return {
            "deals": fallback,
            "summary": _build_summary(fallback) if fallback else {
                "total_value_b": 0.0, "deal_count": 0, "count_by_status": {},
                "avg_premium_pct": 0.0, "largest_deal": None, "by_sector": [],
            },
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": SOURCE,
        }
