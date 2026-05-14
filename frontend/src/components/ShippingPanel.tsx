import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { ShippingDashboard } from "../api/types";
import { MacroTileCard } from "./MacroTile";

/**
 * Panel 14 — Shipping & Freight.
 *
 * Goods-economy pulse from independent sources:
 *   - BDRY ETF (dry-bulk shipping rates proxy for the Baltic Dry Index)
 *   - SEA / FTRI (containers + tankers as equity proxies)
 *   - US rail freight carloads
 *   - US truck tonnage index
 *   - Manufacturing & trade inventories
 *   - Chicago Fed activity index
 */
export function ShippingPanel() {
  const [data, setData] = useState<ShippingDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api.shippingDashboard()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <span>Shipping &amp; Freight</span>
        <span className="normal-case tracking-normal text-terminal-dim">
          {loading ? "fetching…" : data ? data.fetched_at.slice(0, 16) + "Z" : ""}
        </span>
      </div>
      <div className="panel-body overflow-auto">
        {err && <div className="text-accent-red text-xs">⚠ {err}</div>}
        <div className="grid grid-cols-3 lg:grid-cols-4 gap-2 content-start auto-rows-min">
          {(data?.tiles ?? []).map((t) => (
            <MacroTileCard key={t.id} tile={t} />
          ))}
        </div>
      </div>
    </div>
  );
}
