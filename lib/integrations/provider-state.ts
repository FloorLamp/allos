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

import { formatSplitLabel, formatWindow } from "./sync-log";
import { isTruncatedSyncEvent } from "./sync-details";
import { formatTolerance, isSyncStale } from "./staleness";
import { parseSyncEventAt } from "./pull-cadence";

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

// What ONE RUN of this provider is called (#1991). The day-grouped history counts
// runs — "26 pushes today" — and a phone exporter pushing to us is not "syncing", nor
// is a keyless forecast fetch. Derived from the provider KIND for the same reason the
// vocabulary is: a future provider of a known kind gets the right word for free.
export type SyncRunNoun = "push" | "sync" | "refresh";

export function syncRunNounForKind(kind: string): SyncRunNoun {
  if (kind === "push") return "push";
  if (kind === "public") return "refresh";
  return "sync";
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
  // Connected and FLAPPING (#1880): failures in the recent run window, but a
  // successful run landed inside the provider's silence tolerance. Data IS still
  // arriving (or nothing has ever arrived, which the provider's own page already
  // shows), so this is a calm amber fact — it NEVER enters Needs attention, the
  // review badge, or the digest's 🔌 lines. Crying wolf hourly during upstream
  // instability trains the user to ignore the one surface that must be trusted.
  //
  // Since #2263 a provider that fails EVERY run stays here until its tolerance
  // expires, rather than escalating after three. That is the point: it cannot be
  // called broken while its data is still landing, and if the data genuinely stops,
  // the tolerance is what catches it.
  | "intermittent"
  // Connected and genuinely broken: NO successful run inside the provider's silence
  // tolerance (#2263) — however that silence was recorded. The ONLY standing that
  // escalates besides needs-reauth.
  | "failing"
  // The credential died / was revoked (#326) — actionable, and distinct from the
  // benign never-configured case.
  | "needs-reauth"
  // Set up once and later removed (#294). It keeps its history and offers a way back.
  | "not-connected"
  // Connected but nothing has run yet.
  | "never-synced";

// How many recent runs the standing derivation looks at. Deliberately the same
// depth every surface resolves (getIntegrationState reads this window regardless
// of how much display history the caller asked for), so the grid card, the source
// page, and Review can never disagree about whether a provider is flapping.
export const STANDING_RUN_WINDOW = 10;

// Leading run of failures in a newest-first event list. It no longer ESCALATES
// anything (#2263 deleted the consecutive-run rule — a run count is not a measure of
// whether data is arriving): it survives demoted to what it is actually good for,
// which is choosing WHICH recorded error the copy names. A success at the head
// returns 0.
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

// The facts the standing is derived from. `recentRuns` is the newest-first standing
// window (latest included), which decides only whether the provider is FLAPPING; the
// three freshness fields compose the ONE escalation rule (isSyncStale — the same
// derivation the silent-stop signal uses, not a duplicate of it).
export interface ProviderStandingFacts {
  connected: boolean;
  needsReauth: boolean;
  latest: SyncEventFacts | null;
  recentRuns?: readonly SyncEventFacts[];
  lastSuccessAt?: string | null;
  toleranceMinutes?: number | null;
  // NOW, as an instant — resolved by the caller through the lib/clock.ts seam
  // (`instantNow`), never hand-built and never SQL's own datetime('now').
  now?: string | null;
}

// THE standing derivation (#1772, flap-aware since #1880, one silence rule since
// #2263). One shared decision: the Review badge, Needs attention, the grid card, the
// source page, and the digest all read this — latest-event-wins is gone. Only
// `failing` and `needs-reauth` escalate (standingEscalates); `intermittent` stays a
// calm rendered fact.
export function providerStanding(s: ProviderStandingFacts): ProviderStanding {
  if (s.needsReauth) return "needs-reauth";
  if (!s.connected) return "not-connected";
  if (!s.latest) return "never-synced";
  const runs =
    s.recentRuns && s.recentRuns.length > 0 ? s.recentRuns : [s.latest];
  // THE escalation rule, COMPOSED (not duplicated): a connected provider with no
  // successful run inside its silence tolerance is broken, whether that silence was
  // recorded as failures, recorded as nothing, or a mix. Nothing else escalates —
  // counting consecutive failed RUNS measured the noise, not the signal, and for an
  // hourly provider it sat below that provider's own operating variance.
  //
  // `alreadyFailing` is false on purpose — this IS the failing derivation, so there
  // is no other signal to defer to here (getImportIssues still reports each provider
  // once).
  const silent =
    s.lastSuccessAt !== undefined &&
    s.toleranceMinutes !== undefined &&
    !!s.now &&
    isSyncStale(
      {
        provider: "",
        lastSuccessAt: s.lastSuccessAt ?? null,
        toleranceMinutes: s.toleranceMinutes ?? null,
        alreadyFailing: false,
      },
      s.now
    );
  if (silent) return "failing";
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

// The OBSERVED success cadence over a newest-first run window: the MEDIAN gap, in
// whole minutes, between consecutive successful runs. Null when fewer than two
// successes carry a readable stamp — one success states no cadence.
//
// MEASURED FOR DISPLAY ONLY (#2263 decision 4). It never feeds the escalation
// tolerance, which is declared in the registry: this is a statement about what has
// been observed, not a fitted parameter. The intermittent surfaces state the failure
// tally already — which is the noise — and this is the signal beside it.
export function observedSuccessCadenceMinutes(
  eventsNewestFirst: readonly SyncEventFacts[]
): number | null {
  const successes: number[] = [];
  for (const ev of eventsNewestFirst) {
    if (!ev.ok) continue;
    const ms = parseSyncEventAt(ev.at);
    if (ms != null) successes.push(ms);
  }
  if (successes.length < 2) return null;
  successes.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < successes.length; i++) {
    gaps.push((successes[i] - successes[i - 1]) / 60_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(1, Math.round(median));
}

// The observed cadence as the sentence the amber surfaces render — "succeeding about
// every 2 hours". Deliberately hedged and coarse: it is an observation over ten runs,
// not a promise, so it rounds to a unit a person can hold.
export function successCadenceLabel(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `succeeding about every ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36)
    return `succeeding about every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.max(1, Math.round(hours / 24));
  return `succeeding about every ${days} ${days === 1 ? "day" : "days"}`;
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

// The status card's HEADLINE (#1991 pin 9). The card answers "what's the state of
// this source" and then STOPS: it states the standing as a sentence and, below,
// today's activity as an aggregate — never a restatement of the newest run's split,
// its drill-in, or its raw link, all of which live in the history the same page
// renders underneath. Two copies of one event on one screen was the defect.
export function standingHeadline(
  standing: ProviderStanding,
  noun: SyncRunNoun = "sync"
): string {
  switch (standing) {
    case "healthy":
      return noun === "push" ? "Receiving normally" : "Syncing normally";
    case "partial":
      return "Working — more still upstream";
    case "intermittent":
      return INTERMITTENT_HEADLINE;
    case "failing":
      return noun === "push" ? "Not receiving" : "Not syncing";
    case "needs-reauth":
      return "Needs reconnecting";
    case "not-connected":
      return "Not connected";
    case "never-synced":
      return `Connected — waiting for the first ${noun}`;
  }
}

// Today's activity, as one aggregate sentence: "26 pushes today, 340 records added,
// 12 updated." Null when the newest recorded day is not today — an old day's tally
// dressed as "today" would be a lie, and the header's timestamp already says when the
// last run was.
export function periodActivityLabel(
  day: { runs: number; inserted: number; updated: number } | null,
  isToday: boolean,
  noun: SyncRunNoun = "sync",
  vocabulary: SyncVocabulary = "records"
): string | null {
  if (!day || !isToday || day.runs === 0) return null;
  const head = `${day.runs} ${day.runs === 1 ? noun : pluralRunNoun(noun)} today`;
  if (vocabulary === "forecast") {
    const revised = day.inserted + day.updated;
    return revised === 0
      ? `${head}, nothing revised`
      : `${head}, ${revised} ${revised === 1 ? "reading" : "readings"} revised`;
  }
  const parts: string[] = [];
  if (day.inserted > 0) parts.push(`${day.inserted} records added`);
  if (day.updated > 0) parts.push(`${day.updated} updated`);
  return parts.length ? `${head}, ${parts.join(", ")}` : `${head}, nothing new`;
}

// "push" → "pushes", "refresh" → "refreshes", "sync" → "syncs".
export function pluralRunNoun(noun: SyncRunNoun): string {
  return noun === "sync" ? "syncs" : `${noun}es`;
}

// The escalation policy, stated visibly on the source page (#1880 item 1): the one
// shared rule, so the page can promise what the badge and the digest will do. Null
// for an EXEMPT provider — it has no cadence to be late against, so there is no
// policy to promise and an invented sentence would be worse than silence.
export function escalationPolicyLabel(
  toleranceMinutes: number | null,
  noun: SyncRunNoun = "sync"
): string | null {
  if (toleranceMinutes == null) return null;
  return (
    `This source escalates to “Sync failing” when no ${noun} has succeeded ` +
    `in ${formatTolerance(toleranceMinutes)} — the same rule the Review badge and ` +
    "the morning digest use. Individual failures with a recent success behind them " +
    "do not: the next good run catches up."
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

// The per-run TABLE this module used to fold events into (buildHistoryRows,
// windowDivergence, quietRunLabel, failureRunReason) is gone: #1991 replaced the
// per-run log with a DAY-grouped one, and its rules — including the collapse of
// consecutive identical failures those helpers owned — live in
// lib/integrations/sync-history-days.ts. `runWindowNorm` survives because the window
// is still stated once, above the history.
