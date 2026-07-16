"use client";

import { useState, useTransition } from "react";
import type { ErrorEvent } from "@/lib/error-log-format";
import ScrollFade from "@/components/ScrollFade";

function fmtTime(iso: string): string {
  // Local time; the server's TZ on the server, the browser's on the client.
  return new Date(iso).toLocaleString();
}

// Read-only table of persisted server errors, newest first, with an admin-only
// "Clear" button (issue #596). No live stream — errors are rare and low-volume,
// so an SSR snapshot with a manual refresh reads cleaner than the AI-logs SSE.
export default function ErrorLogTable({
  events,
  profileNames,
  clearAction,
}: {
  events: ErrorEvent[];
  profileNames: Record<number, string>;
  clearAction: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <div data-testid="error-log">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="ml-auto">{events.length} errors</span>
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
                    setConfirming(false);
                  })
                }
                className="btn-danger btn-sm"
                data-testid="error-log-clear-confirm"
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
              data-testid="error-log-clear"
            >
              Clear
            </button>
          ))}
      </div>

      {events.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400"
          data-testid="error-log-empty"
        >
          No server errors recorded. Unexpected exceptions and 500s will appear
          here when they happen.
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <ScrollFade>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <th className="th">Time</th>
                  <th className="th">Level</th>
                  <th className="th">Scope</th>
                  <th className="th">Profile</th>
                  <th className="th">Message / detail</th>
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
                      suppressHydrationWarning
                    >
                      {fmtTime(e.time)}
                    </td>
                    <td className="td">
                      <span
                        className={`badge ${
                          e.level === "warn"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                            : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                        }`}
                      >
                        {e.level}
                      </span>
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {e.scope ?? "—"}
                    </td>
                    <td className="td whitespace-nowrap text-slate-500 dark:text-slate-400">
                      {e.profileId != null
                        ? (profileNames[e.profileId] ?? `#${e.profileId}`)
                        : "—"}
                    </td>
                    <td className="td">
                      <div className="font-medium text-rose-700 dark:text-rose-300">
                        {e.message}
                      </div>
                      {e.detail && (
                        <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-slate-500 dark:text-slate-400">
                          {e.detail}
                        </div>
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
