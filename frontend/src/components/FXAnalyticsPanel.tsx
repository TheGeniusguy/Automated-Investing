import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";

// ── Local types (mirror backend shapes; wiring types loosely) ─────────────────

interface FXForward {
  "1M": number | null;
  "3M": number | null;
  "6M": number | null;
  "1Y": number | null;
}

interface FXCarryPair {
  pair: string;
  spot: number | null;
  fwd: FXForward;
  carry_pct: number | null;
  base_rate: number | null;
  quote_rate: number | null;
}

interface FXCarryResponse {
  pairs: FXCarryPair[];
  data_mode?: string;
  as_of?: string;
  source?: string;
}

interface FXVolTenor {
  tenor: string;
  realized_vol: number | null;
  iv_min: number | null;
  iv_p25: number | null;
  iv_median: number | null;
  iv_p75: number | null;
  iv_max: number | null;
}

interface FXVolResponse {
  pair: string;
  tenors: FXVolTenor[];
  data_mode?: string;
  as_of?: string;
  source?: string;
}

const FWD_KEYS: (keyof FXForward)[] = ["1M", "3M", "6M", "1Y"];

type SortKey = "pair" | "spot" | "carry_pct" | "base_rate" | "quote_rate" | keyof FXForward;
type SortDir = "asc" | "desc";

// ── Panel ─────────────────────────────────────────────────────────────────────

export function FXAnalyticsPanel() {
  const [carry, setCarry] = useState<FXCarryResponse | null>(null);
  const [carryLoading, setCarryLoading] = useState(false);
  const [carryErr, setCarryErr] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("carry_pct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [selected, setSelected] = useState<string | null>(null);
  const [vol, setVol] = useState<FXVolResponse | null>(null);
  const [volLoading, setVolLoading] = useState(false);
  const [volErr, setVolErr] = useState<string | null>(null);

  // Initial carry load.
  useEffect(() => {
    setCarryLoading(true);
    setCarryErr(null);
    api
      .fxCarry()
      .then((res: FXCarryResponse) => {
        setCarry(res);
        setCarryLoading(false);
        // Default selection: top-carry pair.
        const ranked = [...(res.pairs ?? [])].sort(
          (a, b) => (b.carry_pct ?? -Infinity) - (a.carry_pct ?? -Infinity),
        );
        if (ranked[0]) setSelected(ranked[0].pair);
      })
      .catch((e: unknown) => {
        setCarryErr(String(e));
        setCarryLoading(false);
      });
  }, []);

  // Vol cone load on selection change.
  useEffect(() => {
    if (!selected) return;
    setVolLoading(true);
    setVolErr(null);
    api
      .fxVol(selected)
      .then((res: FXVolResponse) => {
        setVol(res);
        setVolLoading(false);
      })
      .catch((e: unknown) => {
        setVolErr(String(e));
        setVolLoading(false);
      });
  }, [selected]);

  // Top-carry pair for the hero (always ranked by carry, independent of table sort).
  const topPair = useMemo(() => {
    const pairs = carry?.pairs ?? [];
    if (pairs.length === 0) return null;
    return [...pairs].sort(
      (a, b) => (b.carry_pct ?? -Infinity) - (a.carry_pct ?? -Infinity),
    )[0];
  }, [carry]);

  const sortedPairs = useMemo(() => {
    const pairs = [...(carry?.pairs ?? [])];
    const get = (p: FXCarryPair): number | string | null => {
      if (sortKey === "pair") return p.pair;
      if (sortKey === "spot") return p.spot;
      if (sortKey === "carry_pct") return p.carry_pct;
      if (sortKey === "base_rate") return p.base_rate;
      if (sortKey === "quote_rate") return p.quote_rate;
      return p.fwd?.[sortKey] ?? null;
    };
    pairs.sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      const an = av == null ? -Infinity : av;
      const bn = bv == null ? -Infinity : bv;
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return pairs;
  }, [carry, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "pair" ? "asc" : "desc");
    }
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>FX Carry &amp; Volatility</span>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {carryErr && (
          <div className="text-accent-red text-xs py-2">
            Could not load FX carry data. {carryErr}
          </div>
        )}
        {carryLoading && !carry && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Loading FX carry data...
          </div>
        )}

        {carry && (
          <>
            {/* Hero: top-carry pair */}
            {topPair && (
              <div className="bg-terminal-bg border border-terminal-border rounded-panel p-4 flex items-end justify-between flex-wrap gap-3">
                <div>
                  <div className="text-2xs uppercase tracking-[0.14em] text-terminal-muted mb-1">
                    Highest Carry
                  </div>
                  <div className="stat-figure text-4xl text-terminal-text leading-none">
                    {topPair.pair}
                  </div>
                  <div className="text-xs text-terminal-dim mt-1 font-mono">
                    Spot {fmtNum(topPair.spot, 4)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xs uppercase tracking-[0.14em] text-terminal-muted mb-1">
                    Annualized Carry
                  </div>
                  <div
                    className={`stat-figure text-4xl leading-none ${carryColor(topPair.carry_pct)}`}
                  >
                    {fmtPct(topPair.carry_pct)}
                  </div>
                  <div className="text-2xs text-terminal-dim mt-1 font-mono">
                    base {fmtPctPlain(topPair.base_rate)} / quote{" "}
                    {fmtPctPlain(topPair.quote_rate)}
                  </div>
                </div>
              </div>
            )}

            {/* Carry table */}
            <Section title="Carry Ranking">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
                      <Th label="Pair" col="pair" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="left" />
                      <Th label="Spot" col="spot" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      {FWD_KEYS.map((k) => (
                        <Th key={k} label={k} col={k} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      ))}
                      <Th label="Carry" col="carry_pct" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Base" col="base_rate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Quote" col="quote_rate" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPairs.map((p) => {
                      const active = p.pair === selected;
                      return (
                        <tr
                          key={p.pair}
                          onClick={() => setSelected(p.pair)}
                          className={`border-t border-terminal-border/40 cursor-pointer transition-colors ${
                            active ? "bg-accent-amber/10" : "hover:bg-white/[0.02]"
                          }`}
                        >
                          <td className="py-1.5 px-2 text-left">
                            <span
                              className={`font-medium ${active ? "text-accent-amber" : "text-terminal-text"}`}
                            >
                              {p.pair}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">
                            {fmtNum(p.spot, 4)}
                          </td>
                          {FWD_KEYS.map((k) => (
                            <td
                              key={k}
                              className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted"
                            >
                              {fmtNum(p.fwd?.[k], 4)}
                            </td>
                          ))}
                          <td
                            className={`py-1.5 px-2 text-right font-mono tabular-nums font-semibold ${carryColor(p.carry_pct)}`}
                          >
                            {fmtPct(p.carry_pct)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
                            {fmtPctPlain(p.base_rate)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
                            {fmtPctPlain(p.quote_rate)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {sortedPairs.length === 0 && (
                  <div className="text-2xs text-terminal-dim py-3 text-center">
                    No carry pairs available.
                  </div>
                )}
              </div>
            </Section>

            {/* Vol cone */}
            <Section title="Volatility Cone">
              <div className="flex items-center gap-1 flex-wrap mb-3">
                <span className="text-2xs text-terminal-dim uppercase mr-1">Pair:</span>
                {(carry.pairs ?? []).map((p) => (
                  <button
                    key={p.pair}
                    type="button"
                    onClick={() => setSelected(p.pair)}
                    className={`pill text-2xs ${
                      p.pair === selected
                        ? "bg-accent-amber text-terminal-bg"
                        : "text-terminal-dim hover:text-terminal-text"
                    }`}
                  >
                    {p.pair}
                  </button>
                ))}
              </div>

              {volErr && (
                <div className="text-accent-red text-xs py-2">
                  Could not load volatility data. {volErr}
                </div>
              )}
              {volLoading && (
                <div className="text-terminal-dim text-xs py-6 text-center">
                  Loading volatility cone...
                </div>
              )}
              {!volLoading && !volErr && vol && (
                <>
                  <VolCone tenors={vol.tenors ?? []} />
                  <VolConeLegend />
                  <VolConeTable tenors={vol.tenors ?? []} />
                </>
              )}
              {!volLoading && !volErr && !vol && (
                <div className="text-2xs text-terminal-dim py-3 text-center">
                  Select a pair to view its volatility cone.
                </div>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sortable header cell ──────────────────────────────────────────────────────

function Th({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  align = "right",
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`py-1 px-2 cursor-pointer select-none whitespace-nowrap ${
        align === "left" ? "text-left" : "text-right"
      } ${active ? "text-accent-amber" : "hover:text-terminal-muted"}`}
    >
      {label}
      {active ? <span className="ml-0.5">{sortDir === "asc" ? "↑" : "↓"}</span> : null}
    </th>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
      <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Volatility cone (SVG) ─────────────────────────────────────────────────────

function VolCone({ tenors }: { tenors: FXVolTenor[] }) {
  const W = 640;
  const H = 280;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 34;

  const usable = tenors.filter((t) => t.iv_min != null && t.iv_max != null);

  const { yMin, yMax } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    usable.forEach((t) => {
      [t.iv_min, t.iv_p25, t.iv_median, t.iv_p75, t.iv_max, t.realized_vol].forEach((v) => {
        if (v != null && Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      });
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const pad = (hi - lo) * 0.12 || 1;
    return { yMin: Math.max(0, lo - pad), yMax: hi + pad };
  }, [usable]);

  if (usable.length === 0) {
    return (
      <div className="text-2xs text-terminal-dim py-6 text-center">
        No volatility cone data available.
      </div>
    );
  }

  const n = usable.length;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) =>
    padT + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;

  const bandPath = (lo: (t: FXVolTenor) => number | null, hi: (t: FXVolTenor) => number | null) => {
    const top: string[] = [];
    const bot: string[] = [];
    usable.forEach((t, i) => {
      const hv = hi(t);
      const lv = lo(t);
      if (hv == null || lv == null) return;
      top.push(`${x(i)},${y(hv)}`);
      bot.unshift(`${x(i)},${y(lv)}`);
    });
    if (top.length === 0) return "";
    return `M ${top.join(" L ")} L ${bot.join(" L ")} Z`;
  };

  const linePath = (pick: (t: FXVolTenor) => number | null) => {
    const pts: string[] = [];
    usable.forEach((t, i) => {
      const v = pick(t);
      if (v == null) return;
      pts.push(`${x(i)},${y(v)}`);
    });
    return pts.length ? `M ${pts.join(" L ")}` : "";
  };

  // Y gridlines (5 ticks).
  const ticks = 5;
  const yGrid = Array.from({ length: ticks + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / ticks);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 300 }}>
      {/* Y gridlines + labels */}
      {yGrid.map((v, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(v)}
            y2={y(v)}
            stroke="#2e2a24"
            strokeWidth={1}
          />
          <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#6e665a">
            {v.toFixed(1)}
          </text>
        </g>
      ))}

      {/* Min-max band */}
      <path d={bandPath((t) => t.iv_min, (t) => t.iv_max)} fill="#6e92c4" fillOpacity={0.1} />
      {/* p25-p75 band */}
      <path d={bandPath((t) => t.iv_p25, (t) => t.iv_p75)} fill="#6e92c4" fillOpacity={0.22} />

      {/* Median line */}
      <path d={linePath((t) => t.iv_median)} fill="none" stroke="#a39a8c" strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Realized vol line */}
      <path d={linePath((t) => t.realized_vol)} fill="none" stroke="#c9785c" strokeWidth={2.25} />

      {/* Realized vol dots */}
      {usable.map((t, i) =>
        t.realized_vol == null ? null : (
          <circle key={i} cx={x(i)} cy={y(t.realized_vol)} r={3} fill="#c9785c" />
        ),
      )}

      {/* X tenor labels */}
      {usable.map((t, i) => (
        <text key={t.tenor} x={x(i)} y={H - padB + 18} textAnchor="middle" fontSize={9} fill="#a39a8c">
          {t.tenor}
        </text>
      ))}
    </svg>
  );
}

function VolConeLegend() {
  return (
    <div className="flex flex-wrap gap-4 mt-2 px-1">
      <LegendItem swatch={<span className="w-4 h-2 rounded-sm inline-block" style={{ background: "#6e92c4", opacity: 0.1 }} />} label="IV min-max" />
      <LegendItem swatch={<span className="w-4 h-2 rounded-sm inline-block" style={{ background: "#6e92c4", opacity: 0.3 }} />} label="IV p25-p75" />
      <LegendItem
        swatch={
          <span className="w-4 inline-block border-t-2 border-dashed" style={{ borderColor: "#a39a8c" }} />
        }
        label="IV median"
      />
      <LegendItem
        swatch={<span className="w-4 h-0.5 rounded inline-block" style={{ background: "#c9785c" }} />}
        label="Realized vol"
      />
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-terminal-dim">
      {swatch}
      {label}
    </div>
  );
}

function VolConeTable({ tenors }: { tenors: FXVolTenor[] }) {
  if (tenors.length === 0) return null;
  return (
    <div className="overflow-x-auto mt-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-terminal-dim uppercase tracking-wide text-2xs">
            <th className="text-left py-1 px-2">Tenor</th>
            <th className="text-right py-1 px-2">Realized</th>
            <th className="text-right py-1 px-2">Min</th>
            <th className="text-right py-1 px-2">P25</th>
            <th className="text-right py-1 px-2">Median</th>
            <th className="text-right py-1 px-2">P75</th>
            <th className="text-right py-1 px-2">Max</th>
          </tr>
        </thead>
        <tbody>
          {tenors.map((t) => (
            <tr key={t.tenor} className="border-t border-terminal-border/40">
              <td className="py-1.5 px-2 text-terminal-muted">{t.tenor}</td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-accent-amber font-semibold">
                {fmtNum(t.realized_vol, 1)}
              </td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
                {fmtNum(t.iv_min, 1)}
              </td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted">
                {fmtNum(t.iv_p25, 1)}
              </td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-text">
                {fmtNum(t.iv_median, 1)}
              </td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-muted">
                {fmtNum(t.iv_p75, 1)}
              </td>
              <td className="py-1.5 px-2 text-right font-mono tabular-nums text-terminal-dim">
                {fmtNum(t.iv_max, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function carryColor(v: number | null | undefined): string {
  if (v == null) return "text-terminal-dim";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtPctPlain(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v.toFixed(2)}%`;
}

function fmtNum(v: number | null | undefined, digits: number): string {
  if (v == null || Number.isNaN(v)) return "--";
  return v.toFixed(digits);
}
