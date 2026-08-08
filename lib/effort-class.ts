// SESSION EFFORT CLASS and the workout-nudge deferral it drives (issue #1672). Pure —
// no DB, no clock — so the whole decision is unit-testable and every consumer reads ONE
// classification (#221).
//
// THE PROBLEM. Two weekly targets behind; a morning session credited one; the evening
// workout reminder pushed the other — with no mention of the morning session. Two sins:
// it reads as "the app didn't notice my workout", and it implicitly prescribes a
// same-day double session with no urgency test.
//
// Why the existing gates don't cover it: the presence gate is deliberately
// window-scoped (#921/#981 — a finish quiets only the attempt inside the post-finish
// window), and target crediting quiets only the credited scope's contribution. Nothing
// evaluated DAY-LEVEL trained state against WEEK PACE.
//
// THE CUT IS EFFORT CLASS, NOT TARGET CREDIT (owner-decided, resolving the #921
// tension):
//
//   • TRAINING class — strength, cardio runs/rides/swims, sport sessions. A completed
//     one marks the day trained and defers OTHER training-class nudges when pace
//     allows ("I'm not doing a second strength session this afternoon"), including
//     cross-modality (a morning lift defers an evening run nudge when the run target
//     is still feasible without today).
//   • INCIDENTAL/RECOVERY class — walks, mobility/stretching work. NEVER marks the day
//     trained, so a credited dog walk still doesn't quiet the day's lift reminder —
//     #921's pinned line, upheld verbatim from this side too. Symmetrically,
//     incidental-scope TARGETS are never deferred: a "walk 5×/week" nudge after a
//     morning lift may still fire, because a walk is compatible with a completed
//     workout, not a double session.
//
// Net matrix: training session ⇒ defers training nudges (pace permitting), leaves
// incidental nudges alone. Incidental session ⇒ defers nothing. Pace-tight overrides
// deferral in all cases, with the acknowledgment line mandatory.
//
// DOCTRINE. This is a pure contact REDUCTION decided from existing data — consistent
// with the #1505 attention doctrine (the system may always reduce contact unilaterally;
// the acknowledgment adds no send, it improves one that fires anyway).

import type { ActivityType } from "./types";

export type EffortClass = "training" | "incidental";

// Name fragments that mark an INCIDENTAL session regardless of its stored type. This is
// the membership list to argue about in review; everything not matched is training.
// Deliberately narrow: a walk and a stretch are the cases where a second session is
// clearly still reasonable. (Rucking is a loaded carry — training, not a walk.)
const INCIDENTAL_KEYWORDS = [
  "walk",
  "stroll",
  "dog walk",
  "stretch",
  "mobility",
  "foam roll",
];

function matchesIncidental(name: string): boolean {
  const t = name.trim().toLowerCase();
  if (!t) return false;
  return INCIDENTAL_KEYWORDS.some((k) => t.includes(k));
}

// Which types settle their effort class BY TYPE ALONE, declared per type (#2272).
// `null` means "the NAME decides" — a walk is stored as cardio, and classifying on
// type alone would let a dog walk mark the day trained, exactly the #921 line this
// must uphold.
const TYPE_EFFORT_CLASS: Record<ActivityType, EffortClass | null> = {
  strength: null,
  cardio: null,
  sport: null,
  // That is what the type MEANS (#840).
  recovery: "incidental",
  // The source did not say (#2272). "Unspecified" is not "light": a provider that
  // declined to name a session still recorded a session, so it falls through to the
  // name keywords like every other performance-tier type. Deciding otherwise would
  // let a real gym hour stop counting as training because of a missing label.
  unclassified: null,
};

// The effort class of one session: settled by TYPE where the type itself answers
// (see above), otherwise by the activity NAME.
export function effortClass(
  type: ActivityType | string | null | undefined,
  name: string | null | undefined
): EffortClass {
  const byType = type ? TYPE_EFFORT_CLASS[type as ActivityType] : null;
  if (byType) return byType;
  return matchesIncidental(name ?? "") ? "incidental" : "training";
}

// The effort class of a weekly TARGET's scope, so an incidental-scope target ("walk
// 5×/week") is never deferred. A target names a scope, not a session, so the same
// keyword membership is applied to its scope value.
export function targetScopeEffortClass(
  scopeKind: string,
  scopeValue: string
): EffortClass {
  if (scopeKind === "type" && scopeValue.trim().toLowerCase() === "recovery") {
    return "incidental";
  }
  return matchesIncidental(scopeValue) ? "incidental" : "training";
}

// ---- The deferral decision ----

// A behind weekly target as the decision reads it. `daysLeftInWindow` is the number of
// ON-DAYS remaining in the profile's week window AFTER today — the feasibility
// denominator, carried from the same rollup that computes pace (#221, no second
// engine).
export interface BehindTargetPace {
  scopeKind: string;
  scopeValue: string;
  label: string;
  count: number;
  perWeek: number;
  daysLeftInWindow: number;
}

// A target is still reachable WITHOUT training today when the sessions it still owes
// fit in the days that remain after today.
export function reachableWithoutToday(t: BehindTargetPace): boolean {
  return Math.max(0, t.perWeek - t.count) <= Math.max(0, t.daysLeftInWindow);
}

export interface WorkoutDeferralInput {
  // The completed TRAINING-class session logged today, if any (its display name is what
  // the acknowledgment names). Null when the day is untrained or only saw incidental
  // activity.
  trainedToday: string | null;
  // Every behind weekly target still in play.
  behind: readonly BehindTargetPace[];
}

export type WorkoutDeferral =
  // Send nothing, and leave the day's marker UNSET so tomorrow evaluates fresh — the
  // marker-neutral posture the existing presence holds already use.
  | { kind: "hold" }
  // Send. `acknowledge` is present exactly when we are firing on a trained day, and
  // carries what the message must open with.
  | {
      kind: "fire";
      acknowledge: {
        session: string;
        // The target whose pace forced the send, when one did (null when the send is
        // driven by an incidental-scope target, which is never deferred).
        forcedBy: BehindTargetPace | null;
      } | null;
    };

export function workoutDeferralDecision(
  input: WorkoutDeferralInput
): WorkoutDeferral {
  // An untrained day (or a day that only saw a walk) behaves exactly as before.
  if (!input.trainedToday) return { kind: "fire", acknowledge: null };

  const incidental = input.behind.filter(
    (t) => targetScopeEffortClass(t.scopeKind, t.scopeValue) === "incidental"
  );
  const training = input.behind.filter(
    (t) => targetScopeEffortClass(t.scopeKind, t.scopeValue) === "training"
  );

  // Pace-tight overrides deferral: a target that can no longer be met without a session
  // today is the urgency test the old design lacked.
  const forced = training.find((t) => !reachableWithoutToday(t)) ?? null;

  // Nothing behind at all ⇒ there is no workout being PUSHED, so there is nothing to
  // defer: the message (if any) is a rest-day or on-track reframe, and those are calm
  // notes rather than a prescription for a second session. Their behavior is unchanged.
  if (training.length === 0 && incidental.length === 0) {
    return { kind: "fire", acknowledge: null };
  }

  // Nothing forcing the issue and no incidental-scope target to nudge about ⇒ HOLD.
  if (!forced && incidental.length === 0) return { kind: "hold" };

  return {
    kind: "fire",
    acknowledge: { session: input.trainedToday, forcedBy: forced },
  };
}

// ---- The days-left phrase (issue #1822 item 1) ----

// How much of the week window is left, stated the way a reader hears it. `daysLeft`
// counts the on-days remaining AFTER today, so 0 does NOT mean "the week is over" — it
// means today is the last chance, which is precisely when the nudge matters most.
//
// WHY IT LIVES HERE. Two formatters state the same pace fact: this file's
// `workoutAcknowledgmentLine` and `recoveryOverrideLine` in ./workout-recommendation
// (which already imports this module, so the phrase can be shared without a cycle).
// The acknowledgment used to render the raw count — "Chest is 1/2 with 0 days left",
// which reads as a closed door — while the recovery line already phrased the same edge
// today-inclusively. One pace fact answered two ways is exactly the drift "one question,
// one computation" (#221) exists to prevent, so the phrase is computed once and both
// call it: the edge cannot re-diverge.
export function daysLeftPhrase(daysLeft: number): string {
  const after = Math.max(0, daysLeft);
  if (after === 0) return "only today left";
  return `today and ${after} ${after === 1 ? "day" : "days"} left`;
}

// ---- Generic session titles (issue #1822 item 2) ----

// Session names that describe nothing beyond "I did a workout". Praising one of these
// produces "Nice workout today" — a compliment with no content, which reads as filler
// rather than as the app having noticed anything. The list is deliberately the exact
// whole-string matches: "chest workout" is specific and keeps its praise; a bare
// "Workout" does not.
const GENERIC_SESSION_TITLES = new Set([
  "workout",
  "workouts",
  "training",
  "training session",
  "session",
  "exercise",
  "exercise session",
  "gym",
  "gym session",
  "activity",
  "strength session",
  "workout session",
]);

// Whether a session title says nothing about WHAT was trained. Whole-string, on the
// trimmed lowercase form — a substring test would swallow "chest workout".
export function isGenericSessionTitle(name: string): boolean {
  const t = name.trim().toLowerCase();
  return t === "" || GENERIC_SESSION_TITLES.has(t);
}

// The acknowledgment line: what they did, then the pace fact that justifies pushing
// anyway. Silent about pace when nothing forced the send (an incidental-scope nudge
// after a lift needs no justification — the two are compatible).
//
// Tone note: this is the message OPENING on a day the person already trained, so it
// leads with the session, never with the shortfall (#1672). That goal survives BOTH
// openings: a named session earns the praise, a generic title degrades to a plain
// acknowledgment ("Trained today") rather than a hollow "Nice workout today" — the
// message still opens with what they did, it just stops complimenting a placeholder.
export function workoutAcknowledgmentLine(
  ack: { session: string; forcedBy: BehindTargetPace | null } | null
): string | null {
  if (!ack) return null;
  const session = ack.session.trim().toLowerCase();
  const did = isGenericSessionTitle(session)
    ? "Trained today"
    : `Nice ${session} today`;
  if (!ack.forcedBy) return `${did}.`;
  const t = ack.forcedBy;
  return `${did} — ${t.label} is ${t.count}/${t.perWeek} with ${daysLeftPhrase(
    t.daysLeftInWindow
  )}.`;
}
