"""Alerts engine.

Owns two self-contained DuckDB tables (alert_rules, alert_events) created
lazily via CREATE TABLE IF NOT EXISTS - we do NOT touch db/schema.sql. On first
use ~5 sample rules and a handful of sample events are seeded so the Alerts
panel is fully populated for screenshots, even with no market data available.

A rule fires when current market data crosses its condition. Conditions:
    price_above   - last close >= threshold
    price_below   - last close <= threshold
    pct_move      - abs(1-day % move) >= threshold
    rsi_above     - RSI(14) >= threshold
    rsi_below     - RSI(14) <= threshold
    regime_change - current regime label != the rule's stored baseline (note)

Design contract (matches the rest of the terminal):
- No public function raises. On any failure we degrade to sample data.
- Every payload carries data_mode ("live" | "sample"), as_of (ISO Z), source.
- Current data is read via fetch_arbitrary_ticker / regime detection; when a
  feed is cold we fall back to deterministic sample prices so the Evaluate
  button always returns something.
"""
from __future__ import annotations

import hashlib
import logging
import threading
from datetime import datetime

from ..db import engine as db

log = logging.getLogger(__name__)

VALID_TYPES = (
    "price_above", "price_below", "pct_move",
    "rsi_above", "rsi_below", "regime_change",
)

_READY_LOCK = threading.Lock()
_READY = False


# ---------- Lazy table creation + seeding ----------

_DDL = [
    "CREATE SEQUENCE IF NOT EXISTS seq_alert_rules START 1",
    """
    CREATE TABLE IF NOT EXISTS alert_rules (
        id          BIGINT PRIMARY KEY DEFAULT nextval('seq_alert_rules'),
        rule_type   VARCHAR NOT NULL,
        symbol      VARCHAR NOT NULL,
        threshold   DOUBLE,
        note        VARCHAR,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP DEFAULT now()
    )
    """,
    "CREATE SEQUENCE IF NOT EXISTS seq_alert_events START 1",
    """
    CREATE TABLE IF NOT EXISTS alert_events (
        id              BIGINT PRIMARY KEY DEFAULT nextval('seq_alert_events'),
        rule_id         BIGINT,
        rule_type       VARCHAR NOT NULL,
        symbol          VARCHAR NOT NULL,
        message         VARCHAR NOT NULL,
        observed_value  DOUBLE,
        threshold       DOUBLE,
        triggered_at    TIMESTAMP DEFAULT now()
    )
    """,
]

# (rule_type, symbol, threshold, note) - deterministic seed set, ~5 rules.
_SEED_RULES = [
    ("price_above",   "AAPL", 250.0, "Trim into strength above 250"),
    ("price_below",   "NVDA", 95.0,  "Add on a pullback under 95"),
    ("pct_move",      "TSLA", 5.0,   "Flag any 5%+ single-day move"),
    ("rsi_above",     "SPY",  70.0,  "SPY overbought watch"),
    ("rsi_below",     "QQQ",  30.0,  "QQQ oversold bounce setup"),
    ("regime_change", "^VIX", None,  "risk_on"),
]

# Sample events seeded on first use (rule_type, symbol, message, observed, thr, hours_ago).
_SEED_EVENTS = [
    ("price_above", "AAPL", "AAPL crossed above 250.00 (last 252.310)", 252.31, 250.0, 3),
    ("pct_move",    "TSLA", "TSLA moved 6.2% in a session (>= 5.0%)",     6.2,   5.0,   9),
    ("rsi_below",   "QQQ",  "QQQ RSI(14) at 28.4 (<= 30.0)",             28.4,  30.0,  21),
    ("regime_change", "^VIX", "Regime shifted to risk_off (was risk_on)", None, None, 27),
]


def _ensure_ready() -> None:
    """Create tables (idempotent) and seed sample rules/events on first use."""
    global _READY
    if _READY:
        return
    with _READY_LOCK:
        if _READY:
            return
        try:
            with db.conn() as c:
                for stmt in _DDL:
                    c.execute(stmt)
                _seed(c)
            _READY = True
        except Exception as e:  # pragma: no cover - degrade silently, retry next call
            log.warning("alerts _ensure_ready failed: %s", e)


def _seed(c) -> None:
    """Populate sample rules + events the first time the tables are empty."""
    rule_cnt = c.execute("SELECT COUNT(*) FROM alert_rules").fetchone()
    if rule_cnt and int(rule_cnt[0]) > 0:
        return  # already seeded - do nothing

    rule_ids: list[int] = []
    for rtype, sym, thr, note in _SEED_RULES:
        r = c.execute(
            "INSERT INTO alert_rules (rule_type, symbol, threshold, note) "
            "VALUES (?, ?, ?, ?) RETURNING id",
            [rtype, sym, thr, note],
        ).fetchone()
        rule_ids.append(int(r[0]))

    # Map seed events back to a plausible rule id by (type, symbol) when possible.
    by_key = {(rt, s.upper()): rid for (rt, s, _t, _n), rid in zip(_SEED_RULES, rule_ids)}
    for rtype, sym, msg, observed, thr, hours_ago in _SEED_EVENTS:
        rid = by_key.get((rtype, sym.upper()))
        c.execute(
            "INSERT INTO alert_events "
            "(rule_id, rule_type, symbol, message, observed_value, threshold, triggered_at) "
            "VALUES (?, ?, ?, ?, ?, ?, now() - INTERVAL (?) HOUR)",
            [rid, rtype, sym.upper(), msg, observed, thr, int(hours_ago)],
        )
    log.info("alerts: seeded %d sample rules + %d events", len(rule_ids), len(_SEED_EVENTS))


# ---------- Row mappers ----------

def _rule_row(r) -> dict:
    return {
        "id": int(r[0]),
        "rule_type": r[1],
        "symbol": r[2],
        "threshold": float(r[3]) if r[3] is not None else None,
        "note": r[4],
        "active": bool(r[5]) if r[5] is not None else True,
        "created_at": str(r[6]) if r[6] else None,
    }


def _event_row(r) -> dict:
    return {
        "id": int(r[0]),
        "rule_id": int(r[1]) if r[1] is not None else None,
        "rule_type": r[2],
        "symbol": r[3],
        "message": r[4],
        "observed_value": float(r[5]) if r[5] is not None else None,
        "threshold": float(r[6]) if r[6] is not None else None,
        "triggered_at": str(r[7]) if r[7] else None,
    }


_RULE_COLS = "id, rule_type, symbol, threshold, note, active, created_at"
_EVENT_COLS = "id, rule_id, rule_type, symbol, message, observed_value, threshold, triggered_at"


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _meta(mode: str = "live", source: str = "alerts-engine") -> dict:
    return {"data_mode": mode, "as_of": _now_iso(), "source": source}


# ---------- Market data helpers (never raise) ----------

def _sample_price(symbol: str) -> float:
    """Deterministic pseudo-price seeded off the symbol (hashlib), 20-520 range."""
    h = int(hashlib.sha256(symbol.upper().encode()).hexdigest(), 16)
    return round(20.0 + (h % 50000) / 100.0, 2)


def _closes(symbol: str, days: int) -> tuple[list[float], bool]:
    """Return (close_values, is_live). Live via fetch_arbitrary_ticker, else sample walk."""
    try:
        from ..data.macro_data import fetch_arbitrary_ticker
        pts = fetch_arbitrary_ticker(symbol, days=days)
        vals = [float(p["value"]) for p in pts if p.get("value") is not None]
        if len(vals) >= 2:
            return vals, True
    except Exception as e:
        log.warning("alerts _closes(%s) failed: %s", symbol, e)
    # Deterministic sample series so RSI/pct_move still have something to chew on.
    base = _sample_price(symbol)
    h = int(hashlib.sha256(symbol.upper().encode()).hexdigest(), 16)
    out: list[float] = []
    v = base * 0.9
    for i in range(max(2, days)):
        drift = ((h >> (i % 32)) & 0xFF) / 255.0 - 0.5  # -0.5..0.5, deterministic
        v = max(1.0, v * (1.0 + drift * 0.02))
        out.append(round(v, 2))
    return out, False


def _rsi(closes: list[float], period: int = 14) -> float | None:
    """Wilder RSI on a close series. Returns None when too short."""
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0.0)) / period
    if avg_loss == 0.0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 2)


def _current_regime() -> tuple[str, bool]:
    """Return (regime_label, is_live). Degrades to 'transition' on any failure."""
    try:
        from ..data import macro_data
        from ..regime import regime_model
        vix = macro_data.fetch_series("^VIX", days=30)
        y2 = macro_data.fetch_series("DGS2", days=30)
        y10 = macro_data.fetch_series("DGS10", days=30)
        state = regime_model.detect_current(vix, y2, y10)
        live = bool(vix and y2 and y10)
        return state.label, live
    except Exception as e:
        log.warning("alerts _current_regime failed: %s", e)
        return "transition", False


# ---------- Public API ----------

def list_rules() -> dict:
    """All alert rules (sample set seeded on first call). Never raises."""
    _ensure_ready()
    try:
        rows = db.fetchall(f"SELECT {_RULE_COLS} FROM alert_rules ORDER BY id")
        rules = [_rule_row(r) for r in rows]
        return {"rules": rules, "count": len(rules), **_meta()}
    except Exception as e:
        log.warning("list_rules failed: %s", e)
        rules = [
            {"id": i + 1, "rule_type": rt, "symbol": s, "threshold": t,
             "note": n, "active": True, "created_at": None}
            for i, (rt, s, t, n) in enumerate(_SEED_RULES)
        ]
        return {"rules": rules, "count": len(rules), **_meta("sample", "sample")}


def create_rule(rule: dict) -> dict:
    """Create an alert rule. Validates the type; never raises."""
    _ensure_ready()
    rule = rule or {}
    rtype = str(rule.get("type") or rule.get("rule_type") or "").strip()
    if rtype not in VALID_TYPES:
        rtype = "price_above"
    symbol = str(rule.get("symbol") or "SPY").upper().strip() or "SPY"
    note = rule.get("note")
    note = str(note) if note is not None else None
    try:
        threshold = float(rule["threshold"]) if rule.get("threshold") is not None else None
    except (TypeError, ValueError):
        threshold = None
    try:
        with db.conn() as c:
            r = c.execute(
                f"INSERT INTO alert_rules (rule_type, symbol, threshold, note) "
                f"VALUES (?, ?, ?, ?) RETURNING {_RULE_COLS}",
                [rtype, symbol, threshold, note],
            ).fetchone()
        return {"rule": _rule_row(r), **_meta()}
    except Exception as e:
        log.warning("create_rule failed: %s", e)
        return {
            "rule": {"id": 0, "rule_type": rtype, "symbol": symbol,
                     "threshold": threshold, "note": note, "active": True,
                     "created_at": None},
            **_meta("sample", "sample"),
        }


def delete_rule(rule_id) -> dict:
    """Delete a rule by id. Never raises."""
    _ensure_ready()
    try:
        rid = int(rule_id)
    except (TypeError, ValueError):
        return {"deleted": False, "id": rule_id, **_meta("sample", "sample")}
    try:
        n = db.execute("DELETE FROM alert_rules WHERE id = ?", [rid])
        return {"deleted": bool(n), "id": rid, **_meta()}
    except Exception as e:
        log.warning("delete_rule(%s) failed: %s", rule_id, e)
        return {"deleted": False, "id": rid, **_meta("sample", "sample")}


def evaluate_rules() -> dict:
    """Check every rule against current data, log fires to alert_events.

    Returns {triggered:[event...], checked:int, data_mode, as_of, source}.
    Never raises.
    """
    _ensure_ready()
    triggered: list[dict] = []
    checked = 0
    any_live = False

    try:
        rows = db.fetchall(f"SELECT {_RULE_COLS} FROM alert_rules ORDER BY id")
    except Exception as e:
        log.warning("evaluate_rules load failed: %s", e)
        rows = []

    for r in rows:
        rule = _rule_row(r)
        if not rule.get("active", True):
            continue
        checked += 1
        try:
            fire, observed, message, live = _evaluate_one(rule)
            any_live = any_live or live
            if fire:
                ev = _record_event(rule, observed, message)
                if ev:
                    triggered.append(ev)
        except Exception as e:  # pragma: no cover - one bad rule can't break the run
            log.warning("evaluate rule %s failed: %s", rule.get("id"), e)

    return {
        "triggered": triggered,
        "checked": checked,
        **_meta("live" if any_live else "sample",
                "alerts-engine" if any_live else "sample"),
    }


def _evaluate_one(rule: dict) -> tuple[bool, float | None, str, bool]:
    """Return (fired, observed_value, message, is_live) for a single rule."""
    rtype = rule["rule_type"]
    sym = rule["symbol"]
    thr = rule.get("threshold")

    if rtype == "regime_change":
        label, live = _current_regime()
        baseline = (rule.get("note") or "").strip()
        fired = bool(baseline) and label != baseline
        msg = (f"Regime now {label} (baseline {baseline})" if fired
               else f"Regime steady at {label}")
        return fired, None, msg, live

    if rtype in ("price_above", "price_below"):
        closes, live = _closes(sym, 7)
        last = closes[-1] if closes else None
        if last is None or thr is None:
            return False, last, f"{sym}: no data", live
        fired = last >= thr if rtype == "price_above" else last <= thr
        op = ">=" if rtype == "price_above" else "<="
        msg = f"{sym} {last:.2f} {op} {thr:.2f}" if fired else f"{sym} {last:.2f} (target {thr:.2f})"
        return fired, last, msg, live

    if rtype == "pct_move":
        closes, live = _closes(sym, 5)
        if len(closes) < 2 or thr is None:
            return False, None, f"{sym}: no data", live
        prev, last = closes[-2], closes[-1]
        pct = ((last - prev) / prev * 100.0) if prev else 0.0
        fired = abs(pct) >= thr
        msg = (f"{sym} moved {pct:+.2f}% (|move| >= {thr:.2f}%)" if fired
               else f"{sym} moved {pct:+.2f}% (target {thr:.2f}%)")
        return fired, round(pct, 2), msg, live

    if rtype in ("rsi_above", "rsi_below"):
        closes, live = _closes(sym, 60)
        val = _rsi(closes)
        if val is None or thr is None:
            return False, val, f"{sym}: insufficient data for RSI", live
        fired = val >= thr if rtype == "rsi_above" else val <= thr
        op = ">=" if rtype == "rsi_above" else "<="
        msg = f"{sym} RSI(14) {val:.1f} {op} {thr:.1f}" if fired else f"{sym} RSI(14) {val:.1f} (target {thr:.1f})"
        return fired, val, msg, live

    return False, None, f"{sym}: unknown rule type {rtype}", False


def _record_event(rule: dict, observed: float | None, message: str) -> dict | None:
    """Insert a fired event and return it. Never raises (returns None on failure)."""
    try:
        with db.conn() as c:
            r = c.execute(
                f"INSERT INTO alert_events "
                f"(rule_id, rule_type, symbol, message, observed_value, threshold) "
                f"VALUES (?, ?, ?, ?, ?, ?) RETURNING {_EVENT_COLS}",
                [rule["id"], rule["rule_type"], rule["symbol"], message,
                 observed, rule.get("threshold")],
            ).fetchone()
        return _event_row(r)
    except Exception as e:
        log.warning("_record_event failed: %s", e)
        return None


def list_events(limit: int = 50) -> dict:
    """Most recent triggered events, newest first. Never raises."""
    _ensure_ready()
    try:
        lim = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        lim = 50
    try:
        rows = db.fetchall(
            f"SELECT {_EVENT_COLS} FROM alert_events ORDER BY triggered_at DESC, id DESC LIMIT ?",
            [lim],
        )
        events = [_event_row(r) for r in rows]
        return {"events": events, "count": len(events), **_meta()}
    except Exception as e:
        log.warning("list_events failed: %s", e)
        events = [
            {"id": i + 1, "rule_id": None, "rule_type": rt, "symbol": s,
             "message": m, "observed_value": o, "threshold": t, "triggered_at": None}
            for i, (rt, s, m, o, t, _h) in enumerate(_SEED_EVENTS)
        ]
        return {"events": events, "count": len(events), **_meta("sample", "sample")}
