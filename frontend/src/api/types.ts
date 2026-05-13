// API contract — mirrors backend Pydantic / dict shapes.

export type RegimeLabel = "risk_on" | "risk_off" | "transition";

export interface RegimeState {
  label: RegimeLabel;
  confidence: number;        // 0.0 - 1.0
  reason: string;
  inputs: {
    vix: number | null;
    y2: number | null;
    y10: number | null;
  };
}

export interface SeriesPoint {
  date: string;              // YYYY-MM-DD
  value: number | null;
}

export interface SeriesMeta {
  label: string;
  unit: string;
  source: string;
}

export interface SeriesBundle {
  days: number;
  meta: Record<string, SeriesMeta>;
  series: Record<string, SeriesPoint[]>;
}

export interface RegimeHistoryEntry {
  date: string;
  label: RegimeLabel;
  confidence: number;
  reason: string;
  inputs: { vix: number | null; y2: number | null; y10: number | null };
}

export interface RegimeHistoryResponse {
  days: number;
  history: RegimeHistoryEntry[];
  recent_transitions: {
    date: string;
    from: RegimeLabel;
    to: RegimeLabel;
    reason: string;
  }[];
}

export interface HealthResponse {
  status: string;
  fred_configured: boolean;
  anthropic_configured: boolean;
  claude_model: string;
}
