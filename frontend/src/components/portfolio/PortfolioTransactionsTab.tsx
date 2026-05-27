import { useEffect, useState } from "react";

import { portfolioApi } from "../../api/client";
import type { ImportRow, PortfolioTransaction } from "../../api/types";

interface Props {
  portfolioId: number;
  initialSymbol?: string;
  onTransactionAdded: () => void;
}

type TradeType = "buy" | "sell" | "dividend" | "deposit" | "withdrawal";

const TYPE_COLORS: Record<TradeType, string> = {
  buy:        "text-green-400",
  sell:       "text-red-400",
  dividend:   "text-blue-400",
  deposit:    "text-yellow-400",
  withdrawal: "text-orange-400",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmt2(v: number) {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PortfolioTransactionsTab({ portfolioId, initialSymbol, onTransactionAdded }: Props) {
  // Form state
  const [symbol, setSymbol]       = useState(initialSymbol?.toUpperCase() ?? "");
  const [tradeDate, setTradeDate] = useState(today());
  const [tradeType, setTradeType] = useState<TradeType>("buy");
  const [quantity, setQuantity]   = useState("");
  const [price, setPrice]         = useState("");
  const [commission, setCommission] = useState("0");
  const [notes, setNotes]         = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr]     = useState<string | null>(null);

  // Transaction list
  const [txns, setTxns]       = useState<PortfolioTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);

  // CSV import state
  const [importOpen, setImportOpen]       = useState(false);
  const [csvText, setCsvText]             = useState("");
  const [previewRows, setPreviewRows]     = useState<ImportRow[] | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [importBusy, setImportBusy]       = useState(false);
  const [importMsg, setImportMsg]         = useState<string | null>(null);
  const [importErr, setImportErr]         = useState<string | null>(null);

  useEffect(() => {
    if (initialSymbol) setSymbol(initialSymbol.toUpperCase());
  }, [initialSymbol]);

  const loadTxns = () => {
    setLoading(true);
    setListErr(null);
    portfolioApi
      .transactions(portfolioId)
      .then((data) => {
        setTxns([...data].sort((a, b) => b.trade_date.localeCompare(a.trade_date)));
        setLoading(false);
      })
      .catch((e) => {
        setListErr(String(e));
        setLoading(false);
      });
  };

  useEffect(() => { loadTxns(); }, [portfolioId]);

  const total = (parseFloat(quantity) || 0) * (parseFloat(price) || 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol.trim() || !quantity || !price) {
      setFormErr("Symbol, quantity, and price are required.");
      return;
    }
    setSubmitting(true);
    setFormErr(null);
    try {
      await portfolioApi.addTransaction(portfolioId, {
        symbol:     symbol.trim().toUpperCase(),
        trade_date: tradeDate,
        trade_type: tradeType,
        quantity:   parseFloat(quantity),
        price:      parseFloat(price),
        commission: parseFloat(commission) || 0,
        notes:      notes.trim() || null,
      });
      setSymbol("");
      setQuantity("");
      setPrice("");
      setCommission("0");
      setNotes("");
      loadTxns();
      onTransactionAdded();
    } catch (e) {
      setFormErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (txnId: number) => {
    if (!window.confirm("Delete this transaction?")) return;
    try {
      await portfolioApi.deleteTransaction(portfolioId, txnId);
      loadTxns();
      onTransactionAdded();
    } catch (e) {
      setListErr(String(e));
    }
  };

  const handlePreview = async () => {
    if (!csvText.trim()) {
      setImportErr("Paste some CSV data first.");
      return;
    }
    setImportBusy(true);
    setImportErr(null);
    setImportMsg(null);
    try {
      const res = await portfolioApi.importPreview(portfolioId, csvText);
      setPreviewRows(res.rows);
      setPreviewErrors(res.errors);
      setDetectedFormat(res.detected_format);
    } catch (e) {
      setImportErr(String(e));
      setPreviewRows(null);
    } finally {
      setImportBusy(false);
    }
  };

  const handleCommitImport = async () => {
    if (!previewRows || previewRows.length === 0) return;
    setImportBusy(true);
    setImportErr(null);
    setImportMsg(null);
    try {
      const res = await portfolioApi.importCommit(portfolioId, previewRows);
      setImportMsg(`Imported ${res.inserted} transaction${res.inserted === 1 ? "" : "s"}.`);
      setCsvText("");
      setPreviewRows(null);
      setPreviewErrors([]);
      setDetectedFormat(null);
      loadTxns();
      onTransactionAdded();
    } catch (e) {
      setImportErr(String(e));
    } finally {
      setImportBusy(false);
    }
  };

  const TYPES: TradeType[] = ["buy", "sell", "dividend", "deposit", "withdrawal"];

  return (
    <div className="flex flex-col gap-0 flex-1 min-h-0 overflow-auto">
      {/* ── Add Transaction form ── */}
      <form
        onSubmit={handleSubmit}
        className="border-b border-terminal-border p-3 bg-terminal-bg/60"
      >
        <p className="text-2xs uppercase tracking-wide text-terminal-dim mb-2">Add Transaction</p>

        {/* Type selector */}
        <div className="flex gap-1 mb-2 flex-wrap">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTradeType(t)}
              className={`pill text-2xs capitalize ${
                tradeType === t
                  ? `${TYPE_COLORS[t]} bg-terminal-border`
                  : "text-terminal-dim hover:text-terminal-fg"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-2">
          <div className="flex flex-col gap-0.5">
            <label className="text-2xs text-terminal-dim">Symbol</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-2xs text-terminal-dim">Date</label>
            <input
              type="date"
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg"
              required
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
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-2xs text-terminal-dim">Price / Share</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="150.00"
              min="0"
              step="any"
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono"
              required
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-2xs text-terminal-dim">Commission</label>
            <input
              type="number"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              placeholder="0"
              min="0"
              step="any"
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-2xs text-terminal-dim">Total</label>
            <div className="bg-terminal-bg/40 border border-terminal-border/50 rounded px-2 py-1 text-xs font-mono text-terminal-dim">
              ${fmt2(total)}
            </div>
          </div>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
            <label className="text-2xs text-terminal-dim">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. earnings play, portfolio rebalance"
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-40 self-end"
          >
            {submitting ? "Adding..." : "Add Transaction"}
          </button>
        </div>

        {formErr && <p className="mt-1 text-2xs text-red-400">{formErr}</p>}
      </form>

      {/* ── Import CSV (collapsible) ── */}
      <div className="border-b border-terminal-border bg-terminal-bg/40">
        <button
          type="button"
          onClick={() => setImportOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2 text-2xs uppercase tracking-wide text-terminal-dim hover:text-terminal-fg"
        >
          <span>Import CSV</span>
          <span className="font-mono">{importOpen ? "−" : "+"}</span>
        </button>

        {importOpen && (
          <div className="px-3 pb-3 flex flex-col gap-2">
            <p className="text-2xs text-terminal-muted leading-tight">
              Paste rows from your broker export. We'll auto-detect the format and show you a preview
              before anything is saved. Columns we look for: symbol, date, type (buy/sell), quantity,
              price, and optional commission.
            </p>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={5}
              placeholder={"symbol,date,type,quantity,price,commission\nAAPL,2024-01-15,buy,100,185.50,1.00"}
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs text-terminal-fg font-mono w-full resize-y"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handlePreview}
                disabled={importBusy}
                className="pill text-xs text-terminal-dim hover:text-terminal-fg border border-terminal-border disabled:opacity-40"
              >
                {importBusy ? "Working..." : "Preview"}
              </button>
              {previewRows && previewRows.length > 0 && (
                <button
                  type="button"
                  onClick={handleCommitImport}
                  disabled={importBusy}
                  className="pill text-xs bg-accent/20 text-accent hover:bg-accent/40 disabled:opacity-40"
                >
                  Import {previewRows.length} row{previewRows.length === 1 ? "" : "s"}
                </button>
              )}
              {detectedFormat && (
                <span className="text-2xs text-terminal-dim">Detected format: {detectedFormat}</span>
              )}
            </div>

            {importErr && <p className="text-2xs text-red-400">{importErr}</p>}
            {importMsg && <p className="text-2xs text-green-400">{importMsg}</p>}

            {previewErrors.length > 0 && (
              <div className="bg-red-950/30 border border-red-700/40 rounded p-2">
                <div className="text-2xs text-red-300 uppercase tracking-wide mb-1">
                  {previewErrors.length} row{previewErrors.length === 1 ? "" : "s"} could not be parsed
                </div>
                <ul className="list-disc list-inside text-2xs text-terminal-dim space-y-0.5">
                  {previewErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {previewRows && (
              <div className="overflow-auto border border-terminal-border/50 rounded max-h-60">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
                    <tr>
                      {["Symbol", "Date", "Type", "Qty", "Price", "Commission"].map((h) => (
                        <th key={h} className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r, i) => (
                      <tr key={i} className="border-b border-terminal-border/30">
                        <td className="px-2 py-1 font-mono text-accent font-semibold">{r.symbol}</td>
                        <td className="px-2 py-1 font-mono text-terminal-dim whitespace-nowrap">{r.trade_date}</td>
                        <td className={`px-2 py-1 font-semibold capitalize ${TYPE_COLORS[r.trade_type as TradeType] ?? "text-terminal-fg"}`}>{r.trade_type}</td>
                        <td className="px-2 py-1 font-mono text-right text-terminal-fg">{r.quantity.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                        <td className="px-2 py-1 font-mono text-right text-terminal-fg">${fmt2(r.price)}</td>
                        <td className="px-2 py-1 font-mono text-right text-terminal-dim">${fmt2(r.commission)}</td>
                      </tr>
                    ))}
                    {previewRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-4 text-center text-terminal-dim text-2xs">
                          No valid rows parsed. Check the errors above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Transaction history ── */}
      <div className="flex-1 overflow-auto">
        {listErr && <p className="p-3 text-xs text-red-400">{listErr}</p>}
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-terminal-bg z-10 border-b border-terminal-border">
            <tr>
              {["Date", "Type", "Symbol", "Qty", "Price", "Commission", "Total", "Notes", ""].map((h) => (
                <th
                  key={h}
                  className="px-2 py-1.5 text-2xs uppercase tracking-wide text-terminal-dim text-left whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="animate-pulse border-b border-terminal-border/30">
                    {Array.from({ length: 9 }).map((__, j) => (
                      <td key={j} className="px-2 py-1.5">
                        <div className="h-3 bg-terminal-border/40 rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              : txns.map((t) => (
                  <tr key={t.id} className="border-b border-terminal-border/30 hover:bg-terminal-border/10">
                    <td className="px-2 py-1.5 font-mono text-terminal-dim whitespace-nowrap">{t.trade_date}</td>
                    <td className={`px-2 py-1.5 font-semibold capitalize ${TYPE_COLORS[t.trade_type as TradeType] ?? "text-terminal-fg"}`}>
                      {t.trade_type}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-accent font-semibold">{t.symbol}</td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">{t.quantity.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">${fmt2(t.price)}</td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-dim">${fmt2(t.commission)}</td>
                    <td className="px-2 py-1.5 font-mono text-right text-terminal-fg">${fmt2(t.quantity * t.price)}</td>
                    <td className="px-2 py-1.5 text-terminal-dim truncate max-w-[160px]" title={t.notes ?? ""}>{t.notes ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => handleDelete(t.id)}
                        className="pill text-2xs text-red-400 hover:bg-red-900/20"
                      >
                        Del
                      </button>
                    </td>
                  </tr>
                ))}
            {!loading && txns.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-terminal-dim text-xs">
                  No transactions yet. Use the form above to add your first trade.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
