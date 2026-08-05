// THE nudge cadence decision (issue #2036 §3) — one answer to "given what has already
// been sent, what is live, and what the user has silenced, which nudges go out now and
// which stale markers get swept?".
//
// Four planners had converged on that question independently:
//
//   • planRefillNudges       (lib/refill-nudge.ts, also the pooled twin)  — #227/#325
//   • planPreventiveNudges   (lib/preventive-nudge.ts)                    — #87/#183/#227
//   • planIllnessCareNudges  (lib/illness-care.ts; the temp-red-flag nudge shares it)
//   • planFollowUpNudges     (lib/followup-nudge.ts)                      — #1866
//
// Each of their headers says it "mirrors" one of the others, and each re-derived the
// same three rules by hand. This is that computation, once — the same extraction
// lib/notifications/pointer-rotation.ts (#1945) performed on the food nudge's live
// keyboard decision, in the same shape: PURE, one small decision, the domain planners
// kept as thin adapters that own their vocabulary and their outcome types.
//
// THE THREE RULES
//
//   1. SEND when the condition is live for a candidate, its cadence is not spent, and
//      it is not frozen.
//   2. FREEZE — never send, never clear — for a candidate the user has silenced or the
//      domain has covered. The episode marker stays exactly as it stood so that
//      un-dismissing (or a snooze expiring, or a booked visit being cancelled) resumes
//      the lifecycle rather than restarting it. This is #227's "dismiss once, silence
//      everywhere" and #183's booked-visit coverage, which are the same mechanism.
//   3. SWEEP a marker whose subject is no longer live. `marked` is the FULL live-marker
//      key set, not just the keys among `candidates`, which is what makes the sweep
//      SELF-HEALING (#325): a marker whose subject left by a route nobody enumerated —
//      paused, untracked, deleted, satisfied, re-dated — is still swept.
//
// WHAT STAYS AT THE CALL SITES: everything domain-specific. The gather, the message,
// the suppression-bus lookup, the outcome shape, and — critically — the fact that a
// nudge's `dedupeKey` is the identical key its visible Upcoming finding carries. None
// of that moves; this decides cadence and nothing else.
//
// SAFETY STANDING IS UNCHANGED. Dose reminders and missed-dose escalations do not route
// through here and never did: they are safety signals that an Upcoming dismissal may
// never silence (AGENTS.md), and the four planners above are all care/coaching-tier
// episode nudges. Registering a marker or sharing a planner is bookkeeping; it moves no
// policy.

import { shiftDateStr } from "./date";

/** Which send in a candidate's cadence this one is. */
export type NudgeStage = "first" | "repeat";

/**
 * One subject the planner is deciding about, in the shared vocabulary.
 *
 * `K` is the marker key's identity — a row id, a catalog rule key, a finding dedupeKey.
 * `T` is whatever the domain needs to carry through to its message, untouched here.
 */
export interface NudgeCandidate<K, T> {
  key: K;
  item: T;
  /**
   * Is the condition live for this candidate RIGHT NOW? A tracked item that is no
   * longer low, a rule that has been satisfied, a finding whose episode closed — all
   * `false`, which is what puts their markers in the sweep.
   */
  actionable: boolean;
  /**
   * How many sends this candidate has already had. For a once-per-episode nudge this is
   * "is it marked" as 0 or 1; for a repeat cadence it is the marker's send count.
   */
  sends: number;
  /**
   * The date of the FIRST send, when the marker records one — the anchor a repeat is
   * spaced from. Null for a once-per-episode nudge, whose marker records a date but
   * never has to space anything off it.
   */
  firstSentDate: string | null;
}

export interface NudgeCadencePolicy {
  /** How many sends a candidate ever gets. 1 = once per episode. */
  maxSends: number;
  /** Days between the first send and the repeat. Only read when `maxSends > 1`. */
  repeatDays?: number;
  /**
   * Does a frozen key also block its marker being SWEPT?
   *
   * `true` for the preventive/illness-care family: a rule can be frozen by a booked
   * visit while it is simultaneously no longer in the actionable slice, and clearing
   * there would age the marker out so a later un-cover re-nudges the SAME episode
   * (#183's explicit finding).
   *
   * `false` for refill and follow-up, and for the same stated reason in both: a subject
   * that is not live carries no visible finding, so there is nothing for the user to
   * have dismissed — a frozen-and-not-live key means the freeze is itself stale, and
   * sweeping it is the self-healing behaviour, not a lost silence.
   */
  frozenBlocksClear: boolean;
}

export interface NudgeCadenceInput<K, T> {
  candidates: readonly NudgeCandidate<K, T>[];
  /** The FULL live-marker key set (#325), never just the candidates' keys. */
  marked: Iterable<K>;
  /** Keys the user silenced or the domain covered. */
  frozen?: Iterable<K>;
  /** The subject's local date. Only read by a repeat cadence. */
  today?: string;
  policy: NudgeCadencePolicy;
}

export interface NudgeCadencePlan<K, T> {
  toSend: { key: K; item: T; stage: NudgeStage }[];
  /**
   * Marker keys to delete, in `marked` iteration order. Deliberately UNSORTED: delete
   * order is irrelevant, and each adapter applies the ordering its own tests pin
   * (numeric for id keys, lexical for string keys).
   */
  toClear: K[];
}

/**
 * Decide the plan. Pure — no DB, no clock, no I/O. Every input the decision needs is an
 * argument, including the date, so a caller's timezone stays the caller's business.
 */
export function planNudgeCadence<K, T>({
  candidates,
  marked,
  frozen = [],
  today,
  policy,
}: NudgeCadenceInput<K, T>): NudgeCadencePlan<K, T> {
  const markedSet = new Set(marked);
  const frozenSet = new Set(frozen);
  const liveKeys = new Set(
    candidates.filter((c) => c.actionable).map((c) => c.key)
  );

  const toSend: NudgeCadencePlan<K, T>["toSend"] = [];
  for (const c of candidates) {
    // Rule 2 — frozen: no send, and (per policy) no clear either.
    if (frozenSet.has(c.key)) continue;
    if (!c.actionable) continue;
    // Rule 1 — send, at the stage the cadence is up to.
    if (c.sends === 0) {
      toSend.push({ key: c.key, item: c.item, stage: "first" });
      continue;
    }
    if (c.sends >= policy.maxSends) continue; // the cadence is spent; silence
    // A repeat is spaced off the FIRST send. A marker with no recorded date cannot
    // answer "is it time yet", so it stays silent rather than guessing — which is the
    // conservative direction for a nudge nobody asked to be reminded twice about.
    if (c.firstSentDate == null || today == null) continue;
    if (shiftDateStr(c.firstSentDate, policy.repeatDays ?? 0) <= today)
      toSend.push({ key: c.key, item: c.item, stage: "repeat" });
  }

  // Rule 3 — the self-healing sweep.
  const toClear = [...markedSet].filter(
    (k) => !liveKeys.has(k) && !(policy.frozenBlocksClear && frozenSet.has(k))
  );

  return { toSend, toClear };
}

/**
 * The cadence four of the five domains share: ONE send per episode, and the marker is
 * cleared the moment the episode ends so the NEXT one can fire.
 */
export const ONCE_PER_EPISODE: NudgeCadencePolicy = {
  maxSends: 1,
  frozenBlocksClear: false,
};

/**
 * The same single send, but a frozen key keeps its marker even when it has dropped out
 * of the live set — the preventive/illness-care coverage rule (#183).
 */
export const ONCE_PER_EPISODE_FROZEN_KEEPS: NudgeCadencePolicy = {
  maxSends: 1,
  frozenBlocksClear: true,
};
