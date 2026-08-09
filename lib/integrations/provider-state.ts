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

import type { IntegrationKind } from "@/lib/types/integrations";
import { formatSplitLabel, formatWindow } from "./sync-log";
import { isTruncatedSyncEvent } from "./sync-details";
import { formatTolerance, isSyncStale } from "./staleness";
import { parseSyncEventAt } from "./pull-cadence";
import type { IntegrationDelivery } from "./delivery";

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
//
// TYPED `IntegrationKind`, not `string` (#2301). The old signature is why `archive`
// and `external-attended` fell into the polled dialect silently — the comment promised
// that "a future provider of a known kind gets the right word for free", which was
// true only for the kinds the function happened to name, because a `string` parameter
// has no exhaustiveness to fail. The two attended kinds resolve to `records`, which is
// the value they already got: only the TYPING changes here. It is the guard, not a
// behaviour fix.
export function syncVocabularyForKind(kind: IntegrationKind): SyncVocabulary {
  switch (kind) {
    case "public":
      return "forecast";
    case "push":
    case "oauth":
    case "token":
    case "feed":
    case "archive":
    case "external-attended":
      return "records";
  }
}

// What ONE RUN of this provider is called (#1991). The day-grouped history counts
// runs — "26 pushes today" — and a phone exporter pushing to us is not "syncing", nor
// is a keyless forecast fetch. Derived from the provider KIND for the same reason the
// vocabulary is: a future provider of a known kind gets the right word for free.
//
// `import` (archive) and `upload` (external-attended) joined in #2301 — the two
// attended kinds had been silently taking the polled word.
export type SyncRunNoun = "push" | "sync" | "refresh" | "import" | "upload";

// NULL FOR `feed`, and deliberately: a noun for a run is a fiction where no runs are
// recorded. Outbound surfaces never ask for one, and giving them "sync" is how
// "No syncs yet" ended up rendering forever on a card nothing will ever sync into.
// (Same reasoning as the registry's refusal to declare paging tunables for Weather.)
export function syncRunNounForKind(kind: IntegrationKind): SyncRunNoun | null {
  switch (kind) {
    case "push":
      return "push";
    case "public":
      return "refresh";
    case "oauth":
    case "token":
      return "sync";
    case "archive":
      return "import";
    case "external-attended":
      return "upload";
    case "feed":
      return null;
  }
}

// The semantic tone of a status/outcome, resolved to classes in exactly one place
// (components/integrations/StatusBadge.tsx). Surfaces never pick colors themselves.
export type StatusTone = "good" | "caution" | "bad" | "neutral";

// ---- Standing --------------------------------------------------------------

// ONE union, THREE DISJOINT FAMILIES (#2301). Every state below used to describe a
// live connection, and the model applied them to sources allos does not drive: a
// ten-day-old Takeout file read "Connected", green; an outbound calendar feed read
// "Connected" plus a permanent "No syncs yet"; a hand-run portal tool read
// "Intermittent", whose own contract ("a successful run landed inside the provider's
// silence tolerance") is vacuous when the tolerance is null. The green tone was the
// sharpest part: `good` is a HEALTH verdict, the one claim allos cannot make about a
// source it does not drive.
//
// So the union grew two families and `providerStanding` gained a DELIVERY, which it
// dispatches on. The producer is where illegal combinations become unrepresentable:
// each private derivation returns its own subtype, so no future code path can hand an
// attended provider `failing`. The consumers stay ONE function each — `standingBadge`,
// `standingHeadline`, `standingEscalates`, `needsAttention` — switching over the whole
// union with no `default`, which is what makes growing the union a compile error at
// every surface rather than a silent fall-through.

// The seven original states, UNCHANGED, and now stated to be about a connection.
export type ScheduledStanding =
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

// The ATTENDED vocabulary — PROMOTED, not invented (#2301). Two surfaces had already
// opted out of the shared model rather than be described wrongly by it, and both had
// hand-rolled the honest words: the Fitbit Takeout page states
// `Last import ${when}.` / "Set up, but nothing imported yet." / "No archive imported
// yet.", and lib/portal-status.ts does the same for portals ("this integration is
// attended, so a quiet login is a login nobody has run yet, not a broken one"). Those
// three states are these three; writing fresh copy here would have produced a THIRD
// dialect for a problem caused by there being two.
//
// `attempt-failed` is the state the hand-rolled versions LACKED. An import genuinely
// can fail, and before this it read as `intermittent`.
//
// No `needs-reauth` here: a revoked upload token surfaces as a failed attempt, which
// is what the user sees and what they act on. Fewer states, same information. And
// `not-set-up` rather than `not-connected`, because "Not connected" frames a file
// import as a link you failed to make.
export type AttendedStanding =
  // The last recorded attempt succeeded. The honest statement is WHEN something last
  // arrived; the reader decides whether that is fine.
  | "imported"
  // The last recorded attempt failed. An attention item, never an escalation.
  | "attempt-failed"
  // Set up, nothing in yet.
  | "never-imported"
  // No connection and no history at all.
  | "not-set-up";

// The OUTBOUND vocabulary. Allos publishes; nothing arrives, and no runs are
// recorded — which is why the outbound surfaces state the feed's state and then say
// nothing about runs at all.
export type OutboundStanding = "feed-enabled" | "feed-off";

// What kind of shape a provider is in, as one closed vocabulary every surface reads.
export type ProviderStanding =
  ScheduledStanding | AttendedStanding | OutboundStanding;

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
  // WHO MOVES THE DATA (#2301) — the axis that decides WHICH question is being asked,
  // and therefore which family of answers is even representable. Derived from the
  // provider's kind (KIND_DELIVERY), never declared per provider.
  delivery: IntegrationDelivery;
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
// #2263, delivery-dispatched since #2301). One shared decision: the Review badge,
// Needs attention, the grid card, the source page, and the digest all read this —
// latest-event-wins is gone. Only `failing` and `needs-reauth` escalate
// (standingEscalates), both scheduled-only; `intermittent` stays a calm rendered fact.
//
// THE PRODUCER IS WHERE ILLEGAL COMBINATIONS BECOME UNREPRESENTABLE: each branch
// returns its own subtype, so an attended provider cannot be handed a connection
// verdict by this or any future code path.
export function providerStanding(s: ProviderStandingFacts): ProviderStanding {
  switch (s.delivery) {
    case "scheduled":
      return scheduledStanding(s);
    case "attended":
      return attendedStanding(s);
    case "outbound":
      return outboundStanding(s);
  }
}

// A source allos does not drive, read by its LAST ATTEMPT. There is no run window to
// consult and no flap to detect: "3 of the last 10 runs failed" describes a connection
// misbehaving on its own, and nothing here happens on its own. The freshness fields
// are ignored on purpose — an attended provider declares `silenceToleranceMinutes:
// null` because allos may never call it late.
function attendedStanding(s: ProviderStandingFacts): AttendedStanding {
  if (s.latest) return s.latest.ok ? "imported" : "attempt-failed";
  // No attempt has ever been recorded, so the only question left is whether this was
  // ever set up. `needsReauth` is deliberately not consulted (see AttendedStanding).
  return s.connected ? "never-imported" : "not-set-up";
}

// Allos publishes; nothing arrives. The only fact is whether the feed is live.
function outboundStanding(s: ProviderStandingFacts): OutboundStanding {
  return s.connected ? "feed-enabled" : "feed-off";
}

// The original seven-state derivation, MOVED HERE VERBATIM: the #2263 silence rule,
// `intermittent`, and the flap window are untouched for the providers they were
// written for. This refactor must not move a single scheduled verdict.
function scheduledStanding(s: ProviderStandingFacts): ScheduledStanding {
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

// The attended family's word for one run — "import" for an `archive`, "upload" for an
// `external-attended` tool. Falls back to "import", the more common of the two, for a
// caller with no noun in hand.
function attendedWord(noun: SyncRunNoun | null): {
  run: string;
  past: string;
} {
  return noun === "upload"
    ? { run: "upload", past: "Uploaded" }
    : { run: "import", past: "Imported" };
}

// ONE badge vocabulary. The grid card, the setup-page status header, and Review's
// card all render this — they used to hand-roll three different sets of words and
// tints for the same three states.
//
// TONE IS THE POINT of the #2301 split. `good` is a HEALTH verdict, and the attended
// and outbound families are never given one: green asserts a connection is working,
// and for a source allos does not drive the honest statement is only WHEN something
// last arrived — the reader decides whether that is fine. `neutral` throughout there,
// with `caution` reserved for a run that actually failed.
//
// `noun` selects the attended dialect (import / upload); the scheduled and outbound
// labels ignore it.
export function standingBadge(
  standing: ProviderStanding,
  noun: SyncRunNoun | null = null
): ProviderBadge {
  const word = attendedWord(noun);
  switch (standing) {
    // ── scheduled: the connection verdicts, unchanged ──
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
    // ── attended: never green, because nothing here is a connection ──
    case "imported":
      return { label: `Last ${word.run}`, tone: "neutral" };
    case "attempt-failed":
      return { label: `Last ${word.run} failed`, tone: "caution" };
    case "never-imported":
      return {
        label: `Nothing ${word.past.toLowerCase()} yet`,
        tone: "neutral",
      };
    case "not-set-up":
      return { label: "Not set up", tone: "neutral" };
    // ── outbound ──
    case "feed-enabled":
      return { label: "Feed enabled", tone: "neutral" };
    case "feed-off":
      return { label: "Feed off", tone: "neutral" };
  }
}

// Which standings ESCALATE (#1880): Review's "Needs attention" card, the
// profile-menu/Data badge, the dashboard hero item, and the digest's 🔌 lines all
// gate on this. Everything else — including `intermittent` — is a rendered fact on
// calm surfaces only; the reach of a flapping provider may only ever narrow.
//
// EXACTLY the two scheduled states, still — which since #2301 means NO attended or
// outbound state can ever escalate, and that is the property that makes the split
// worth doing rather than three more members on a flat union. Allos cannot claim an
// attended source is *still* broken: only the user knows whether they will run the
// tool again, and a morning digest line about a portal tool last touched on someone's
// laptop is the crying-wolf failure #1880 exists to prevent.
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
//
// `attempt-failed` joins `partial` and `not-connected` here (#2301): expanded in
// Review, no badge, no digest 🔌 line. A reach reduction plus one calm rendered
// surface, which the contact-consent rule permits. `not-set-up` and `feed-off` are
// deliberately NOT attention — an integration nobody set up is not an unfinished task.
export function needsAttention(standing: ProviderStanding): boolean {
  return (
    standingEscalates(standing) ||
    standing === "partial" ||
    standing === "not-connected" ||
    standing === "attempt-failed"
  );
}

// Has this provider been SET UP at all? Asked by the Import grid, which shows a
// compact STATUS card for anything set up and the original pitch card for anything
// that is not — its owner either bought it or unbought it. ONE decision rather than a
// member list per surface: `not-connected` is the scheduled "set up once, later
// removed" (#294), `not-set-up` is its attended twin, `feed-off` its outbound one.
export function standingUnconfigured(standing: ProviderStanding): boolean {
  return (
    standing === "not-connected" ||
    standing === "not-set-up" ||
    standing === "feed-off"
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
  noun: SyncRunNoun | null = "sync"
): string {
  const word = attendedWord(noun);
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
      return `Connected — waiting for the first ${noun ?? "sync"}`;
    // ── attended. "Syncing normally" and "the next successful sync catches up" were
    //    what an attended page adopting this component would have rendered (#2301):
    //    nothing will catch up, because there is no next run until a person starts
    //    one. These state what happened and stop. ──
    case "imported":
      // The surface appends WHEN — it already renders the timestamp.
      return word.past;
    case "attempt-failed":
      return `The last ${word.run} failed`;
    case "never-imported":
      return `Set up — nothing ${word.past.toLowerCase()} yet`;
    case "not-set-up":
      return "Not set up";
    // ── outbound ──
    case "feed-enabled":
      return "Publishing to your calendar";
    case "feed-off":
      return "Feed off";
  }
}

// Today's activity, as one aggregate sentence: "26 pushes today, 340 records added,
// 12 updated." Null when the newest recorded day is not today — an old day's tally
// dressed as "today" would be a lie, and the header's timestamp already says when the
// last run was.
export function periodActivityLabel(
  day: { runs: number; inserted: number; updated: number } | null,
  isToday: boolean,
  noun: SyncRunNoun | null = "sync",
  vocabulary: SyncVocabulary = "records"
): string | null {
  // A provider with no run noun records no runs (the outbound `feed`), so there is no
  // activity to aggregate — never a count in an invented word.
  if (!noun) return null;
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

// A DECLARED TABLE, not a suffix rule (#2301). The old `${noun}es` fallback happened
// to be right for exactly the three nouns that existed and yields "importes" and
// "uploades" for the two added here — an English pluralisation rule is not something
// to derive, and `Record<SyncRunNoun, string>` makes a new noun a build error until it
// declares its plural.
const RUN_NOUN_PLURAL: Record<SyncRunNoun, string> = {
  push: "pushes",
  sync: "syncs",
  refresh: "refreshes",
  import: "imports",
  upload: "uploads",
};

export function pluralRunNoun(noun: SyncRunNoun): string {
  return RUN_NOUN_PLURAL[noun];
}

// The escalation policy, stated visibly on the source page (#1880 item 1): the one
// shared rule, so the page can promise what the badge and the digest will do. Null
// for an EXEMPT SCHEDULED provider — it has no cadence to be late against, so there is
// no policy to promise and an invented sentence would be worse than silence.
//
// THE ATTENDED INVERSE (#2301). Returning null there was honest silence, but the page
// can now state the POSITIVE, which is the thing a reader of that page actually wants
// to know: allos will never mark this source late, because only they can start it.
// Outbound stays silent — nothing arrives, so there is no lateness either way and no
// sentence to write about it.
export function escalationPolicyLabel(
  toleranceMinutes: number | null,
  noun: SyncRunNoun | null = "sync",
  delivery: IntegrationDelivery = "scheduled"
): string | null {
  if (delivery === "outbound") return null;
  if (delivery === "attended") {
    return (
      `This source is only ever as fresh as your last ${attendedWord(noun).run} — ` +
      "allos never marks it late, because only you can start it."
    );
  }
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
