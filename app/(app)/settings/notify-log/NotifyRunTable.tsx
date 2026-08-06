"use client";

import { useState, useTransition } from "react";
import ScrollFade from "@/components/ScrollFade";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestamp } from "@/lib/format-date";
import {
  classifyNotifyLine,
  type NotifyRun,
  type NotifyLineKind,
} from "@/lib/notify-log-format";

// The run table for Settings → Logs & audit → Notify tick (issue #2209). Same shell
// as its sibling viewers — card, ScrollFade, `.th`/`.td`, dashed empty panel,
// formatTimestamp + useFormatPrefs, the admin-gated Clear action — over a different
// row model: one row per (run, profile), expandable to its lines.
//
// Expansion is a plain <details>, so it needs no client state and works with JS off;
// only the Clear confirm is stateful.

const KIND_BADGE: Record<NotifyLineKind, string> = {
  decline: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  send: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  failure: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  note: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export default function NotifyRunTable({
  runs,
  profileNames,
  totalRuns,
  filtered,
  truncated,
  clearAction,
}: {
  runs: NotifyRun[];
  profileNames: Record<number, string>;
  totalRuns: number;
  filtered: boolean;
  truncated: boolean;
  clearAction: () => Promise<void>;
}) {
  const formatPrefs = useFormatPrefs();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <div data-testid="notify-log">
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {truncated && (
          <span data-testid="notify-log-truncated">
            Showing the most recent runs — older ones are still on disk, past
            this view&rsquo;s window.
          </span>
        )}
        <span className="ml-auto" />
        {totalRuns > 0 &&
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
                data-testid="notify-log-clear-confirm"
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
              data-testid="notify-log-clear"
            >
              Clear
            </button>
          ))}
      </div>

      {runs.length === 0 ? (
        <div
          className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400"
          data-testid="notify-log-empty"
        >
          {filtered ? (
            "No tick runs match these filters."
          ) : (
            <>
              {/* Not "nothing here yet": the log lives on the data volume and
                  survives deploys, so a genuinely empty page means something
                  specific and actionable. */}
              No tick runs recorded. This log survives deploys, so an empty page
              means the notification tick has never run on this instance — check
              that the scheduler (the <code>allos-notify</code> sidecar, or your
              own cron) is alive.
            </>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <ScrollFade>
            <table className="w-full text-sm" data-testid="notify-log-table">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/10">
                  <th className="th whitespace-nowrap">Run (UTC)</th>
                  <th className="th">Profile</th>
                  <th className="th">Decided</th>
                  <th className="th">Lines</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.key}
                    className="border-b border-black/5 align-top dark:border-white/10"
                    data-testid="notify-log-run"
                  >
                    <td
                      className="td whitespace-nowrap text-slate-500 dark:text-slate-400"
                      suppressHydrationWarning
                    >
                      {formatTimestamp(run.startedAt, formatPrefs, {
                        zone: "utc",
                      })}
                    </td>
                    <td className="td whitespace-nowrap">
                      {run.profileId == null
                        ? "— (whole run)"
                        : (profileNames[run.profileId] ?? `#${run.profileId}`)}
                    </td>
                    <td className="td whitespace-nowrap">
                      {/* A run that decided nothing says so IN WORDS. Rendering it
                          as an empty cell would reproduce, one row down, the exact
                          ambiguity this page exists to kill. */}
                      {run.counts.declines === 0 &&
                      run.counts.sends === 0 &&
                      run.counts.failures === 0 ? (
                        <span
                          className="text-slate-500 dark:text-slate-400"
                          data-testid="notify-log-quiet"
                        >
                          nothing to do
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {run.counts.sends > 0 && (
                            <span className={`badge ${KIND_BADGE.send}`}>
                              {run.counts.sends} sent
                            </span>
                          )}
                          {run.counts.declines > 0 && (
                            <span
                              className={`badge ${KIND_BADGE.decline}`}
                              data-testid="notify-log-decline-count"
                            >
                              {run.counts.declines} declined
                            </span>
                          )}
                          {run.counts.failures > 0 && (
                            <span className={`badge ${KIND_BADGE.failure}`}>
                              {run.counts.failures} failed
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="td">
                      <details>
                        <summary className="cursor-pointer text-slate-500 dark:text-slate-400">
                          {run.counts.total}
                        </summary>
                        <ul className="mt-2 space-y-2">
                          {run.events.map((e) => {
                            const kind = classifyNotifyLine(e);
                            return (
                              <li key={e.id} data-testid="notify-log-line">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <span className={`badge ${KIND_BADGE[kind]}`}>
                                    {kind}
                                  </span>
                                  <span className="font-medium">
                                    {e.message}
                                  </span>
                                  <span
                                    className="text-xs text-slate-500 dark:text-slate-400"
                                    suppressHydrationWarning
                                  >
                                    {formatTimestamp(e.time, formatPrefs, {
                                      zone: "utc",
                                    })}
                                  </span>
                                </div>
                                {e.detail && (
                                  <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-slate-500 dark:text-slate-400">
                                    {e.detail}
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
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
