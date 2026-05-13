"""Rule-based macro regime detection (v1).

Per the design doc, HMM is deferred until validation passes. The rule-based
classifier produces three regimes from the 5 core macro series:

  - risk_on:    VIX < 15 AND 10Y >= 2Y (upward-sloping curve)
  - risk_off:   VIX > 25 OR 2Y > 10Y (inversion)
  - transition: anything else

A confidence score reflects how cleanly the inputs satisfy the dominant regime.

`detect_regime` returns the current label; `regime_history` labels each day
over the supplied window, which Panel 2 (Regime Journal) consumes.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..data.macro_data import SeriesPoint, latest_value


RegimeLabel = Literal["risk_on", "risk_off", "transition"]


@dataclass
class RegimeState:
    label: RegimeLabel
    confidence: float          # 0.0 - 1.0
    reason: str                # one-line plain-English summary
    inputs: dict[str, float | None]

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "confidence": round(self.confidence, 2),
            "reason": self.reason,
            "inputs": self.inputs,
        }


def _classify(vix: float | None, y2: float | None, y10: float | None) -> RegimeState:
    inputs = {"vix": vix, "y2": y2, "y10": y10}

    # If we're missing anything critical, we can't classify.
    if vix is None or y2 is None or y10 is None:
        return RegimeState(
            label="transition",
            confidence=0.0,
            reason="Insufficient macro data for classification.",
            inputs=inputs,
        )

    inverted = y2 > y10
    curve_spread = y10 - y2

    # Risk-off: strong stress signals
    if vix > 25 or inverted:
        # Confidence scales with how stretched VIX and the inversion are
        vix_stress = max(0.0, min(1.0, (vix - 25) / 25))
        curve_stress = max(0.0, min(1.0, (y2 - y10) / 1.0)) if inverted else 0.0
        conf = max(0.5, min(1.0, 0.6 + 0.4 * max(vix_stress, curve_stress)))
        reasons = []
        if vix > 25:
            reasons.append(f"VIX elevated at {vix:.1f}")
        if inverted:
            reasons.append(f"Curve inverted (2Y {y2:.2f}% > 10Y {y10:.2f}%)")
        return RegimeState(
            label="risk_off",
            confidence=conf,
            reason="; ".join(reasons),
            inputs=inputs,
        )

    # Risk-on: calm vol, positive curve
    if vix < 15 and curve_spread > 0:
        vix_calm = max(0.0, min(1.0, (15 - vix) / 15))
        curve_health = max(0.0, min(1.0, curve_spread / 1.5))
        conf = max(0.5, min(1.0, 0.6 + 0.4 * min(vix_calm, curve_health)))
        return RegimeState(
            label="risk_on",
            confidence=conf,
            reason=f"VIX subdued at {vix:.1f}; curve healthy (+{curve_spread:.2f}%)",
            inputs=inputs,
        )

    # Transition: in between
    return RegimeState(
        label="transition",
        confidence=0.5,
        reason=(
            f"Mixed signals: VIX {vix:.1f}, "
            f"2Y/10Y spread {curve_spread:+.2f}%"
        ),
        inputs=inputs,
    )


def detect_current(
    vix_series: list[SeriesPoint],
    y2_series: list[SeriesPoint],
    y10_series: list[SeriesPoint],
) -> RegimeState:
    """Classify the latest available datapoint across the three inputs."""
    return _classify(
        vix=latest_value(vix_series),
        y2=latest_value(y2_series),
        y10=latest_value(y10_series),
    )


def regime_history(
    vix_series: list[SeriesPoint],
    y2_series: list[SeriesPoint],
    y10_series: list[SeriesPoint],
) -> list[dict]:
    """Label each day across the supplied window. Aligns by date, forward-fills
    missing values within each series (FRED/yfinance disagree on trading days).
    """
    # Build per-date lookup, fill forward as we walk dates in order.
    def _index(points: list[SeriesPoint]) -> dict[str, float | None]:
        return {p["date"]: p["value"] for p in points}

    vix_idx = _index(vix_series)
    y2_idx = _index(y2_series)
    y10_idx = _index(y10_series)

    all_dates = sorted(set(vix_idx) | set(y2_idx) | set(y10_idx))

    out: list[dict] = []
    last_vix = last_y2 = last_y10 = None
    for d in all_dates:
        if (v := vix_idx.get(d)) is not None:
            last_vix = v
        if (v := y2_idx.get(d)) is not None:
            last_y2 = v
        if (v := y10_idx.get(d)) is not None:
            last_y10 = v
        state = _classify(last_vix, last_y2, last_y10)
        out.append({"date": d, **state.to_dict()})
    return out


def find_transitions(history: list[dict], limit: int = 5) -> list[dict]:
    """Most recent regime changes from a history series, newest first."""
    transitions: list[dict] = []
    prev = None
    for entry in history:
        if prev is not None and entry["label"] != prev["label"]:
            transitions.append({
                "date": entry["date"],
                "from": prev["label"],
                "to": entry["label"],
                "reason": entry["reason"],
            })
        prev = entry
    return list(reversed(transitions))[:limit]
