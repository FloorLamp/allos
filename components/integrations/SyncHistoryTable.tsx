import { IconHistory } from "@tabler/icons-react";
import CardFootnote from "@/components/CardFootnote";
import type { IntegrationState } from "@/lib/queries/integrations";
import { getIntegration } from "@/lib/integrations/registry";
import { silenceToleranceMinutes } from "@/lib/integrations/staleness";
import {
  escalationPolicyLabel,
  runWindowNorm,
  syncRunNounForKind,
} from "@/lib/integrations/provider-state";
import { projectSyncHistoryDays } from "@/lib/integrations/sync-history-view";
import SyncHistoryDays from "./SyncHistoryDays";

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
  // #2301: for an ATTENDED source this states the inverse instead of nothing — allos
  // never marks it late, because only the reader can start it — and for an OUTBOUND
  // one it stays silent, since nothing arrives to be late.
  const policy = escalationPolicyLabel(
    silenceToleranceMinutes(getIntegration(state.id)),
    noun,
    state.delivery
  );

  const days = projectSyncHistoryDays(history, {
    kind: state.kind,
    vocabulary,
    timeZone: state.timeZone,
    provenanceCounts: state.provenanceCounts,
    // The history marker names the newest RECORDED run. Provider standing may use a
    // synthetic expired-token event that deliberately does not belong in this log.
    latestEventId: history[0]?.id ?? null,
  });

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
        <SyncHistoryDays
          key={`${state.latest?.id ?? "empty"}:${state.historyNextBefore ?? "end"}`}
          days={days}
          today={state.today}
          providerId={state.id}
          initialCursor={state.historyNextBefore}
          timeZone={state.timeZone}
          isAdmin={isAdmin}
        />
      )}

      {policy && (
        <CardFootnote data-testid="escalation-policy">
          <span className="font-semibold text-slate-600 dark:text-slate-300">
            Status note:
          </span>{" "}
          {policy}
        </CardFootnote>
      )}
    </div>
  );
}
