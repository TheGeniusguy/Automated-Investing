"""Superinvestor / Smart-Money Clone Tracker (Bloomberg-style).

Tracks famous investment managers by CIK from their quarterly SEC EDGAR 13F-HR
filings: top positions by reported market value, portfolio weight, the latest
quarter-over-quarter move per name (New buy / Add / Trim / Sold), and a cloneable
"model portfolio" weighted by reported values. An aggregate SMART-MONEY CONSENSUS
surfaces the names most widely held across the tracked managers.

Live path: best-effort pull of the latest 13F-HR information table per manager
via the existing EDGAR helpers (`sec_edgar` for submissions, the
`institutional_holdings` parser for the XML info table). The scan is bounded by a
short wall-clock budget and a cap on managers fetched live; if too little
resolves we return None so the caller falls back to deterministic SAMPLE data.

Sample path: realistic per-manager portfolios (Berkshire heavy AAPL/BAC/AXP/KO/CVX;
Pershing concentrated; Scion small/contrarian; etc.) with weights, share counts,
market values, and move tags. Deterministic via md5 seeding so screenshots are
stable. This module NEVER raises - it always returns a populated payload with an
internal data_mode ("live"|"sample") + as_of + source for honesty under the hood.
"""
from __future__ import annotations

import hashlib
import logging
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import httpx

from ..config import settings
from . import cache, sec_edgar
from . import institutional_holdings as inst

log = logging.getLogger(__name__)

# Curated roster of famous managers. Real CIKs (zero-padded, EDGAR style).
# If a CIK is stale/unfetchable, that manager simply degrades to the sample path.
MANAGERS: list[dict] = [
    {"name": "Berkshire Hathaway",     "firm": "Berkshire Hathaway Inc.",        "cik": "0001067983", "manager": "Warren Buffett"},
    {"name": "Pershing Square",        "firm": "Pershing Square Capital Mgmt",   "cik": "0001336528", "manager": "Bill Ackman"},
    {"name": "Scion Asset Management",  "firm": "Scion Asset Management LLC",     "cik": "0001649339", "manager": "Michael Burry"},
    {"name": "Bridgewater Associates", "firm": "Bridgewater Associates LP",      "cik": "0001350694", "manager": "Ray Dalio (founder)"},
    {"name": "Appaloosa Management",   "firm": "Appaloosa LP",                   "cik": "0001656456", "manager": "David Tepper"},
    {"name": "Greenlight Capital",     "firm": "Greenlight Capital Inc.",        "cik": "0001079114", "manager": "David Einhorn"},
    {"name": "Third Point",            "firm": "Third Point LLC",                "cik": "0001040273", "manager": "Dan Loeb"},
    {"name": "Duquesne Family Office",  "firm": "Duquesne Family Office LLC",     "cik": "0001536411", "manager": "Stanley Druckenmiller"},
]

# Live budget knobs - keep the scan FAST and bounded; never stall the request.
LIVE_BUDGET_S = 7.0
LIVE_MAX_MANAGERS = 8
TOP_N = 8               # top positions retained per manager
CONSENSUS_N = 10        # names shown in the smart-money consensus leaderboard

_MOVES = ("New", "Add", "Trim", "Sold")


# ---------------------------------------------------------------------------
# Deterministic md5 seeding (canonical pattern, stable across calls)
# ---------------------------------------------------------------------------

def _hash(key: str, salt: str = "") -> int:
    return int(hashlib.md5(f"{key}|{salt}".encode()).hexdigest()[:8], 16)


def _rand01(key: str, salt: str) -> float:
    return (_hash(key, salt) % 1_000_000) / 1_000_000.0


def _headers() -> dict[str, str]:
    return {
        "User-Agent": settings.sec_user_agent,
        "Accept": "application/xml, application/json",
    }


# ---------------------------------------------------------------------------
# CUSIP -> ticker map for the mega-caps that dominate famous 13F portfolios.
# 13F filings report by CUSIP, never ticker, so without this map the live path
# would have to guess a symbol from the issuer name (e.g. "AMAZON COM INC" ->
# "AMAZ"), which renders as real but is wrong. These cover the overwhelming
# majority of top positions these managers actually hold; anything unresolved
# falls back to a cleaned issuer NAME, never a fabricated ticker.
# ---------------------------------------------------------------------------

CUSIP_TO_TICKER: dict[str, str] = {
    "037833100": "AAPL",   "594918104": "MSFT",   "023135106": "AMZN",
    "02079K305": "GOOGL",  "02079K107": "GOOG",   "30303M102": "META",
    "67066G104": "NVDA",   "88160R101": "TSLA",   "084670702": "BRK.B",
    "060505104": "BAC",    "025816109": "AXP",    "191216100": "KO",
    "166764100": "CVX",    "674599105": "OXY",    "615369105": "MCO",
    "500754106": "KHC",    "171340102": "CB",     "23918K108": "DVA",
    "46625H100": "JPM",    "949746101": "WFC",    "92826C839": "V",
    "57636Q104": "MA",     "437076102": "HD",     "91324P102": "UNH",
    "742718109": "PG",     "478160104": "JNJ",    "92343V104": "VZ",
    "90184L102": "TMUS",   "90353T100": "UBER",   "112585104": "BN",
    "432833107": "HLT",    "169656105": "CMG",    "76131D103": "QSR",
    "44267D107": "HHH",    "13646K108": "CP",     "G2554F113": "ACGL",
    "G1151C101": "ATAT",   "260543103": "DG",     "743315103": "PGR",
}


def _resolve_symbol(cusip: str, edgar_symbol: str | None) -> str | None:
    """Prefer an EDGAR-provided ticker, then the CUSIP map. None if neither."""
    if edgar_symbol:
        return edgar_symbol
    if cusip:
        return CUSIP_TO_TICKER.get(cusip.strip().upper())
    return None


# ---------------------------------------------------------------------------
# Sample data: realistic per-manager portfolios
# Each row: (symbol, name, market_value_usd, shares, move, move_pct)
# market_value is the reported position value in dollars.
# ---------------------------------------------------------------------------

SAMPLE_PORTFOLIOS: dict[str, list[tuple]] = {
    "0001067983": [  # Berkshire Hathaway - concentrated mega-cap value
        ("AAPL", "Apple Inc.",                 69_900_000_000, 300_000_000, "Trim", -13.0),
        ("AXP",  "American Express Co.",        41_100_000_000,  151_610_700, "Add",   0.0),
        ("BAC",  "Bank of America Corp.",       30_600_000_000,  766_300_000, "Trim", -18.0),
        ("KO",   "Coca-Cola Co.",              28_700_000_000,  400_000_000, "Add",   0.0),
        ("CVX",  "Chevron Corp.",              18_800_000_000,  118_610_500, "Add",   3.2),
        ("OXY",  "Occidental Petroleum",       13_100_000_000,  255_281_500, "Add",   2.9),
        ("MCO",  "Moody's Corp.",               11_200_000_000,   24_669_778, "Add",   0.0),
        ("KHC",  "Kraft Heinz Co.",             11_000_000_000,  325_634_818, "Add",   0.0),
        ("CB",   "Chubb Ltd.",                   7_900_000_000,   27_033_784, "Add",   4.3),
        ("DVA",  "DaVita Inc.",                  5_400_000_000,   36_095_570, "Add",   0.0),
    ],
    "0001336528": [  # Pershing Square - highly concentrated, ~8 names
        ("UBER", "Uber Technologies Inc.",     2_270_000_000,  30_300_000, "New",   100.0),
        ("BN",   "Brookfield Corp.",           1_840_000_000,  35_280_000, "Add",   12.0),
        ("HLT",  "Hilton Worldwide Holdings",  1_690_000_000,   7_350_000, "Add",    4.0),
        ("CMG",  "Chipotle Mexican Grill",     1_530_000_000,  28_880_000, "Trim",  -9.0),
        ("QSR",  "Restaurant Brands Intl",     1_220_000_000,  17_240_000, "Add",    0.0),
        ("HHH",  "Howard Hughes Holdings",       980_000_000,  13_650_000, "Add",    0.0),
        ("CP",   "Canadian Pacific Kansas City", 870_000_000,   9_840_000, "Trim",  -6.0),
        ("GOOGL","Alphabet Inc. Class A",        760_000_000,   4_720_000, "Add",    8.0),
    ],
    "0001649339": [  # Scion (Burry) - tiny, contrarian, fast-rotating book
        ("BABA", "Alibaba Group Holding",        16_900_000,    155_000, "Add",   45.0),
        ("JD",   "JD.com Inc.",                  13_600_000,    340_000, "Add",   60.0),
        ("BIDU", "Baidu Inc.",                    8_500_000,     80_000, "New",  100.0),
        ("MOH",  "Molina Healthcare Inc.",        4_700_000,     14_000, "New",  100.0),
        ("HCA",  "HCA Healthcare Inc.",           4_200_000,     12_000, "New",  100.0),
        ("BRKR", "Bruker Corp.",                  3_300_000,     55_000, "New",  100.0),
        ("ACGL", "Arch Capital Group",            2_900_000,     31_000, "Trim", -20.0),
        ("REAL", "The RealReal Inc.",             1_600_000,    600_000, "Sold", -100.0),
    ],
    "0001350694": [  # Bridgewater - broad, ETF-heavy macro book
        ("IVV",  "iShares Core S&P 500 ETF",    1_510_000_000,  2_640_000, "Trim",  -7.0),
        ("VWO",  "Vanguard FTSE Emerging Mkts",   980_000_000, 22_100_000, "Add",   14.0),
        ("GOOGL","Alphabet Inc. Class A",          640_000_000,  3_980_000, "Add",    5.0),
        ("PG",   "Procter & Gamble Co.",           520_000_000,  3_140_000, "Add",    2.0),
        ("NVDA", "NVIDIA Corp.",                    480_000_000,  4_360_000, "Trim", -22.0),
        ("KO",   "Coca-Cola Co.",                   430_000_000,  6_000_000, "Add",    9.0),
        ("JNJ",  "Johnson & Johnson",               390_000_000,  2_530_000, "Add",    0.0),
        ("META", "Meta Platforms Inc.",             360_000_000,    640_000, "Trim", -11.0),
        ("WMT",  "Walmart Inc.",                     330_000_000,  4_700_000, "Add",   18.0),
        ("PEP",  "PepsiCo Inc.",                     300_000_000,  1_770_000, "Add",    0.0),
    ],
    "0001656456": [  # Appaloosa (Tepper) - tech + China tilt
        ("BABA", "Alibaba Group Holding",          720_000_000,  6_600_000, "Add",   18.0),
        ("AMZN", "Amazon.com Inc.",                 540_000_000,  3_000_000, "Add",    8.0),
        ("META", "Meta Platforms Inc.",             510_000_000,    900_000, "Trim",  -6.0),
        ("NVDA", "NVIDIA Corp.",                     430_000_000,  3_900_000, "Trim", -14.0),
        ("MSFT", "Microsoft Corp.",                  360_000_000,    860_000, "Add",    0.0),
        ("PDD",  "PDD Holdings Inc.",                340_000_000,  3_200_000, "Add",   25.0),
        ("GOOG", "Alphabet Inc. Class C",            290_000_000,  1_750_000, "Add",    0.0),
        ("UBER", "Uber Technologies Inc.",           240_000_000,  3_200_000, "New",  100.0),
    ],
    "0001079114": [  # Greenlight (Einhorn) - value, some specials
        ("GRBK", "Green Brick Partners Inc.",        450_000_000,  7_400_000, "Add",    0.0),
        ("BHF",  "Brighthouse Financial Inc.",       210_000_000,  4_100_000, "Add",    6.0),
        ("CNXC", "Concentrix Corp.",                 180_000_000,  3_300_000, "Add",   12.0),
        ("CNX",  "CNX Resources Corp.",              160_000_000,  5_600_000, "Trim",  -8.0),
        ("HPQ",  "HP Inc.",                          140_000_000,  4_300_000, "New",  100.0),
        ("KD",   "Kyndryl Holdings Inc.",            120_000_000,  3_900_000, "Add",    9.0),
        ("ALIT", "Alight Inc.",                       95_000_000, 14_000_000, "Add",    0.0),
        ("SLVM", "Sylvamo Corp.",                     78_000_000,    980_000, "Trim", -15.0),
    ],
    "0001040273": [  # Third Point (Loeb) - event-driven large cap
        ("PCG",  "PG&E Corp.",                       720_000_000, 35_000_000, "Add",   10.0),
        ("AMZN", "Amazon.com Inc.",                  610_000_000,  3_400_000, "Add",    5.0),
        ("META", "Meta Platforms Inc.",              560_000_000,    980_000, "Add",    8.0),
        ("MSFT", "Microsoft Corp.",                  430_000_000,  1_030_000, "Trim",  -7.0),
        ("KKR",  "KKR & Co. Inc.",                   380_000_000,  3_100_000, "New",  100.0),
        ("BSX",  "Boston Scientific Corp.",          340_000_000,  4_100_000, "Add",    0.0),
        ("TSM",  "Taiwan Semiconductor ADR",         300_000_000,  1_650_000, "Add",   22.0),
        ("DHR",  "Danaher Corp.",                    260_000_000,  1_080_000, "Trim", -12.0),
    ],
    "0001536411": [  # Duquesne (Druckenmiller) - high-turnover growth/macro
        ("NTRA", "Natera Inc.",                      430_000_000,  3_100_000, "Add",   16.0),
        ("MSFT", "Microsoft Corp.",                  300_000_000,    720_000, "Add",    0.0),
        ("CPNG", "Coupang Inc.",                     280_000_000, 12_900_000, "Add",   30.0),
        ("WMT",  "Walmart Inc.",                     250_000_000,  3_560_000, "New",  100.0),
        ("TEVA", "Teva Pharmaceutical ADR",          230_000_000, 12_700_000, "Add",    5.0),
        ("FLUT", "Flutter Entertainment plc",        210_000_000,    910_000, "New",  100.0),
        ("WFC",  "Wells Fargo & Co.",                190_000_000,  2_900_000, "Trim", -18.0),
        ("AGCO", "AGCO Corp.",                       150_000_000,  1_550_000, "Sold", -100.0),
    ],
}

SAMPLE_QUARTER = "2026-03-31"


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _fetch_info_table_xml(cik: str) -> tuple[list[dict], list[dict]] | None:
    """Return (current_holdings, prior_holdings) parsed from the two most recent
    13F-HR info tables for a manager, or None if nothing usable resolved.

    Reuses sec_edgar submissions caching + the institutional_holdings parser.
    """
    sub_key = f"sec:sub:{cik}"
    payload = cache.get(sub_key)
    if payload is None:
        try:
            url = sec_edgar.EDGAR_SUBMISSIONS_URL.format(cik=cik)
            with httpx.Client(timeout=10.0, headers=_headers(), follow_redirects=True) as c:
                r = c.get(url)
                r.raise_for_status()
                payload = r.json()
            cache.set(sub_key, payload, sec_edgar.SUBMISSIONS_TTL)
        except Exception as e:
            log.warning("superinvestors: submissions fetch failed for %s: %s", cik, e)
            stale = cache.get_stale(sub_key)
            if stale is None:
                return None
            payload = stale

    filings_meta = inst._find_13f_info_table(payload)[:2]
    if not filings_meta:
        return None

    parsed: list[list[dict]] = []
    cik_int = str(int(cik))
    for fm in filings_meta:
        acc = fm.get("accession", "")
        if not acc:
            continue
        acc_nd = acc.replace("-", "")
        info_key = f"superinv:xml:{cik}:{acc_nd}"
        holdings = cache.get(info_key)
        if holdings is None:
            index_url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nd}/"
            try:
                with httpx.Client(timeout=10.0, headers=_headers(), follow_redirects=True) as c:
                    idx_r = c.get(index_url + "index.json")
                    if idx_r.status_code != 200:
                        continue
                    items = idx_r.json().get("directory", {}).get("item", [])
                    xml_doc = None
                    for item in items:
                        nm = (item.get("name") or "").lower()
                        if "infotable" in nm and nm.endswith(".xml"):
                            xml_doc = item["name"]
                            break
                        if nm.endswith(".xml") and "13f" in nm:
                            xml_doc = item["name"]
                    if not xml_doc:
                        continue
                    xml_r = c.get(f"{index_url}{xml_doc}")
                    if xml_r.status_code != 200:
                        continue
                    holdings = inst._parse_13f_xml(
                        xml_r.text, cik, "", fm.get("filing_date", ""), acc,
                    )
                    cache.set(info_key, holdings, sec_edgar.SUBMISSIONS_TTL)
            except (httpx.HTTPError, ET.ParseError, ValueError) as e:
                log.warning("superinvestors: info table fetch failed for %s/%s: %s", cik, acc, e)
                continue
        if holdings:
            parsed.append(holdings)

    if not parsed:
        return None
    current = parsed[0]
    prior = parsed[1] if len(parsed) > 1 else []
    return current, prior


def _classify_move(cur_shares: int, prev_shares: int | None) -> tuple[str, float]:
    """Quarter-over-quarter move classification + percent change."""
    if prev_shares is None or prev_shares == 0:
        return "New", 100.0
    if cur_shares == 0:
        return "Sold", -100.0
    delta_pct = round((cur_shares - prev_shares) / prev_shares * 100.0, 1)
    if cur_shares > prev_shares:
        return "Add", delta_pct
    if cur_shares < prev_shares:
        return "Trim", delta_pct
    return "Add", 0.0


def _live_manager_rows(mgr: dict) -> dict | None:
    """Build one manager's enriched record from live 13F data, or None."""
    res = _fetch_info_table_xml(mgr["cik"])
    if res is None:
        return None
    current, prior = res

    # Aggregate current holdings by issuer (a name can appear as multiple lots).
    def agg(rows: list[dict]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for h in rows:
            cusip = (h.get("cusip") or "").strip()
            key = cusip or (h.get("name_of_issuer") or "").strip()
            if not key:
                continue
            val = (h.get("value_x1000") or 0) * 1000
            sh = h.get("shares") or 0
            if key not in out:
                out[key] = {
                    "name": h.get("name_of_issuer") or key,
                    "symbol": _resolve_symbol(cusip, h.get("symbol")),
                    "value": 0,
                    "shares": 0,
                }
            out[key]["value"] += val
            out[key]["shares"] += sh
        return out

    cur_agg = agg(current)
    prior_agg = agg(prior)
    if not cur_agg:
        return None

    total = sum(v["value"] for v in cur_agg.values()) or 1
    ranked = sorted(cur_agg.items(), key=lambda kv: kv[1]["value"], reverse=True)

    positions: list[dict] = []
    for key, v in ranked[:TOP_N]:
        prev = prior_agg.get(key)
        prev_shares = prev["shares"] if prev else None
        move, move_pct = _classify_move(int(v["shares"]), prev_shares)
        positions.append({
            "symbol": v["symbol"] or _issuer_label(v["name"]),
            "name": v["name"],
            "weight": round(v["value"] / total * 100.0, 2),
            "market_value": int(v["value"]),
            "shares": int(v["shares"]),
            "move": move,
            "move_pct": move_pct,
        })

    if not positions:
        return None

    return _finalize_manager(mgr, positions, total, len(cur_agg))


def _issuer_label(name: str) -> str:
    """Honest display fallback when CUSIP->ticker is unresolved: a cleaned
    issuer name (NOT a fabricated ticker). Reads as a company, not a symbol."""
    words = (name or "").strip().title().split()
    if not words:
        return "--"
    label = " ".join(words[:2])
    return label.replace("Com Inc", "").replace(" Inc", "").strip() or words[0]


def _live_payload() -> dict | None:
    started = time.monotonic()
    managers: list[dict] = []
    for mgr in MANAGERS[:LIVE_MAX_MANAGERS]:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        try:
            rec = _live_manager_rows(mgr)
        except Exception as e:  # never let one manager break the scan
            log.warning("superinvestors: live build failed for %s: %s", mgr["name"], e)
            rec = None
        if rec is not None:
            managers.append(rec)

    # Require a meaningful fraction to resolve live, else fall back to sample.
    if len(managers) < max(3, LIVE_MAX_MANAGERS // 2):
        return None
    return _assemble(managers, data_mode="live", source="sec-edgar")


# ---------------------------------------------------------------------------
# Sample path
# ---------------------------------------------------------------------------

def _sample_payload() -> dict:
    managers: list[dict] = []
    for mgr in MANAGERS:
        rows = SAMPLE_PORTFOLIOS.get(mgr["cik"]) or []
        if not rows:
            continue
        total = sum(r[2] for r in rows) or 1
        positions: list[dict] = []
        for symbol, name, mv, shares, move, move_pct in rows:
            positions.append({
                "symbol": symbol,
                "name": name,
                "weight": round(mv / total * 100.0, 2),
                "market_value": int(mv),
                "shares": int(shares),
                "move": move,
                "move_pct": float(move_pct),
            })
        managers.append(_finalize_manager(mgr, positions, total, len(positions)))
    return _assemble(managers, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Shared assembly
# ---------------------------------------------------------------------------

def _finalize_manager(mgr: dict, positions: list[dict], total: float,
                      position_count: int) -> dict:
    positions = sorted(positions, key=lambda p: p["weight"], reverse=True)
    # Top buy = largest non-sold add/new by weight; top sell = trim/sold.
    buys = [p for p in positions if p["move"] in ("New", "Add")]
    sells = [p for p in positions if p["move"] in ("Trim", "Sold")]
    top_buy = buys[0]["symbol"] if buys else None
    top_sell = sells[0]["symbol"] if sells else None
    return {
        "name": mgr["name"],
        "firm": mgr["firm"],
        "cik": mgr["cik"],
        "manager": mgr["manager"],
        "portfolio_value": int(total),
        "position_count": int(position_count),
        "top_positions": positions,
        "top_buy": top_buy,
        "top_sell": top_sell,
    }


def _build_consensus(managers: list[dict]) -> list[dict]:
    """Names most widely held across the tracked managers (held_by count, then
    aggregate reported value)."""
    bucket: dict[str, dict] = {}
    for m in managers:
        for p in m["top_positions"]:
            sym = p["symbol"]
            if not sym or sym == "--":
                continue
            b = bucket.setdefault(sym, {"symbol": sym, "name": p["name"],
                                        "held_by": 0, "total_value": 0})
            b["held_by"] += 1
            b["total_value"] += p["market_value"]
    rows = sorted(
        bucket.values(),
        key=lambda r: (r["held_by"], r["total_value"]),
        reverse=True,
    )
    return [
        {"symbol": r["symbol"], "name": r["name"], "held_by": r["held_by"],
         "total_value": int(r["total_value"])}
        for r in rows[:CONSENSUS_N]
    ]


def _assemble(managers: list[dict], *, data_mode: str, source: str) -> dict:
    managers = sorted(managers, key=lambda m: m["portfolio_value"], reverse=True)
    consensus = _build_consensus(managers)
    total_aum = int(sum(m["portfolio_value"] for m in managers))
    most_held = consensus[0]["symbol"] if consensus else None
    return {
        "managers": managers,
        "consensus": consensus,
        "summary": {
            "manager_count": len(managers),
            "total_aum": total_aum,
            "most_held": most_held,
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def superinvestors() -> dict:
    """Track famous managers' 13F portfolios. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and
    tags the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("managers"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("superinvestors live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("superinvestors sample path failed hard: %s", e)
        return {
            "managers": [],
            "consensus": [],
            "summary": {"manager_count": 0, "total_aum": 0, "most_held": None},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
