import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";

// ── Local response shape (mirrors backend app/data/seasonality.py) ────────────
// Mirrored here as local interfaces per the wiring contract: the client method
// returns a permissive type and each panel binds its own shape.

interface MonthSeason {
  month: number;
  month_name: string;
  avg_return_pct: number | null;
  hit_rate_pct: number | null;
  count: number;
}

interface MatrixCell {
  year: number;
  month: number;
  return_pct: number;
}

interface DayOfWeekSeason {
  day: string;
  avg_return_pct: number | null;
  count: number;
}

interface SeasonalityResponse {
  symbol: string;
  years: number;
  monthly: MonthSeason[];
  month_year_matrix: MatrixCell[];
  day_of_week: DayOfWeekSeason[];
  best_month: MonthSeason | null;
  worst_month: MonthSeason | null;
  current_month: MonthSeason | null;
  data_mode: string;
  as_of: string;
  source: string;
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ── Component ─────────────────────────────────────────────────────────────────

export function SeasonalityPanel() {
  const [symbolInput, setSymbolInput] = useState("SPY");
  const [symbol, setSymbol] = useState("SPY");

  const [data, setData] = useState<SeasonalityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Alive-guard so a stale request can never overwrite a newer one.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .seasonality(symbol)
      .then((res: SeasonalityResponse) => {
        if (!alive) return;
        setData(res);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const submit = () => {
    const s = symbolInput.trim().toUpperCase();
    if (!s) {
      setErr("Enter a symbol.");
      return;
    }
    setSymbol(s);
  };

  // Largest absolute monthly avg, used to scale the seasonality bars.
  const maxMonthlyMag = useMemo(() => {
    let m = 0.5;
    (data?.monthly ?? []).forEach((row) => {
      if (row.avg_return_pct != null) m = Math.max(m, Math.abs(row.avg_return_pct));
    });
    return m;
  }, [data]);

  // Largest absolute day-of-week avg, used to scale those bars.
  const maxDowMag = useMemo(() => {
    let m = 0.05;
    (data?.day_of_week ?? []).forEach((row) => {
      if (row.avg_return_pct != null) m = Math.max(m, Math.abs(row.avg_return_pct));
    });
    return m;
  }, [data]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Seasonality</span>
        {data && (
          <span className="text-terminal-dim normal-case tracking-normal">
            {data.symbol} / {data.years}y
          </span>
        )}
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Controls */}
        <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5">
            <span className="text-2xs text-terminal-dim uppercase">Symbol</span>
            <input
              type="text"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="SPY"
              className="w-24 bg-terminal-panel border border-terminal-border/60 rounded px-2 py-1 text-xs text-terminal-text focus:outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={loading}
            className="pill bg-accent text-black disabled:opacity-40"
          >
            {loading ? "Loading..." : "Run"}
          </button>
        </div>

        {err && <div className="text-accent-red text-xs py-2">{err}</div>}
        {loading && !data && (
          <div className="text-terminal-dim text-xs py-6 text-center">
            Building seasonality study...
          </div>
        )}

        {data && (
          <>
            <SeasonalityHero data={data} />

            {/* Monthly seasonality bars */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Monthly Seasonality (avg return + hit rate)
              </div>
              <MonthlyBars rows={data.monthly} maxMag={maxMonthlyMag} currentMonth={data.current_month?.month ?? null} />
            </div>

            {/* Month x Year heatmap */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Month by Year
              </div>
              <MonthYearHeatmap matrix={data.month_year_matrix} />
            </div>

            {/* Day-of-week bars */}
            <div className="bg-terminal-bg border border-terminal-border/50 rounded p-2">
              <div className="text-2xs text-terminal-muted uppercase tracking-wider mb-2">
                Day of Week (avg daily return)
              </div>
              <DayOfWeekBars rows={data.day_of_week} maxMag={maxDowMag} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Serif hero ────────────────────────────────────────────────────────────────

function SeasonalityHero({ data }: { data: SeasonalityResponse }) {
  const cur = data.current_month;
  const best = data.best_month;
  const worst = data.worst_month;
  return (
    <div className="bg-terminal-bg border border-terminal-border/50 rounded p-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <HeroStat
        label={cur ? `${cur.month_name} (current month)` : "Current month"}
        value={fmtSignedPct(cur?.avg_return_pct ?? null)}
        sub={cur && cur.hit_rate_pct != null ? `${cur.hit_rate_pct.toFixed(0)}% positive / ${cur.count} yrs` : "no history"}
        color={colorBySign(cur?.avg_return_pct ?? null)}
      />
      <HeroStat
        label={best ? `Best month - ${best.month_name}` : "Best month"}
        value={fmtSignedPct(best?.avg_return_pct ?? null)}
        sub={best && best.hit_rate_pct != null ? `${best.hit_rate_pct.toFixed(0)}% positive` : "no history"}
        color="text-accent-green"
      />
      <HeroStat
        label={worst ? `Worst month - ${worst.month_name}` : "Worst month"}
        value={fmtSignedPct(worst?.avg_return_pct ?? null)}
        sub={worst && worst.hit_rate_pct != null ? `${worst.hit_rate_pct.toFixed(0)}% positive` : "no history"}
        color="text-accent-red"
      />
    </div>
  );
}

function HeroStat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-2xs text-terminal-dim uppercase tracking-wide leading-tight">{label}</div>
      <div className={`font-serif text-3xl leading-tight mt-1 ${color}`}>{value}</div>
      <div className="text-2xs text-terminal-dim mt-0.5">{sub}</div>
    </div>
  );
}

// ── Monthly seasonality bars ──────────────────────────────────────────────────

function MonthlyBars({
  rows,
  maxMag,
  currentMonth,
}: {
  rows: MonthSeason[];
  maxMag: number;
  currentMonth: number | null;
}) {
  if (!rows.some((r) => r.avg_return_pct != null)) {
    return <div className="text-2xs text-terminal-dim">No monthly data.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const v = row.avg_return_pct;
        const pct = v == null ? 0 : (Math.abs(v) / maxMag) * 100;
        const isCurrent = currentMonth != null && row.month === currentMonth;
        return (
          <div key={row.month} className="flex items-center gap-2">
            <span
              className={`text-2xs w-8 shrink-0 ${isCurrent ? "text-accent-amber font-semibold" : "text-terminal-muted"}`}
            >
              {row.month_name}
            </span>
            <div className="flex-1 h-4 bg-terminal-panel rounded-sm overflow-hidden relative">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${pct}%`,
                  backgroundColor: v == null ? "transparent" : v >= 0 ? "#3fb950" : "#f85149",
                  opacity: 0.85,
                }}
              />
            </div>
            <span className={`text-2xs w-14 text-right tabular-nums ${colorBySign(v)}`}>
              {fmtSignedPct(v)}
            </span>
            <span className="text-2xs w-12 text-right tabular-nums text-terminal-dim">
              {row.hit_rate_pct == null ? "--" : `${row.hit_rate_pct.toFixed(0)}%`}
            </span>
          </div>
        );
      })}
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-2xs w-8 shrink-0" />
        <span className="flex-1" />
        <span className="text-2xs w-14 text-right text-terminal-dim uppercase">Avg</span>
        <span className="text-2xs w-12 text-right text-terminal-dim uppercase">Hit</span>
      </div>
    </div>
  );
}

// ── Month x Year heatmap ──────────────────────────────────────────────────────

function MonthYearHeatmap({ matrix }: { matrix: MatrixCell[] }) {
  // Build year -> [12 monthly returns]. Years descending (recent first).
  const years = useMemo(() => {
    const byYear = new Map<number, (number | null)[]>();
    matrix.forEach((cell) => {
      const mi = cell.month - 1;
      if (mi < 0 || mi > 11) return;
      if (!byYear.has(cell.year)) byYear.set(cell.year, Array(12).fill(null));
      byYear.get(cell.year)![mi] = cell.return_pct;
    });
    return [...byYear.entries()].sort((a, b) => b[0] - a[0]);
  }, [matrix]);

  if (years.length === 0) {
    return <div className="text-2xs text-terminal-dim">No monthly history.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-2xs border-collapse">
        <thead>
          <tr>
            <th className="text-left pr-2 text-terminal-dim font-normal">Year</th>
            {MONTH_LABELS.map((m) => (
              <th key={m} className="text-center px-1 text-terminal-dim font-normal w-9">
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map(([y, vals]) => (
            <tr key={y}>
              <td className="pr-2 text-terminal-muted tabular-nums">{y}</td>
              {vals.map((v, i) => (
                <td
                  key={i}
                  className="text-center px-1 py-0.5 tabular-nums border border-terminal-bg"
                  style={{ background: heatColor(v), color: v == null ? "#4b5563" : "#0a0a0a" }}
                  title={
                    v == null
                      ? ""
                      : `${y}-${String(i + 1).padStart(2, "0")}: ${v.toFixed(2)}%`
                  }
                >
                  {v == null ? "" : v.toFixed(1)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Day-of-week bars ──────────────────────────────────────────────────────────

function DayOfWeekBars({ rows, maxMag }: { rows: DayOfWeekSeason[]; maxMag: number }) {
  if (!rows.some((r) => r.avg_return_pct != null)) {
    return <div className="text-2xs text-terminal-dim">No day-of-week data.</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const v = row.avg_return_pct;
        const pct = v == null ? 0 : (Math.abs(v) / maxMag) * 100;
        return (
          <div key={row.day} className="flex items-center gap-2">
            <span className="text-2xs w-16 shrink-0 text-terminal-muted">{row.day}</span>
            <div className="flex-1 h-4 bg-terminal-panel rounded-sm overflow-hidden relative">
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${pct}%`,
                  backgroundColor: v == null ? "transparent" : v >= 0 ? "#3fb950" : "#f85149",
                  opacity: 0.85,
                }}
              />
            </div>
            <span className={`text-2xs w-16 text-right tabular-nums ${colorBySign(v)}`}>
              {fmtSignedPct(v, 3)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorBySign(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function fmtSignedPct(v: number | null | undefined, dp = 2): string {
  if (v == null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

function heatColor(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "#1a1a1a";
  if (v > 5) return "rgba(22, 163, 74, 0.95)";
  if (v >= 1) return "rgba(34, 197, 94, 0.55)";
  if (v > -1) return "rgba(120, 120, 120, 0.45)";
  if (v >= -5) return "rgba(239, 68, 68, 0.5)";
  return "rgba(185, 28, 28, 0.95)";
}
