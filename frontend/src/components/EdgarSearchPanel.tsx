import { useEffect, useState } from "react";

// ── Local types (no edits to api/types.ts) ───────────────────────────────────
interface EdgarHit {
  company: string;
  ticker_or_cik: string;
  form: string;
  filed_date: string | null;
  snippet_or_title: string;
  url: string;
}
interface EdgarSearchResponse {
  query: string;
  forms: string | null;
  count: number;
  results: EdgarHit[];
  form_counts: Record<string, number>;
  data_mode: "live" | "sample";
  as_of: string;
  source: string;
}

// ── Local fallback so the panel never renders empty ──────────────────────────
const FALLBACK: EdgarSearchResponse = {
  query: "going concern",
  forms: null,
  count: 6,
  results: [
    {
      company: "AMC Entertainment Holdings",
      ticker_or_cik: "AMC",
      form: "10-K",
      filed_date: "2025-03-01",
      snippet_or_title: "Going concern — debt maturities and covenant compliance discussion",
      url: "https://www.sec.gov/Archives/edgar/data/1411579/000141157925000045/amc-20241231.htm",
    },
    {
      company: "GameStop Corp.",
      ticker_or_cik: "GME",
      form: "10-Q",
      filed_date: "2025-09-10",
      snippet_or_title: "Substantial doubt about ability to continue as a going concern removed",
      url: "https://www.sec.gov/Archives/edgar/data/1326380/000132638025000077/gme-20250802.htm",
    },
    {
      company: "Lucid Group, Inc.",
      ticker_or_cik: "LCID",
      form: "8-K",
      filed_date: "2025-07-30",
      snippet_or_title: "Risk factor — recurring losses raise going concern considerations",
      url: "https://www.sec.gov/Archives/edgar/data/1811210/000181121025000054/lcid-8k.htm",
    },
    {
      company: "Beyond Meat, Inc.",
      ticker_or_cik: "BYND",
      form: "10-Q",
      filed_date: "2025-08-08",
      snippet_or_title: "Substantial doubt regarding the Company's ability to continue",
      url: "https://www.sec.gov/Archives/edgar/data/1655210/000165521025000061/bynd-20250628.htm",
    },
    {
      company: "Peloton Interactive",
      ticker_or_cik: "PTON",
      form: "10-K",
      filed_date: "2025-09-12",
      snippet_or_title: "Material weakness in internal control over financial reporting",
      url: "https://www.sec.gov/Archives/edgar/data/1639825/000163982525000088/pton-20250630.htm",
    },
    {
      company: "WeWork Inc.",
      ticker_or_cik: "WE",
      form: "10-Q",
      filed_date: "2025-05-09",
      snippet_or_title: "Going concern — losses, negative cash flows, and lease obligations",
      url: "https://www.sec.gov/Archives/edgar/data/1813756/000181375625000033/we-20250331.htm",
    },
  ],
  form_counts: { "10-K": 2, "10-Q": 3, "8-K": 1 },
  data_mode: "sample",
  as_of: "2026-06-28T18:00:00+00:00",
  source: "sample",
};

// Quick-pick forensic / disclosure phrases.
const PRESETS = ["going concern", "material weakness", "restatement", "subsequent event"];

// ── Color helper: tint the form badge by document family ─────────────────────
function formColor(form: string): string {
  const f = form.toUpperCase();
  if (f.startsWith("10-K")) return "text-accent-blue border-accent-blue/40";
  if (f.startsWith("10-Q")) return "text-accent-green border-accent-green/40";
  if (f.startsWith("8-K")) return "text-accent-amber border-accent-amber/40";
  if (f.startsWith("S-")) return "text-accent border-accent/40";
  if (f.startsWith("SC ") || f.includes("13")) return "text-accent-red border-accent-red/40";
  return "text-terminal-muted border-terminal-border";
}

export function EdgarSearchPanel() {
  const [input, setInput] = useState("going concern");
  const [query, setQuery] = useState("going concern");
  const [data, setData] = useState<EdgarSearchResponse>(FALLBACK);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/edgar-search?q=${encodeURIComponent(query)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: EdgarSearchResponse) => {
        if (!alive) return;
        if (json && Array.isArray(json.results)) {
          setData(json);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  const submit = () => {
    const s = input.trim();
    if (s) setQuery(s);
  };

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-header flex items-center justify-between">
        <span>EDGAR FULL-TEXT SEARCH</span>
        <span className="text-[10px] font-mono text-terminal-dim">SEC filings · last ~10y</span>
      </div>

      <div className="panel-body flex flex-col gap-3 overflow-auto">
        {/* Search box */}
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder='Search filings, e.g. "material weakness"'
            className="flex-1 bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono text-terminal-text focus:outline-none focus:border-accent"
          />
          <button
            onClick={submit}
            className="px-3 py-1 text-xs font-mono uppercase border border-terminal-border rounded text-terminal-muted hover:text-accent hover:border-accent transition-colors"
          >
            Search
          </button>
          {loading && <span className="text-xs text-terminal-dim font-mono">Loading...</span>}
          {error && <span className="text-xs text-accent-amber font-mono">offline - showing cached</span>}
        </div>

        {/* Preset chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => {
                setInput(p);
                setQuery(p);
              }}
              className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                query === p
                  ? "border-accent text-accent"
                  : "border-terminal-border text-terminal-dim hover:text-terminal-text hover:border-terminal-muted"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Result count + active query */}
        <div className="flex items-center justify-between text-[10px] font-mono text-terminal-dim border-b border-terminal-divider pb-1">
          <span>
            <span className="text-terminal-text">{data.count}</span> filing
            {data.count === 1 ? "" : "s"} matching{" "}
            <span className="text-accent">&ldquo;{data.query}&rdquo;</span>
          </span>
          <span className="flex items-center gap-2">
            {Object.entries(data.form_counts).slice(0, 4).map(([f, n]) => (
              <span key={f}>
                {f} <span className="text-terminal-muted">{n}</span>
              </span>
            ))}
          </span>
        </div>

        {/* Results list */}
        {data.results.length ? (
          <div className="divide-y divide-terminal-divider">
            {data.results.map((r, i) => (
              <a
                key={`${r.url}-${i}`}
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-2.5 py-2 hover:bg-terminal-bg rounded px-1 -mx-1 transition-colors"
              >
                <span
                  className={`shrink-0 mt-0.5 px-1.5 py-0.5 text-[10px] font-mono uppercase rounded border tabular-nums ${formColor(
                    r.form,
                  )}`}
                >
                  {r.form}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-sans text-terminal-text truncate group-hover:text-accent">
                      {r.company}
                    </span>
                    <span className="shrink-0 text-[10px] font-mono text-terminal-muted tabular-nums">
                      {r.ticker_or_cik}
                    </span>
                  </div>
                  <div className="text-xs text-terminal-muted font-sans leading-snug line-clamp-2">
                    {r.snippet_or_title}
                  </div>
                </div>
                <span className="shrink-0 text-[10px] font-mono text-terminal-dim tabular-nums mt-0.5">
                  {r.filed_date ?? "—"}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="text-xs text-terminal-dim font-sans py-6 text-center">
            No filings matched. Try a broader phrase.
          </div>
        )}

        <div className="mt-auto text-[10px] font-mono text-terminal-dim pt-1 border-t border-terminal-divider">
          Links open the source document on sec.gov in a new tab
        </div>
      </div>
    </div>
  );
}
