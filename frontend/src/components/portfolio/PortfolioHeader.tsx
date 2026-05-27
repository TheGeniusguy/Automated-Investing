import { useState } from "react";

import { portfolioApi } from "../../api/client";
import type { Portfolio } from "../../api/types";

interface Props {
  portfolios: Portfolio[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreated: () => void;
  onDeleted: () => void;
}

export function PortfolioHeader({
  portfolios,
  selectedId,
  onSelect,
  onCreated,
  onDeleted,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [cashStr, setCashStr] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = portfolios.find((p) => p.id === selectedId) ?? null;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      const cash = parseFloat(cashStr) || 0;
      await portfolioApi.create({ name: trimmed, cash_balance: cash });
      setName("");
      setCashStr("0");
      setShowCreate(false);
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!window.confirm(`Delete portfolio "${selected?.name}"? All transactions will be removed.`))
      return;
    setBusy(true);
    try {
      await portfolioApi.delete(selectedId);
      onDeleted();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 py-2 border-b border-terminal-border flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Portfolio selector */}
        <select
          value={selectedId ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!isNaN(v) && v > 0) onSelect(v);
          }}
          className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg flex-1 min-w-[140px]"
        >
          {portfolios.length === 0 && (
            <option value="" disabled>
              No portfolios yet
            </option>
          )}
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {/* New Portfolio toggle */}
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40"
        >
          + New
        </button>

        {/* Delete selected */}
        {selectedId != null && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="pill text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20"
            title="Delete portfolio"
          >
            Delete
          </button>
        )}

        {/* Cash balance display */}
        {selected && (
          <span className="text-xs text-terminal-dim ml-auto">
            Cash:{" "}
            <span className="text-terminal-fg">
              ${selected.cash_balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </span>
        )}
      </div>

      {/* Inline create form */}
      {showCreate && (
        <div className="flex items-center gap-2 flex-wrap bg-terminal-bg/60 rounded px-2 py-1.5 border border-terminal-border">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Portfolio name"
            className="bg-transparent border-b border-terminal-border text-xs text-terminal-fg outline-none flex-1 min-w-[120px] py-0.5"
            autoFocus
          />
          <input
            type="number"
            value={cashStr}
            onChange={(e) => setCashStr(e.target.value)}
            placeholder="Initial cash"
            className="bg-transparent border-b border-terminal-border text-xs text-terminal-fg outline-none w-28 py-0.5"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy || !name.trim()}
            className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-40"
          >
            {busy ? "Creating..." : "Create"}
          </button>
          <button
            type="button"
            onClick={() => { setShowCreate(false); setErr(null); }}
            className="pill text-xs text-terminal-dim hover:text-terminal-fg"
          >
            Cancel
          </button>
        </div>
      )}

      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}
