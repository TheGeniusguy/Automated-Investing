"""Core finance math for the cross-asset return comparator.

Everything here is PURE (no I/O, no network) and deterministic so it can be
unit-tested against hand-verified numbers.

Conventions
-----------
- A cashflow series is signed from the INVESTOR's perspective: money paid out
  (the initial outlay, contributions) is negative; money received
  (distributions, sale proceeds) is positive.
- ``irr`` works on EQUALLY-SPACED period cashflows; index 0 is "today". The
  returned rate is therefore a *per-period* rate.
- ``xirr`` works on date-stamped cashflows and returns an *annualized* rate
  using an Actual/365 day count.

Formulas
--------
NPV:      NPV(r) = Σ  CF_t / (1 + r)^t            (t = period index, 0..N)
IRR:      the rate r such that NPV(r) = 0.
XIRR:     Σ CF_i / (1 + r)^(days_i / 365) = 0     (days_i measured from CF[0])
CAGR:     (end / begin)^(1/years) - 1
Mortgage: P = L * c / (1 - (1 + c)^-n)            (c = periodic rate, n = #periods)
          (straight-line L/n when the rate is 0)
"""
from __future__ import annotations

import math
from datetime import date, datetime
from typing import Optional


# ──────────────────────────────────────────────────────────────────────────
# NPV
# ──────────────────────────────────────────────────────────────────────────
def npv(rate: float, cashflows: list[float]) -> float:
    """Net present value of equally-spaced ``cashflows`` discounted at ``rate``.

    NPV(r) = Σ_t  CF_t / (1 + r)^t,  t = 0, 1, 2, ...
    """
    total = 0.0
    for t, cf in enumerate(cashflows):
        total += cf / ((1.0 + rate) ** t)
    return total


def _npv_derivative(rate: float, cashflows: list[float]) -> float:
    """d(NPV)/d(rate) = Σ_t  -t * CF_t / (1 + r)^(t + 1)."""
    total = 0.0
    for t, cf in enumerate(cashflows):
        if t == 0:
            continue
        total += -t * cf / ((1.0 + rate) ** (t + 1))
    return total


# ──────────────────────────────────────────────────────────────────────────
# IRR — per-period, equally spaced
# ──────────────────────────────────────────────────────────────────────────
def irr(cashflows: list[float], guess: float = 0.1) -> Optional[float]:
    """Internal rate of return for EQUALLY-SPACED period cashflows.

    Index 0 = today. Returns the per-period rate r solving NPV(r) = 0.

    Uses Newton's method seeded at ``guess`` with a robust bisection fallback.
    Returns ``None`` when there is no sign change in the cashflows (no IRR
    exists) or neither method converges.
    """
    if not cashflows or len(cashflows) < 2:
        return None
    # An IRR can only exist if there is at least one sign change.
    if not _has_sign_change(cashflows):
        return None

    # 1) Newton's method.
    rate = guess
    for _ in range(100):
        try:
            f = npv(rate, cashflows)
            df = _npv_derivative(rate, cashflows)
        except (OverflowError, ZeroDivisionError, ValueError):
            break
        if not math.isfinite(f) or not math.isfinite(df):
            break
        if abs(f) < 1e-9:
            return rate
        if df == 0:
            break
        new_rate = rate - f / df
        if new_rate <= -0.999999:  # keep (1 + r) strictly positive
            new_rate = (rate - 0.999999) / 2.0
        if abs(new_rate - rate) < 1e-10:
            rate = new_rate
            break
        rate = new_rate
    if math.isfinite(rate) and abs(npv(rate, cashflows)) < 1e-6:
        return rate

    # 2) Bisection fallback over a wide bracket.
    return _bisect_npv(lambda r: npv(r, cashflows))


# ──────────────────────────────────────────────────────────────────────────
# XIRR — date-aware annualized
# ──────────────────────────────────────────────────────────────────────────
def _to_date(d) -> date:
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    return datetime.strptime(str(d)[:10], "%Y-%m-%d").date()


def _xnpv(rate: float, amounts: list[float], year_fracs: list[float]) -> float:
    """XNPV using Actual/365 year fractions relative to the first flow."""
    total = 0.0
    for amt, yf in zip(amounts, year_fracs):
        total += amt / ((1.0 + rate) ** yf)
    return total


def _xnpv_derivative(rate: float, amounts: list[float], year_fracs: list[float]) -> float:
    total = 0.0
    for amt, yf in zip(amounts, year_fracs):
        if yf == 0:
            continue
        total += -yf * amt / ((1.0 + rate) ** (yf + 1.0))
    return total


def xirr(dated_cashflows: list[tuple[str, float]], guess: float = 0.1) -> Optional[float]:
    """Date-aware annualized IRR (Actual/365).

    ``dated_cashflows`` is a list of ``(date_str, amount)`` tuples. Amounts are
    signed from the investor's perspective. Returns the annual rate r solving
    Σ CF_i / (1 + r)^(days_i / 365) = 0, where days_i is measured from the
    earliest cashflow date.

    Newton's method with a bisection fallback. Returns ``None`` when there is
    no sign change or convergence fails.
    """
    if not dated_cashflows or len(dated_cashflows) < 2:
        return None

    pairs = sorted(((_to_date(d), float(a)) for d, a in dated_cashflows), key=lambda p: p[0])
    amounts = [a for _, a in pairs]
    if not _has_sign_change(amounts):
        return None

    t0 = pairs[0][0]
    year_fracs = [((d - t0).days) / 365.0 for d, _ in pairs]

    # 1) Newton's method.
    rate = guess
    for _ in range(100):
        try:
            f = _xnpv(rate, amounts, year_fracs)
            df = _xnpv_derivative(rate, amounts, year_fracs)
        except (OverflowError, ZeroDivisionError, ValueError):
            break
        if not math.isfinite(f) or not math.isfinite(df):
            break
        if abs(f) < 1e-9:
            return rate
        if df == 0:
            break
        new_rate = rate - f / df
        if new_rate <= -0.999999:
            new_rate = (rate - 0.999999) / 2.0
        if abs(new_rate - rate) < 1e-10:
            rate = new_rate
            break
        rate = new_rate
    if math.isfinite(rate) and abs(_xnpv(rate, amounts, year_fracs)) < 1e-6:
        return rate

    # 2) Bisection fallback.
    return _bisect_npv(lambda r: _xnpv(r, amounts, year_fracs))


# ──────────────────────────────────────────────────────────────────────────
# CAGR
# ──────────────────────────────────────────────────────────────────────────
def cagr(begin_value: float, end_value: float, years: float) -> Optional[float]:
    """Compound annual growth rate: (end / begin)^(1/years) - 1.

    Returns ``None`` for non-positive begin value, non-positive end value, or
    non-positive ``years`` (the formula is undefined / not meaningful there).
    """
    if begin_value is None or end_value is None or years is None:
        return None
    if begin_value <= 0 or end_value <= 0 or years <= 0:
        return None
    try:
        return (end_value / begin_value) ** (1.0 / years) - 1.0
    except (ValueError, OverflowError, ZeroDivisionError):
        return None


# ──────────────────────────────────────────────────────────────────────────
# Mortgage / amortization
# ──────────────────────────────────────────────────────────────────────────
def mortgage_payment(
    principal: float,
    annual_rate: float,
    term_years: float,
    periods_per_year: int = 12,
) -> float:
    """Level amortization payment.

    With periodic rate c = annual_rate / 100 / periods_per_year and
    n = term_years * periods_per_year periods:

        payment = principal * c / (1 - (1 + c)^-n)

    A 0% rate degenerates to straight-line principal / n.

    ``annual_rate`` is a PERCENT (e.g. 6.0 == 6%).
    """
    n = int(round(term_years * periods_per_year))
    if n <= 0 or principal <= 0:
        return 0.0
    c = (annual_rate / 100.0) / periods_per_year
    if abs(c) < 1e-12:
        return principal / n
    return principal * c / (1.0 - (1.0 + c) ** (-n))


def amortization_schedule(
    principal: float,
    annual_rate: float,
    term_years: float,
    periods_per_year: int = 12,
) -> list[dict]:
    """Full amortization schedule.

    Returns one row per period:
        {period, payment, interest, principal_paid, balance}

    The final balance is clamped to exactly 0 to absorb floating rounding.
    """
    n = int(round(term_years * periods_per_year))
    rows: list[dict] = []
    if n <= 0 or principal <= 0:
        return rows
    c = (annual_rate / 100.0) / periods_per_year
    payment = mortgage_payment(principal, annual_rate, term_years, periods_per_year)
    balance = principal
    for period in range(1, n + 1):
        interest = balance * c
        principal_paid = payment - interest
        if period == n:
            # absorb rounding on the final payment
            principal_paid = balance
            payment_row = interest + principal_paid
        else:
            payment_row = payment
        balance = balance - principal_paid
        if balance < 0:
            balance = 0.0
        rows.append(
            {
                "period": period,
                "payment": round(payment_row, 2),
                "interest": round(interest, 2),
                "principal_paid": round(principal_paid, 2),
                "balance": round(balance, 2),
            }
        )
    return rows


# ──────────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────────
def _has_sign_change(values: list[float]) -> bool:
    seen_pos = any(v > 0 for v in values)
    seen_neg = any(v < 0 for v in values)
    return seen_pos and seen_neg


def _bisect_npv(npv_fn, lo: float = -0.9999, hi: float = 100.0) -> Optional[float]:
    """Bisection root finder for an NPV-style function over (lo, hi).

    Scans for a sign-change bracket, then bisects. Returns ``None`` if no
    bracket is found.
    """
    try:
        f_lo = npv_fn(lo)
    except (OverflowError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(f_lo):
        return None

    # Walk a grid to find a bracket where the sign flips.
    steps = 2000
    prev_r = lo
    prev_f = f_lo
    bracket = None
    for i in range(1, steps + 1):
        r = lo + (hi - lo) * i / steps
        try:
            f = npv_fn(r)
        except (OverflowError, ValueError, ZeroDivisionError):
            prev_r, prev_f = r, float("nan")
            continue
        if math.isfinite(f) and math.isfinite(prev_f) and (prev_f == 0 or f == 0 or (prev_f < 0) != (f < 0)):
            if f == 0:
                return r
            if prev_f == 0:
                return prev_r
            bracket = (prev_r, r)
            break
        prev_r, prev_f = r, f

    if bracket is None:
        return None

    a, b = bracket
    fa = npv_fn(a)
    for _ in range(200):
        mid = (a + b) / 2.0
        fm = npv_fn(mid)
        if abs(fm) < 1e-10 or (b - a) / 2.0 < 1e-12:
            return mid
        if (fa < 0) != (fm < 0):
            b = mid
        else:
            a, fa = mid, fm
    return (a + b) / 2.0
