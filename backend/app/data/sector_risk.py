"""Sector risk + drawdown analytics.

Pure computation over the ETF price history we already cache. No new external
data sources. Compounds with the existing regime classifier: every drawdown
trough is tagged with the macro regime that was active when the trough hit.

Surfaces:
  - Top 5 historical drawdowns (peak -> trough -> recovery) with regime tag,
    depth %, drawdown duration, and recovery duration.
  - Tail risk tile grid: 21D + 252D realized vol, annualized Sharpe, annualized
    Sortino, downside deviation, CVaR-95, max DD depth + duration.
  - Vol regime: percentile of current 21D realized vol vs 5y history.
  - Sector-SPY correlation z-score: current 60D correlation vs 5y rolling stats.

When FRED is unavailable the regime tag is "n/a" (the classifier needs yield
inputs); everything else still renders.
"""
from __future__ import annotations

import logging
import math
import statistics
from datetime import date
from typing import Optional

from ..config import settings
from ..regime import regime_model
from . import macro_data, sector_detail

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 3650  # ~10y
MIN_DRAWDOWN_PCT = 5.0   # ignore drawdowns shallower than 5%
TOP_N_DRAWDOWNS = 5
ROLL_VOL_WINDOW = 21
ROLL_CORR_WINDOW = 60
ANNUAL_FACTOR = 252


# ── Helpers ─────────────────────────────────────────────────────────────────

def _closes(symbol: str) -> list[tuple[str, float]]:
    pts = macro_data.fetch_arbitrary_ticker(symbol, days=LOOKBACK_DAYS)
    return [(p["date"], float(p["value"])) for p in pts if p.get("value") is not None]


def _daily_returns(closes: list[tuple[str, float]]) -> tuple[list[str], list[float]]:
    dates: list[str] = []
    rets: list[float] = []
    for i in range(1, len(closes)):
        prev = closes[i - 1][1]
        curr = closes[i][1]
        if prev > 0:
            dates.append(closes[i][0])
            rets.append((curr - prev) / prev)
    return dates, rets


def _rolling_std(xs: list[float], window: int) -> list[Optional[float]]:
    """Population std over a rolling window. Returns same length as input,
    with leading window-1 entries as None."""
    out: list[Optional[float]] = [None] * len(xs)
    if len(xs) < window:
        return out
    for i in range(window - 1, len(xs)):
        w = xs[i - window + 1 : i + 1]
        out[i] = statistics.pstdev(w)
    return out


def _rolling_corr(xs: list[float], ys: list[float], window: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(xs)
    n = min(len(xs), len(ys))
    if n < window:
        return out
    for i in range(window - 1, n):
        x_win = xs[i - window + 1 : i + 1]
        y_win = ys[i - window + 1 : i + 1]
        try:
            c = _pearson(x_win, y_win)
        except Exception:
            c = None
        out[i] = c
    return out


def _pearson(xs: list[float], ys: list[float]) -> Optional[float]:
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _percentile_rank(value: float, distribution: list[float]) -> Optional[float]:
    if not distribution:
        return None
    n = len(distribution)
    below = sum(1 for x in distribution if x <= value)
    return (below / n) * 100.0


# ── Drawdown finder ─────────────────────────────────────────────────────────

def _find_drawdowns(closes: list[tuple[str, float]]) -> list[dict]:
    """Walk the close series finding peak->trough->recovery drawdowns.

    A drawdown closes when price recovers to the prior peak. If no recovery
    has happened by end-of-series, it's recorded as ongoing.
    """
    if len(closes) < 2:
        return []

    dds: list[dict] = []
    peak_idx = 0
    peak_value = closes[0][1]
    trough_idx = 0
    trough_value = closes[0][1]
    in_dd = False

    for i in range(1, len(closes)):
        price = closes[i][1]
        if price >= peak_value:
            # New peak — close out any active material drawdown.
            if in_dd:
                depth_pct = (trough_value - peak_value) / peak_value * 100.0
                if abs(depth_pct) >= MIN_DRAWDOWN_PCT:
                    dds.append({
                        "peak_date":      closes[peak_idx][0],
                        "peak_value":     peak_value,
                        "trough_date":    closes[trough_idx][0],
                        "trough_value":   trough_value,
                        "recovery_date":  closes[i][0],
                        "depth_pct":      depth_pct,
                        "drawdown_days":  _date_delta(closes[peak_idx][0], closes[trough_idx][0]),
                        "recovery_days":  _date_delta(closes[trough_idx][0], closes[i][0]),
                        "total_days":     _date_delta(closes[peak_idx][0], closes[i][0]),
                        "ongoing":        False,
                    })
            peak_idx = i
            peak_value = price
            trough_idx = i
            trough_value = price
            in_dd = False
        elif price < trough_value:
            trough_value = price
            trough_idx = i
            in_dd = True

    # End-of-series ongoing drawdown.
    if in_dd:
        depth_pct = (trough_value - peak_value) / peak_value * 100.0
        if abs(depth_pct) >= MIN_DRAWDOWN_PCT:
            last_date = closes[-1][0]
            dds.append({
                "peak_date":      closes[peak_idx][0],
                "peak_value":     peak_value,
                "trough_date":    closes[trough_idx][0],
                "trough_value":   trough_value,
                "recovery_date":  None,
                "depth_pct":      depth_pct,
                "drawdown_days":  _date_delta(closes[peak_idx][0], closes[trough_idx][0]),
                "recovery_days":  None,
                "total_days":     _date_delta(closes[peak_idx][0], last_date),
                "ongoing":        True,
            })

    # Most negative first.
    dds.sort(key=lambda d: d["depth_pct"])
    return dds


def _date_delta(a: str, b: str) -> Optional[int]:
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days
    except Exception:
        return None


# ── Tail risk metrics ───────────────────────────────────────────────────────

def _tail_risk(returns: list[float], drawdowns: list[dict]) -> dict:
    n = len(returns)
    if n < 2:
        return {}

    mean = sum(returns) / n
    std = statistics.pstdev(returns)
    annual_ret = mean * ANNUAL_FACTOR * 100.0
    annual_vol = std * math.sqrt(ANNUAL_FACTOR) * 100.0

    # Trailing windows.
    last_21 = returns[-min(21, n):]
    last_252 = returns[-min(252, n):]
    vol_21d = statistics.pstdev(last_21) * math.sqrt(ANNUAL_FACTOR) * 100.0 if len(last_21) >= 2 else None
    vol_252d = statistics.pstdev(last_252) * math.sqrt(ANNUAL_FACTOR) * 100.0 if len(last_252) >= 2 else None

    # Downside-only stats.
    negative = [r for r in returns if r < 0]
    if negative:
        downside_std = statistics.pstdev(negative)
        downside_dev_ann = downside_std * math.sqrt(ANNUAL_FACTOR) * 100.0
        sortino = (annual_ret / downside_dev_ann) if downside_dev_ann else None
    else:
        downside_dev_ann = None
        sortino = None

    sharpe = (annual_ret / annual_vol) if annual_vol else None

    # CVaR-95: average return on the worst 5% of days (expressed as a daily %).
    sorted_returns = sorted(returns)
    cutoff = max(1, int(n * 0.05))
    cvar_95_daily = (sum(sorted_returns[:cutoff]) / cutoff) * 100.0

    # Max drawdown summary from the precomputed list.
    if drawdowns:
        max_dd = min(drawdowns, key=lambda d: d["depth_pct"])
        max_dd_depth_pct = max_dd["depth_pct"]
        max_dd_duration_days = max_dd["total_days"]
    else:
        max_dd_depth_pct = None
        max_dd_duration_days = None

    return {
        "annual_return_pct":     round(annual_ret, 2),
        "annual_vol_pct":        round(annual_vol, 2),
        "vol_21d_annualized_pct": round(vol_21d, 2) if vol_21d is not None else None,
        "vol_252d_annualized_pct": round(vol_252d, 2) if vol_252d is not None else None,
        "sharpe_ann":            round(sharpe, 2) if sharpe is not None else None,
        "sortino_ann":           round(sortino, 2) if sortino is not None else None,
        "downside_dev_ann_pct":  round(downside_dev_ann, 2) if downside_dev_ann is not None else None,
        "cvar_95_daily_pct":     round(cvar_95_daily, 3),
        "max_dd_depth_pct":      round(max_dd_depth_pct, 2) if max_dd_depth_pct is not None else None,
        "max_dd_duration_days":  max_dd_duration_days,
        "n_obs":                 n,
    }


def _vol_regime(returns: list[float]) -> dict:
    """21D realized vol percentile vs the sector's own 5y distribution of 21D vols."""
    stds = _rolling_std(returns, ROLL_VOL_WINDOW)
    valid = [s for s in stds if s is not None]
    if not valid:
        return {"current_vol_pct": None, "percentile": None, "p10": None, "p90": None}
    current = valid[-1] * math.sqrt(ANNUAL_FACTOR) * 100.0
    distribution_ann = [s * math.sqrt(ANNUAL_FACTOR) * 100.0 for s in valid]
    sorted_d = sorted(distribution_ann)
    n = len(sorted_d)
    return {
        "current_vol_pct":   round(current, 2),
        "percentile":        round(_percentile_rank(current, distribution_ann) or 0, 1),
        "p10":               round(sorted_d[max(0, int(n * 0.10) - 1)], 2),
        "p50":               round(sorted_d[max(0, int(n * 0.50) - 1)], 2),
        "p90":               round(sorted_d[min(n - 1, int(n * 0.90))], 2),
    }


def _correlation_z(
    sector_returns: list[float],
    spy_returns: list[float],
) -> dict:
    """60D rolling correlation. Compare current to the full 5y distribution of
    60D correlations -> z-score and percentile."""
    n = min(len(sector_returns), len(spy_returns))
    if n < ROLL_CORR_WINDOW + 2:
        return {"current": None, "mean": None, "std": None, "z": None, "percentile": None}
    rolling = _rolling_corr(sector_returns[-n:], spy_returns[-n:], ROLL_CORR_WINDOW)
    valid = [c for c in rolling if c is not None]
    if not valid:
        return {"current": None, "mean": None, "std": None, "z": None, "percentile": None}
    current = valid[-1]
    mean = sum(valid) / len(valid)
    std = statistics.pstdev(valid)
    z = ((current - mean) / std) if std > 0 else None
    return {
        "current":    round(current, 3),
        "mean":       round(mean, 3),
        "std":        round(std, 3),
        "z":          round(z, 2) if z is not None else None,
        "percentile": round(_percentile_rank(current, valid) or 0, 1),
        "window":     ROLL_CORR_WINDOW,
    }


# ── Regime overlay ──────────────────────────────────────────────────────────

def _regime_lookup() -> tuple[dict[str, str], bool]:
    """Build a {date: regime_label} map across the lookback window. Requires
    FRED for the yield inputs; without FRED we return an empty map and the
    drawdown rows show "n/a" for the regime tag."""
    if not settings.has_fred:
        return {}, False
    try:
        vix = macro_data.fetch_explicit("^VIX", source="yfinance", days=LOOKBACK_DAYS)
        y2 = macro_data.fetch_explicit("DGS2", source="fred", days=LOOKBACK_DAYS)
        y10 = macro_data.fetch_explicit("DGS10", source="fred", days=LOOKBACK_DAYS)
        history = regime_model.regime_history(vix, y2, y10)
        return {row["date"]: row["label"] for row in history}, True
    except Exception as exc:
        log.warning("Regime lookup failed for sector_risk: %s", exc)
        return {}, False


# ── Public API ──────────────────────────────────────────────────────────────

def sector_risk(sector_id: str) -> dict:
    if sector_id not in sector_detail.SECTORS:
        raise ValueError(f"Unknown sector: {sector_id}")
    sec = sector_detail.SECTORS[sector_id]
    etf = sec["etf"]

    etf_closes = _closes(etf)
    spy_closes = _closes("SPY")
    if len(etf_closes) < 30:
        return {
            "sector_id": sector_id, "etf": etf,
            "available": False,
            "reason": "Not enough ETF history",
            "drawdowns": [], "tail_risk": {}, "vol_regime": {},
            "correlation_to_spy": {},
            "regime_classifier_available": False,
        }

    etf_dates, etf_returns = _daily_returns(etf_closes)
    _spy_dates, spy_returns_raw = _daily_returns(spy_closes)

    # Align SPY returns to the ETF's date index (trimming SPY to common dates).
    spy_by_date = {d: r for d, r in zip(_spy_dates, spy_returns_raw)}
    spy_returns_aligned = [spy_by_date.get(d, 0.0) for d in etf_dates]

    drawdowns = _find_drawdowns(etf_closes)
    top_drawdowns = drawdowns[:TOP_N_DRAWDOWNS]

    # Tag each drawdown trough with the macro regime active at that date.
    regime_map, classifier_available = _regime_lookup()
    for dd in top_drawdowns:
        trough = dd["trough_date"]
        dd["trough_regime"] = regime_map.get(trough, "n/a" if classifier_available else "n/a")

    tail = _tail_risk(etf_returns, drawdowns)
    vol_regime = _vol_regime(etf_returns)
    corr = _correlation_z(etf_returns, spy_returns_aligned)

    # Equity curve sample for the frontend: weekly downsample to keep payload small.
    curve = _downsample_curve(etf_closes, step=5)  # ~1 point per week

    return {
        "sector_id":                  sector_id,
        "name":                       sec["name"],
        "etf":                        etf,
        "lookback_days":              LOOKBACK_DAYS,
        "available":                  True,
        "regime_classifier_available": classifier_available,
        "drawdowns":                  top_drawdowns,
        "drawdown_count_total":       len(drawdowns),
        "tail_risk":                  tail,
        "vol_regime":                 vol_regime,
        "correlation_to_spy":         corr,
        "equity_curve":               curve,
    }


def _downsample_curve(closes: list[tuple[str, float]], step: int) -> list[dict]:
    if not closes:
        return []
    sampled = closes[::step]
    if sampled[-1][0] != closes[-1][0]:
        sampled.append(closes[-1])
    return [{"date": d, "value": round(v, 2)} for d, v in sampled]
