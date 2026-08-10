"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { AiEvent, AiStatus } from "@/lib/ai-log";
import LogTable from "@/components/LogTable";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestamp } from "@/lib/format-date";

const MAX_ROWS = 500;

const STATUS_BADGE: Record<AiStatus, string> = {
  ok: "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300",
  skipped: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

// Renders the AI event table and live-streams new events via SSE. Seeded with
// the server-rendered `initial` events so it works without JS too. The Clear
// button mirrors the Errors tab's (#1842): admin-gated server action behind a
// two-tap confirm; the local table/seen state is reset alongside, because the
// streamed rows live in client state that a revalidation alone can't empty.
export default function LogsStream({
  initial,
  clearAction,
}: {
  initial: AiEvent[];
  clearAction: () => Promise<void>;
}) {
  const formatPrefs = useFormatPrefs();
  const [events, setEvents] = useState<AiEvent[]>(initial);
  const [live, setLive] = useState(false);
  const seen = useRef<Set<string>>(new Set(initial.map((e) => e.id)));
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

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
        {events.length > 0 &&
          (confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-slate-500 dark:text-slate-400">
                Clear all?
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    await clearAction();
                    setEvents([]);
                    seen.current.clear();
                    setConfirming(false);
                  })
                }
                className="btn-danger btn-sm"
                data-testid="ai-log-clear-confirm"
              >
                {pending ? "Clearing…" : "Confirm"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md px-2 py-1 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-md border border-black/10 px-2 py-1 font-medium text-slate-500 hover:text-slate-700 dark:border-white/10 dark:text-slate-400 dark:hover:text-slate-200"
              data-testid="ai-log-clear"
            >
              Clear
            </button>
          ))}
      </div>

      <LogTable
        columns={[
          { label: "Time (UTC)", className: "whitespace-nowrap" },
          { label: "Feature" },
          { label: "Status" },
          { label: "Tier" },
          { label: "Model" },
          { label: "Duration" },
          { label: "Tokens" },
          { label: "Detail / error" },
        ]}
        isEmpty={events.length === 0}
        emptyMessage="No AI activity yet. Trigger an AI feature (e.g. supplement suggestions or a document upload) and it will appear here live."
      >
        {events.map((e) => (
          <tr
            key={e.id}
            className="border-b border-black/5 align-top dark:border-white/10"
          >
            {/* Read as UTC through the shared formatter (#1448), so the
                        server render and the first client render are byte-identical
                        — the toLocaleString() this replaced rendered the server's
                        zone on the server and the browser's on the client, which is
                        why this cell needed suppressHydrationWarning. */}
            <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
              {formatTimestamp(e.time, formatPrefs, { zone: "utc" })}
            </td>
            <td className="td">{e.feature}</td>
            <td className="td">
              <span className={`badge ${STATUS_BADGE[e.status]}`}>
                {e.status}
              </span>
            </td>
            <td className="td text-slate-500 dark:text-slate-400">
              {e.tier ?? "—"}
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
                ? `${e.usage.in.toLocaleString("en-US")} / ${e.usage.out.toLocaleString("en-US")}`
                : "—"}
            </td>
            <td className="td">
              {e.error ? (
                <span className="text-rose-600 dark:text-rose-400">
                  {e.error}
                </span>
              ) : (
                <span className="whitespace-pre-wrap wrap-break-word text-slate-500 dark:text-slate-400">
                  {e.detail ?? ""}
                </span>
              )}
            </td>
          </tr>
        ))}
      </LogTable>
    </div>
  );
}
