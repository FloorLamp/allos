import { IconCheck, IconCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { IntegrationState } from "@/lib/queries/integrations";
import { staleSyncDetail } from "@/lib/integrations/staleness";
import {
  formatCoverage,
  intermittentReassurance,
  intermittentRunsLabel,
  successCadenceLabel,
  INTERMITTENT_HEADLINE,
  periodActivityLabel,
  standingBadge,
  standingHeadline,
  syncRunNounForKind,
} from "@/lib/integrations/source-state";
import { groupSyncDays } from "@/lib/integrations/sync-history-days";
import RawPayloadViewer from "@/components/RawPayloadViewer";
import SyncRowsDrilldown from "@/components/SyncRowsDrilldown";
import StatusBadge from "./StatusBadge";
import IntegrationBackfillProgress from "./IntegrationBackfillProgress";
import SyncTimestamp from "./SyncTimestamp";
import { SyncDetailsNotes, SyncOutcomeLine } from "./SyncOutcome";

// Records a sync actually wrote (inserted + updated) — the count the provenance
// drill-in (#1333) can resolve to deep links. It is the SUMMARY count, shown either
// way; whether the DRILL-IN is offered is a separate question answered by recorded
// provenance (#1771), not by this number.
function writtenCount(ev: {
  ok: number;
  inserted: number | null;
  updated: number | null;
}): number {
  if (!ev.ok) return 0;
  return (ev.inserted ?? 0) + (ev.updated ?? 0);
}

// THE status header for one integration (#1772) — the answer to "what's the state of
// this integration", rendered identically wherever it is asked. The provider's setup
// page (its home) puts it at the top of the page with the connect/disconnect/sync
// controls; Review's inbox renders the same component for a provider that needs
// attention. They used to be two hand-mirrored cards with different badges, different
// timestamp formats, and different accountings.
//
// `controls` is the per-surface slot (the responsive/shared-content rule): the shape
// is shared, the buttons belong to whoever is rendering.
//
// `detail` is the other per-surface choice, and #1991 is why it exists:
//
//   "run"    — Review's inbox card. It shows ONE event and there is nothing beneath
//              it, so the newest run's split, its coverage, its drill-in and its raw
//              link ARE the card's content.
//   "period" — the provider's own page, which renders the full history right below.
//              The card answers and stops (pin 9): the standing as a sentence, plus
//              today's aggregate. Restating the newest run here put the identical
//              split, "What this wrote" and "View raw" TWICE on one screen.
export type StatusDetail = "run" | "period";

export default function IntegrationStatusHeader({
  state,
  showName = false,
  controls,
  isAdmin = false,
  detail = "run",
  testid,
  watchBackfills = false,
}: {
  state: IntegrationState;
  // Review lists several providers, so it names each; the setup page's PageHeader
  // already carries the name.
  showName?: boolean;
  controls?: ReactNode;
  isAdmin?: boolean;
  detail?: StatusDetail;
  testid?: string;
  watchBackfills?: boolean;
}) {
  const { latest, standing, vocabulary } = state;
  // The run noun selects the attended dialect too (#2301) — "Last import" for an
  // archive, "Last upload" for an attended tool — and is NULL for the outbound feed,
  // which records no runs to name.
  const noun = syncRunNounForKind(state.kind);
  const badge = standingBadge(standing, noun);
  const perRun = detail === "run";
  const coverage = perRun && latest ? formatCoverage(latest, vocabulary) : null;
  const provenance = state.provenanceCounts;
  const written = latest ? writtenCount(latest) : 0;
  const visibleBackfills = watchBackfills
    ? state.backfills
    : state.backfills.filter((job) => job.status !== "completed");
  // Today's activity, aggregated — the period card's one fact. The newest day group
  // IS today's when the newest run landed today; periodActivityLabel refuses to
  // dress an older day's tally as "today".
  const newestDay = perRun
    ? null
    : (groupSyncDays(state.history, state.timeZone)[0] ?? null);
  const activity = periodActivityLabel(
    newestDay,
    newestDay?.day === state.today,
    noun,
    vocabulary
  );
  const cadence = successCadenceLabel(state.successCadenceMinutes);
  // "No syncs yet" is a PROMISE that a sync is coming, and it is only true for the
  // SCHEDULED family (#2301): the outbound feed will never sync anything in, and an
  // attended source already states its own emptiness through the badge and the
  // headline ("Set up — nothing imported yet"). Nothing where nothing is true.
  const awaitFirstRun = state.delivery === "scheduled";

  return (
    <div data-testid={testid}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {showName && (
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {state.name}
            </span>
          )}
          <StatusBadge
            label={badge.label}
            tone={badge.tone}
            icon={
              badge.tone === "good" ? (
                <IconCheck className="h-3.5 w-3.5" />
              ) : undefined
            }
            testid={`sync-status-${state.id}`}
          />
        </div>
        {latest && (
          <SyncTimestamp
            value={latest.at}
            className="text-xs text-slate-500 dark:text-slate-400"
          />
        )}
      </div>

      {standing === "intermittent" ? (
        // A FLAPPING provider's header states the pattern, not the last event
        // (#1880 item 1): what is true ("working, with interruptions"), the honest
        // tally, and why nothing is lost — the question a person actually has.
        <div className="mt-2" data-testid="intermittent-summary">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {INTERMITTENT_HEADLINE}
            {state.lastSuccessAt && (
              <>
                {" "}
                — last success{" "}
                <SyncTimestamp value={state.lastSuccessAt} relativeOnly />.
              </>
            )}
          </p>
          {/* The failure tally names the NOISE; the observed success cadence names
              the signal, which is the reading this surface was missing (#2263 item
              4). Measured over the standing window for DISPLAY only — the
              escalation tolerance stays declared in the registry. */}
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {intermittentRunsLabel(
              state.recentRuns.failed,
              state.recentRuns.total
            )}
            {cadence && <> · {cadence}</>} ·{" "}
            {intermittentReassurance(vocabulary)}.
          </p>
        </div>
      ) : perRun ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {latest ? (
            <SyncOutcomeLine ev={latest} vocabulary={vocabulary} />
          ) : awaitFirstRun ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
              <IconCircle className="h-4 w-4 shrink-0" stroke={1.75} />
              No syncs yet
            </span>
          ) : null}
          {coverage && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {coverage}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-2" data-testid={`sync-period-${state.id}`}>
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {standingHeadline(standing, noun)}
            {activity ? ` — ${activity}.` : "."}
          </p>
          {!latest && awaitFirstRun && (
            <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
              <IconCircle className="h-4 w-4 shrink-0" stroke={1.75} />
              No syncs yet
            </p>
          )}
        </div>
      )}

      {/* The quiet stop (#1685): a `failing` standing whose latest run SUCCEEDED —
          the escalation came from the staleness breach, so the outcome line above
          honestly says "Refreshed/Synced" and THIS states what is wrong. */}
      {state.stale && latest?.ok ? (
        <p
          className="mt-1 wrap-break-word text-sm text-rose-700 dark:text-rose-300"
          data-testid={`sync-stale-${state.id}`}
        >
          {staleSyncDetail(state.name, state.stale)}
        </p>
      ) : null}
      {standing !== "intermittent" && latest && !latest.ok && latest.error && (
        <p
          className="mt-1 wrap-break-word text-sm text-rose-700 dark:text-rose-300"
          data-testid={`sync-error-${latest.id}`}
        >
          {latest.error}
        </p>
      )}
      {/* When the latest attempt failed, say when data last actually arrived — the
          question every reader of a red card has next. (The intermittent branch
          already leads with its last success.) */}
      {standing !== "intermittent" &&
        latest &&
        !latest.ok &&
        state.lastSuccessAt && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Last successful sync{" "}
            <SyncTimestamp value={state.lastSuccessAt} relativeOnly />.
          </p>
        )}
      {/* The newest run's diagnostics, drill-in and raw payload belong to whichever
          surface OWNS that run. On the provider's own page the history below owns it,
          and repeating it here was the #1991 duplication. */}
      {perRun && latest && <SyncDetailsNotes ev={latest} />}
      {perRun && latest && written > 0 && provenance[latest.id] && (
        <SyncRowsDrilldown
          eventId={latest.id}
          count={provenance[latest.id]}
          remainder={Math.max(written - provenance[latest.id], 0)}
        />
      )}

      {(visibleBackfills.length > 0 || watchBackfills) && (
        <IntegrationBackfillProgress
          provider={state.id}
          initialJobs={visibleBackfills}
          watch={watchBackfills}
        />
      )}

      {(controls || (perRun && isAdmin && latest?.raw_ref)) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {controls}
          {perRun && isAdmin && latest?.raw_ref && (
            <div className="w-full">
              <RawPayloadViewer id={latest.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
