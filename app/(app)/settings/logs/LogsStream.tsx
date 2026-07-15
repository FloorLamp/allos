"use client";

import { useEffect, useRef, useState } from "react";
import type { AiEvent, AiStatus } from "@/lib/ai-log";
import ScrollFade from "@/components/ScrollFade";

const MAX_ROWS = 500;

const STATUS_BADGE: Record<AiStatus, string> = {
  ok: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  skipped: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

function fmtTime(iso: string): string {
  // Local time; the column header notes the timezone is the server's TZ.
  return new Date(iso).toLocaleString();
}

// Renders the AI event table and live-streams new events via SSE. Seeded with
// the server-rendered `initial` events so it works without JS too.
export default function LogsStream({ initial }: { initial: AiEvent[] }) {
  const [events, setEvents] = useState<AiEvent[]>(initial);
  const [live, setLive] = useState(false);
  const seen = useRef<Set<string>>(new Set(initial.map((e) => e.id)));

  useEffect(() => {
    const es = new EventSource("/settings/logs/stream");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // EventSource auto-reconnects
    es.onmessage = (msg) => {
      let ev: AiEvent;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!ev?.id || seen.current.has(ev.id)) return;
      seen.current.add(ev.id);
      setEvents((prev) => [ev, ...prev].slice(0, MAX_ROWS));
    };
    return () => es.close();
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            live ? "bg-emerald-500" : "bg-slate-300 dark:bg-ink-700"
          }`}
        />
        {live ? "Live" : "Reconnecting…"}
        <span className="ml-auto">{events.length} events</span>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400">
          No AI activity yet. Trigger an AI feature (e.g. supplement suggestions
          or a document upload) and it will appear here live.
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <ScrollFade>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <th className="th">Time</th>
                  <th className="th">Feature</th>
                  <th className="th">Status</th>
                  <th className="th">Model</th>
                  <th className="th">Duration</th>
                  <th className="th">Tokens</th>
                  <th className="th">Detail / error</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-black/5 align-top dark:border-white/10"
                  >
                    <td
                      className="td whitespace-nowrap text-slate-500 dark:text-slate-400"
                      // toLocaleString() renders in the server's locale/TZ on the
                      // server and the browser's on the client, so the first
                      // client render can differ — suppress the expected mismatch.
                      suppressHydrationWarning
                    >
                      {fmtTime(e.time)}
                    </td>
                    <td className="td">{e.feature}</td>
                    <td className="td">
                      <span className={`badge ${STATUS_BADGE[e.status]}`}>
                        {e.status}
                      </span>
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {e.model ?? "—"}
                    </td>
                    <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {e.durationMs != null
                        ? `${(e.durationMs / 1000).toFixed(1)}s`
                        : "—"}
                    </td>
                    <td className="td whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400">
                      {e.usage
                        ? `${e.usage.in.toLocaleString()} / ${e.usage.out.toLocaleString()}`
                        : "—"}
                    </td>
                    <td className="td">
                      {e.error ? (
                        <span className="text-rose-600 dark:text-rose-400">
                          {e.error}
                        </span>
                      ) : (
                        <span className="whitespace-pre-wrap break-words text-slate-500 dark:text-slate-400">
                          {e.detail ?? ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollFade>
        </div>
      )}
    </div>
  );
}
