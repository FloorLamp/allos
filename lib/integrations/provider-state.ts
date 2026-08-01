// THE state model for "what's the state of this integration" (#1772).
//
// One provider used to be described by four surfaces in three visual languages: the
// Integrations grid card, the setup page's status card (its own badge, a raw SQLite
// UTC timestamp, and the `last_sync_summary` JSON echoed as `key: value` badges — a
// THIRD accounting alongside formatSplitLabel and the legacy `written` fallback),
// `IntegrationSyncHistoryLink`, and Review's Connected-sources card. Same question,
// different timestamps, different accountings, different affordances depending on
// where you were standing — the #221 "one question, one computation" disease at the
// surface level, with #524 as the precedent for fixing it at the computation.
//
// So: this module is the computation. It is PURE (no @/lib/db, no React) — the read
// layer (lib/queries/integrations.ts `getIntegrationState`) supplies the facts and
// every surface FORMATS this module's answers. A surface that wants a different
// badge, a different outcome sentence, or a different history shape has to change it
// here, where all three change together.

import { formatSplitLabel, formatWindow, isNoOpSyncEvent } from "./sync-log";
import { isTruncatedSyncEvent } from "./sync-details";

// The event fields every state answer is derived from. Structurally typed rather than
// importing the row type, so the pure tier never drags @/lib/db in behind it.
export interface SyncEventFacts {
  id: number;
  at: string;
  ok: number;
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  written: number | null;
  suppressed?: number | null;
  edited?: number | null;
  skipped?: number | null;
  window_start?: string | null;
  window_end?: string | null;
  details?: string | null;
  error?: string | null;
}

// ---- Vocabulary ------------------------------------------------------------

// WHAT a sync's counts are counting, which decides the words used to report them.
// `records` is the default: rows a person owns and can open. `forecast` is the
// cache-cell dialect — Weather & UV's split counts revised cells of the GLOBAL
// location-keyed forecast cache (`weather_uv_hours` / `weather_days`), so
// "16 changed · 365 unchanged" was technically honest accounting and meaningless to
// the person reading it (#1772). Same computation, honest words.
export type SyncVocabulary = "records" | "forecast";

// Derived from the provider KIND, never from a provider id: `public` is the keyless
// shared-cache kind, and any future provider of that kind gets the right dialect for
// free.
export function syncVocabularyForKind(kind: string): SyncVocabulary {
  return kind === "public" ? "forecast" : "records";
}

// The semantic tone of a status/outcome, resolved to classes in exactly one place
// (components/integrations/StatusBadge.tsx). Surfaces never pick colors themselves.
export type StatusTone = "good" | "caution" | "bad" | "neutral";

// ---- Standing --------------------------------------------------------------

// What kind of shape a provider is in, as one closed vocabulary every surface reads.
export type ProviderStanding =
  // Connected, and its most recent run succeeded cleanly.
  | "healthy"
  // Connected, most recent run succeeded but stopped early (#1614) — real data
  // landed, more is upstream.
  | "partial"
  // Connected, most recent run failed.
  | "failing"
  // The credential died / was revoked (#326) — actionable, and distinct from the
  // benign never-configured case.
  | "needs-reauth"
  // Set up once and later removed (#294). It keeps its history and offers a way back.
  | "not-connected"
  // Connected but nothing has run yet.
  | "never-synced";

export function providerStanding(s: {
  connected: boolean;
  needsReauth: boolean;
  latest: SyncEventFacts | null;
}): ProviderStanding {
  if (s.needsReauth) return "needs-reauth";
  if (!s.connected) return "not-connected";
  if (!s.latest) return "never-synced";
  if (!s.latest.ok) return "failing";
  return isTruncatedSyncEvent(s.latest) ? "partial" : "healthy";
}

export interface ProviderBadge {
  label: string;
  tone: StatusTone;
}

// ONE badge vocabulary. The grid card, the setup-page status header, and Review's
// card all render this — they used to hand-roll three different sets of words and
// tints for the same three states.
export function standingBadge(standing: ProviderStanding): ProviderBadge {
  switch (standing) {
    case "healthy":
      return { label: "Connected", tone: "good" };
    case "partial":
      return { label: "Partial sync", tone: "caution" };
    case "failing":
      return { label: "Sync failing", tone: "bad" };
    case "needs-reauth":
      return { label: "Needs reconnect", tone: "bad" };
    case "not-connected":
      return { label: "Not connected", tone: "caution" };
    case "never-synced":
      return { label: "Connected", tone: "good" };
  }
}

// Does this provider belong in Review's INBOX with its reason and its action, or is
// it healthy enough to collapse to a single line? Review is an inbox (#1772): a
// provider is there because something is wrong or unfinished, not because it exists.
// `never-synced` is deliberately NOT attention: a just-enabled provider waiting for
// the hourly tick is working as designed, and the staleness detector (#1685) is what
// escalates one that never starts.
export function needsAttention(standing: ProviderStanding): boolean {
  return (
    standing === "failing" ||
    standing === "needs-reauth" ||
    standing === "partial" ||
    standing === "not-connected"
  );
}

// ---- Outcome ---------------------------------------------------------------

// WHAT CHANGED in a successful run, in the vocabulary its provider speaks.
// `formatSplitLabel` (#674) stays THE record-language engine — this does not fork it,
// it selects the dialect. The raw `last_sync_summary` key:value badges the setup pages
// echoed (a third accounting, with no formatter, printing internal keys verbatim) are
// retired in favour of this.
export function formatSyncChange(
  ev: SyncEventFacts,
  vocabulary: SyncVocabulary = "records"
): { primary: string; muted: boolean } {
  if (vocabulary === "records") return formatSplitLabel(ev);
  // Cache dialect. A forecast cell is not a record: it is a figure the provider
  // republishes, so the only interesting number is how much of the cached window this
  // run REVISED, and an all-unchanged refetch is the normal, quiet case. Counting
  // revised forecast cells as "16 changed · 365 unchanged" was technically honest and
  // meaningless to the person reading it.
  const revised = (ev.inserted ?? 0) + (ev.updated ?? 0);
  if (revised === 0) return { primary: "no change", muted: true };
  return {
    primary: `${revised} ${revised === 1 ? "reading" : "readings"} revised`,
    muted: false,
  };
}

// The one-line outcome for a status HEADER or a collapsed inbox row: a whole sentence
// rather than a table cell. Composed from the same formatSyncChange, so a surface can
// pick the projection it needs without a second accounting appearing.
export function formatSyncOutcome(
  ev: SyncEventFacts,
  vocabulary: SyncVocabulary = "records"
): { primary: string; muted: boolean } {
  if (!ev.ok) return { primary: "Sync failed", muted: false };
  const change = formatSyncChange(ev, vocabulary);
  if (vocabulary !== "forecast") return change;
  return change.muted
    ? { primary: "Forecast unchanged", muted: true }
    : { primary: `Forecast refreshed · ${change.primary}`, muted: false };
}

// The verdict a history row's Outcome column states — did the run work — separate
// from what it changed, so a failure row can carry its REASON where the accounting
// would be. Same tone vocabulary as everything else.
export function eventVerdict(
  ev: SyncEventFacts,
  vocabulary: SyncVocabulary = "records"
): { label: string; tone: StatusTone } {
  if (!ev.ok) return { label: "Failed", tone: "bad" };
  if (isTruncatedSyncEvent(ev)) return { label: "Partial", tone: "caution" };
  return {
    label: vocabulary === "forecast" ? "Refreshed" : "Synced",
    tone: "good",
  };
}

// The tone of an event's outcome line — green success, amber partial, red failure.
export function outcomeTone(ev: SyncEventFacts): StatusTone {
  return eventVerdict(ev).tone;
}

// The coverage line for a run, in the provider's own vocabulary. Weather's window is
// the forecast reach the run set out to cover (#1771), which is exactly the thing
// worth naming for a cache; a record provider's window is the data window it pulled.
export function formatCoverage(
  ev: SyncEventFacts,
  vocabulary: SyncVocabulary = "records"
): string | null {
  if (!ev.window_start && !ev.window_end) return null;
  const window = formatWindow(ev.window_start ?? null, ev.window_end ?? null);
  return vocabulary === "forecast" ? `covers ${window}` : window;
}

// ---- History ---------------------------------------------------------------

// One row of the sync-history TABLE (#1772). The old surface was a flex-wrapped
// inline run of timestamp + outcome + window per event: nothing aligned, the window
// repeated verbatim on every row (noise when identical, unremarked when it differed —
// which is exactly when it carries signal, see #1771), the failure REASON rendered
// only for the latest event so a historical "Sync failed" row explained nothing, and
// an hourly provider filled every slot with near-identical no-ops.
export type SyncHistoryRow<T extends SyncEventFacts = SyncEventFacts> =
  | {
      kind: "event";
      ev: T;
      // Only when this run's window departs from the run norm. Identical windows are
      // stated once, above the table.
      window: string | null;
    }
  | {
      kind: "quiet";
      // A maximal run of CONSECUTIVE no-op syncs (#137), the same collapsing the
      // Imports feed does — an hourly provider otherwise fills all ten slots inside
      // one day with rows that say nothing.
      count: number;
      newestAt: string;
      oldestAt: string;
    };

// The window shape MOST of a provider's runs cover, so the table can state it once
// and flag only the rows that differ. Null when the events carry no window at all.
export function runWindowNorm(
  events: readonly SyncEventFacts[],
  vocabulary: SyncVocabulary = "records"
): string | null {
  const tally = new Map<string, number>();
  for (const ev of events) {
    const label = formatCoverage(ev, vocabulary);
    if (!label) continue;
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of tally) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

// Fold a provider's events (NEWEST-FIRST, as the queries return them) into table
// rows: consecutive no-ops collapsed, and each surviving row carrying its window only
// when that window departs from the norm. Pure → unit-testable.
export function buildHistoryRows<T extends SyncEventFacts>(
  eventsNewestFirst: readonly T[],
  vocabulary: SyncVocabulary = "records"
): SyncHistoryRow<T>[] {
  const norm = runWindowNorm(eventsNewestFirst, vocabulary);
  const out: SyncHistoryRow<T>[] = [];
  let i = 0;
  while (i < eventsNewestFirst.length) {
    const ev = eventsNewestFirst[i];
    if (!isNoOpSyncEvent(ev)) {
      const window = formatCoverage(ev, vocabulary);
      out.push({ kind: "event", ev, window: window === norm ? null : window });
      i++;
      continue;
    }
    let j = i;
    while (
      j < eventsNewestFirst.length &&
      isNoOpSyncEvent(eventsNewestFirst[j])
    )
      j++;
    const run = eventsNewestFirst.slice(i, j);
    // A single quiet sync is not a run — collapsing it would hide a row and gain
    // nothing, so it renders as itself.
    if (run.length === 1) {
      const window = formatCoverage(run[0], vocabulary);
      out.push({
        kind: "event",
        ev: run[0],
        window: window === norm ? null : window,
      });
    } else {
      out.push({
        kind: "quiet",
        count: run.length,
        newestAt: run[0].at,
        oldestAt: run[run.length - 1].at,
      });
    }
    i = j;
  }
  return out;
}

// The quiet-run summary sentence, in the provider's vocabulary. Pure.
export function quietRunLabel(
  count: number,
  vocabulary: SyncVocabulary = "records"
): string {
  return vocabulary === "forecast"
    ? `${count} refreshes with no change`
    : `${count} syncs with no new data`;
}
