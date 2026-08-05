// Pure cadence/dedup decision for the OVERDUE-follow-up push (issue #1866), the
// refill-nudge planner shape applied to the #700 chain. The DB gather + send lives in
// lib/notifications/followup.ts; this file only DECIDES, given the currently-overdue
// follow-up ids, each one's already-sent dates, and the ids whose finding is
// currently snoozed, which follow-ups to nudge now and which stale markers to clear.
//
// THE CADENCE IS THE CONTRACT (owner ruling, #1866): deliberately conservative —
//   1. ONE send when the follow-up crosses overdue;
//   2. ONE repeat FOLLOWUP_REPEAT_DAYS later, framed as final;
//   3. then NOTHING further, ever — the finding keeps holding the calm surfaces
//      (Upcoming + the non-hideable hero), which never age out.
// The marker (notify_last_followup_<carePlanItemId>, profile_settings) stores the
// send DATES, comma-joined, so the whole cadence state is one value and the repeat
// spacing is data, not a second marker. Ids are care_plan_items AUTOINCREMENT ids —
// never recycled (#203) — so a marker can never attach to a different follow-up.
//
// TERMINATION + self-healing (#325): the marked set the notifier feeds in is the
// FULL set of live markers, so a marker whose follow-up has left the overdue set —
// settled via the #1866 terminator, resolved against a later record, deleted, or
// re-dated into the future — is swept. A settled/resolved follow-up can never
// re-enter the overdue set (the builder excludes closed chain nodes), so the sweep
// can never resurrect a terminated escalation; a follow-up whose planned date was
// pushed FORWARD and later crosses overdue again starts a fresh two-send cadence,
// which is correct — a new tracked due date is a new consent (the issue's own rule).
//
// SUPPRESSION FREEZE (#227): a follow-up whose finding is currently hidden under its
// own "snooze-only" policy (a live time-boxed snooze — a dismiss is RESISTED and
// never reaches this planner) is held out of `toSend` with its marker untouched, so
// the cadence resumes exactly where it stood when the snooze expires.

import { planNudgeCadence } from "./nudge-cadence";

export const FOLLOWUP_NUDGE_MARKER_PREFIX = "notify_last_followup_";

// Weeks, not days (owner ruling: "one repeat weeks later"). Three weeks keeps the
// repeat clearly a second event, not a drumbeat.
export const FOLLOWUP_REPEAT_DAYS = 21;

// How many sends a follow-up ever gets (the crossing + one repeat).
export const FOLLOWUP_MAX_SENDS = 2;

export function followUpNudgeMarkerKey(carePlanItemId: number): string {
  return `${FOLLOWUP_NUDGE_MARKER_PREFIX}${carePlanItemId}`;
}

// The care_plan_items id a live marker key names, or NaN for a foreign key shape.
export function followUpIdFromMarker(key: string): number {
  return Number(key.slice(FOLLOWUP_NUDGE_MARKER_PREFIX.length));
}

// The marker VALUE ⇄ the dates already sent. Stored comma-joined
// ("2026-08-01,2026-08-22"); parse tolerates an empty/absent value.
export function parseFollowUpMarker(
  value: string | null | undefined
): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

export function serializeFollowUpMarker(dates: readonly string[]): string {
  return dates.join(",");
}

// One currently-OVERDUE follow-up, as gathered by the notifier.
export interface FollowUpNudgeCandidate {
  id: number; // care_plan_items id (the dedupeKey's own suffix)
  sentDates: readonly string[]; // parsed marker value — the dates already sent
}

export type FollowUpNudgeStage = "first" | "repeat";

export interface FollowUpNudgePlan {
  // Follow-ups to nudge now, each with which cadence stage this send is — the
  // notifier renders "repeat" as the stated-final reminder and appends the send date
  // to the marker on a successful delivery.
  toSend: { id: number; stage: FollowUpNudgeStage }[];
  // Marker ids to delete: their follow-up is no longer overdue (terminated, resolved,
  // deleted, or re-dated), so the cadence state is stale.
  toClear: number[];
}

// Decide the plan. Pure. `markedIds` is the FULL live-marker id set (self-healing
// sweep, #325); `suppressedIds` are candidates currently hidden by a live snooze —
// frozen: neither sent nor cleared.
//
// Since #2036 this is the shared planNudgeCadence decision (lib/nudge-cadence.ts) with
// the ONE cadence policy that is not once-per-episode: `maxSends: 2` with a repeat
// spaced `repeatDays` off the FIRST send. That policy IS the #1866 owner ruling, and it
// is the reason the engine carries a stage and a date at all — the other four planners
// are the same engine with `maxSends: 1`. Everything else here is follow-up vocabulary:
// the comma-joined marker value, the care_plan_items id space, the numeric ordering.
export function planFollowUpNudges(
  candidates: readonly FollowUpNudgeCandidate[],
  markedIds: Iterable<number>,
  suppressedIds: Iterable<number>,
  today: string,
  repeatDays: number = FOLLOWUP_REPEAT_DAYS
): FollowUpNudgePlan {
  const plan = planNudgeCadence<number, null>({
    // The caller passes exactly the currently-OVERDUE set, so every candidate is live;
    // a follow-up that settled, resolved or was re-dated is simply absent, and its
    // marker reaches the sweep through `markedIds`.
    candidates: candidates.map((c) => ({
      key: c.id,
      item: null,
      actionable: true,
      sends: c.sentDates.length,
      firstSentDate: c.sentDates[0] ?? null,
    })),
    marked: markedIds,
    frozen: suppressedIds,
    today,
    // An absent follow-up carries no live finding, so suppression cannot freeze its
    // clear — the same posture the refill nudge states.
    policy: {
      maxSends: FOLLOWUP_MAX_SENDS,
      repeatDays,
      frozenBlocksClear: false,
    },
  });
  return {
    toSend: plan.toSend.map((s) => ({ id: s.key, stage: s.stage })),
    toClear: plan.toClear.sort((a, b) => a - b),
  };
}
