"""Macro regime model v2 — 5-state with probability vector.

The v1 model classifies risk_on / risk_off / transition off VIX + 2s10s.
v2 adds:
  - early_cycle and late_cycle states between risk_on and risk_off
  - recession state distinct from generic risk_off
  - a probability vector over all 5 states using soft scoring of drivers
  - driver attribution: which inputs are pushing toward which regime

Drivers used (all FRED + yfinance, no new keys):
  - VIX (^VIX)
  - 10Y-2Y spread (DGS10 − DGS2)
  - 10Y-3M spread (DGS10 − DGS3MO)
  - HY credit spread (BAMLH0A0HYM2)
  - Initial claims YoY (recession signal)
  - Industrial Production YoY (cycle position)

This module is additive — the v1 RegimeState contract still drives the
existing UI; v2 adds /api/regime/v2 alongside.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Literal

from ..data import macro_data, yield_curve, recession as recession_mod

log = logging.getLogger(__name__)


RegimeV2 = Literal["risk_on", "early_cycle", "late_cycle", "risk_off", "recession"]


REGIMES: list[RegimeV2] = ["risk_on", "early_cycle", "late_cycle", "risk_off", "recession"]


@dataclass
class RegimeV2State:
    label: RegimeV2
    probabilities: dict[str, float]
    confidence: float
    reason: str
    drivers: list[dict]

    def to_dict(self) -> dict:
        return {
            "label":         self.label,
            "probabilities": self.probabilities,
            "confidence":    self.confidence,
            "reason":        self.reason,
            "drivers":       self.drivers,
        }


# ----------- Driver helpers -----------

def _yoy_change(values: list[dict]) -> float | None:
    pts = [p for p in values if p["value"] is not None]
    pts.sort(key=lambda p: p["date"])
    if len(pts) < 13:
        return None
    cur = pts[-1]["value"]
    prev = pts[-13]["value"]
    if prev is None or prev == 0:
        return None
    return (cur / prev - 1.0) * 100.0


def _latest(values: list[dict]) -> float | None:
    for p in reversed(values):
        if p.get("value") is not None:
            return p["value"]
    return None


# ----------- Soft scoring -----------

def _score_drivers() -> tuple[list[dict], dict[str, float]]:
    """Compute current driver readings and per-regime score contributions.

    Each driver pushes the probability vector with a soft sigmoid weight.
    """
    vix     = _latest(macro_data.fetch_series("^VIX",          days=30))
    y2      = _latest(macro_data.fetch_series("DGS2",          days=30))
    y10     = _latest(macro_data.fetch_series("DGS10",         days=30))
    y3m     = _latest(macro_data.fetch_series("DGS3MO",        days=30))
    hy      = _latest(macro_data.fetch_series("BAMLH0A0HYM2",  days=30))
    icsa_raw= macro_data.fetch_series("ICSA",                 days=400)
    indpro  = macro_data.fetch_series("INDPRO",               days=400)

    claims_yoy = _yoy_change(icsa_raw)
    ip_yoy     = _yoy_change(indpro)
    sahm_state = recession_mod.sahm_rule()
    sahm_val   = sahm_state.get("current")

    spread_2_10  = (y10 - y2)  if (y10 is not None and y2 is not None) else None
    spread_3m_10y= (y10 - y3m) if (y10 is not None and y3m is not None) else None

    # Initialize log-odds-style scores for each regime.
    scores = {r: 0.0 for r in REGIMES}

    drivers: list[dict] = []

    # ── VIX
    if vix is not None:
        if vix < 14:
            scores["risk_on"] += 1.0
            scores["early_cycle"] += 0.5
            interp = "calm — supports risk-on"
        elif vix < 18:
            scores["early_cycle"] += 0.5
            scores["late_cycle"] += 0.3
            interp = "moderate"
        elif vix < 25:
            scores["late_cycle"] += 0.6
            scores["risk_off"] += 0.4
            interp = "elevated — late-cycle or stress emerging"
        elif vix < 35:
            scores["risk_off"] += 1.0
            scores["recession"] += 0.5
            interp = "stressed — risk-off pricing"
        else:
            scores["risk_off"] += 1.5
            scores["recession"] += 1.0
            interp = "panic — recession pricing"
        drivers.append({"name": "VIX", "value": round(vix, 2), "interpretation": interp})

    # ── 2s10s
    if spread_2_10 is not None:
        if spread_2_10 < -0.10:
            scores["late_cycle"] += 0.8
            scores["risk_off"] += 0.6
            scores["recession"] += 0.8
            interp = "deeply inverted — late-cycle / recession risk"
        elif spread_2_10 < 0:
            scores["late_cycle"] += 0.6
            scores["risk_off"] += 0.3
            scores["recession"] += 0.4
            interp = "inverted — late-cycle warning"
        elif spread_2_10 < 0.50:
            scores["late_cycle"] += 0.3
            scores["early_cycle"] += 0.1
            interp = "flat"
        elif spread_2_10 < 1.50:
            scores["risk_on"] += 0.5
            scores["early_cycle"] += 0.4
            interp = "positive — healthy"
        else:
            scores["early_cycle"] += 0.8
            scores["risk_on"] += 0.4
            interp = "steep — early-cycle"
        drivers.append({"name": "10Y-2Y spread", "value": round(spread_2_10, 3), "interpretation": interp})

    # ── 10Y-3M
    if spread_3m_10y is not None:
        if spread_3m_10y < -0.50:
            scores["recession"] += 1.0
            scores["risk_off"] += 0.4
            interp = "deeply inverted — NY Fed model recession-prob elevated"
        elif spread_3m_10y < 0:
            scores["late_cycle"] += 0.5
            scores["recession"] += 0.5
            interp = "inverted"
        else:
            scores["early_cycle"] += 0.2
            interp = "normal"
        drivers.append({"name": "10Y-3M spread", "value": round(spread_3m_10y, 3), "interpretation": interp})

    # ── HY spread
    if hy is not None:
        if hy < 3.5:
            scores["risk_on"] += 0.7
            scores["early_cycle"] += 0.3
            interp = "tight — risk appetite high"
        elif hy < 5.0:
            scores["risk_on"] += 0.3
            scores["late_cycle"] += 0.4
            interp = "moderate"
        elif hy < 7.0:
            scores["late_cycle"] += 0.5
            scores["risk_off"] += 0.5
            interp = "widening — credit stress emerging"
        else:
            scores["risk_off"] += 1.0
            scores["recession"] += 0.7
            interp = "wide — credit stress"
        drivers.append({"name": "HY spread", "value": round(hy, 2), "interpretation": interp})

    # ── Claims YoY (positive = labor weakening)
    if claims_yoy is not None:
        if claims_yoy > 15:
            scores["recession"] += 1.0
            scores["risk_off"] += 0.5
            interp = f"+{claims_yoy:.1f}% YoY — labor weakening sharply"
        elif claims_yoy > 5:
            scores["late_cycle"] += 0.6
            scores["risk_off"] += 0.3
            interp = f"+{claims_yoy:.1f}% YoY — softening"
        elif claims_yoy > -5:
            scores["late_cycle"] += 0.2
            scores["risk_on"] += 0.1
            interp = f"{claims_yoy:+.1f}% YoY — stable"
        else:
            scores["risk_on"] += 0.4
            scores["early_cycle"] += 0.5
            interp = f"{claims_yoy:+.1f}% YoY — labor tightening"
        drivers.append({"name": "Claims YoY", "value": round(claims_yoy, 1), "interpretation": interp})

    # ── IP YoY (cycle position)
    if ip_yoy is not None:
        if ip_yoy > 3:
            scores["risk_on"] += 0.5
            scores["early_cycle"] += 0.6
            interp = f"+{ip_yoy:.1f}% — expansion"
        elif ip_yoy > 0:
            scores["early_cycle"] += 0.2
            scores["late_cycle"] += 0.3
            interp = f"+{ip_yoy:.1f}% — slowing"
        elif ip_yoy > -3:
            scores["late_cycle"] += 0.5
            scores["risk_off"] += 0.2
            interp = f"{ip_yoy:.1f}% — contracting"
        else:
            scores["recession"] += 0.8
            scores["risk_off"] += 0.4
            interp = f"{ip_yoy:.1f}% — sharp contraction"
        drivers.append({"name": "IP YoY", "value": round(ip_yoy, 1), "interpretation": interp})

    # ── Sahm Rule (recession trigger)
    if sahm_val is not None:
        if sahm_val >= 0.50:
            scores["recession"] += 1.5
            scores["risk_off"] += 0.5
            interp = f"{sahm_val:.2f}pp — TRIGGERED"
        elif sahm_val >= 0.30:
            scores["late_cycle"] += 0.5
            scores["recession"] += 0.7
            interp = f"{sahm_val:.2f}pp — close to trigger"
        elif sahm_val >= 0.10:
            scores["late_cycle"] += 0.3
            interp = f"{sahm_val:.2f}pp — elevated"
        else:
            scores["risk_on"] += 0.2
            scores["early_cycle"] += 0.3
            interp = f"{sahm_val:.2f}pp — labor stable"
        drivers.append({"name": "Sahm Rule", "value": round(sahm_val, 2), "interpretation": interp})

    return drivers, scores


def _softmax(scores: dict[str, float], temperature: float = 1.0) -> dict[str, float]:
    """Softmax over score dict, returning probabilities that sum to 1."""
    max_s = max(scores.values()) if scores else 0.0
    exps = {k: math.exp((v - max_s) / temperature) for k, v in scores.items()}
    total = sum(exps.values())
    if total == 0:
        # Uniform fallback
        n = len(scores)
        return {k: 1.0 / n for k in scores}
    return {k: v / total for k, v in exps.items()}


def detect_current() -> RegimeV2State:
    drivers, scores = _score_drivers()
    probabilities = _softmax(scores)

    # Top label
    if not probabilities:
        label = "risk_on"
        confidence = 0.0
    else:
        label = max(probabilities, key=probabilities.get)
        confidence = probabilities[label]

    reason = _build_reason(label, drivers)

    return RegimeV2State(
        label=label,
        probabilities={k: round(v, 3) for k, v in probabilities.items()},
        confidence=round(confidence, 3),
        reason=reason,
        drivers=drivers,
    )


def _build_reason(label: RegimeV2, drivers: list[dict]) -> str:
    label_text = {
        "risk_on":     "Risk-on regime",
        "early_cycle": "Early-cycle expansion",
        "late_cycle":  "Late-cycle conditions",
        "risk_off":    "Risk-off / stress regime",
        "recession":   "Recession-adjacent regime",
    }[label]
    if not drivers:
        return f"{label_text} — insufficient driver data."
    top3 = drivers[:3]
    bits = "; ".join(f"{d['name']}: {d['interpretation']}" for d in top3)
    return f"{label_text}. {bits}."
