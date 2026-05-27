import { useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  ScreenerFilter,
  ScreenerResponse,
  ScreenerSchema,
} from "../api/types";

const TWO_VALUE_OPS = new Set(["between"]);
const LIST_OPS = new Set(["in", "not_in"]);

/**
 * Screener panel — DuckDB-backed stock screener.
 *
 * Build a stack of (key, op, value) predicates, hit Run, see a sortable
 * results table. Filter dimensions come from the backend `/api/screener/schema`
 * so the frontend stays in sync if the backend adds new columns.
 */
export function ScreenerPanel() {
  const [schema, setSchema] = useState<ScreenerSchema | null>(null);
  const [filters, setFilters] = useState<ScreenerFilter[]>([]);
  const [sort, setSort] = useState<string>("symbol");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [limit, setLimit] = useState(100);
  const [results, setResults] = useState<ScreenerResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.screenerSchema().then(setSchema).catch((e) => setErr(String(e)));
  }, []);

  const addFilter = () => {
    if (!schema || schema.filters.length === 0) return;
    const first = schema.filters[0];
    const defaultOp = first.type === "number" ? "gte" : "eq";
    setFilters([...filters, { key: first.key, op: defaultOp, value: first.type === "number" ? 0 : "" }]);
  };

  const updateFilter = (i: number, patch: Partial<ScreenerFilter>) => {
    setFilters(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  };

  const removeFilter = (i: number) => {
    setFilters(filters.filter((_, idx) => idx !== i));
  };

  const run = async () => {
    if (!schema) return;
    setBusy(true);
    setErr(null);
    try {
      const cleaned = filters.map((f) => ({
        ...f,
        value: coerceValue(f, schema),
      }));
      const res = await api.runScreener({ filters: cleaned, sort, sort_dir: sortDir, limit });
      setResults(res);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel h-full flex flex-col">
      <header className="panel-header flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-accent font-semibold">SCREENER</span>
          {results && (
            <span className="text-xs text-terminal-dim">
              {results.count} result{results.count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={addFilter} disabled={!schema} className="pill hover:bg-accent hover:text-black">
            + Filter
          </button>
          <button onClick={run} disabled={!schema || busy} className="pill hover:bg-accent hover:text-black">
            {busy ? "Running…" : "Run"}
          </button>
        </div>
      </header>

      <div className="panel-body flex-1 overflow-auto p-2 space-y-3">
        {err && <div className="text-rose-400 text-xs">Error: {err}</div>}

        {/* Filter builder */}
        {schema && (
          <div className="space-y-1 text-xs">
            {filters.length === 0 && (
              <p className="text-terminal-dim italic">
                No filters. Click "+ Filter" to add one, or hit Run to list everything.
              </p>
            )}
            {filters.map((f, i) => {
              const meta = schema.filters.find((m) => m.key === f.key);
              const ops = meta ? schema.ops[meta.type] : schema.ops.text;
              return (
                <div key={i} className="flex items-center gap-1 flex-wrap">
                  <select
                    value={f.key}
                    onChange={(e) => {
                      const newMeta = schema.filters.find((m) => m.key === e.target.value);
                      const newOp = newMeta?.type === "number" ? "gte" : "eq";
                      updateFilter(i, { key: e.target.value, op: newOp, value: newMeta?.type === "number" ? 0 : "" });
                    }}
                    className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 font-mono"
                  >
                    {schema.filters.map((m) => (
                      <option key={m.key} value={m.key}>{m.key}</option>
                    ))}
                  </select>
                  <select
                    value={f.op}
                    onChange={(e) => updateFilter(i, { op: e.target.value })}
                    className="bg-terminal-panel border border-terminal-border rounded px-2 py-1"
                  >
                    {ops.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                  <FilterValueInput
                    op={f.op}
                    type={meta?.type ?? "text"}
                    value={f.value}
                    onChange={(v) => updateFilter(i, { value: v })}
                  />
                  <button onClick={() => removeFilter(i)} className="text-terminal-dim hover:text-rose-400 text-[10px] px-1">
                    ✕
                  </button>
                </div>
              );
            })}

            <div className="flex items-center gap-2 pt-2 border-t border-terminal-border">
              <label className="flex items-center gap-1 text-terminal-dim">
                sort
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="bg-terminal-panel border border-terminal-border rounded px-2 py-1"
                >
                  {schema.sort_keys.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <select
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}
                className="bg-terminal-panel border border-terminal-border rounded px-2 py-1"
              >
                <option value="asc">asc</option>
                <option value="desc">desc</option>
              </select>
              <label className="flex items-center gap-1 text-terminal-dim">
                limit
                <input
                  type="number"
                  value={limit}
                  min={1}
                  max={500}
                  onChange={(e) => setLimit(Number(e.target.value) || 100)}
                  className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-20"
                />
              </label>
            </div>
          </div>
        )}

        {/* Results */}
        {results && results.results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-terminal-dim uppercase tracking-wide">
                <tr>
                  <th className="text-left py-1 px-2">Symbol</th>
                  <th className="text-left py-1 px-2">Name</th>
                  <th className="text-left py-1 px-2">Sector</th>
                  <th className="text-right py-1 px-2">Last</th>
                  <th className="text-right py-1 px-2">Rev</th>
                  <th className="text-right py-1 px-2">Gross</th>
                  <th className="text-right py-1 px-2">Op</th>
                  <th className="text-right py-1 px-2">Net</th>
                  <th className="text-right py-1 px-2">EPS</th>
                  <th className="text-right py-1 px-2">FCF</th>
                  <th className="text-right py-1 px-2">Rev YoY</th>
                </tr>
              </thead>
              <tbody>
                {results.results.map((r) => (
                  <tr key={r.symbol} className="border-b border-terminal-border/50 hover:bg-terminal-panel/60">
                    <td className="py-1 px-2 font-mono">{r.symbol}</td>
                    <td className="py-1 px-2 truncate max-w-[200px]">{r.name ?? "—"}</td>
                    <td className="py-1 px-2 text-terminal-dim">{r.sector ?? "—"}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtNum(r.last_close, 2)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtBigNum(r.revenue)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtPct(r.gross_margin)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtPct(r.operating_margin)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtPct(r.net_margin)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtNum(r.eps_diluted, 2)}</td>
                    <td className="text-right py-1 px-2 tabular-nums">{fmtBigNum(r.free_cash_flow)}</td>
                    <td
                      className="text-right py-1 px-2 tabular-nums"
                      style={{ color: r.revenue_yoy_pct == null ? undefined : r.revenue_yoy_pct >= 0 ? "#5fb878" : "#e74c3c" }}
                    >
                      {fmtPct(r.revenue_yoy_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {results && results.results.length === 0 && !err && (
          <div className="text-terminal-dim text-xs italic">No rows matched. Loosen filters?</div>
        )}
      </div>
    </section>
  );
}

function FilterValueInput({
  op,
  type,
  value,
  onChange,
}: {
  op: string;
  type: "number" | "text";
  value: ScreenerFilter["value"];
  onChange: (v: ScreenerFilter["value"]) => void;
}) {
  if (TWO_VALUE_OPS.has(op)) {
    const arr = Array.isArray(value) ? value : [0, 0];
    return (
      <span className="flex items-center gap-1">
        <input
          type={type === "number" ? "number" : "text"}
          value={String(arr[0] ?? "")}
          onChange={(e) => onChange([type === "number" ? Number(e.target.value) : e.target.value, arr[1]])}
          className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-20"
          placeholder="min"
        />
        <span className="text-terminal-dim">–</span>
        <input
          type={type === "number" ? "number" : "text"}
          value={String(arr[1] ?? "")}
          onChange={(e) => onChange([arr[0], type === "number" ? Number(e.target.value) : e.target.value])}
          className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-20"
          placeholder="max"
        />
      </span>
    );
  }
  if (LIST_OPS.has(op)) {
    const v = Array.isArray(value) ? value.join(",") : String(value ?? "");
    return (
      <input
        value={v}
        onChange={(e) => onChange(e.target.value.split(/[\s,]+/).filter(Boolean))}
        className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-40"
        placeholder="a, b, c"
      />
    );
  }
  return (
    <input
      type={type === "number" ? "number" : "text"}
      value={Array.isArray(value) ? "" : String(value ?? "")}
      onChange={(e) => onChange(type === "number" ? Number(e.target.value) : e.target.value)}
      className="bg-terminal-panel border border-terminal-border rounded px-2 py-1 w-32"
      placeholder="value"
    />
  );
}

function coerceValue(f: ScreenerFilter, schema: ScreenerSchema): ScreenerFilter["value"] {
  const meta = schema.filters.find((m) => m.key === f.key);
  if (!meta) return f.value;
  if (TWO_VALUE_OPS.has(f.op)) return f.value;
  if (LIST_OPS.has(f.op)) return Array.isArray(f.value) ? f.value : [String(f.value)];
  if (meta.type === "number") return Number(f.value);
  return String(f.value);
}

function fmtNum(v: number | null, decimals = 0): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtBigNum(v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(2)}%`;
}
