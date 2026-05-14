import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { MacroCatalog, MacroSnapshot, MacroTile as TileData } from "../api/types";
import { MacroTileCard } from "./MacroTile";

/**
 * Panel 12 — Macro Economy Explorer.
 *
 * Browses the 130+ FRED indicator catalog by category. Each tile shows the
 * latest reading + sparkline. Without a FRED key, the catalog still lists
 * every series; once a key is set, every category fills with live data.
 */
export function MacroExplorer() {
  const [catalog, setCatalog] = useState<MacroCatalog | null>(null);
  const [activeCat, setActiveCat] = useState<string>("yields");
  const [snapshot, setSnapshot] = useState<MacroSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState<TileData | null>(null);
  const [query, setQuery] = useState<string>("");

  useEffect(() => {
    api.macroCatalog()
      .then(setCatalog)
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!activeCat) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    setFocused(null);
    api.macroSnapshot(activeCat)
      .then((d) => alive && setSnapshot(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [activeCat]);

  const tiles = useMemo(() => {
    if (!snapshot) return [];
    if (!query.trim()) return snapshot.tiles;
    const q = query.toLowerCase();
    return snapshot.tiles.filter(
      (t) => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q),
    );
  }, [snapshot, query]);

  return (
    <div className="grid grid-cols-5 gap-2 h-full">
      <div className="col-span-1">
        <CategorySidebar
          catalog={catalog}
          active={activeCat}
          setActive={setActiveCat}
          query={query}
          setQuery={setQuery}
        />
      </div>
      <div className={focused ? "col-span-3" : "col-span-4"}>
        <div className="panel h-full">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <span>{snapshot?.category_label ?? "Macro Economy"}</span>
              <span className="normal-case tracking-normal text-terminal-dim">
                {tiles.length}/{snapshot?.tiles.length ?? 0}
              </span>
            </div>
            <span className="normal-case tracking-normal text-terminal-dim">
              {loading ? "fetching…" : ""}
            </span>
          </div>
          <div className="panel-body grid grid-cols-2 gap-2 content-start auto-rows-min">
            {err && <div className="col-span-2 text-accent-red text-xs">⚠ {err}</div>}
            {!loading && tiles.length === 0 && (
              <div className="col-span-2 text-terminal-dim text-xs">
                No tiles match. (FRED key required to populate values.)
              </div>
            )}
            {tiles.map((t) => (
              <MacroTileCard
                key={t.id}
                tile={t}
                onClick={(x) => setFocused(focused?.id === x.id ? null : x)}
                selected={focused?.id === t.id}
              />
            ))}
          </div>
        </div>
      </div>
      {focused && (
        <div className="col-span-1">
          <FocusedDetail tile={focused} onClose={() => setFocused(null)} />
        </div>
      )}
    </div>
  );
}

function CategorySidebar({
  catalog, active, setActive, query, setQuery,
}: {
  catalog: MacroCatalog | null;
  active: string;
  setActive: (s: string) => void;
  query: string;
  setQuery: (s: string) => void;
}) {
  return (
    <div className="panel h-full">
      <div className="panel-header"><span>Macro Catalog</span></div>
      <div className="panel-body p-0 flex flex-col">
        <div className="px-3 py-2 border-b border-terminal-divider">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter…"
            spellCheck={false}
            className="w-full bg-black/40 border border-terminal-divider
                       text-terminal-text font-mono text-xs p-1.5 outline-none
                       focus:border-accent-amber/60"
          />
        </div>
        <ul className="flex-1 overflow-auto divide-y divide-terminal-divider text-xs">
          {(catalog?.categories ?? []).map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActive(c.id)}
                className={
                  "w-full text-left px-3 py-1.5 flex justify-between items-center transition " +
                  (c.id === active ? "bg-white/[0.04] text-accent-amber" : "hover:bg-white/[0.02] text-terminal-text")
                }
              >
                <span>{c.label}</span>
                <span className="text-terminal-dim tabular-nums">{c.count}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FocusedDetail({ tile, onClose }: { tile: TileData; onClose: () => void }) {
  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>{tile.id}</span>
        <button onClick={onClose} className="normal-case tracking-normal text-terminal-muted hover:text-accent-red">
          close
        </button>
      </div>
      <div className="panel-body text-xs space-y-3">
        <div>
          <div className="text-terminal-muted text-2xs uppercase tracking-wider mb-1">
            {tile.label}
          </div>
          <div className="text-2xl text-accent-amber tabular-nums">
            {tile.latest === null ? "—" : tile.latest.toFixed(4)}
          </div>
          <div className="text-terminal-muted">{tile.unit}</div>
          {tile.latest_date && (
            <div className="text-2xs text-terminal-dim mt-1">
              latest {tile.latest_date}
            </div>
          )}
        </div>

        <div className="space-y-1 text-xs">
          {tile.prior !== null && tile.prior !== undefined && (
            <Row k="prior" v={tile.prior.toFixed(4)} />
          )}
          {tile.delta_pct !== null && tile.delta_pct !== undefined && (
            <Row k="Δ %" v={`${tile.delta_pct > 0 ? "+" : ""}${(tile.delta_pct * 100).toFixed(2)}%`} />
          )}
          {tile.min_1y !== null && tile.min_1y !== undefined && (
            <Row k="1y min" v={(tile.min_1y ?? 0).toFixed(2)} />
          )}
          {tile.max_1y !== null && tile.max_1y !== undefined && (
            <Row k="1y max" v={(tile.max_1y ?? 0).toFixed(2)} />
          )}
          <Row k="frequency" v={tile.frequency ?? ""} />
          <Row k="source" v={tile.source ?? ""} />
        </div>

        {tile.note && (
          <div className="pt-2 border-t border-terminal-divider text-terminal-muted leading-relaxed">
            {tile.note}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-terminal-muted">{k}</span>
      <span className="text-terminal-text tabular-nums">{v}</span>
    </div>
  );
}
