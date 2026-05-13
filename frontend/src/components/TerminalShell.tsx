import { useEffect, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout";

import { api } from "../api/client";
import type { HealthResponse } from "../api/types";
import { MacroRegimeTracker } from "./MacroRegimeTracker";

// react-grid-layout uses 12-column x N-row grid; layout values are in grid units.
const LAYOUT: Layout[] = [
  { i: "macro", x: 0, y: 0, w: 12, h: 18, minW: 6, minH: 10 },
];

const ROW_HEIGHT = 30;

export function TerminalShell() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(new Date());
  const [gridWidth, setGridWidth] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth - 16 : 1200,
  );

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    const resize = () => setGridWidth(window.innerWidth - 16);
    window.addEventListener("resize", resize);
    return () => {
      clearInterval(tick);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="h-full flex flex-col">
      <Topbar health={health} now={now} />

      <div className="flex-1 overflow-auto px-2">
        <GridLayout
          className="layout"
          layout={LAYOUT}
          cols={12}
          rowHeight={ROW_HEIGHT}
          width={gridWidth}
          margin={[8, 8]}
          draggableHandle=".panel-header"
          isBounded
        >
          <div key="macro">
            <MacroRegimeTracker />
          </div>
        </GridLayout>
      </div>

      <StatusBar health={health} now={now} />
    </div>
  );
}

function Topbar({ health, now }: { health: HealthResponse | null; now: Date }) {
  return (
    <header className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-panel">
      <div className="flex items-center gap-3">
        <span className="text-accent-amber font-semibold tracking-widest text-sm">
          AI ▸ TERMINAL
        </span>
        <span className="text-terminal-muted text-2xs uppercase tracking-wider">
          Automated-Investing · v0.1
        </span>
      </div>
      <div className="flex items-center gap-3 text-2xs text-terminal-muted">
        <span>{health?.claude_model ?? "—"}</span>
        <span>{now.toISOString().slice(11, 19)} UTC</span>
      </div>
    </header>
  );
}

function StatusBar({ health, now }: { health: HealthResponse | null; now: Date }) {
  const fred = health?.fred_configured;
  const claude = health?.anthropic_configured;
  return (
    <footer className="flex items-center justify-between px-3 py-1.5 border-t border-terminal-border bg-terminal-panel text-2xs text-terminal-muted">
      <div className="flex items-center gap-4">
        <KeyStatus name="FRED" ok={fred} />
        <KeyStatus name="ANTHROPIC" ok={claude} />
      </div>
      <div className="flex items-center gap-3">
        <span>{now.toLocaleDateString()}</span>
        <span className="text-accent-green">● connected</span>
      </div>
    </footer>
  );
}

function KeyStatus({ name, ok }: { name: string; ok: boolean | undefined }) {
  const color =
    ok === undefined ? "text-terminal-dim"
      : ok           ? "text-accent-green"
      :                "text-accent-red";
  const dot =
    ok === undefined ? "bg-terminal-dim"
      : ok           ? "bg-accent-green"
      :                "bg-accent-red";
  return (
    <span className={`flex items-center gap-1 ${color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {name}
    </span>
  );
}
