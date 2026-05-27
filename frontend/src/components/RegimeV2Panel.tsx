import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { RegimeV2Driver, RegimeV2Label, RegimeV2State } from "../api/types";

/**
 * Regime V2 — Wave 5.
 *
 * 5-state classifier with probability bar + driver attribution.
 */
const REGIME_ORDER: RegimeV2Label[] = ["risk_on", "early_cycle", "late_cycle", "risk_off", "recession"];

const REGIME_COLORS: Record<RegimeV2Label, string> = {
  risk_on:     "#22c55e",
  early_cycle: "#5fb878",
  late_cycle:  "#fbbf24",
  risk_off:    "#fb7185",
  recession:   "#ef4444",
};

const REGIME_LABELS: Record<RegimeV2Label, string> = {
  risk_on:     "Risk-On",
  early_cycle: "Early Cycle",
  late_cycle:  "Late Cycle",
  risk_off:    "Risk-Off",
  recession:   "Recession",
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
        <span className="pill normal-case tracking-normal text-2xs"
              style={{ background: REGIME_COLORS[state.label] + "30", color: REGIME_COLORS[state.label] }}>
          {REGIME_LABELS[state.label]} · {(state.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="panel-body py-3 flex flex-col gap-3 overflow-auto">
        <ProbabilityBar probabilities={state.probabilities} />
        <div className="text-2xs text-terminal-muted leading-relaxed">{state.reason}</div>
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
              style={{ flexBasis: `${p * 100}%`, background: REGIME_COLORS[r] }}
              title={`${REGIME_LABELS[r]}: ${(p * 100).toFixed(1)}%`}
              className="flex items-center justify-center text-2xs text-black/80 font-semibold"
            >
              {p > 0.10 ? `${(p * 100).toFixed(0)}%` : ""}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-5 gap-1 mt-1 text-2xs text-terminal-muted">
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
      <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1">drivers</div>
      <div className="divide-y divide-terminal-divider text-xs">
        {drivers.map((d) => (
          <div key={d.name} className="py-1.5 flex flex-col">
            <div className="flex justify-between">
              <span className="text-terminal-text">{d.name}</span>
              <span className="text-accent-amber tabular-nums">{d.value}</span>
            </div>
            <div className="text-2xs text-terminal-muted">{d.interpretation}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
