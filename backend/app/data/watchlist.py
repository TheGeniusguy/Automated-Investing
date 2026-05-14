"""Watchlist module — what the correlation engine and downstream panels scan.

The default watchlist is intentionally compact: liquid, well-known instruments
that span asset classes so correlation breakdowns surface meaningful
cross-asset signals rather than within-sector noise.

Structure:
  groups: ordered list of group names (for stable matrix axis ordering)
  members: dict of group -> list of {ticker, label} dicts

The default covers:
  - Broad equity: SPY, QQQ, IWM
  - Macro:        ^VIX, DX-Y.NYB, GLD, TLT, BTC-USD
  - Sectors:      XLF, XLE, XLK, XLV, XLI, XLU, XLP, XLY

This can be overridden by writing JSON to backend/watchlist.json (gitignored).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class WatchlistEntry:
    ticker: str
    label: str
    group: str


DEFAULT_GROUPS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Equity", [
        ("SPY",  "S&P 500"),
        ("QQQ",  "Nasdaq 100"),
        ("IWM",  "Russell 2000"),
    ]),
    ("Macro", [
        ("^VIX",     "VIX"),
        ("DX-Y.NYB", "Dollar Index"),
        ("GLD",      "Gold"),
        ("TLT",      "20Y+ Treasuries"),
        ("BTC-USD",  "Bitcoin"),
    ]),
    ("Sectors", [
        ("XLF", "Financials"),
        ("XLE", "Energy"),
        ("XLK", "Technology"),
        ("XLV", "Health Care"),
        ("XLI", "Industrials"),
        ("XLU", "Utilities"),
        ("XLP", "Staples"),
        ("XLY", "Discretionary"),
    ]),
]


def _watchlist_file() -> Path:
    # repo-root/backend/watchlist.json
    return Path(__file__).parent.parent.parent / "watchlist.json"


def load_watchlist() -> list[WatchlistEntry]:
    """Return the active watchlist. Falls back to DEFAULT_GROUPS if no override."""
    override = _watchlist_file()
    if override.exists():
        try:
            data = json.loads(override.read_text())
            entries: list[WatchlistEntry] = []
            for group in data.get("groups", []):
                gname = group["name"]
                for item in group["members"]:
                    entries.append(WatchlistEntry(item["ticker"], item.get("label", item["ticker"]), gname))
            if entries:
                return entries
        except Exception as e:
            log.warning("watchlist.json present but unreadable (%s) — using default", e)
    out: list[WatchlistEntry] = []
    for gname, members in DEFAULT_GROUPS:
        for ticker, label in members:
            out.append(WatchlistEntry(ticker, label, gname))
    return out


def watchlist_meta() -> dict:
    """JSON-serializable view for the frontend."""
    return {
        "groups": [
            {
                "name": g.group,
                "members": [
                    {"ticker": e.ticker, "label": e.label}
                    for e in load_watchlist()
                    if e.group == g.group
                ],
            }
            for g in _unique_groups(load_watchlist())
        ],
        "tickers": [e.ticker for e in load_watchlist()],
    }


def _unique_groups(entries: list[WatchlistEntry]) -> list[WatchlistEntry]:
    """One representative per group, preserving original order."""
    seen: set[str] = set()
    out: list[WatchlistEntry] = []
    for e in entries:
        if e.group not in seen:
            seen.add(e.group)
            out.append(e)
    return out
