import { IconHistory } from "@tabler/icons-react";
import type { IntegrationState } from "@/lib/queries/integrations";
import type { IntegrationSyncEvent } from "@/lib/types";
import { getIntegration } from "@/lib/integrations/registry";
import { syncStalenessThreshold } from "@/lib/integrations/staleness";
import {
  escalationPolicyLabel,
  eventVerdict,
  formatSyncChange,
  runWindowNorm,
  syncRunNounForKind,
} from "@/lib/integrations/provider-state";
import {
  drilldownCoverage,
  failureRunReason,
  groupSyncDays,
  syncDayAttention,
  syncDayLabel,
  syncRangeLabel,
} from "@/lib/integrations/sync-history-days";
import {
  originChoiceLabel,
  parseSyncEventDetails,
} from "@/lib/integrations/sync-details";
import SyncHistoryDays, {
  type SyncDayEntryView,
  type SyncDayView,
  type SyncRunView,
} from "./SyncHistoryDays";

// The provider's sync history, on the provider's own page (#1772), GROUPED BY DAY
// (#1991).
//
// #1212 retired the duplicate copy and left Review's expander as the single history;
// #1772 rebuilt it as a real table on the provider's own page. Neither fixed what a
// high-frequency source does to a per-run log: the Health Connect exporter re-sends
// its rolling window every ~20 minutes, so the table read
// "Synced · N new · 4 changed · 73 unchanged" about seventy times a day. The
// repeating "73 unchanged" is the tell — it is not news, and a real anomaly was
// invisible in that stream.
//
// So: one line per DAY, expanding to only what earned it (the pure rules live in
// lib/integrations/sync-history-days.ts); the WINDOW column is gone, because it was
// structurally constant for a given provider and is already stated once in this
// header; and the admin raw viewer is one link per run opening a dialog instead of a
// JSON tree rendered inline in the primary reading position.
//
// This component PROJECTS: it turns SQLite rows into plain serializable views so the
// interactive list (SyncHistoryDays) can be a client component without a row proxy
// ever crossing the boundary.
export default function SyncHistoryTable({
  state,
  isAdmin = false,
}: {
  state: IntegrationState;
  isAdmin?: boolean;
}) {
  const { history, vocabulary } = state;
  const noun = syncRunNounForKind(state.kind);
  // Stated ONCE above the history, from the LATEST run (#1880 item 4) — which is why
  // no row carries a window of its own any more.
  const norm = runWindowNorm(history, vocabulary);
  // The visible escalation policy (#1880 item 1): the page states the one shared
  // rule, so the amber/red the badge and digest will show is never a surprise.
  const policy = escalationPolicyLabel(
    syncStalenessThreshold(getIntegration(state.id))
  );

  const toRun = (ev: IntegrationSyncEvent): SyncRunView => {
    const verdict = eventVerdict(ev, vocabulary);
    const change = ev.ok ? formatSyncChange(ev, vocabulary) : null;
    const written = ev.ok ? (ev.inserted ?? 0) + (ev.updated ?? 0) : 0;
    const coverage = drilldownCoverage(
      written,
      state.provenanceCounts[ev.id] ?? 0
    );
    const details = parseSyncEventDetails(ev.details ?? null);
    return {
      id: ev.id,
      at: ev.at,
      ok: ev.ok !== 0,
      verdict,
      change: change?.primary ?? null,
      changeMuted: change?.muted ?? false,
      skipped: ev.skipped ?? 0,
      error: ev.error ?? null,
      notes: details
        ? [...details.warnings, ...details.origins.map(originChoiceLabel)]
        : [],
      itemizable: coverage.offer ? coverage.itemizable : 0,
      remainder: coverage.offer ? coverage.remainder : 0,
      hasRaw: !!ev.raw_ref,
    };
  };

  const days: SyncDayView[] = groupSyncDays(history, state.timeZone).map(
    (day) => ({
      day: day.day,
      label: syncDayLabel(day, noun, vocabulary),
      attention: syncDayAttention(day),
      newestAt: day.newestAt,
      entries: day.entries.map((entry): SyncDayEntryView => {
        if (entry.kind === "run") {
          return { kind: "run", reason: entry.reason, run: toRun(entry.ev) };
        }
        if (entry.kind === "failure-run") {
          return {
            kind: "failure-run",
            count: entry.runs.length,
            newestAt: entry.runs[0].at,
            oldestAt: entry.runs[entry.runs.length - 1].at,
            reason: failureRunReason(entry.runs.length, entry.error),
            runs: entry.runs.map(toRun),
          };
        }
        return {
          kind: "range",
          label: syncRangeLabel(entry.runs, noun, vocabulary),
          newestAt: entry.runs[0].at,
          oldestAt: entry.runs[entry.runs.length - 1].at,
          runs: entry.runs.map(toRun),
        };
      }),
    })
  );

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

      {days.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No syncs recorded yet. Each run will be listed here — what it wrote,
          skipped, or errored.
        </p>
      ) : (
        <SyncHistoryDays days={days} isAdmin={isAdmin} />
      )}

      <p
        className="mt-3 max-w-prose rounded-lg border border-dashed border-black/10 px-3 py-2 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
        data-testid="escalation-policy"
      >
        {policy}
      </p>
    </div>
  );
}
