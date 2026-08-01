import { IconHistory } from "@tabler/icons-react";
import type { IntegrationState } from "@/lib/queries/integrations";
import {
  buildHistoryRows,
  eventVerdict,
  formatSyncChange,
  quietRunLabel,
  runWindowNorm,
} from "@/lib/integrations/provider-state";
import { STATUS_TEXT_TONE } from "./StatusBadge";
import SyncTimestamp from "./SyncTimestamp";
import { SyncDetailsNotes } from "./SyncOutcome";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import SyncRowsDrilldown from "@/components/SyncRowsDrilldown";

// The provider's sync history, on the provider's own page (#1772).
//
// #1212 retired the duplicate copy and left Review's expander as the single history;
// #1614 routed Weather into it. Neither redesigned it for the primary role it had
// inherited — it was still the #208 debug feed: a flex-wrapped inline run of
// timestamp + outcome + window per event with nothing aligned, the failure REASON
// rendered only for the latest event (so a "Sync failed" row in history explained
// nothing, and the moment a success landed even the most recent failure's reason
// vanished from the UI entirely), the window repeated verbatim on every row, no
// absolute times, a per-row expander nested inside the history expander, and no
// no-op collapsing, so an hourly provider filled every slot inside a day.
//
// This is the redesign, and it lives HERE because the setup page is the provider's
// home: status, controls, and history in one place. History still renders in exactly
// ONE place (#1212's rule holds) — Review is now an inbox that links to it.
export default function SyncHistoryTable({
  state,
  isAdmin = false,
}: {
  state: IntegrationState;
  isAdmin?: boolean;
}) {
  const { history, vocabulary } = state;
  const rows = buildHistoryRows(history, vocabulary);
  // Stated ONCE above the table; a row shows its own window only when it departs from
  // this — which is exactly when the window carries signal (see #1771's failure-vs-
  // success asymmetry), instead of being noise on every row.
  const norm = runWindowNorm(history, vocabulary);
  const provenance = new Set(state.provenanceEventIds);

  return (
    <div className="card" data-testid="sync-history">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
          <IconHistory
            className="h-4 w-4 text-slate-500 dark:text-slate-400"
            stroke={1.75}
          />
          Sync history
        </h2>
        {norm && (
          <span
            className="text-xs text-slate-500 dark:text-slate-400"
            data-testid="sync-history-window"
          >
            Each run {norm}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No syncs recorded yet. Each run will be listed here — what it wrote,
          skipped, or errored.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="section-label">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  When
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Outcome
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  What changed
                </th>
                <th scope="col" className="py-1 font-medium">
                  Window
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/5">
              {rows.map((row) => {
                if (row.kind === "quiet") {
                  // A run of CONSECUTIVE no-ops (#137), the same collapsing the
                  // Imports feed does.
                  return (
                    <tr
                      key={`quiet-${row.newestAt}-${row.count}`}
                      data-testid="sync-history-quiet"
                      className="text-slate-500 dark:text-slate-400"
                    >
                      <td className="py-2 pr-3 align-top text-xs">
                        <SyncTimestamp value={row.newestAt} relativeOnly /> –{" "}
                        <SyncTimestamp value={row.oldestAt} relativeOnly />
                      </td>
                      <td className="py-2 pr-3 align-top" colSpan={3}>
                        {quietRunLabel(row.count, vocabulary)}
                      </td>
                    </tr>
                  );
                }
                const ev = row.ev;
                const verdict = eventVerdict(ev, vocabulary);
                const change = ev.ok ? formatSyncChange(ev, vocabulary) : null;
                const written = ev.ok
                  ? (ev.inserted ?? 0) + (ev.updated ?? 0)
                  : 0;
                return (
                  <tr key={ev.id} data-testid={`sync-history-row-${ev.id}`}>
                    <td className="py-2 pr-3 align-top text-xs text-slate-500 dark:text-slate-400">
                      <SyncTimestamp value={ev.at} />
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <span
                        className={`font-medium ${STATUS_TEXT_TONE[verdict.tone]}`}
                      >
                        {verdict.label}
                      </span>
                      {/* The REASON, on EVERY failure row — not only the latest one.
                          Two bare "Sync failed" rows with no explanation was the live
                          behaviour this replaces. */}
                      {!ev.ok && ev.error && (
                        <p
                          className="mt-0.5 break-words text-xs text-rose-700 dark:text-rose-300"
                          data-testid={`sync-error-${ev.id}`}
                        >
                          {ev.error}
                        </p>
                      )}
                      <SyncDetailsNotes ev={ev} />
                      {isAdmin && ev.raw_ref && <RawPayloadViewer id={ev.id} />}
                    </td>
                    <td className="py-2 pr-3 align-top">
                      {change ? (
                        <span
                          className={
                            change.muted
                              ? "text-slate-500 dark:text-slate-400"
                              : "text-slate-700 dark:text-slate-200"
                          }
                        >
                          {change.primary}
                        </span>
                      ) : (
                        <span aria-hidden>—</span>
                      )}
                      {ev.skipped ? (
                        <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                          · {ev.skipped} skipped
                        </span>
                      ) : null}
                      {written > 0 && provenance.has(ev.id) && (
                        <SyncRowsDrilldown eventId={ev.id} count={written} />
                      )}
                    </td>
                    <td className="py-2 align-top text-xs text-slate-500 dark:text-slate-400">
                      {row.window ?? <span aria-hidden>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
