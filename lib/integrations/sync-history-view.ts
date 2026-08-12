import type { IntegrationKind, IntegrationSyncEvent } from "../types";
import {
  drilldownCoverage,
  failureRunReason,
  groupSyncDays,
  syncDayAttention,
  syncDayLabel,
  syncRangeLabel,
  type SyncRunReason,
} from "./sync-history-days";
import {
  eventVerdict,
  formatSyncChange,
  syncRunNounForKind,
  type StatusTone,
  type SyncVocabulary,
} from "./source-state";
import { originChoiceLabel, parseSyncEventDetails } from "./sync-details";

// Plain client-safe views for the paged sync ledger. Collapsed ranges carry only
// event ids; their full run details are projected by the lazy expansion action.
export interface SyncRunView {
  id: number;
  at: string;
  isLatest: boolean;
  ok: boolean;
  verdict: { label: string; tone: StatusTone };
  change: string | null;
  changeMuted: boolean;
  skipped: number;
  error: string | null;
  notes: string[];
  itemizable: number;
  remainder: number;
  hasRaw: boolean;
}

export type SyncDayEntryView =
  | { kind: "run"; reason: SyncRunReason; run: SyncRunView }
  | {
      kind: "failure-run";
      count: number;
      newestAt: string;
      oldestAt: string;
      reason: string | null;
      runIds: number[];
      isLatest: boolean;
    }
  | {
      kind: "range";
      label: string;
      newestAt: string;
      oldestAt: string;
      runIds: number[];
    };

export interface SyncDayView {
  day: string;
  label: string;
  attention: { label: string; tone: StatusTone } | null;
  entries: SyncDayEntryView[];
}

export interface SyncHistoryPageView {
  days: SyncDayView[];
  nextBefore: string | null;
}

interface ProjectionContext {
  vocabulary: SyncVocabulary;
  provenanceCounts: Record<number, number>;
  latestEventId: number | null;
}

export function projectSyncRun(
  ev: IntegrationSyncEvent,
  context: ProjectionContext
): SyncRunView {
  const verdict = eventVerdict(ev, context.vocabulary);
  const change = ev.ok ? formatSyncChange(ev, context.vocabulary) : null;
  const written = ev.ok ? (ev.inserted ?? 0) + (ev.updated ?? 0) : 0;
  const coverage = drilldownCoverage(
    written,
    context.provenanceCounts[ev.id] ?? 0
  );
  const details = parseSyncEventDetails(ev.details ?? null);
  return {
    id: ev.id,
    at: ev.at,
    isLatest: ev.id === context.latestEventId,
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
}

export function projectSyncHistoryDays(
  events: readonly IntegrationSyncEvent[],
  options: ProjectionContext & {
    kind: IntegrationKind;
    timeZone: string;
    markLatest?: boolean;
  }
): SyncDayView[] {
  const noun = syncRunNounForKind(options.kind);
  // Outbound feeds record no runs, so there is no truthful day label to project.
  if (!noun) return [];
  const toRun = (ev: IntegrationSyncEvent) => projectSyncRun(ev, options);
  return groupSyncDays(events, options.timeZone, {
    markLatest: options.markLatest,
  }).map((day) => ({
    day: day.day,
    label: syncDayLabel(day, noun, options.vocabulary),
    attention: syncDayAttention(day),
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
          runIds: entry.runs.map((run) => run.id),
          isLatest: entry.runs[0].id === options.latestEventId,
        };
      }
      return {
        kind: "range",
        label: syncRangeLabel(entry.runs, noun, options.vocabulary),
        newestAt: entry.runs[0].at,
        oldestAt: entry.runs[entry.runs.length - 1].at,
        runIds: entry.runs.map((run) => run.id),
      };
    }),
  }));
}
