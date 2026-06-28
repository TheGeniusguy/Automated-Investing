import { useCallback, useEffect, useState } from "react";

import { api } from "../api/client";
import type {
  PaperOrder,
  PaperOverview,
  PaperPortfolio,
  PaperPosition,
} from "../api/types";

// ── formatting helpers ─────────────────────────────────────────────────────────

function money(v: number | null | undefined, decimals = 2): string {
  if (v == null || Number.isNaN(v)) return "-";
  return `$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function signedMoney(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "-";
  return `${v >= 0 ? "+" : "-"}${money(v)}`;
}

function signedPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function num(v: number | null | undefined, decimals = 2): string {
  if (v == null || Number.isNaN(v)) return "-";
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function plColor(v: number | null | undefined): string {
  if (v == null) return "text-terminal-text";
  return v >= 0 ? "text-accent-green" : "text-accent-red";
}

function sideColor(side: string): string {
  return side?.toLowerCase() === "buy" ? "text-accent-green" : "text-accent-red";
}

type Side = "buy" | "sell";
type OrderType = "market" | "limit";

// ── hero stat ──────────────────────────────────────────────────────────────────

function HeroStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2 rounded border border-terminal-border/50 bg-terminal-bg min-w-[140px] flex-1">
      <span className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</span>
      <span className={`stat-figure text-2xl leading-none ${tone ?? "text-terminal-text"}`}>
        {value}
      </span>
      {sub && <span className={`text-2xs ${tone ?? "text-terminal-muted"}`}>{sub}</span>}
    </div>
  );
}

function ExecStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs uppercase tracking-wider text-terminal-dim">{label}</span>
      <span className={`stat-figure text-base ${tone ?? "text-terminal-text"}`}>{value}</span>
    </div>
  );
}

// ── main component ──────────────────────────────────────────────────────────────

export function PaperTradingPanel() {
  const [portfolios, setPortfolios] = useState<PaperPortfolio[]>([]);
  const [pid, setPid] = useState<number | null>(null);
  const [overview, setOverview] = useState<PaperOverview | null>(null);

  const [listLoading, setListLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);
  const [ovLoading, setOvLoading] = useState(false);
  const [ovErr, setOvErr] = useState<string | null>(null);

  // order ticket
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<Side>("buy");
  const [quantity, setQuantity] = useState("");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [placing, setPlacing] = useState(false);
  const [orderErr, setOrderErr] = useState<string | null>(null);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);

  // create book
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCash, setNewCash] = useState("100000");
  const [creating, setCreating] = useState(false);

  // reset (inline confirm, no browser dialog)
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const loadPortfolios = useCallback((selectId?: number) => {
    setListLoading(true);
    setListErr(null);
    api
      .paperList()
      .then((list) => {
        setPortfolios(list);
        setListLoading(false);
        if (list.length === 0) {
          setPid(null);
          return;
        }
        // keep current selection if still present, else pick requested / first
        setPid((cur) => {
          const wanted = selectId ?? cur;
          const exists = wanted != null && list.some((p) => p.id === wanted);
          return exists ? wanted! : list[0].id;
        });
      })
      .catch((e) => {
        setListErr(String(e));
        setListLoading(false);
      });
  }, []);

  const loadOverview = useCallback((id: number) => {
    setOvLoading(true);
    setOvErr(null);
    api
      .paperOverview(id)
      .then((data) => {
        setOverview(data);
        setOvLoading(false);
      })
      .catch((e) => {
        setOvErr(String(e));
        setOvLoading(false);
      });
  }, []);

  useEffect(() => {
    loadPortfolios();
  }, [loadPortfolios]);

  useEffect(() => {
    if (pid != null) loadOverview(pid);
  }, [pid, loadOverview]);

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pid == null) return;
    const qty = parseFloat(quantity);
    if (!symbol.trim() || !qty || qty <= 0) {
      setOrderErr("Symbol and a positive quantity are required.");
      return;
    }
    if (orderType === "limit" && !(parseFloat(limitPrice) > 0)) {
      setOrderErr("Enter a limit price for a limit order.");
      return;
    }
    setPlacing(true);
    setOrderErr(null);
    setOrderMsg(null);
    try {
      await api.paperOrder(pid, {
        symbol: symbol.trim().toUpperCase(),
        side,
        quantity: qty,
        order_type: orderType,
        limit_price: orderType === "limit" ? parseFloat(limitPrice) : null,
      });
      setOrderMsg(`${side === "buy" ? "Bought" : "Sold"} ${num(qty, 0)} ${symbol.trim().toUpperCase()}.`);
      setSymbol("");
      setQuantity("");
      setLimitPrice("");
      loadOverview(pid);
    } catch (err) {
      setOrderErr(String(err));
    } finally {
      setPlacing(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const created = await api.paperCreate(newName.trim(), parseFloat(newCash) || 100000);
      setNewName("");
      setNewCash("100000");
      setCreateOpen(false);
      loadPortfolios(created?.id);
    } catch (err) {
      setListErr(String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleReset = async () => {
    if (pid == null) return;
    setResetting(true);
    setConfirmReset(false);
    try {
      const data = await api.paperReset(pid);
      setOverview(data);
      setOrderMsg(null);
    } catch (err) {
      setOvErr(String(err));
    } finally {
      setResetting(false);
    }
  };

  const positions: PaperPosition[] = overview?.positions ?? [];
  const orders: PaperOrder[] = overview?.orders ?? [];
  const exec = overview?.execution;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="text-xs font-semibold uppercase tracking-wider">Paper Trading</span>
        <div className="flex items-center gap-2">
          {/* Portfolio selector */}
          <select
            value={pid ?? ""}
            onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}
            disabled={listLoading || portfolios.length === 0}
            className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-2xs text-terminal-text focus:outline-none focus:border-accent-amber"
          >
            {portfolios.length === 0 && <option value="">No books</option>}
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreateOpen((o) => !o)}
            className="pill text-terminal-dim hover:text-terminal-text border border-terminal-border"
          >
            New book
          </button>
        </div>
      </div>

      <div className="panel-body flex-1 min-h-0 overflow-auto flex flex-col gap-3 p-3">
        {/* Create book form */}
        {createOpen && (
          <form
            onSubmit={handleCreate}
            className="flex items-end gap-2 flex-wrap bg-terminal-bg border border-terminal-border/50 rounded p-2"
          >
            <div className="flex flex-col gap-0.5">
              <label className="text-2xs text-terminal-dim">Book name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Swing Book"
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
                required
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="text-2xs text-terminal-dim">Starting cash</label>
              <input
                type="number"
                value={newCash}
                onChange={(e) => setNewCash(e.target.value)}
                min="0"
                step="any"
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="pill bg-accent-amber/20 text-accent-amber hover:bg-accent-amber/30 disabled:opacity-40"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </form>
        )}

        {listErr && <p className="text-xs text-accent-red">{listErr}</p>}

        {/* Hero stat row */}
        {ovLoading && !overview ? (
          <div className="flex gap-2 flex-wrap animate-pulse">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[68px] flex-1 min-w-[140px] rounded border border-terminal-border/50 bg-terminal-bg" />
            ))}
          </div>
        ) : overview ? (
          <div className="flex gap-2 flex-wrap">
            <HeroStat label="Equity" value={money(overview.equity)} sub={`${num(overview.position_count, 0)} positions`} />
            <HeroStat label="Cash" value={money(overview.cash)} sub={`of ${money(overview.starting_cash)} start`} />
            <HeroStat
              label="Total P&L"
              value={signedMoney(overview.total_pl)}
              sub={signedPct(overview.total_pl_pct)}
              tone={plColor(overview.total_pl)}
            />
            <HeroStat label="Buying Power" value={money(exec?.buying_power)} sub={`market value ${money(overview.market_value)}`} />
          </div>
        ) : null}

        {ovErr && <p className="text-xs text-accent-red">{ovErr}</p>}

        {/* Order ticket */}
        <form
          onSubmit={handlePlaceOrder}
          className="bg-terminal-bg border border-terminal-border/50 rounded p-2 flex flex-col gap-2"
        >
          <p className="text-2xs uppercase tracking-wide text-terminal-dim">Order Ticket</p>
          <div className="flex flex-wrap items-end gap-2">
            {/* Side toggle */}
            <div className="flex gap-1">
              {(["buy", "sell"] as Side[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`pill capitalize ${
                    side === s
                      ? s === "buy"
                        ? "bg-accent-green/20 text-accent-green"
                        : "bg-accent-red/20 text-accent-red"
                      : "text-terminal-dim hover:text-terminal-text border border-terminal-border"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-0.5">
              <label className="text-2xs text-terminal-dim">Symbol</label>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="AAPL"
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text font-mono w-24"
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <label className="text-2xs text-terminal-dim">Quantity</label>
              <input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="100"
                min="0"
                step="any"
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text font-mono w-24"
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <label className="text-2xs text-terminal-dim">Type</label>
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as OrderType)}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text"
              >
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </div>

            {orderType === "limit" && (
              <div className="flex flex-col gap-0.5">
                <label className="text-2xs text-terminal-dim">Limit Price</label>
                <input
                  type="number"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder="150.00"
                  min="0"
                  step="any"
                  className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-text font-mono w-28"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={placing || pid == null}
              className={`pill self-end disabled:opacity-40 ${
                side === "buy"
                  ? "bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
                  : "bg-accent-red/20 text-accent-red hover:bg-accent-red/30"
              }`}
            >
              {placing ? "Placing..." : `Place ${side} order`}
            </button>
          </div>
          {orderErr && <p className="text-2xs text-accent-red">{orderErr}</p>}
          {orderMsg && <p className="text-2xs text-accent-green">{orderMsg}</p>}
        </form>

        {/* Positions table */}
        <div className="border border-terminal-border/50 rounded overflow-hidden">
          <div className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim border-b border-terminal-border/50 bg-white/[0.015]">
            Positions
          </div>
          <div className="overflow-auto max-h-72">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-terminal-panel z-10 border-b border-terminal-border">
                <tr>
                  {["Symbol", "Qty", "Avg Cost", "Last", "Mkt Value", "Unreal P&L", "P&L %"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim whitespace-nowrap ${
                        i === 0 ? "text-left" : "text-right"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ovLoading && positions.length === 0
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="animate-pulse border-b border-terminal-border/30">
                        {Array.from({ length: 7 }).map((__, j) => (
                          <td key={j} className="px-2 py-1.5">
                            <div className="h-3 bg-terminal-border/40 rounded" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : positions.map((p) => (
                      <tr key={p.symbol} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                        <td className="px-2 py-1.5 font-mono text-accent-amber font-semibold">{p.symbol}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{num(p.shares, 2)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(p.avg_cost)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(p.current_price)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(p.market_value)}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.unrealized_pl)}`}>
                          {signedMoney(p.unrealized_pl)}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-mono ${plColor(p.unrealized_pl_pct)}`}>
                          {signedPct(p.unrealized_pl_pct)}
                        </td>
                      </tr>
                    ))}
                {!ovLoading && positions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-terminal-dim text-xs">
                      No open positions. Place an order above to build the book.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Execution analytics card */}
        <div className="border border-terminal-border/50 rounded overflow-hidden">
          <div className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim border-b border-terminal-border/50 bg-white/[0.015]">
            Execution Analytics
          </div>
          <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">
            <ExecStat label="Buying Power" value={money(exec?.buying_power)} />
            <ExecStat label="Margin Used" value={money(exec?.margin_used)} />
            <ExecStat label="Gross Exposure" value={money(exec?.gross_exposure)} />
            <ExecStat label="Commissions Paid" value={money(exec?.commissions_paid)} tone="text-accent-red" />
            <ExecStat label="Est. Slippage Cost" value={money(exec?.est_slippage_cost)} tone="text-accent-red" />
            <ExecStat label="Fills" value={num(exec?.fill_count, 0)} />
            <ExecStat
              label="Win Rate"
              value={exec ? `${(exec.win_rate * 100).toFixed(1)}%` : "-"}
              tone="text-accent-blue"
            />
            <ExecStat label="Closed Trades" value={num(exec?.closed_trades, 0)} />
          </div>
        </div>

        {/* Recent orders */}
        <div className="border border-terminal-border/50 rounded overflow-hidden">
          <div className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim border-b border-terminal-border/50 bg-white/[0.015]">
            Recent Orders
          </div>
          <div className="overflow-auto max-h-64">
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-terminal-panel z-10 border-b border-terminal-border">
                <tr>
                  {["Side", "Symbol", "Qty", "Type", "Fill", "Commission", "Slippage"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim whitespace-nowrap ${
                        i === 1 ? "text-left" : i === 0 ? "text-left" : "text-right"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                    <td className={`px-2 py-1.5 font-semibold uppercase ${sideColor(o.side)}`}>{o.side}</td>
                    <td className="px-2 py-1.5 font-mono text-accent-amber font-semibold">{o.symbol}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{num(o.quantity, 2)}</td>
                    <td className="px-2 py-1.5 text-right capitalize text-terminal-muted">{o.order_type}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{money(o.fill_price)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">{money(o.commission)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-terminal-dim">{money(o.slippage_cost)}</td>
                  </tr>
                ))}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-5 text-center text-terminal-dim text-xs">
                      No orders yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Reset book (inline confirm, no browser dialog) */}
        <div className="flex items-center gap-2">
          {confirmReset ? (
            <>
              <span className="text-2xs text-terminal-muted">
                Reset this book to starting cash? All orders will be cleared.
              </span>
              <button
                type="button"
                onClick={handleReset}
                disabled={resetting}
                className="pill bg-accent-red/20 text-accent-red hover:bg-accent-red/30 disabled:opacity-40"
              >
                {resetting ? "Resetting..." : "Confirm reset"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="pill text-terminal-dim hover:text-terminal-text border border-terminal-border"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              disabled={pid == null}
              className="pill text-terminal-dim hover:text-accent-red border border-terminal-border disabled:opacity-40"
            >
              Reset book
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
