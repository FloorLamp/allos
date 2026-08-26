"use client";

import type { ErrorEvent } from "@/lib/error-log-format";
import { countLabel } from "@/lib/plural";
import ClearLogControl from "@/components/ClearLogControl";
import LogTable from "@/components/LogTable";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestamp } from "@/lib/format-date";

// Persisted server errors, newest first. Errors are rare and low-volume, so an
// SSR snapshot with a manual refresh reads cleaner than the AI-logs SSE.
export default function ErrorLogTable({
  events,
  profileNames,
  clearAction,
}: {
  events: ErrorEvent[];
  profileNames: Record<number, string>;
  clearAction: () => Promise<void>;
}) {
  const formatPrefs = useFormatPrefs();

  return (
    <div data-testid="error-log">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="ml-auto">{countLabel(events.length, "error")}</span>
        {events.length > 0 && (
          <ClearLogControl log="error" clear={clearAction} />
        )}
      </div>

      <LogTable
        columns={[
          { label: "Time (UTC)", className: "whitespace-nowrap" },
          { label: "Level" },
          { label: "Scope" },
          { label: "Profile" },
          { label: "Message / detail" },
        ]}
        isEmpty={events.length === 0}
        emptyMessage="No server errors recorded. Unexpected exceptions and 500s will appear here when they happen."
        emptyTestId="error-log-empty"
      >
        {events.map((e) => (
          <tr
            key={e.id}
            className="border-b border-black/5 align-top dark:border-white/10"
          >
            <td
              className="td whitespace-nowrap text-slate-500 dark:text-slate-400"
              suppressHydrationWarning
            >
              {formatTimestamp(e.time, formatPrefs, { zone: "utc" })}
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
                <div className="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-xs text-slate-500 dark:text-slate-400">
                  {e.detail}
                </div>
              )}
            </td>
          </tr>
        ))}
      </LogTable>
    </div>
  );
}
