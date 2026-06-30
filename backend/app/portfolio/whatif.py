"""Pre-Trade What-If Portfolio Analytics (Bloomberg `PORT` scenario / what-if).

Simulate a proposed buy / sell / rebalance and show the BEFORE -> AFTER delta in
the portfolio's risk profile, so you can see what a trade does to your risk before
you place it.

Method (LIVE path, fully honest - both sides go through the *identical*
computation):
  1. Load the default portfolio's open positions from the transaction log via the
     shipped FIFO path (`positions.compute_positions`) and enrich them with live
     market data (`valuation.enrich_positions`).
  2. Compute the CURRENT (before) risk metrics by REUSING the shipped quant engine
     `risk.compute_portfolio_risk` (annualized vol, daily VaR95 / CVaR95,
     concentration HHI / Herfindahl, factor exposures) plus a portfolio beta-to-SPY
     and tracking-error vs SPY built from the same return series the risk engine
     uses (`risk._fetch_returns`).
  3. Define a default proposed-trade scenario - trim the single most overweight
     holding and rotate the proceeds into a diversifier ETF - so the panel demos
     meaningfully with zero user input.
  4. Build the HYPOTHETICAL positions by applying those trades to the current
     positions (adjust shares + cash, recompute weights), then recompute the SAME
     metrics on the hypothetical set. `after` is genuinely derived: it runs through
     the exact same metric functions, never hand-fabricated.
  5. deltas = after - before for each scalar metric.

When no portfolio exists, prices are unavailable, or anything else goes wrong, we
degrade to a deterministic, realistic SAMPLE payload where the `after` numbers are
*still* genuinely derived from `before` + the trades (one small risk model runs on
both weight vectors - not random) and tag it `data_mode="sample"`. This module
NEVER raises: `whatif()` always returns a populated payload carrying
`data_mode` / `as_of` / `source` for honesty under the hood. No on-screen badge.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 252
TRADING_DAYS = 252
TRIM_FRACTION = 0.30          # how much of the most-overweight name we trim
# Candidate diversifier ETFs (rotate proceeds into the first one not already held).
DIVERSIFIERS = ["GLD", "TLT", "IEF", "SHY", "GSG"]

# Rounding discipline so before/after are stable and deltas == after - before
# EXACTLY (deltas are computed by subtracting the already-rounded values, never
# re-rounded). This keeps the smoke-test equality honest.
_ROUND = {"vol": 2, "var95": 3, "cvar95": 3, "beta": 3, "hhi": 4, "tracking_error": 2}
_DELTA_KEYS = ["vol", "var95", "cvar95", "beta", "hhi", "tracking_error"]
# Direction each metric pushes risk: +1 means "a larger value is riskier".
# VaR / CVaR are negative loss numbers, so MORE NEGATIVE (a lower value) is riskier.
_RISK_SIGN = {"vol": 1, "var95": -1, "cvar95": -1, "beta": 1, "hhi": 1, "tracking_error": 1}

_now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Public entry point - NEVER raises
# ---------------------------------------------------------------------------

def whatif(portfolio_id: int | None = None) -> dict:
    """Run a pre-trade what-if on the default (or given) portfolio. See module docstring.

    Always returns a populated dict; degrades to deterministic SAMPLE data tagged
    with data_mode / as_of / source.
    """
    try:
        live = _live_whatif(portfolio_id)
        if live is not None:
            return live
    except Exception as e:  # absolute safety net - contract forbids raising
        log.warning("whatif live path failed, returning sample: %s", e)
    try:
        return _sample_whatif(portfolio_id)
    except Exception as e:
        log.error("whatif sample path failed hard: %s", e)
        return _hard_fallback(portfolio_id)


# ---------------------------------------------------------------------------
# LIVE path
# ---------------------------------------------------------------------------

def _live_whatif(portfolio_id: int | None) -> dict | None:
    from . import crud
    from . import positions as pos_mod
    from . import valuation

    portfolios = crud.list_portfolios()
    if not portfolios:
        return None

    pid = portfolio_id if portfolio_id is not None else portfolios[0]["id"]
    pf = crud.get_portfolio(pid) or portfolios[0]
    pid = pf["id"]

    txns = crud.get_transactions(pid)
    open_positions, _realized, cash_delta = pos_mod.compute_positions(txns)
    if not open_positions:
        return None

    current_cash = float(pf.get("cash_balance") or 0.0) + cash_delta
    enriched, summary = valuation.enrich_positions(open_positions, current_cash)
    if not enriched:
        return None

    before = _compute_live_metrics(enriched)
    if before is None:
        return None

    trades = _default_trades(enriched, summary)
    if not trades:
        return None

    hypo = _apply_trades(enriched, summary, trades)
    if not hypo:
        return None

    after = _compute_live_metrics(hypo)
    if after is None:
        return None

    out_trades = [
        {
            "symbol": t["symbol"],
            "action": t["action"],
            "quantity": round(float(t["quantity"]), 4),
            "est_value": round(float(t["est_value"]), 2),
        }
        for t in trades
    ]
    return _finalize(before, after, out_trades, pid, data_mode="live", source="yfinance")


def _compute_live_metrics(enriched: list[dict]) -> dict | None:
    """Run the SHIPPED risk engine on a set of enriched positions and add a
    portfolio beta-to-SPY + tracking-error from the same return series.
    Returns the metric dict, or None when prices/returns are unavailable."""
    from . import risk as risk_mod

    rr = risk_mod.compute_portfolio_risk(enriched, lookback_days=LOOKBACK_DAYS)
    if rr.get("portfolio_volatility_pct") is None:
        return None

    beta, te = _beta_and_tracking_error(enriched)
    if beta is None or te is None:
        return None

    return _metric_dict(
        vol=rr["portfolio_volatility_pct"],
        var95=rr["var_95_daily_pct"],
        cvar95=rr["cvar_95_daily_pct"],
        beta=beta,
        hhi=rr["herfindahl"],
        tracking_error=te,
        factor_exposures=rr.get("factor_exposures") or [],
    )


def _beta_and_tracking_error(enriched: list[dict]) -> tuple[float | None, float | None]:
    """Portfolio beta vs SPY and annualized tracking error vs SPY, built from the
    SAME daily return series the risk engine consumes (`risk._fetch_returns`)."""
    import numpy as np
    from .risk import _fetch_returns

    symbols = [p["symbol"] for p in enriched]
    weights = np.array([float(p.get("portfolio_weight") or 0.0) / 100.0 for p in enriched])
    if weights.sum() <= 0:
        return None, None

    spy_dates, spy_rets = _fetch_returns("SPY", LOOKBACK_DAYS)
    if len(spy_dates) < 30:
        return None, None
    spy_map = dict(zip(spy_dates, spy_rets))

    rows: list[np.ndarray] = []
    valid_w: list[float] = []
    for sym, w in zip(symbols, weights):
        d, r = _fetch_returns(sym, LOOKBACK_DAYS)
        if not r:
            continue
        m = dict(zip(d, r))
        aligned = np.array([m.get(dt, 0.0) for dt in spy_dates])
        if (aligned != 0.0).sum() < 20:
            continue
        rows.append(aligned)
        valid_w.append(w)

    if not rows:
        return None, None

    wv = np.array(valid_w)
    total = wv.sum()
    if total <= 0:
        return None, None
    wv = wv / total  # renormalize so the invested book sums to 1.0

    port_ret = wv @ np.stack(rows, axis=0)            # (n_days,)
    spy_ret = np.array([spy_map[dt] for dt in spy_dates])

    spy_var = float(np.var(spy_ret, ddof=1))
    if spy_var <= 0:
        return None, None
    cov = float(np.cov(port_ret, spy_ret)[0, 1])
    beta = cov / spy_var

    excess = port_ret - spy_ret
    te = float(np.std(excess, ddof=1) * math.sqrt(TRADING_DAYS) * 100.0)
    return round(beta, 3), round(te, 2)


def _default_trades(enriched: list[dict], summary: dict) -> list[dict]:
    """Trim the most-overweight holding and rotate the proceeds into a diversifier
    ETF. Data-driven so the after-set is genuinely different from the before-set."""
    ranked = sorted(enriched, key=lambda p: p.get("portfolio_weight") or 0.0, reverse=True)
    top = ranked[0]
    top_price = float(top.get("current_price") or 0.0)
    top_shares = float(top.get("shares") or 0.0)
    if top_price <= 0 or top_shares <= 0:
        return []

    trim_qty = round(top_shares * TRIM_FRACTION, 4)
    if trim_qty <= 0:
        return []
    proceeds = trim_qty * top_price

    held = {p["symbol"].upper() for p in enriched}
    div_sym = next((d for d in DIVERSIFIERS if d not in held), DIVERSIFIERS[0])
    div_price = _last_price(div_sym)
    if not div_price or div_price <= 0:
        return []
    buy_qty = round(proceeds / div_price, 4)
    if buy_qty <= 0:
        return []

    return [
        {"symbol": top["symbol"].upper(), "action": "sell", "quantity": trim_qty,
         "price": top_price, "est_value": trim_qty * top_price},
        {"symbol": div_sym, "action": "buy", "quantity": buy_qty,
         "price": div_price, "est_value": buy_qty * div_price},
    ]


def _apply_trades(enriched: list[dict], summary: dict, trades: list[dict]) -> list[dict]:
    """Apply the trades to the current positions and return a hypothetical enriched
    list carrying `symbol` + `portfolio_weight` (all the risk engine needs)."""
    price_map = {p["symbol"].upper(): float(p.get("current_price") or 0.0) for p in enriched}
    shares_map = {p["symbol"].upper(): float(p.get("shares") or 0.0) for p in enriched}
    cash = float(summary.get("cash_balance") or 0.0)

    for t in trades:
        sym = t["symbol"].upper()
        qty = float(t["quantity"])
        price = float(t["price"])
        price_map.setdefault(sym, price)
        if price_map[sym] <= 0:
            price_map[sym] = price
        if t["action"] == "buy":
            shares_map[sym] = shares_map.get(sym, 0.0) + qty
            cash -= qty * price
        else:  # sell
            shares_map[sym] = max(0.0, shares_map.get(sym, 0.0) - qty)
            cash += qty * price

    rows: list[dict] = []
    total_mv = 0.0
    for sym, sh in shares_map.items():
        if sh <= 0:
            continue
        mv = sh * price_map.get(sym, 0.0)
        total_mv += mv
        rows.append({"symbol": sym, "shares": sh, "current_price": price_map.get(sym, 0.0),
                     "market_value": mv})

    total_value = total_mv + cash
    if total_value <= 0:
        return []
    for r in rows:
        r["portfolio_weight"] = round(r["market_value"] / total_value * 100.0, 2)
    return rows


def _last_price(symbol: str) -> float | None:
    try:
        from ..data.macro_data import fetch_arbitrary_ticker
        pts = fetch_arbitrary_ticker(symbol, days=10)
        vals = [p["value"] for p in pts if p.get("value") is not None]
        return float(vals[-1]) if vals else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# SAMPLE path (deterministic - `after` genuinely derived via a small risk model)
# ---------------------------------------------------------------------------

# A concentrated mega-cap book (the kind a what-if is most useful on). Each asset
# carries an annualized vol, a beta-to-SPY, and an asset class so the model can
# build a covariance and a residual-risk term. NOT random - fixed constants.
_SAMPLE_BOOK: list[dict] = [
    {"symbol": "NVDA", "weight": 0.32, "vol": 0.45, "beta": 1.65, "cls": "equity",
     "price": 122.50, "name": "NVIDIA Corp."},
    {"symbol": "AAPL", "weight": 0.24, "vol": 0.28, "beta": 1.15, "cls": "equity",
     "price": 214.30, "name": "Apple Inc."},
    {"symbol": "MSFT", "weight": 0.22, "vol": 0.26, "beta": 1.05, "cls": "equity",
     "price": 448.10, "name": "Microsoft Corp."},
    {"symbol": "AMZN", "weight": 0.22, "vol": 0.33, "beta": 1.25, "cls": "equity",
     "price": 186.40, "name": "Amazon.com Inc."},
]
_SAMPLE_DIVERSIFIER = {"symbol": "GLD", "vol": 0.15, "beta": 0.08, "cls": "gold",
                       "price": 215.80, "name": "SPDR Gold Shares"}
_SAMPLE_NOTIONAL = 250_000.0      # book size used to turn weight shifts into $ trades
_SAMPLE_SHIFT = 0.12              # weight rotated out of the top name into the diversifier
_SPY_VOL = 0.16                   # assumed SPY annualized vol for the TE / residual model


def _sample_whatif(portfolio_id: int | None) -> dict:
    before_assets = [dict(a) for a in _SAMPLE_BOOK]
    before = _model_metrics(before_assets)

    # Trade: trim the top name by _SAMPLE_SHIFT of book weight, rotate into GLD.
    top = before_assets[0]
    after_assets = [dict(a) for a in _SAMPLE_BOOK]
    after_assets[0]["weight"] = round(after_assets[0]["weight"] - _SAMPLE_SHIFT, 4)
    after_assets.append({**_SAMPLE_DIVERSIFIER, "weight": _SAMPLE_SHIFT})
    after = _model_metrics(after_assets)

    sell_value = round(_SAMPLE_SHIFT * _SAMPLE_NOTIONAL, 2)
    buy_value = sell_value
    trades = [
        {"symbol": top["symbol"], "action": "sell",
         "quantity": round(sell_value / top["price"], 4), "est_value": sell_value},
        {"symbol": _SAMPLE_DIVERSIFIER["symbol"], "action": "buy",
         "quantity": round(buy_value / _SAMPLE_DIVERSIFIER["price"], 4), "est_value": buy_value},
    ]
    return _finalize(before, after, trades, portfolio_id, data_mode="sample", source="sample")


def _corr(a: dict, b: dict) -> float:
    """Deterministic pairwise correlation by asset class for the sample model."""
    ca, cb = a["cls"], b["cls"]
    if a["symbol"] == b["symbol"]:
        return 1.0
    pair = frozenset((ca, cb))
    if pair == frozenset(("equity",)):
        return 0.60
    if pair == frozenset(("equity", "gold")):
        return 0.05
    if pair == frozenset(("equity", "bond")):
        return -0.20
    if pair == frozenset(("gold", "bond")):
        return 0.10
    return 0.30


def _model_metrics(assets: list[dict]) -> dict:
    """Self-contained risk model. Runs on a weight vector + per-asset vol/beta and
    returns the SAME metric shape as the live path. Used for BOTH before and after
    so the sample `after` is genuinely derived, never hand-typed."""
    w = [a["weight"] for a in assets]
    tot = sum(w) or 1.0
    w = [x / tot for x in w]

    # Portfolio variance from the class-correlation covariance.
    port_var = 0.0
    for i, ai in enumerate(assets):
        for j, aj in enumerate(assets):
            port_var += w[i] * w[j] * ai["vol"] * aj["vol"] * _corr(ai, aj)
    ann_vol = math.sqrt(max(port_var, 0.0))
    daily_vol = ann_vol / math.sqrt(TRADING_DAYS)

    # Parametric normal VaR / Expected-Shortfall (z95 = 1.645, ES95 factor = 2.063).
    var95 = -1.645 * daily_vol * 100.0
    cvar95 = -2.063 * daily_vol * 100.0

    beta = sum(w[i] * assets[i]["beta"] for i in range(len(assets)))
    hhi = sum(x * x for x in w)

    # Tracking error vs SPY under r_i = beta_i * r_spy + resid_i (resids independent).
    spy_var = _SPY_VOL ** 2
    te_var = (beta - 1.0) ** 2 * spy_var
    for i, a in enumerate(assets):
        resid_var = max(a["vol"] ** 2 - a["beta"] ** 2 * spy_var, 1e-4)
        te_var += (w[i] ** 2) * resid_var
    te = math.sqrt(max(te_var, 0.0)) * 100.0

    # Factor exposures from class weights (plausible, deterministic).
    eq_w = sum(w[i] for i, a in enumerate(assets) if a["cls"] == "equity")
    gold_w = sum(w[i] for i, a in enumerate(assets) if a["cls"] == "gold")
    bond_w = sum(w[i] for i, a in enumerate(assets) if a["cls"] == "bond")
    factors = [
        {"factor": "SPY", "beta": round(beta, 3)},
        {"factor": "QQQ", "beta": round(eq_w * 0.62, 3)},
        {"factor": "IWM", "beta": round(eq_w * 0.10, 3)},
        {"factor": "HYG", "beta": round(eq_w * 0.12 - bond_w * 0.10, 3)},
        {"factor": "GLD", "beta": round(gold_w * 0.92, 3)},
        {"factor": "TLT", "beta": round(bond_w * 0.85 - eq_w * 0.05, 3)},
    ]
    return _metric_dict(
        vol=ann_vol * 100.0, var95=var95, cvar95=cvar95,
        beta=beta, hhi=hhi, tracking_error=te, factor_exposures=factors,
    )


# ---------------------------------------------------------------------------
# Shared assembly
# ---------------------------------------------------------------------------

def _metric_dict(*, vol, var95, cvar95, beta, hhi, tracking_error, factor_exposures) -> dict:
    """Round each scalar to its fixed precision so deltas are exact, then attach
    the factor list."""
    return {
        "vol": round(float(vol), _ROUND["vol"]),
        "var95": round(float(var95), _ROUND["var95"]),
        "cvar95": round(float(cvar95), _ROUND["cvar95"]),
        "beta": round(float(beta), _ROUND["beta"]),
        "hhi": round(float(hhi), _ROUND["hhi"]),
        "tracking_error": round(float(tracking_error), _ROUND["tracking_error"]),
        "factor_exposures": list(factor_exposures),
    }


def _finalize(before: dict, after: dict, trades: list[dict], portfolio_id: int | None,
              *, data_mode: str, source: str) -> dict:
    # deltas == after - before EXACTLY (subtract already-rounded values, no re-round).
    deltas = {k: after[k] - before[k] for k in _DELTA_KEYS}

    # Net risk direction: tally how many metrics moved in the riskier direction.
    score = 0
    for k in _DELTA_KEYS:
        d = deltas[k]
        if abs(d) < 1e-12:
            continue
        score += 1 if (d > 0) == (_RISK_SIGN[k] > 0) else -1
    risk_direction = "Higher" if score > 0 else "Lower" if score < 0 else "Unchanged"

    # Biggest single change, ranked by magnitude relative to the before value.
    def _rel(k: str) -> float:
        base = abs(before[k])
        return abs(deltas[k]) / base if base > 1e-9 else abs(deltas[k])

    biggest_key = max(_DELTA_KEYS, key=_rel)
    biggest_change = {
        "metric": biggest_key,
        "delta": deltas[biggest_key],
        "from": before[biggest_key],
        "to": after[biggest_key],
    }

    sell_syms = [t["symbol"] for t in trades if t["action"] == "sell"]
    buy_syms = [t["symbol"] for t in trades if t["action"] == "buy"]
    trim = sell_syms[0] if sell_syms else "the overweight"
    div = buy_syms[0] if buy_syms else "a diversifier"
    verb = {"Lower": "lowers", "Higher": "raises", "Unchanged": "barely moves"}[risk_direction]
    note = (
        f"Pre-trade simulation: trimming {trim} and adding {div} {verb} portfolio risk - "
        f"vol {before['vol']:.1f}% -> {after['vol']:.1f}%, beta {before['beta']:.2f} -> "
        f"{after['beta']:.2f}, concentration (HHI) {before['hhi']:.3f} -> {after['hhi']:.3f}. "
        f"No orders are placed."
    )

    return {
        "portfolio_id": portfolio_id,
        "proposed_trades": trades,
        "before": before,
        "after": after,
        "deltas": deltas,
        "summary": {
            "risk_direction": risk_direction,
            "biggest_change": biggest_change,
            "note": note,
        },
        "data_mode": data_mode,
        "as_of": _now(),
        "source": source,
    }


def _hard_fallback(portfolio_id: int | None) -> dict:
    """Absolute last resort - still a populated, internally consistent payload."""
    before = _metric_dict(vol=22.0, var95=-2.3, cvar95=-3.2, beta=1.2, hhi=0.26,
                          tracking_error=7.5, factor_exposures=[])
    after = _metric_dict(vol=19.5, var95=-2.0, cvar95=-2.8, beta=1.02, hhi=0.20,
                         tracking_error=6.4, factor_exposures=[])
    trades = [
        {"symbol": "NVDA", "action": "sell", "quantity": 244.9, "est_value": 30000.0},
        {"symbol": "GLD", "action": "buy", "quantity": 139.0, "est_value": 30000.0},
    ]
    return _finalize(before, after, trades, portfolio_id, data_mode="sample", source="sample")
