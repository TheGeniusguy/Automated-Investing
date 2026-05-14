import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { EnergyDashboard } from "../api/types";
import { MacroTileCard } from "./MacroTile";

/**
 * Panel 13 — Energy Detail.
 *
 * Composite of FRED spot prices + EIA weekly inventories + yfinance futures
 * + energy-equity proxies. Sections: prices, inventories, production,
 * equity proxies.
 */
export function EnergyPanel() {
  const [data, setData] = useState<EnergyDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.energyDashboard()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Energy Dashboard</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : data ? data.fetched_at.slice(0, 16) + "Z" : ""}
        </span>
      </div>
      <div className="panel-body overflow-auto">
        {err && <div className="text-accent-red text-xs">⚠ {err}</div>}
        <div className="space-y-3">
          {(data?.sections ?? []).map((sec) => (
            <section key={sec.section}>
              <div className="text-2xs uppercase tracking-wider text-terminal-muted mb-1.5">
                {sec.label}
              </div>
              <div className="grid grid-cols-3 lg:grid-cols-4 gap-2">
                {sec.tiles.map((t) => (
                  <MacroTileCard key={t.id} tile={t} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
