"""Bond Analytics / YAS - single-bond price, yield, and risk math.

Mirrors a Bloomberg YAS (Yield and Spread Analysis) screen. Everything here is
pure, closed-form, semiannual-coupon bond math - no external feeds are required
for the calculator. The sample "issue universe" is priced off the live US
Treasury curve (via ``data/yield_curve.current_curve``) plus sample credit
spreads, degrading to a sample curve when FRED is unavailable.

Conventions
-----------
- Internally, rates (coupon, ytm, credit spread) are DECIMALS (0.05 == 5%).
- Public entrypoints accept and return rates as PERCENT numbers (5.0 == 5%) and
  spreads as basis points, since that is how a UI form and the curve report them.
- Closed-form semiannual coupon bond:
    n = years * freq,  c = coupon_rate * face / freq,  y = ytm / freq
    price = c * (1 - (1+y)^-n) / y  +  face * (1+y)^-n     (y == 0 -> c*n + face)
- Macaulay duration  = sum(t_years * PV_cf) / price
- Modified duration  = macaulay / (1 + ytm/freq)
- Convexity          = sum(k*(k+1) * PV_cf) / (price * (1+y)^2) / freq^2  (k = period index)
- DV01               = modified_duration * price * 0.0001   (price change per 1bp)

Never raises. Any failure degrades to a populated sample payload.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# Sample data (clearly namespaced per the sample-data policy)
# ──────────────────────────────────────────────────────────────────────────

# Fallback nominal Treasury curve in PERCENT, keyed by term in years. Used only
# when the live FRED curve is unavailable. Illustrative but realistic shape.
SAMPLE_CURVE_POINTS: list[tuple[float, float]] = [
    (1 / 12, 5.35),
    (3 / 12, 5.30),
    (6 / 12, 5.15),
    (1.0, 4.80),
    (2.0, 4.45),
    (3.0, 4.30),
    (5.0, 4.25),
    (7.0, 4.30),
    (10.0, 4.40),
    (20.0, 4.70),
    (30.0, 4.60),
]

# Sample credit spreads over the matched Treasury point, in BASIS POINTS, by
# rating bucket. Treasuries carry zero spread.
SAMPLE_CREDIT_SPREADS_BPS: dict[str, float] = {
    "AAA": 0.0,
    "AA+": 35.0,
    "AA": 55.0,
    "A": 95.0,
    "BBB": 150.0,
    "BB": 290.0,
    "B": 440.0,
}

# Static sample issue universe. Treasuries are priced straight off the curve;
# corporates add their rating's sample spread. (coupon is PERCENT, maturity in
# years from today.)
SAMPLE_BONDS: list[dict] = [
    {"id": "UST-2Y",   "name": "US Treasury 4.500 2028",     "coupon": 4.500, "maturity": 2.0,  "rating": "AAA", "kind": "treasury"},
    {"id": "UST-5Y",   "name": "US Treasury 4.250 2031",     "coupon": 4.250, "maturity": 5.0,  "rating": "AAA", "kind": "treasury"},
    {"id": "UST-10Y",  "name": "US Treasury 4.375 2036",     "coupon": 4.375, "maturity": 10.0, "rating": "AAA", "kind": "treasury"},
    {"id": "UST-30Y",  "name": "US Treasury 4.625 2056",     "coupon": 4.625, "maturity": 30.0, "rating": "AAA", "kind": "treasury"},
    {"id": "AAPL-30",  "name": "Apple Inc 4.850 2030",       "coupon": 4.850, "maturity": 4.0,  "rating": "AA+", "kind": "corporate"},
    {"id": "MSFT-34",  "name": "Microsoft Corp 4.450 2034",  "coupon": 4.450, "maturity": 8.0,  "rating": "AAA", "kind": "corporate"},
    {"id": "ORCL-34",  "name": "Oracle Corp 5.550 2034",     "coupon": 5.550, "maturity": 8.5,  "rating": "BBB", "kind": "corporate"},
    {"id": "F-32",     "name": "Ford Motor 6.950 2032",      "coupon": 6.950, "maturity": 6.0,  "rating": "BB",  "kind": "corporate"},
    {"id": "CCL-30",   "name": "Carnival Corp 7.625 2030",   "coupon": 7.625, "maturity": 4.5,  "rating": "B",   "kind": "corporate"},
]

FACE = 100.0  # par value the universe is priced against


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ──────────────────────────────────────────────────────────────────────────
# Core bond math (PURE; rates are DECIMALS here, e.g. 0.045)
# ──────────────────────────────────────────────────────────────────────────

def bond_price(face: float, coupon_rate: float, ytm: float, years: float, freq: int = 2) -> float:
    """Clean price of a semiannual (or ``freq``-annual) coupon bond.

    coupon_rate / ytm are DECIMALS. Returns the present value of all coupons
    plus the discounted face value.
    """
    n = int(round(years * freq))
    if n <= 0:
        return float(face)
    c = coupon_rate * face / freq
    y = ytm / freq
    if abs(y) < 1e-12:
        return float(c * n + face)
    if y <= -1.0:
        # discount factor blows up; clamp to keep math finite
        y = -0.999999
    disc = (1.0 + y) ** (-n)
    annuity = (1.0 - disc) / y
    return float(c * annuity + face * disc)


def ytm_from_price(price: float, face: float, coupon_rate: float, years: float, freq: int = 2) -> float:
    """Invert ``bond_price`` for yield to maturity (DECIMAL).

    Price is monotonic-decreasing in yield, so a bisection over a wide bracket is
    robust. Newton's method is tried first (seeded at the current yield estimate)
    with bisection as a guaranteed fallback.
    """
    n = int(round(years * freq))
    if n <= 0 or price <= 0:
        return float(coupon_rate)

    def f(y_dec: float) -> float:
        return bond_price(face, coupon_rate, y_dec, years, freq) - price

    # 1) Newton's method with a numerical derivative.
    rate = max(coupon_rate, 0.01)
    h = 1e-6
    for _ in range(60):
        fr = f(rate)
        if abs(fr) < 1e-9:
            return float(rate)
        dfr = (f(rate + h) - fr) / h
        if dfr == 0 or not _finite(dfr):
            break
        new_rate = rate - fr / dfr
        if new_rate <= -0.99:
            new_rate = (rate - 0.99) / 2.0
        if abs(new_rate - rate) < 1e-12:
            rate = new_rate
            break
        rate = new_rate
    if _finite(rate) and abs(f(rate)) < 1e-6 and rate > -0.99:
        return float(rate)

    # 2) Bisection fallback over a wide yield bracket.
    lo, hi = -0.95, 2.0
    f_lo, f_hi = f(lo), f(hi)
    if f_lo == 0:
        return float(lo)
    if f_hi == 0:
        return float(hi)
    if (f_lo < 0) == (f_hi < 0):
        # No sign change in range; return best-effort current coupon yield.
        return float(max(coupon_rate, 0.0001))
    for _ in range(200):
        mid = (lo + hi) / 2.0
        fm = f(mid)
        if abs(fm) < 1e-10 or (hi - lo) / 2.0 < 1e-12:
            return float(mid)
        if (f_lo < 0) != (fm < 0):
            hi = mid
        else:
            lo, f_lo = mid, fm
    return float((lo + hi) / 2.0)


def _cashflow_pvs(face: float, coupon_rate: float, ytm: float, years: float, freq: int):
    """Return (list of (period_index, time_years, pv_of_cashflow), price)."""
    n = int(round(years * freq))
    out: list[tuple[int, float, float]] = []
    if n <= 0:
        return out, float(face)
    c = coupon_rate * face / freq
    y = ytm / freq
    if y <= -1.0:
        y = -0.999999
    price = 0.0
    for k in range(1, n + 1):
        cf = c + (face if k == n else 0.0)
        pv = cf / ((1.0 + y) ** k)
        out.append((k, k / freq, pv))
        price += pv
    return out, float(price)


def macaulay_duration(face: float, coupon_rate: float, ytm: float, years: float, freq: int = 2) -> float:
    """Macaulay duration in YEARS: sum(t_years * PV_cf) / price."""
    pvs, price = _cashflow_pvs(face, coupon_rate, ytm, years, freq)
    if not pvs or price <= 0:
        return 0.0
    weighted = sum(t_years * pv for _, t_years, pv in pvs)
    return float(weighted / price)


def modified_duration(mac_duration: float, ytm: float, freq: int = 2) -> float:
    """Modified duration: macaulay / (1 + ytm/freq)."""
    denom = 1.0 + ytm / freq
    if abs(denom) < 1e-12:
        return float(mac_duration)
    return float(mac_duration / denom)


def convexity(face: float, coupon_rate: float, ytm: float, years: float, freq: int = 2) -> float:
    """Convexity: sum(k*(k+1)*PV_cf) / (price*(1+y)^2) / freq^2  (k = period index)."""
    pvs, price = _cashflow_pvs(face, coupon_rate, ytm, years, freq)
    if not pvs or price <= 0:
        return 0.0
    y = ytm / freq
    if y <= -1.0:
        y = -0.999999
    acc = sum(k * (k + 1) * pv for k, _, pv in pvs)
    return float(acc / (price * (1.0 + y) ** 2) / (freq ** 2))


def dv01(price: float, mod_dur: float) -> float:
    """Dollar value of 1 basis point: mod_dur * price * 0.0001."""
    return float(mod_dur * price * 0.0001)


def price_yield_curve(face: float, coupon_rate: float, ytm: float, years: float,
                      freq: int = 2, span_bps: float = 400.0, steps: int = 41) -> list[dict]:
    """The convexity bowl: price across a grid of yields centered on ``ytm``.

    ``ytm`` / ``coupon_rate`` are DECIMALS. ``span_bps`` is the half-width of the
    grid in basis points. Output ytm is reported in PERCENT for the UI.
    """
    out: list[dict] = []
    if steps < 2:
        steps = 2
    span = span_bps / 10000.0  # bps -> decimal
    lo = max(ytm - span, 0.0001)
    hi = ytm + span
    for i in range(steps):
        y = lo + (hi - lo) * i / (steps - 1)
        out.append({
            "ytm": round(y * 100.0, 4),
            "price": round(bond_price(face, coupon_rate, y, years, freq), 4),
        })
    return out


def scenario_table(face: float, coupon_rate: float, ytm: float, years: float,
                   freq: int = 2, price: float | None = None,
                   mod_dur: float | None = None, conv: float | None = None) -> list[dict]:
    """Rate-shock P&L for +/-25/50/100/200 bp using duration + convexity.

    Estimated price change for a yield shock dy (DECIMAL):
        dP ~= (-mod_dur * P * dy) + (0.5 * convexity * P * dy^2)
    The exact repriced value is included alongside the estimate for honesty.
    ``ytm`` / ``coupon_rate`` are DECIMALS; shocks reported in basis points.
    """
    if price is None:
        price = bond_price(face, coupon_rate, ytm, years, freq)
    if mod_dur is None:
        mac = macaulay_duration(face, coupon_rate, ytm, years, freq)
        mod_dur = modified_duration(mac, ytm, freq)
    if conv is None:
        conv = convexity(face, coupon_rate, ytm, years, freq)

    shocks_bps = [-200, -100, -50, -25, 25, 50, 100, 200]
    rows: list[dict] = []
    for bps in shocks_bps:
        dy = bps / 10000.0
        est_change = (-mod_dur * price * dy) + (0.5 * conv * price * dy * dy)
        est_price = price + est_change
        new_y = ytm + dy
        exact_price = bond_price(face, coupon_rate, new_y, years, freq) if new_y > -0.99 else est_price
        rows.append({
            "shock_bps": bps,
            "new_yield": round(new_y * 100.0, 4),
            "price": round(est_price, 4),
            "exact_price": round(exact_price, 4),
            "price_change": round(est_change, 4),
            "pct_change": round((est_change / price * 100.0) if price else 0.0, 4),
        })
    return rows


def _finite(x: float) -> bool:
    return x == x and x not in (float("inf"), float("-inf"))


# ──────────────────────────────────────────────────────────────────────────
# Live-ish curve helpers (reuse the existing yield_curve module)
# ──────────────────────────────────────────────────────────────────────────

def _live_curve_points() -> tuple[list[tuple[float, float]], bool]:
    """Return [(years, yield_percent), ...] and whether it came from live data.

    Pulls ``yield_curve.current_curve`` and keeps points with real yields. Falls
    back to ``SAMPLE_CURVE_POINTS`` when FRED is unavailable or returns nothing.
    """
    try:
        from . import yield_curve  # local import keeps module import-safe
        curve = yield_curve.current_curve()
        pts = [
            (float(p["years"]), float(p["yield"]))
            for p in curve.get("points", [])
            if p.get("yield") is not None and p.get("years") is not None
        ]
        if len(pts) >= 2:
            pts.sort(key=lambda t: t[0])
            return pts, True
    except Exception as exc:  # never raise - degrade to sample
        log.debug("bond_analytics: live curve unavailable (%s); using sample", exc)
    return list(SAMPLE_CURVE_POINTS), False


def _interp_yield(points: list[tuple[float, float]], years: float) -> float:
    """Linear-interpolate a yield (PERCENT) at ``years`` from sorted curve points."""
    if not points:
        return 4.5
    if years <= points[0][0]:
        return points[0][1]
    if years >= points[-1][0]:
        return points[-1][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= years <= x1:
            if x1 == x0:
                return y0
            w = (years - x0) / (x1 - x0)
            return y0 + w * (y1 - y0)
    return points[-1][1]


# ──────────────────────────────────────────────────────────────────────────
# Public entrypoints
# ──────────────────────────────────────────────────────────────────────────

def analyze_bond(face: float, coupon: float, ytm_or_price: float, maturity: float,
                 freq: int = 2, is_price: bool = False) -> dict:
    """Full YAS analysis of a single bond.

    Parameters (UI-friendly units)
    -------------------------------
    face         : par value (e.g. 100 or 1000)
    coupon       : annual coupon rate in PERCENT (e.g. 4.85)
    ytm_or_price : if ``is_price`` is False, a yield to maturity in PERCENT;
                   if True, a clean price in the same units as ``face``.
    maturity     : years to maturity
    freq         : coupon payments per year (default 2 = semiannual)
    is_price     : interpret ``ytm_or_price`` as a price instead of a yield.

    Returns ``{price, ytm, mac_duration, mod_duration, convexity, dv01,
    price_yield_curve[], scenario_table[], data_mode, as_of, source}``. Never raises.
    """
    try:
        face = float(face)
        coupon_dec = float(coupon) / 100.0
        freq = int(freq) if freq else 2
        maturity = float(maturity)
        if maturity <= 0:
            maturity = 1.0

        if is_price:
            price = float(ytm_or_price)
            ytm_dec = ytm_from_price(price, face, coupon_dec, maturity, freq)
        else:
            ytm_dec = float(ytm_or_price) / 100.0
            price = bond_price(face, coupon_dec, ytm_dec, maturity, freq)

        mac = macaulay_duration(face, coupon_dec, ytm_dec, maturity, freq)
        mod = modified_duration(mac, ytm_dec, freq)
        conv = convexity(face, coupon_dec, ytm_dec, maturity, freq)
        bp_value = dv01(price, mod)

        return {
            "price": round(price, 4),
            "ytm": round(ytm_dec * 100.0, 4),
            "mac_duration": round(mac, 4),
            "mod_duration": round(mod, 4),
            "convexity": round(conv, 4),
            "dv01": round(bp_value, 6),
            "price_yield_curve": price_yield_curve(face, coupon_dec, ytm_dec, maturity, freq),
            "scenario_table": scenario_table(face, coupon_dec, ytm_dec, maturity, freq,
                                             price=price, mod_dur=mod, conv=conv),
            "data_mode": "live",
            "as_of": _now_iso(),
            "source": "closed-form-bond-math",
        }
    except Exception as exc:  # never raise
        log.warning("bond_analytics.analyze_bond failed (%s); returning safe payload", exc)
        return _safe_analysis()


def bond_universe() -> dict:
    """Sample issue universe priced off the live Treasury curve + sample spreads.

    Returns ``{bonds: [{id, name, coupon, maturity, rating, price, ytm, duration,
    convexity, dv01}], data_mode, as_of, source}``. Never raises.
    """
    try:
        points, is_live = _live_curve_points()
        bonds: list[dict] = []
        for b in SAMPLE_BONDS:
            try:
                coupon_pct = float(b["coupon"])
                coupon_dec = coupon_pct / 100.0
                maturity = float(b["maturity"])
                base_yield_pct = _interp_yield(points, maturity)
                spread_bps = SAMPLE_CREDIT_SPREADS_BPS.get(b["rating"], 0.0)
                ytm_pct = base_yield_pct + spread_bps / 100.0
                ytm_dec = ytm_pct / 100.0

                price = bond_price(FACE, coupon_dec, ytm_dec, maturity)
                mac = macaulay_duration(FACE, coupon_dec, ytm_dec, maturity)
                mod = modified_duration(mac, ytm_dec, 2)
                conv = convexity(FACE, coupon_dec, ytm_dec, maturity)
                bp_value = dv01(price, mod)

                bonds.append({
                    "id": b["id"],
                    "name": b["name"],
                    "coupon": round(coupon_pct, 4),
                    "maturity": round(maturity, 4),
                    "rating": b["rating"],
                    "price": round(price, 4),
                    "ytm": round(ytm_pct, 4),
                    "duration": round(mod, 4),
                    "convexity": round(conv, 4),
                    "dv01": round(bp_value, 6),
                })
            except Exception as exc:
                log.debug("bond_analytics: skipping bond %s (%s)", b.get("id"), exc)

        return {
            "bonds": bonds,
            "data_mode": "live" if is_live else "sample",
            "as_of": _now_iso(),
            "source": "us-treasury-curve+sample-credit-spreads" if is_live
                      else "sample-curve+sample-credit-spreads",
        }
    except Exception as exc:  # never raise
        log.warning("bond_analytics.bond_universe failed (%s); returning sample", exc)
        return {"bonds": [], "data_mode": "sample", "as_of": _now_iso(),
                "source": "sample-curve+sample-credit-spreads"}


def _safe_analysis() -> dict:
    """A guaranteed-populated fallback analysis (par 100, 5% coupon, 10Y, 5% ytm)."""
    face, coupon_dec, ytm_dec, maturity = 100.0, 0.05, 0.05, 10.0
    price = bond_price(face, coupon_dec, ytm_dec, maturity)
    mac = macaulay_duration(face, coupon_dec, ytm_dec, maturity)
    mod = modified_duration(mac, ytm_dec, 2)
    conv = convexity(face, coupon_dec, ytm_dec, maturity)
    return {
        "price": round(price, 4),
        "ytm": round(ytm_dec * 100.0, 4),
        "mac_duration": round(mac, 4),
        "mod_duration": round(mod, 4),
        "convexity": round(conv, 4),
        "dv01": round(dv01(price, mod), 6),
        "price_yield_curve": price_yield_curve(face, coupon_dec, ytm_dec, maturity),
        "scenario_table": scenario_table(face, coupon_dec, ytm_dec, maturity, price=price, mod_dur=mod, conv=conv),
        "data_mode": "sample",
        "as_of": _now_iso(),
        "source": "closed-form-bond-math",
    }
