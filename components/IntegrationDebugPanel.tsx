import { IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import type { IntegrationSyncEvent } from "@/lib/types";
import { formatWindow } from "@/lib/integrations/sync-log";
import RelativeTime from "./RelativeTime";

// "Recent activity / debug" card shown on the Health Connect and Strava setup
// pages. Answers the questions the app previously couldn't: did my last sync
// arrive, when, what did it write vs drop, and did it error? All data is read
// profile-scoped by the page (getIntegrationSyncEvents / getLastSuccessfulSyncAt).
export default function IntegrationDebugPanel({
  events,
  lastSuccessAt,
  connected,
}: {
  events: IntegrationSyncEvent[];
  lastSuccessAt: string | null;
  connected: boolean;
}) {
  return (
    <div className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Recent activity
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {lastSuccessAt ? (
            <>
              Last successful sync:{" "}
              <RelativeTime
                value={lastSuccessAt}
                className="font-medium text-slate-600 dark:text-slate-300"
              />
            </>
          ) : connected ? (
            "No successful sync yet"
          ) : (
            "Not connected"
          )}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No sync events yet. Once your device or Strava pushes data, each sync
          shows up here with its data window and what it wrote.
        </p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-black/5 section-label dark:border-white/10">
                <th className="px-1 py-2 font-medium">When</th>
                <th className="px-1 py-2 font-medium">Status</th>
                <th className="px-1 py-2 font-medium">Data window</th>
                <th className="px-1 py-2 text-right font-medium">
                  Recv / Wrote / Skipped
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-black/5 last:border-0 dark:border-white/5"
                >
                  <td className="whitespace-nowrap px-1 py-2 align-top text-slate-500 dark:text-slate-400">
                    <RelativeTime value={e.at} />
                  </td>
                  <td className="px-1 py-2 align-top">
                    {e.ok ? (
                      <span className="badge inline-flex items-center gap-1 bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                        <IconCheck className="h-3.5 w-3.5" /> OK
                      </span>
                    ) : (
                      <span className="badge inline-flex items-center gap-1 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                        <IconAlertTriangle className="h-3.5 w-3.5" /> Error
                      </span>
                    )}
                    {!e.ok && e.error && (
                      <div className="mt-1 max-w-xs break-words text-xs text-rose-600 dark:text-rose-400">
                        {e.error}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-1 py-2 align-top text-slate-500 dark:text-slate-400">
                    {formatWindow(e.window_start, e.window_end)}
                  </td>
                  <td className="whitespace-nowrap px-1 py-2 text-right align-top tabular-nums text-slate-600 dark:text-slate-300">
                    {e.received == null && e.written == null
                      ? "—"
                      : `${e.received ?? 0} / ${e.written ?? 0} / ${e.skipped ?? 0}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
