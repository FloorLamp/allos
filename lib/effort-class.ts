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

// The effort class of one session. `recovery` is incidental BY TYPE (that is what the
// type means); otherwise the activity NAME decides, because a walk is stored as cardio
// and classifying on type alone would let a dog walk mark the day trained — exactly the
// #921 line this must uphold.
export function effortClass(
  type: ActivityType | string | null | undefined,
  name: string | null | undefined
): EffortClass {
  if (type === "recovery") return "incidental";
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

// The acknowledgment line: what they did, then the pace fact that justifies pushing
// anyway. Silent about pace when nothing forced the send (an incidental-scope nudge
// after a lift needs no justification — the two are compatible).
//
// Tone note: this is the message OPENING on a day the person already trained, so it
// leads with the session, never with the shortfall.
export function workoutAcknowledgmentLine(
  ack: { session: string; forcedBy: BehindTargetPace | null } | null
): string | null {
  if (!ack) return null;
  const did = `Nice ${ack.session.trim().toLowerCase()} today`;
  if (!ack.forcedBy) return `${did}.`;
  const t = ack.forcedBy;
  const days = Math.max(0, t.daysLeftInWindow);
  const dayWord = days === 1 ? "day" : "days";
  return `${did} — ${t.label} is ${t.count}/${t.perWeek} with ${days} ${dayWord} left.`;
}
