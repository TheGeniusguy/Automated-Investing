import type {
  CorrelationsResponse,
  FilingsDefaults,
  FilingsResponse,
  HealthResponse,
  JournalSpxResponse,
  RegimeHistoryResponse,
  RegimeState,
  SeriesBundle,
  StressTestPosition,
  StressTestResponse,
} from "./types";

// In dev, Vite proxies /api → backend. In prod, same-origin or VITE_API_BASE.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`);
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText} — ${path}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health:        ()                    => getJSON<HealthResponse>("/api/health"),
  allSeries:     (days = 90)           => getJSON<SeriesBundle>(`/api/macro/series?days=${days}`),
  currentRegime: ()                    => getJSON<RegimeState>("/api/regime/current"),
  regimeHistory: (days = 365)          => getJSON<RegimeHistoryResponse>(`/api/regime/history?days=${days}`),
  journalSpx:    (days = 3650)         => getJSON<JournalSpxResponse>(`/api/journal/spx?days=${days}`),
  correlations:  (recent = 30, baseline = 365) =>
    getJSON<CorrelationsResponse>(`/api/correlations?recent_days=${recent}&baseline_days=${baseline}`),
  filingsDefaults: () => getJSON<FilingsDefaults>("/api/filings/defaults"),
  filings: (tickers: string[], days = 30, forms: string[] = []) => {
    const qs = new URLSearchParams({
      tickers: tickers.join(","),
      days:    String(days),
      forms:   forms.join(","),
    });
    return getJSON<FilingsResponse>(`/api/filings?${qs}`);
  },
  stressTest:    (positions: StressTestPosition[], days = 3650) =>
    fetch(`${API_BASE}/api/portfolio/stress-test`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ positions, days }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json() as Promise<StressTestResponse>;
    }),
};

// SSE briefing — uses fetch streaming because EventSource doesn't support POST.
export interface BriefingEvents {
  onRegime?: (state: RegimeState) => void;
  onToken?:  (text: string) => void;
  onError?:  (err: string) => void;
  onDone?:   () => void;
}

export async function streamBriefing(
  signal: AbortSignal,
  positions: { ticker: string; weight: number }[] | null,
  handlers: BriefingEvents,
): Promise<void> {
  const r = await fetch(`${API_BASE}/api/briefing/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ positions }),
    signal,
  });
  if (!r.ok || !r.body) {
    handlers.onError?.(`${r.status} ${r.statusText}`);
    handlers.onDone?.();
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Tiny SSE parser — events separated by "\n\n".
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        switch (event) {
          case "regime": handlers.onRegime?.(parsed); break;
          case "token":  handlers.onToken?.(parsed.text ?? ""); break;
          case "error":  handlers.onError?.(parsed.error ?? "unknown error"); break;
          case "done":   handlers.onDone?.(); break;
        }
      } catch {
        // Malformed event — skip silently.
      }
    }
  }
  handlers.onDone?.();
}
