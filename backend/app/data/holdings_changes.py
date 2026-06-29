"""13F Change-Tracking & Hedge-Fund Clustering (Bloomberg `HDS`).

A quarter-over-quarter DELTA engine layered on the same SEC EDGAR 13F-HR data the
superinvestor tracker (`superinvestors.py`) already pulls. For each tracked manager
it classifies every position move since the prior filing: NEW BUYS (initiated),
SOLD-OUT (fully exited), ADDS (share count up) and TRIMS (share count down), with
the percent change in shares and the dollar change in reported value. It then rolls
those moves up into a market-wide view (which names drew the most new buys, the most
exits, the biggest net adds) and a CROWDING / clustering view (which names the most
managers concentrate in, and where managers are moving together - consensus buying
or selling the same name).

Live path: reuse the superinvestor module's manager roster, its CUSIP->ticker map,
and its bounded EDGAR current/prior 13F fetch. The scan is wall-clock bounded and
capped on managers fetched live; if too little resolves we return None so the caller
falls back to deterministic SAMPLE data.

Sample path: a realistic q/q tape - several managers initiating a hot AI name (NVDA),
broad trimming of a crowded mega-cap (AAPL), and a consensus sold-out (INTC) - plus a
crowding table. Deterministic and static so screenshots are stable. This module NEVER
raises - it always returns a populated payload with an internal data_mode
("live"|"sample") + as_of + source for honesty under the hood.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Reuse the superinvestor roster + CUSIP map (public, data-only surface). The heavy
# EDGAR current/prior fetch is reused too but accessed defensively below so an
# upstream rename degrades us to sample instead of raising.
try:
    from .superinvestors import CUSIP_TO_TICKER, MANAGERS
except Exception:  # pragma: no cover - superinvestors must exist, but never raise
    CUSIP_TO_TICKER = {}
    MANAGERS = []

# Live budget knobs - keep the scan FAST and bounded; never stall the request.
LIVE_BUDGET_S = 8.0
LIVE_MAX_MANAGERS = 8
TOP_N = 10              # rows retained in each market-wide / crowding leaderboard
PER_MANAGER_LIST_N = 6  # new-buy / sold-out rows kept per manager


# ---------------------------------------------------------------------------
# Small helpers (replicated, not imported, to avoid fragile private deps)
# ---------------------------------------------------------------------------

def _resolve_symbol(cusip: str, edgar_symbol: str | None) -> str | None:
    """Prefer an EDGAR-provided ticker, then the shared CUSIP map. None if neither."""
    if edgar_symbol:
        return edgar_symbol
    if cusip:
        return CUSIP_TO_TICKER.get(cusip.strip().upper())
    return None


def _issuer_label(name: str) -> str:
    """Honest display fallback when CUSIP->ticker is unresolved: a cleaned issuer
    name (NOT a fabricated ticker)."""
    words = (name or "").strip().title().split()
    if not words:
        return "--"
    label = " ".join(words[:2])
    return label.replace("Com Inc", "").replace(" Inc", "").strip() or words[0]


def _classify_move(cur_shares: int, prev_shares: int) -> tuple[str, float]:
    """Quarter-over-quarter move for a name held in BOTH quarters."""
    if prev_shares <= 0:
        return "New", 100.0
    if cur_shares == prev_shares:
        return "Hold", 0.0
    delta_pct = round((cur_shares - prev_shares) / prev_shares * 100.0, 1)
    return ("Add", delta_pct) if cur_shares > prev_shares else ("Trim", delta_pct)


# ---------------------------------------------------------------------------
# Live path
# ---------------------------------------------------------------------------

def _agg(rows: list[dict]) -> dict[str, dict]:
    """Aggregate raw 13F rows by issuer (a name can appear as multiple lots)."""
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


def _live_manager_delta(mgr: dict, fetch) -> dict | None:
    """Build one manager's q/q delta record from live 13F data, or None."""
    res = fetch(mgr["cik"])
    if res is None:
        return None
    current, prior = res
    cur_agg = _agg(current)
    prior_agg = _agg(prior)
    if not cur_agg or not prior_agg:
        # Need both quarters for a meaningful delta; degrade this manager.
        return None

    positions: list[dict] = []
    for key in set(cur_agg) | set(prior_agg):
        cur = cur_agg.get(key)
        prev = prior_agg.get(key)
        ref = cur or prev
        name = ref["name"]
        symbol = ref["symbol"] or _issuer_label(name)
        cur_val = int(cur["value"]) if cur else 0
        prev_val = int(prev["value"]) if prev else 0
        cur_sh = int(cur["shares"]) if cur else 0
        prev_sh = int(prev["shares"]) if prev else 0
        if cur and not prev:
            action, pct = "New", 100.0
        elif prev and not cur:
            action, pct = "Sold", -100.0
        else:
            action, pct = _classify_move(cur_sh, prev_sh)
        positions.append({
            "symbol": symbol,
            "name": name,
            "action": action,
            "pct": pct,
            "cur_value": cur_val,
            "prev_value": prev_val,
            "held": cur is not None,
        })

    return {"manager": mgr["name"], "firm": mgr["firm"], "positions": positions}


def _live_payload() -> dict | None:
    import time

    # Reuse the superinvestor EDGAR fetch defensively (private fn, guarded).
    try:
        from . import superinvestors as si
        fetch = getattr(si, "_fetch_info_table_xml", None)
    except Exception as e:
        log.warning("holdings_changes: superinvestors import failed: %s", e)
        return None
    if fetch is None or not MANAGERS:
        return None

    started = time.monotonic()
    recs: list[dict] = []
    for mgr in MANAGERS[:LIVE_MAX_MANAGERS]:
        if time.monotonic() - started > LIVE_BUDGET_S:
            break
        try:
            rec = _live_manager_delta(mgr, fetch)
        except Exception as e:  # never let one manager break the scan
            log.warning("holdings_changes: live delta failed for %s: %s", mgr.get("name"), e)
            rec = None
        if rec is not None and rec["positions"]:
            recs.append(rec)

    # Require a meaningful fraction to resolve live, else fall back to sample.
    if len(recs) < max(3, LIVE_MAX_MANAGERS // 2):
        return None
    return _assemble(recs, data_mode="live", source="sec-edgar")


# ---------------------------------------------------------------------------
# Sample path - deterministic, realistic q/q tape
# Each row: (symbol, name, action, pct, cur_value, prev_value)
# action in {New, Add, Trim, Sold, Hold}; held = action != "Sold".
# Narrative: NVDA is the consensus NEW BUY, INTC the consensus SOLD-OUT, AAPL the
# crowded mega-cap getting broadly trimmed.
# ---------------------------------------------------------------------------

SAMPLE_MANAGERS: list[tuple] = [
    ("Berkshire Hathaway", "Berkshire Hathaway Inc.", [
        ("AAPL", "Apple Inc.",            "Trim",  -13.0, 69_900_000_000, 80_300_000_000),
        ("AXP",  "American Express Co.",  "Hold",    0.0, 41_100_000_000, 41_100_000_000),
        ("BAC",  "Bank of America Corp.", "Trim",  -18.0, 30_600_000_000, 37_300_000_000),
        ("KO",   "Coca-Cola Co.",         "Hold",    0.0, 28_700_000_000, 28_700_000_000),
        ("CVX",  "Chevron Corp.",         "Add",     3.2, 18_800_000_000, 18_200_000_000),
        ("OXY",  "Occidental Petroleum",  "Add",     2.9, 13_100_000_000, 12_700_000_000),
        ("NVDA", "NVIDIA Corp.",          "New",   100.0,  4_000_000_000,             0),
        ("INTC", "Intel Corp.",           "Sold", -100.0,             0,  2_100_000_000),
    ]),
    ("Pershing Square", "Pershing Square Capital Mgmt", [
        ("NVDA", "NVIDIA Corp.",          "New",   100.0,  2_600_000_000,             0),
        ("UBER", "Uber Technologies Inc.","Add",    12.0,  2_270_000_000,  2_030_000_000),
        ("BN",   "Brookfield Corp.",      "Add",    11.0,  1_840_000_000,  1_660_000_000),
        ("HLT",  "Hilton Worldwide",      "Add",     4.0,  1_690_000_000,  1_620_000_000),
        ("CMG",  "Chipotle Mexican Grill","Trim",   -9.0,  1_530_000_000,  1_680_000_000),
        ("INTC", "Intel Corp.",           "Sold", -100.0,             0,    410_000_000),
    ]),
    ("Scion Asset Management", "Scion Asset Management LLC", [
        ("NVDA", "NVIDIA Corp.",          "New",   100.0,     52_000_000,             0),
        ("BABA", "Alibaba Group Holding", "Add",    45.0,     16_900_000,     11_650_000),
        ("JD",   "JD.com Inc.",           "Add",    60.0,     13_600_000,      8_500_000),
        ("MOH",  "Molina Healthcare Inc.","New",   100.0,      4_700_000,             0),
        ("REAL", "The RealReal Inc.",     "Sold", -100.0,             0,      1_600_000),
    ]),
    ("Appaloosa Management", "Appaloosa LP", [
        ("NVDA", "NVIDIA Corp.",          "New",   100.0,    430_000_000,             0),
        ("BABA", "Alibaba Group Holding", "Add",    18.0,    720_000_000,    610_000_000),
        ("AMZN", "Amazon.com Inc.",       "Add",     8.0,    540_000_000,    500_000_000),
        ("META", "Meta Platforms Inc.",   "Trim",   -6.0,    510_000_000,    543_000_000),
        ("AAPL", "Apple Inc.",            "Trim",  -11.0,    360_000_000,    405_000_000),
        ("MSFT", "Microsoft Corp.",       "Hold",    0.0,    360_000_000,    360_000_000),
    ]),
    ("Bridgewater Associates", "Bridgewater Associates LP", [
        ("AAPL", "Apple Inc.",            "Trim",  -10.0,    410_000_000,    456_000_000),
        ("GOOGL","Alphabet Inc. Class A", "Add",     5.0,    640_000_000,    610_000_000),
        ("NVDA", "NVIDIA Corp.",          "Trim",  -22.0,    480_000_000,    615_000_000),
        ("PG",   "Procter & Gamble Co.",  "Add",     2.0,    520_000_000,    510_000_000),
        ("META", "Meta Platforms Inc.",   "Trim",  -11.0,    360_000_000,    405_000_000),
        ("INTC", "Intel Corp.",           "Sold", -100.0,             0,    140_000_000),
    ]),
    ("Greenlight Capital", "Greenlight Capital Inc.", [
        ("AAPL", "Apple Inc.",            "Trim",   -8.0,    140_000_000,    152_000_000),
        ("HPQ",  "HP Inc.",               "New",   100.0,    140_000_000,             0),
        ("CNXC", "Concentrix Corp.",      "Add",    12.0,    180_000_000,    161_000_000),
        ("GRBK", "Green Brick Partners",  "Hold",    0.0,    450_000_000,    450_000_000),
        ("INTC", "Intel Corp.",           "Sold", -100.0,             0,     95_000_000),
    ]),
    ("Third Point", "Third Point LLC", [
        ("AMZN", "Amazon.com Inc.",       "Add",     5.0,    610_000_000,    580_000_000),
        ("META", "Meta Platforms Inc.",   "Add",     8.0,    560_000_000,    518_000_000),
        ("AAPL", "Apple Inc.",            "Trim",   -7.0,    300_000_000,    323_000_000),
        ("KKR",  "KKR & Co. Inc.",        "New",   100.0,    380_000_000,             0),
        ("MSFT", "Microsoft Corp.",       "Trim",   -7.0,    430_000_000,    462_000_000),
    ]),
    ("Duquesne Family Office", "Duquesne Family Office LLC", [
        ("NVDA", "NVIDIA Corp.",          "New",   100.0,    310_000_000,             0),
        ("MSFT", "Microsoft Corp.",       "Add",     6.0,    300_000_000,    283_000_000),
        ("AAPL", "Apple Inc.",            "Hold",    0.0,    250_000_000,    250_000_000),
        ("CPNG", "Coupang Inc.",          "Add",    30.0,    280_000_000,    215_000_000),
        ("WFC",  "Wells Fargo & Co.",     "Trim",  -18.0,    190_000_000,    232_000_000),
        ("AGCO", "AGCO Corp.",            "Sold", -100.0,             0,    150_000_000),
    ]),
]


def _sample_payload() -> dict:
    recs: list[dict] = []
    for manager, firm, rows in SAMPLE_MANAGERS:
        positions = [
            {
                "symbol": symbol,
                "name": name,
                "action": action,
                "pct": float(pct),
                "cur_value": int(cur_val),
                "prev_value": int(prev_val),
                "held": action != "Sold",
            }
            for symbol, name, action, pct, cur_val, prev_val in rows
        ]
        recs.append({"manager": manager, "firm": firm, "positions": positions})
    return _assemble(recs, data_mode="sample", source="sample")


# ---------------------------------------------------------------------------
# Shared assembly: per-manager changes + market-wide moves + crowding
# ---------------------------------------------------------------------------

def _finalize_manager(rec: dict) -> dict:
    positions = rec["positions"]
    new_buys = sorted(
        (p for p in positions if p["action"] == "New"),
        key=lambda p: p["cur_value"], reverse=True,
    )
    sold_out = sorted(
        (p for p in positions if p["action"] == "Sold"),
        key=lambda p: p["prev_value"], reverse=True,
    )
    adds = [p for p in positions if p["action"] == "Add"]
    trims = [p for p in positions if p["action"] == "Trim"]
    top_add = max(adds, key=lambda p: p["pct"], default=None)
    top_trim = min(trims, key=lambda p: p["pct"], default=None)
    net_change_value = int(sum(p["cur_value"] - p["prev_value"] for p in positions))
    return {
        "manager": rec["manager"],
        "firm": rec["firm"],
        "new_buys": [
            {"symbol": p["symbol"], "name": p["name"], "value": p["cur_value"]}
            for p in new_buys[:PER_MANAGER_LIST_N]
        ],
        "sold_out": [
            {"symbol": p["symbol"], "name": p["name"]}
            for p in sold_out[:PER_MANAGER_LIST_N]
        ],
        "top_add": {"symbol": top_add["symbol"], "pct": top_add["pct"]} if top_add else None,
        "top_trim": {"symbol": top_trim["symbol"], "pct": top_trim["pct"]} if top_trim else None,
        "net_change_value": net_change_value,
    }


def _assemble(recs: list[dict], *, data_mode: str, source: str) -> dict:
    new_buy_bucket: dict[str, dict] = {}
    sold_bucket: dict[str, dict] = {}
    add_bucket: dict[str, dict] = {}
    crowd: dict[str, dict] = {}

    for m in recs:
        for p in m["positions"]:
            sym = p["symbol"]
            if not sym or sym == "--":
                continue
            name = p["name"]
            action = p["action"]
            net = p["cur_value"] - p["prev_value"]

            if p["held"]:
                c = crowd.setdefault(sym, {"name": name, "held_by": 0,
                                           "combined_value": 0, "buy": 0, "sell": 0})
                c["held_by"] += 1
                c["combined_value"] += p["cur_value"]
                if action in ("New", "Add"):
                    c["buy"] += 1
                elif action == "Trim":
                    c["sell"] += 1

            if action == "New":
                b = new_buy_bucket.setdefault(sym, {"name": name, "manager_count": 0,
                                                    "total_value": 0})
                b["manager_count"] += 1
                b["total_value"] += p["cur_value"]
            if action == "Sold":
                s = sold_bucket.setdefault(sym, {"name": name, "manager_count": 0})
                s["manager_count"] += 1
            if action in ("New", "Add") and net > 0:
                a = add_bucket.setdefault(sym, {"name": name, "net_value": 0})
                a["net_value"] += net

    top_new_buys = [
        {"symbol": s, "name": v["name"], "manager_count": v["manager_count"],
         "total_value": int(v["total_value"])}
        for s, v in sorted(new_buy_bucket.items(),
                           key=lambda kv: (kv[1]["manager_count"], kv[1]["total_value"]),
                           reverse=True)[:TOP_N]
    ]
    top_sold_out = [
        {"symbol": s, "name": v["name"], "manager_count": v["manager_count"]}
        for s, v in sorted(sold_bucket.items(),
                           key=lambda kv: kv[1]["manager_count"], reverse=True)[:TOP_N]
    ]
    top_adds = [
        {"symbol": s, "name": v["name"], "net_value": int(v["net_value"])}
        for s, v in sorted(add_bucket.items(),
                           key=lambda kv: kv[1]["net_value"], reverse=True)[:TOP_N]
    ]

    def _action(buy: int, sell: int) -> str:
        if buy > sell:
            return "Buying"
        if sell > buy:
            return "Selling"
        return "Holding"

    crowding = [
        {"symbol": s, "name": v["name"], "held_by": v["held_by"],
         "combined_value": int(v["combined_value"]),
         "recent_action": _action(v["buy"], v["sell"])}
        for s, v in sorted(crowd.items(),
                           key=lambda kv: (kv[1]["held_by"], kv[1]["combined_value"]),
                           reverse=True)[:TOP_N]
    ]

    manager_changes = sorted(
        (_finalize_manager(m) for m in recs),
        key=lambda m: abs(m["net_change_value"]), reverse=True,
    )

    return {
        "manager_changes": manager_changes,
        "market_moves": {
            "top_new_buys": top_new_buys,
            "top_sold_out": top_sold_out,
            "top_adds": top_adds,
        },
        "crowding": crowding,
        "summary": {
            "most_bought": top_new_buys[0]["symbol"] if top_new_buys else None,
            "most_sold": top_sold_out[0]["symbol"] if top_sold_out else None,
            "most_crowded": crowding[0]["symbol"] if crowding else None,
            "manager_count": len(recs),
        },
        "data_mode": data_mode,
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def holdings_changes() -> dict:
    """13F quarter-over-quarter change + crowding engine. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data and tags
    the payload with data_mode / as_of / source.
    """
    try:
        live = _live_payload()
        if live is not None and live.get("manager_changes"):
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("holdings_changes live path failed, returning sample: %s", e)
    try:
        return _sample_payload()
    except Exception as e:
        log.error("holdings_changes sample path failed hard: %s", e)
        return {
            "manager_changes": [],
            "market_moves": {"top_new_buys": [], "top_sold_out": [], "top_adds": []},
            "crowding": [],
            "summary": {"most_bought": None, "most_sold": None,
                        "most_crowded": None, "manager_count": 0},
            "data_mode": "sample",
            "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": "sample",
        }
