import { useEffect, useRef, useState } from "react";

import { streamBriefing } from "../api/client";
import type { RegimeState } from "../api/types";
import { RegimeBadge } from "./RegimeBadge";

type Status = "idle" | "streaming" | "error" | "done";

interface Props {
  /** Provided by the parent so the badge tracks the latest detection. */
  externalRegime: RegimeState | null;
}

export function BriefingPane({ externalRegime }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [streamedRegime, setStreamedRegime] = useState<RegimeState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-fetch on mount.
  useEffect(() => {
    start();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the briefing scrolled to the latest token.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [text]);

  const start = () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setText("");
    setError(null);
    setStatus("streaming");

    streamBriefing(ctrl.signal, null, {
      onRegime: (s) => setStreamedRegime(s),
      onToken:  (t) => setText((prev) => prev + t),
      onError:  (e) => { setError(e); setStatus("error"); },
      onDone:   ()  => setStatus((s) => (s === "error" ? s : "done")),
    }).catch((e) => {
      if (ctrl.signal.aborted) return;
      setError(String(e));
      setStatus("error");
    });
  };

  const regime = streamedRegime ?? externalRegime;

  return (
    <div className="panel h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span>Claude Briefing</span>
          <RegimeBadge state={regime} />
        </div>
        <button
          onClick={start}
          disabled={status === "streaming"}
          className="text-terminal-muted hover:text-accent-amber disabled:opacity-40 transition"
        >
          {status === "streaming" ? "streaming…" : "refresh"}
        </button>
      </div>

      <div ref={bodyRef} className="panel-body whitespace-pre-wrap leading-relaxed">
        {status === "error" ? (
          <span className="text-accent-red">⚠ {error}</span>
        ) : text ? (
          <span>{text}</span>
        ) : (
          <span className="text-terminal-dim">Assembling macro context…</span>
        )}
        {status === "streaming" && (
          <span className="inline-block w-2 h-4 ml-0.5 bg-accent-amber animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
}
