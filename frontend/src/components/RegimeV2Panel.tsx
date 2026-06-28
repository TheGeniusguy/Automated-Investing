import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { RegimeV2Driver, RegimeV2Label, RegimeV2State } from "../api/types";

/**
 * Regime V2 — Wave 5.
 *
 * 5-state classifier with probability bar + driver attribution.
 */
const REGIME_ORDER: RegimeV2Label[] = ["risk_on", "early_cycle", "late_cycle", "risk_off", "recession"];

const REGIME_LABELS: Record<RegimeV2Label, string> = {
  risk_on:     "Risk-On",
  early_cycle: "Early Cycle",
  late_cycle:  "Late Cycle",
  risk_off:    "Risk-Off",
  recession:   "Recession",
};

// Warm green → clay → red risk scale, built entirely from design tokens (no hex).
// Adjacent same-hue states are separated by opacity so all five stay legible.
const REGIME_BAR: Record<RegimeV2Label, string> = {
  risk_on:     "bg-regime-on",
  early_cycle: "bg-regime-on/55",
  late_cycle:  "bg-accent-amber",
  risk_off:    "bg-accent-red/70",
  recession:   "bg-accent-red",
};

const REGIME_TEXT: Record<RegimeV2Label, string> = {
  risk_on:     "text-regime-on",
  early_cycle: "text-accent-green",
  late_cycle:  "text-accent-amber",
  risk_off:    "text-accent-red",
  recession:   "text-regime-off",
};

const REGIME_PILL: Record<RegimeV2Label, string> = {
  risk_on:     "bg-regime-on/15 text-regime-on",
  early_cycle: "bg-regime-on/10 text-accent-green",
  late_cycle:  "bg-accent-amber/15 text-accent-amber",
  risk_off:    "bg-accent-red/15 text-accent-red",
  recession:   "bg-accent-red/20 text-regime-off",
};

export function RegimeV2Panel() {
  const [state, setState] = useState<RegimeV2State | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.regimeV2()
      .then((s) => alive && setState(s))
      .catch((e) => alive && setErr(String(e)));
    return () => { alive = false; };
  }, []);

  if (err) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Regime v2</span></div>
        <div className="panel-body text-accent-red">⚠ {err}</div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="panel h-full">
        <div className="panel-header"><span>Regime v2</span></div>
        <div className="panel-body text-terminal-dim">loading…</div>
      </div>
    );
  }

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header">
        <span>5-State Macro Regime</span>
        <span className={`pill normal-case tracking-normal text-2xs ${REGIME_PILL[state.label]}`}>
          {REGIME_LABELS[state.label]} · {(state.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="panel-body flex flex-col gap-4 overflow-auto">
        {/* Hero: current regime confidence as a confident editorial figure */}
        <div className="flex items-baseline gap-3">
          <span className={`stat-figure text-4xl leading-none ${REGIME_TEXT[state.label]}`}>
            {(state.confidence * 100).toFixed(0)}%
          </span>
          <div className="flex flex-col">
            <span className="font-serif text-lg leading-tight text-terminal-text">
              {REGIME_LABELS[state.label]}
            </span>
            <span className="text-2xs uppercase tracking-wider text-terminal-dim">
              confidence
            </span>
          </div>
        </div>
        <ProbabilityBar probabilities={state.probabilities} />
        <div className="text-xs text-terminal-muted leading-relaxed">{state.reason}</div>
        <DriversTable drivers={state.drivers} />
      </div>
    </div>
  );
}

function ProbabilityBar({ probabilities }: { probabilities: Record<string, number> }) {
  return (
    <div>
      <div className="flex w-full h-6 rounded overflow-hidden">
        {REGIME_ORDER.map((r) => {
          const p = probabilities[r] ?? 0;
          if (p <= 0.001) return null;
          return (
            <div
              key={r}
              style={{ flexBasis: `${p * 100}%` }}
              title={`${REGIME_LABELS[r]}: ${(p * 100).toFixed(1)}%`}
              className={`flex items-center justify-center text-2xs tabular-nums text-terminal-bg font-semibold ${REGIME_BAR[r]}`}
            >
              {p > 0.10 ? `${(p * 100).toFixed(0)}%` : ""}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-5 gap-1 mt-1.5 text-2xs text-terminal-muted">
        {REGIME_ORDER.map((r) => (
          <div key={r} className="text-center">{REGIME_LABELS[r]}</div>
        ))}
      </div>
    </div>
  );
}

function DriversTable({ drivers }: { drivers: RegimeV2Driver[] }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1.5">drivers</div>
      <div className="divide-y divide-terminal-divider text-xs">
        {drivers.map((d) => (
          <div key={d.name} className="py-2 flex flex-col gap-0.5">
            <div className="flex justify-between gap-2">
              <span className="text-terminal-text">{d.name}</span>
              <span className="font-mono tabular-nums text-accent-amber">{d.value}</span>
            </div>
            <div className="text-2xs text-terminal-muted leading-relaxed">{d.interpretation}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
