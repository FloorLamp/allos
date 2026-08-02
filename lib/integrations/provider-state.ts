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
import { isSyncStale } from "./staleness";
import { daysBetweenDateStr } from "../date";

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
  // Connected, and every recent run succeeded cleanly.
  | "healthy"
  // Connected, most recent run succeeded but stopped early (#1614) — real data
  // landed, more is upstream.
  | "partial"
  // Connected and FLAPPING (#1880): failures in the recent run window, but not
  // enough consecutive ones to escalate and no staleness breach. Data is still
  // flowing (or nothing has ever flowed, which the provider's own page already
  // shows), so this is a calm amber fact — it NEVER enters Needs attention, the
  // review badge, or the digest's 🔌 lines. Crying wolf hourly during upstream
  // instability trains the user to ignore the one surface that must be trusted.
  | "intermittent"
  // Connected and genuinely broken: FAILING_CONSECUTIVE_RUNS consecutive failures,
  // or the #1685 staleness threshold breached (no successful run within the
  // provider's registry threshold). The ONLY standing that escalates besides
  // needs-reauth — a single failed run no longer does (#1880).
  | "failing"
  // The credential died / was revoked (#326) — actionable, and distinct from the
  // benign never-configured case.
  | "needs-reauth"
  // Set up once and later removed (#294). It keeps its history and offers a way back.
  | "not-connected"
  // Connected but nothing has run yet.
  | "never-synced";

// How many CONSECUTIVE failures escalate a flapping provider to `failing` (#1880).
// Below this, a failure with the idempotent full-window re-fetch behind it loses
// nothing — the next good run catches up — so the standing stays `intermittent`.
export const FAILING_CONSECUTIVE_RUNS = 3;

// How many recent runs the standing derivation looks at. Deliberately the same
// depth every surface resolves (getIntegrationState reads this window regardless
// of how much display history the caller asked for), so the grid card, the source
// page, and Review can never disagree about whether a provider is flapping.
export const STANDING_RUN_WINDOW = 10;

// Leading run of failures in a newest-first event list — the "N consecutive
// failures" the escalation rule counts. A success at the head returns 0.
export function consecutiveLeadingFailures(
  eventsNewestFirst: readonly SyncEventFacts[]
): number {
  let n = 0;
  for (const ev of eventsNewestFirst) {
    if (ev.ok) break;
    n++;
  }
  return n;
}

// The facts the standing is derived from. `recentRuns` is the newest-first
// standing window (latest included); the three staleness fields compose the #1685
// rule (isSyncStale — the same derivation the silent-stop signal uses, not a
// duplicate of it).
export interface ProviderStandingFacts {
  connected: boolean;
  needsReauth: boolean;
  latest: SyncEventFacts | null;
  recentRuns?: readonly SyncEventFacts[];
  lastSuccessAt?: string | null;
  thresholdDays?: number | null;
  today?: string | null;
}

// THE standing derivation (#1772, flap-aware since #1880). One shared rule: the
// Review badge, Needs attention, the grid card, the source page, and the digest
// all read this — latest-event-wins is gone. Only `failing` and `needs-reauth`
// escalate (standingEscalates); `intermittent` stays a calm rendered fact.
export function providerStanding(s: ProviderStandingFacts): ProviderStanding {
  if (s.needsReauth) return "needs-reauth";
  if (!s.connected) return "not-connected";
  if (!s.latest) return "never-synced";
  const runs =
    s.recentRuns && s.recentRuns.length > 0 ? s.recentRuns : [s.latest];
  // The #1685 staleness rule, COMPOSED: a connected provider with no successful
  // run inside its registry threshold is broken however few failures it recorded.
  // `alreadyFailing` is false on purpose — this IS the failing derivation, so
  // there is no other signal to defer to here (getImportIssues still reports each
  // provider once).
  const stale =
    s.lastSuccessAt !== undefined &&
    s.thresholdDays !== undefined &&
    !!s.today &&
    isSyncStale(
      {
        provider: "",
        lastSuccessAt: s.lastSuccessAt ?? null,
        thresholdDays: s.thresholdDays ?? null,
        alreadyFailing: false,
      },
      s.today
    );
  if (stale || consecutiveLeadingFailures(runs) >= FAILING_CONSECUTIVE_RUNS) {
    return "failing";
  }
  if (s.latest.ok && isTruncatedSyncEvent(s.latest)) return "partial";
  if (runs.some((ev) => !ev.ok)) return "intermittent";
  return "healthy";
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
    case "intermittent":
      return { label: "Intermittent", tone: "caution" };
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

// Which standings ESCALATE (#1880): Review's "Needs attention" card, the
// profile-menu/Data badge, the dashboard hero item, and the digest's 🔌 lines all
// gate on this. Everything else — including `intermittent` — is a rendered fact on
// calm surfaces only; the reach of a flapping provider may only ever narrow.
export function standingEscalates(standing: ProviderStanding): boolean {
  return standing === "failing" || standing === "needs-reauth";
}

// Does this provider render EXPANDED with its reason and its action, or collapse to
// a single line? Review is an inbox (#1772): a provider is expanded because
// something is wrong or unfinished, not because it exists.
// `never-synced` is deliberately NOT attention: a just-enabled provider waiting for
// the hourly tick is working as designed, and the staleness detector (#1685) is what
// escalates one that never starts. `intermittent` is deliberately NOT attention
// either (#1880): it collapses to a calm amber one-liner stating the pattern.
export function needsAttention(standing: ProviderStanding): boolean {
  return (
    standingEscalates(standing) ||
    standing === "partial" ||
    standing === "not-connected"
  );
}

// ---- Flap + escalation copy (#1880) ---------------------------------------

// The honest pattern statement for a flapping provider's one-liner and status
// header: "3 of the last 10 runs failed".
export function intermittentRunsLabel(failed: number, total: number): string {
  return `${failed} of the last ${total} ${total === 1 ? "run" : "runs"} failed`;
}

// Why a flapping provider loses nothing, in the provider's own vocabulary — the
// question a person reading an amber chip actually has.
export function intermittentReassurance(vocabulary: SyncVocabulary): string {
  return vocabulary === "forecast"
    ? "nothing missing — each run re-fetches the full window"
    : "the next successful sync catches up";
}

// The intermittent status header's headline. The copy states the pattern, not the
// last event.
export const INTERMITTENT_HEADLINE = "Working, with interruptions";

// The escalation policy, stated visibly on the source page (#1880 item 1): the one
// shared rule, so the page can promise what the badge and the digest will do.
export function escalationPolicyLabel(thresholdDays: number | null): string {
  const consecutive = `after ${FAILING_CONSECUTIVE_RUNS} consecutive failures`;
  const staleness =
    thresholdDays == null
      ? ""
      : `, or when no run has succeeded in ${thresholdDays} ${
          thresholdDays === 1 ? "day" : "days"
        }`;
  return (
    `This source escalates to “Sync failing” ${consecutive}${staleness} — ` +
    "the same rule the Review badge and the morning digest use."
  );
}

// The consequence of a broken source, in user terms (#1880 item 2): what stops
// arriving, not which HTTP verb failed. Providers declare their own phrase in the
// registry (`stoppedConsequence`); this is the fallback for one that doesn't.
export function failureConsequence(
  name: string,
  declared?: string | null
): string {
  return declared ?? `New data from ${name} has stopped arriving.`;
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
      // Only when this run's window departs from the run norm — a divergence NOTE
      // (windowDivergence). Identical windows are stated once, above the table.
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
    }
  | {
      kind: "failure-run";
      // A maximal run of CONSECUTIVE IDENTICAL failures (#1880 item 3), collapsed
      // the same way no-ops are: "Failed ×2 · 4:00–5:00 PM · reason". The table then
      // SHOWS intermittency instead of encoding it as an alternating zebra.
      count: number;
      newestAt: string;
      oldestAt: string;
      error: string | null;
      // The newest event of the run, for stable keys and admin drill-ins.
      newest: T;
    };

// The window the LATEST windowed run covers (#1880 item 4). The norm used to be a
// majority vote over the whole event set, so after a day rollover the header —
// computed from stale history — contradicted the newest row. The latest run is the
// norm; OLDER rows note their divergence, never the reverse. Null when no event
// carries a window.
export function runWindowNorm(
  events: readonly SyncEventFacts[],
  vocabulary: SyncVocabulary = "records"
): string | null {
  for (const ev of events) {
    const label = formatCoverage(ev, vocabulary);
    if (label) return label;
  }
  return null;
}

// The raw [start, end] of the latest windowed run — the divergence comparisons below
// need the parts, not the label.
function latestWindow(
  events: readonly SyncEventFacts[]
): { start: string | null; end: string | null } | null {
  for (const ev of events) {
    if (ev.window_start || ev.window_end) {
      return { start: ev.window_start ?? null, end: ev.window_end ?? null };
    }
  }
  return null;
}

// An OLDER row's divergence note against the latest run's window (#1880 item 4).
// Null when the row matches the norm (or has no window). A run that shares the
// norm's start but stopped one day short is the day-rollover case, and says so:
// "covered → 2026-08-08 (before the day rolled)". Anything else states its own
// window in full.
export function windowDivergence(
  ev: SyncEventFacts,
  norm: { start: string | null; end: string | null } | null,
  vocabulary: SyncVocabulary = "records"
): string | null {
  const start = ev.window_start ?? null;
  const end = ev.window_end ?? null;
  if (!start && !end) return null;
  if (!norm) return formatCoverage(ev, vocabulary);
  if (start === norm.start && end === norm.end) return null;
  if (start === norm.start && end && norm.end) {
    const gap = daysBetweenDateStr(end.slice(0, 10), norm.end.slice(0, 10));
    if (gap === 1) return `covered → ${end} (before the day rolled)`;
    if (gap != null && gap > 0) return `covered → ${end}`;
  }
  return formatCoverage(ev, vocabulary);
}

// Fold a provider's events (NEWEST-FIRST, as the queries return them) into table
// rows: consecutive no-ops collapsed (#137), consecutive IDENTICAL failures
// collapsed (#1880 item 3), and each surviving row carrying its window only when it
// departs from the latest run's norm. Pure → unit-testable.
export function buildHistoryRows<T extends SyncEventFacts>(
  eventsNewestFirst: readonly T[],
  vocabulary: SyncVocabulary = "records"
): SyncHistoryRow<T>[] {
  const norm = latestWindow(eventsNewestFirst);
  const divergence = (ev: T) => windowDivergence(ev, norm, vocabulary);
  const out: SyncHistoryRow<T>[] = [];
  let i = 0;
  while (i < eventsNewestFirst.length) {
    const ev = eventsNewestFirst[i];
    if (!ev.ok) {
      // A maximal run of consecutive failures WITH THE SAME REASON — an upstream
      // outage retried hourly. A failure with a different reason starts its own
      // run (two different causes must not collapse into one row).
      let j = i;
      while (
        j < eventsNewestFirst.length &&
        !eventsNewestFirst[j].ok &&
        (eventsNewestFirst[j].error ?? null) === (ev.error ?? null)
      )
        j++;
      const run = eventsNewestFirst.slice(i, j);
      if (run.length === 1) {
        out.push({ kind: "event", ev, window: divergence(ev) });
      } else {
        out.push({
          kind: "failure-run",
          count: run.length,
          newestAt: run[0].at,
          oldestAt: run[run.length - 1].at,
          error: ev.error ?? null,
          newest: run[0],
        });
      }
      i = j;
      continue;
    }
    if (!isNoOpSyncEvent(ev)) {
      out.push({ kind: "event", ev, window: divergence(ev) });
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
      out.push({ kind: "event", ev: run[0], window: divergence(run[0]) });
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

// A collapsed failure run's shared reason, count-qualified so the row still says the
// reason held for EVERY run it collapsed (#1880 item 3). Null when the runs carried
// no recorded reason.
export function failureRunReason(
  count: number,
  error: string | null
): string | null {
  if (!error) return null;
  return count === 2 ? `${error} — both runs` : `${error} — all ${count} runs`;
}
