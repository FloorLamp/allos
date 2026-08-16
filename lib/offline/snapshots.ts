// THE OFFLINE READ SNAPSHOT REGISTRY (issue #2908). Pure, CLIENT-SAFE and DB-FREE.
//
// Offline, this app could write but not read. The PWA write queue (#28) is eight
// idempotent flows deep, and `public/sw.js` still states — correctly — that rendered
// HTML is never cached. So in a dead zone you could log a dose and not see your med
// list, and not see whether you had already logged it.
//
// The Emergency Card (#42) is the one place that was already solved, and it is the
// shape this generalizes: an authenticated visit refreshes a CURATED, BOUNDED,
// PROFILE-STAMPED payload into device storage; logout and profile switch wipe it; a
// session-free page renders it with no network. This module makes that the rule and
// DECLARES it, instead of leaving it an exception one feature happened to get.
//
// What this is NOT: it is not an HTTP cache (the service worker's policy is untouched
// — see the invariant comment in components/OfflineSnapshotRefresher.tsx), it is not a
// sync engine, and it holds no verdicts. A snapshot carries FACTS with a date on them.
// A coaching verdict computed against "now" freezes into a lie the moment it is stored,
// so none is ever stored (owner decision 5).
//
// THE SELECTION RULE, and the reason the registry is type-checked rather than a
// convention: a snapshot earns its place when it answers "what have I already done"
// for something the write queue can also capture. `SNAPSHOT_REGISTRY` below is that
// sentence with teeth in the #2130 declare-or-argue shape — a sixth kind cannot join,
// and the five cannot lose their scope/wipe/overlay declarations, by omission.

import type { FlowKind, QueuedIntent, DosePayload, FoodPayload } from "./queue";
import type { MedicationListRow } from "@/lib/medication-list";
import { dateStrInTz, daysBetweenDateStr } from "@/lib/date";
import { freshnessAgeDays, freshnessState } from "@/lib/freshness";

// ── The five kinds ───────────────────────────────────────────────────────────

export type SnapshotKind =
  | "dose-schedule"
  | "medication-list"
  | "recent-training"
  | "food-tallies"
  | "practice-week";

export const SNAPSHOT_KINDS: readonly SnapshotKind[] = [
  "dose-schedule",
  "medication-list",
  "recent-training",
  "food-tallies",
  "practice-week",
];

// How a snapshot's contents are BOUNDED, which is the same decision as when it goes
// stale — the two are one property, not two.
//
//   profile-day    — the payload is one PROFILE-LOCAL DAY ("today's doses"). It goes
//                    stale at THAT PROFILE'S midnight, never the device's: a caregiver
//                    in Berlin reading a snapshot captured for a profile in Denver must
//                    not be told a Denver-evening schedule is "today" because Berlin
//                    has ticked over. The envelope carries the profile's timezone so
//                    the device can answer this with no server.
//   rolling-window  — the payload is a last-N window ("the last 10 sessions per
//                    exercise"). It has no midnight; it ages, and `staleAfterDays` is
//                    the clock lib/freshness.ts judges it against.
export type SnapshotScope = "profile-day" | "rolling-window";

export interface SnapshotDecl {
  // The section heading on /offline.
  readonly title: string;
  // The "what have I already done" question this kind answers — the selection rule,
  // restated per row so a future addition has to answer it too.
  readonly answers: string;
  readonly scope: SnapshotScope;
  // The staleness clock for a `rolling-window` kind, in whole days. A `profile-day`
  // kind states 0: its clock is the profile's midnight, and a second number here would
  // be a second answer to one question.
  readonly staleAfterDays: number;
  // The queued write flows that OVERLAY this snapshot at render (the read-your-writes
  // half). Empty is a real answer — the med list is the safety case and nothing the
  // queue captures changes it.
  readonly overlays: readonly FlowKind[];
  // Why this kind is bounded the way it is, and why it is safe to hold on a device.
  readonly why: string;
}

// The registry. Every kind declares its scope, its clock, its overlay flows and its
// reasoning. `satisfies Record<SnapshotKind, SnapshotDecl>` is the tooth: a sixth
// member of the union fails `tsc` here until someone declares it, exactly as
// OFFLINE_QUEUE_COVERAGE does for one-tap affordances.
export const SNAPSHOT_REGISTRY = {
  "dose-schedule": {
    title: "Today's doses",
    answers: "Have I taken this one yet today?",
    scope: "profile-day",
    staleAfterDays: 0,
    overlays: ["dose", "skip-dose"],
    why: "One profile-local day of scheduled doses with their resolutions — the read the queue's oldest flow was writing blind into. Bounded by the day; a dose schedule is a handful of rows.",
  },
  "medication-list": {
    title: "Medications & supplements",
    answers: "What do you take? — asked by a stranger, in a room with no signal.",
    scope: "rolling-window",
    staleAfterDays: 7,
    overlays: [],
    why: "The safety case, and the only kind with no queued counterpart: nothing the queue captures changes the list, so it declares no overlay rather than pretending to one. Bounded by the active regimen and refreshed weekly — a med change propagates on the next authenticated visit.",
  },
  "recent-training": {
    title: "Recent training",
    answers: "What did I lift last time? — the basement gym with no bars.",
    scope: "rolling-window",
    staleAfterDays: 3,
    overlays: ["set"],
    why: "Last-N sessions per movement plus the recent activity spine. Explicitly last-N and capped (MAX_SNAPSHOT_EXERCISES / MAX_SNAPSHOT_SESSIONS) — training history is the one read here that would otherwise grow without bound.",
  },
  "food-tallies": {
    title: "Today's food",
    answers: "Have I already logged that serving?",
    scope: "profile-day",
    staleAfterDays: 0,
    overlays: ["food"],
    why: "The day's group counters and protein total — a day rollup, so the bound is the day. Counts and grams only: no meal notes, no photos.",
  },
  "practice-week": {
    title: "Practices this week",
    answers: "Have I done my practice today, and where is the week at?",
    scope: "rolling-window",
    staleAfterDays: 1,
    overlays: ["practice"],
    why: "Tracked practices with their week progress — the cadence question, which is a week and therefore a rolling window rather than a day. Refreshed daily because the week's own counts move daily.",
  },
} as const satisfies Record<SnapshotKind, SnapshotDecl>;

// ── Bounds ───────────────────────────────────────────────────────────────────
// Every snapshot is bounded, and the bounds are constants rather than magic numbers at
// the call sites so the coverage test can read them.

export const MAX_SNAPSHOT_DOSES = 60;
export const MAX_SNAPSHOT_MEDICATIONS = 80;
export const MAX_SNAPSHOT_EXERCISES = 15;
export const MAX_SNAPSHOT_SESSIONS = 10;
export const MAX_SNAPSHOT_ACTIVITIES = 10;
export const MAX_SNAPSHOT_FOOD_GROUPS = 40;
export const MAX_SNAPSHOT_PRACTICES = 30;

// ── The payloads ─────────────────────────────────────────────────────────────

export type DoseStatus = "pending" | "taken" | "skipped";

export interface DoseScheduleEntry {
  doseId: number;
  name: string;
  // Dose strength / product ("50 mg"), or null.
  detail: string | null;
  // The time-of-day bucket label ("Morning"), or null for an anytime dose.
  slot: string | null;
  // The dose's stored wall time ("08:00"), or null.
  time: string | null;
  status: DoseStatus;
  // Set by the OVERLAY only (never by the server builder): this resolution is a tap
  // still sitting in the write queue, not something the server has confirmed.
  queued?: boolean;
}

export interface DoseScheduleData {
  // The profile-local day these doses are for.
  date: string;
  entries: DoseScheduleEntry[];
}

export interface MedicationListData {
  rows: MedicationListRow[];
}

export interface RecentSessionLine {
  date: string;
  equipment: string | null;
  text: string;
}

export interface RecentExerciseHistory {
  exercise: string;
  sessions: RecentSessionLine[];
}

export interface RecentActivityLine {
  date: string;
  title: string;
  detail: string | null;
  // Overlay-only: this session is a queued `set` intent, not a server row.
  queued?: boolean;
}

export interface RecentTrainingData {
  activities: RecentActivityLine[];
  exercises: RecentExerciseHistory[];
}

export interface FoodTallyRow {
  key: string;
  label: string;
  servings: number;
  // Overlay-only: servings from queued `food` intents included in `servings` above.
  queued?: number;
}

export interface FoodTalliesData {
  date: string;
  groups: FoodTallyRow[];
  // null when the profile doesn't track protein.
  proteinGrams: number | null;
  queuedProteinGrams?: number;
}

export interface PracticeWeekRow {
  identity: string;
  name: string;
  perWeek: number;
  countThisWeek: number;
  todayCount: number;
  // Overlay-only: taps from queued `practice` intents folded into the counts above.
  queued?: number;
}

export interface PracticeWeekData {
  // The profile-local day the week progress was read on.
  date: string;
  practices: PracticeWeekRow[];
}

export interface SnapshotDataByKind {
  "dose-schedule": DoseScheduleData;
  "medication-list": MedicationListData;
  "recent-training": RecentTrainingData;
  "food-tallies": FoodTalliesData;
  "practice-week": PracticeWeekData;
}

export type SnapshotData = SnapshotDataByKind[SnapshotKind];

// ── The stored envelope ──────────────────────────────────────────────────────
//
// Versioned and PROFILE-STAMPED, for the reason the emergency payload is: a blob from
// another profile or an older schema is refused on READ rather than mis-rendered. The
// wipe on logout / profile switch is the primary defense (see clearSnapshots); this is
// the belt to its braces, because the worst defect this feature can have is one
// profile's doses rendering under another profile's name.

export const SNAPSHOT_VERSION = 1;

export interface SnapshotEnvelope<K extends SnapshotKind = SnapshotKind> {
  version: number;
  kind: K;
  // The profile the payload was CAPTURED under (#599, extended from intents to
  // snapshots). Every read is scoped by it.
  profileId: number;
  // The profile's IANA timezone at capture — what makes `capturedOn` a PROFILE-LOCAL
  // day on a device that may be in another zone entirely.
  timeZone: string;
  // The profile-local day of capture (YYYY-MM-DD).
  capturedOn: string;
  // The instant of capture (ISO) — the "as of" line's input.
  fetchedAt: string;
  data: SnapshotDataByKind[K];
}

export type AnySnapshot = {
  [K in SnapshotKind]: SnapshotEnvelope<K>;
}[SnapshotKind];

function isKind(v: unknown): v is SnapshotKind {
  return (
    typeof v === "string" && (SNAPSHOT_KINDS as readonly string[]).includes(v)
  );
}

// Parse a stored envelope defensively: a malformed / wrong-version / wrong-shape blob
// yields null, so the offline surface says "nothing stored for this section" rather
// than throwing on a page whose whole job is to work when nothing else does.
export function parseSnapshot(value: unknown): AnySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.version !== SNAPSHOT_VERSION) return null;
  if (!isKind(o.kind)) return null;
  if (typeof o.profileId !== "number" || !Number.isFinite(o.profileId)) {
    return null;
  }
  if (typeof o.timeZone !== "string" || o.timeZone.length === 0) return null;
  if (typeof o.capturedOn !== "string" || o.capturedOn.length === 0) return null;
  if (typeof o.fetchedAt !== "string" || o.fetchedAt.length === 0) return null;
  if (!o.data || typeof o.data !== "object") return null;
  return o as unknown as AnySnapshot;
}

// ── Profile scoping ──────────────────────────────────────────────────────────

// Keep only the snapshots captured under `profileId`. The caller with a session uses
// this; the session-free /offline page uses `resolveSnapshotProfile` below.
export function snapshotsForProfile<T extends { profileId: number }>(
  stored: readonly T[],
  profileId: number
): T[] {
  return stored.filter((s) => s.profileId === profileId);
}

// The ONE profile every stored snapshot belongs to, or null when they disagree.
//
// The offline page is SINGLE-PROFILE BY CONSTRUCTION: it renders the profile that was
// active at capture, and never a picker — there is no session there to authorize a
// choice between two. A mixed store is therefore not a rendering problem to solve but
// an invariant that has been broken (a wipe that did not run), so the honest answer is
// null and the honest response is to render nothing and wipe. Never "pick the newest".
export function resolveSnapshotProfile(
  stored: readonly { profileId: number }[]
): number | null {
  if (stored.length === 0) return null;
  const first = stored[0].profileId;
  return stored.every((s) => s.profileId === first) ? first : null;
}

// ── Staleness ────────────────────────────────────────────────────────────────

// The profile-local day it is NOW, judged in the SNAPSHOT'S OWN timezone. This is the
// instant/profile-local-day distinction the whole feature turns on.
export function snapshotNowDay(env: SnapshotEnvelope, now: Date): string {
  return dateStrInTz(env.timeZone, now);
}

// Whether a stored snapshot is past its clock.
//
// A `profile-day` payload is stale the moment the profile's own day rolls over — not
// after N hours, and not when the device's day rolls over. A `rolling-window` payload
// is judged by lib/freshness.ts's ONE decision (`age > interval`), in the shared
// vocabulary rather than a second inline comparison.
export function isSnapshotStale(env: SnapshotEnvelope, now: Date): boolean {
  const decl = SNAPSHOT_REGISTRY[env.kind];
  const todayLocal = snapshotNowDay(env, now);
  if (decl.scope === "profile-day") return env.capturedOn !== todayLocal;
  return (
    freshnessState(
      freshnessAgeDays(env.capturedOn, todayLocal),
      decl.staleAfterDays
    ) === "due"
  );
}

// How old the snapshot is in whole profile-local days — the number the "as of" line
// turns into copy. Null when either day is unreadable.
export function snapshotAgeDays(
  env: SnapshotEnvelope,
  now: Date
): number | null {
  return daysBetweenDateStr(env.capturedOn, snapshotNowDay(env, now));
}

// The kinds an authenticated visit should re-fetch: everything enabled that is absent
// or past its clock. Refresh RIDES authenticated traffic — there is no background sync
// and no service-worker credential — so this runs at a mount, answers cheaply, and
// asks for nothing when everything is current.
export function snapshotsToRefresh(
  stored: readonly SnapshotEnvelope[],
  profileId: number,
  now: Date
): SnapshotKind[] {
  const held = new Map(
    stored
      .filter((s) => s.profileId === profileId)
      .map((s) => [s.kind, s] as const)
  );
  return SNAPSHOT_KINDS.filter((kind) => {
    const env = held.get(kind);
    return !env || isSnapshotStale(env, now);
  });
}

// ── The overlay: folding queued writes into a stored read ────────────────────
//
// The strangest gap #2908 names is read-your-writes: the queue KNOWS a dose was tapped
// offline, and no offline surface showed it. These fold the pending intents into the
// payload at RENDER time. They never mutate the queue and they never touch the live
// pages — the overlay exists only where a snapshot renders.
//
// PROFILE SCOPING APPLIES HERE TOO, and it is easy to miss: an intent carries its own
// captured profile (#599), and folding another profile's queued dose into this
// profile's schedule would leak across exactly the boundary the wipe defends. A legacy
// intent with no `profileId` predates the stamp and has no other possible attribution,
// so it folds in — the same fallback the replay route takes.

export function intentBelongsToProfile(
  intent: QueuedIntent,
  profileId: number
): boolean {
  return intent.profileId == null || intent.profileId === profileId;
}

function relevantIntents(
  intents: readonly QueuedIntent[],
  profileId: number,
  flows: readonly FlowKind[]
): QueuedIntent[] {
  return intents.filter(
    (i) => intentBelongsToProfile(i, profileId) && flows.includes(i.flow)
  );
}

export function overlayDoseSchedule(
  data: DoseScheduleData,
  intents: readonly QueuedIntent[],
  profileId: number
): DoseScheduleData {
  const queued = new Map<number, DoseStatus>();
  for (const intent of relevantIntents(intents, profileId, [
    "dose",
    "skip-dose",
  ])) {
    // The day matters: a dose tapped yesterday and still queued is not a resolution of
    // today's row. The intent's `date` is the client's captured local date, which is
    // the same day vocabulary the snapshot's `date` is in.
    if (intent.date !== data.date) continue;
    const doseId = (intent.payload as DosePayload).doseId;
    if (typeof doseId !== "number") continue;
    queued.set(doseId, intent.flow === "dose" ? "taken" : "skipped");
  }
  if (queued.size === 0) return data;
  return {
    ...data,
    entries: data.entries.map((e) => {
      const q = queued.get(e.doseId);
      // A resolution the SERVER already recorded wins: it is the fact, and the queued
      // tap will replay onto it as a no-op (the set-to semantics in lib/offline/queue).
      if (!q || e.status !== "pending") return e;
      return { ...e, status: q, queued: true };
    }),
  };
}

export function overlayFoodTallies(
  data: FoodTalliesData,
  intents: readonly QueuedIntent[],
  profileId: number
): FoodTalliesData {
  const servings = new Map<string, number>();
  let protein = 0;
  for (const intent of relevantIntents(intents, profileId, ["food"])) {
    if (intent.date !== data.date) continue;
    const p = intent.payload as FoodPayload;
    if (p.entry === "serving" && p.groupKey) {
      servings.set(p.groupKey, (servings.get(p.groupKey) ?? 0) + 1);
    } else if (p.entry === "protein" && typeof p.grams === "number") {
      protein += p.grams;
    }
  }
  if (servings.size === 0 && protein === 0) return data;
  const groups = data.groups.map((g) => {
    const q = servings.get(g.key);
    if (!q) return g;
    servings.delete(g.key);
    return { ...g, servings: g.servings + q, queued: q };
  });
  // A group tapped offline that has NOTHING logged today has no row to raise, and
  // dropping it would mean the tally silently omits the very tap the user just made.
  for (const [key, q] of servings) {
    groups.push({ key, label: key, servings: q, queued: q });
  }
  return {
    ...data,
    groups,
    proteinGrams:
      protein > 0 ? (data.proteinGrams ?? 0) + protein : data.proteinGrams,
    ...(protein > 0 ? { queuedProteinGrams: protein } : {}),
  };
}

export function overlayRecentTraining(
  data: RecentTrainingData,
  intents: readonly QueuedIntent[],
  profileId: number
): RecentTrainingData {
  const queued = relevantIntents(intents, profileId, ["set"]);
  if (queued.length === 0) return data;
  // Newest first, matching the stored spine's own order.
  const lines: RecentActivityLine[] = queued
    .slice()
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .map((intent) => {
      const fields = (intent.payload as { fields?: Record<string, string> })
        .fields;
      return {
        date: intent.date,
        title: fields?.title?.trim() || "Workout",
        detail: fields?.activity_type?.trim() || null,
        queued: true as const,
      };
    });
  return { ...data, activities: [...lines, ...data.activities] };
}

export function overlayPracticeWeek(
  data: PracticeWeekData,
  intents: readonly QueuedIntent[],
  profileId: number
): PracticeWeekData {
  const queued = new Map<string, number>();
  for (const intent of relevantIntents(intents, profileId, ["practice"])) {
    const identity = (intent.payload as { identity?: string }).identity;
    if (!identity) continue;
    queued.set(identity, (queued.get(identity) ?? 0) + 1);
  }
  if (queued.size === 0) return data;
  return {
    ...data,
    practices: data.practices.map((p) => {
      const q = queued.get(p.identity);
      if (!q) return p;
      // The queued practice intent is DAY-IDEMPOTENT (owner decision 3): replay inserts
      // only if that (practice, day) holds no session, so two taps are one day either
      // way. The overlay tells the same truth the replay will — never "+2".
      const addsToday = p.todayCount > 0 ? 0 : 1;
      return {
        ...p,
        todayCount: p.todayCount + addsToday,
        countThisWeek: p.countThisWeek + addsToday,
        queued: q,
      };
    }),
  };
}

// Fold the queue into whichever payload this is. Total over the union, so a sixth kind
// cannot silently render un-overlaid.
export function overlaySnapshot(
  env: AnySnapshot,
  intents: readonly QueuedIntent[]
): AnySnapshot {
  switch (env.kind) {
    case "dose-schedule":
      return {
        ...env,
        data: overlayDoseSchedule(env.data, intents, env.profileId),
      };
    case "food-tallies":
      return {
        ...env,
        data: overlayFoodTallies(env.data, intents, env.profileId),
      };
    case "recent-training":
      return {
        ...env,
        data: overlayRecentTraining(env.data, intents, env.profileId),
      };
    case "practice-week":
      return {
        ...env,
        data: overlayPracticeWeek(env.data, intents, env.profileId),
      };
    case "medication-list":
      // Declared `overlays: []` — nothing the queue captures changes the list.
      return env;
  }
}
