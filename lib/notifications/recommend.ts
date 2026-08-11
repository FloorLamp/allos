// "What should I train today" for the Telegram workout reminder — now a thin
// FORMATTER over the unified next-workout core (#221) rather than a second engine.
// It gathers the same coaching input the dashboard/overview use, runs the shared
// `recommendNextWorkout` (bounded window, recovery exclusion, weekday habit,
// behind-target composition, frequency-ranked exercise list) for the focus +
// exercises, and consults the full coaching engine for rest/on-track awareness so
// the reminder can reframe on a recovery day. Deterministic, no API. All day
// boundaries follow the configured app timezone (via gatherCoachingInput).

import { now as clockNow } from "../clock";
import { illnessCoachingMode, recommendCoaching } from "../coaching";
import {
  orderBehindTargets,
  recommendNextWorkout,
  recoveryOverrideLine,
} from "../workout-recommendation";
import { parkedDisclosureLines } from "../weather-training";
import { exerciseSessionCount } from "../exercise-familiarity";
import { isWorkoutNudgeSuppressed } from "../workout-nudge";
import { workoutPresenceGate } from "../workout-presence-gate";
import { gatherCoachingInput, getActivitiesByDate } from "../queries";
import { frequencyScopeLabel } from "../frequency-targets";
import {
  effortClass,
  workoutDeferralDecision,
  type BehindTargetPace,
} from "../effort-class";
import {
  getWorkoutPresence,
  getFinishedActivityCredit,
} from "../queries/presence";
import { getFindingSuppressions } from "../queries/upcoming";
import type { CoachingInput } from "../coaching";
import type { WorkoutRecommendation } from "./workout-format";

export type { WorkoutRecommendation };

// `gathered` (#447): the notify tick already runs the full coaching gather once per
// profile per tick for the rest-episode reconcile; passing it here lets the workout
// slot reuse that single scan instead of repeating the heaviest per-profile read.
// Omitted (the request-time/manual callers) ⇒ gather fresh.
export function recommendWorkout(
  profileId: number,
  gathered?: CoachingInput,
  now: Date = clockNow()
): WorkoutRecommendation | null {
  // One gather, one core — the dashboard, the overview, and this reminder all
  // read the same computation, so they can't drift.
  const input = gathered ?? gatherCoachingInput(profileId, "kg", "km");

  // Situation-aware hold (issue #837): the workout-reminder slot goes QUIET during an
  // open flagged-illness episode and through the post-close ease-back ramp — a fever
  // week needs no "time to train" ping. Returning null holds it out of BOTH the send
  // and the daily `notify_last_workout` marker, so the normal lifecycle resumes when
  // the ramp ends. The one-shot ease-back nudge is a separate slot (runEaseBack).
  if (illnessCoachingMode(input.illness, input.today).mode !== "normal")
    return null;

  // Presence gates (issue #981), the #921 declined-suppression revisit. Both read the
  // ONE derived workout presence (never a second derivation, #221) + the tracked target
  // scopes this reminder already reasons over, and both are MARKER-NEUTRAL — returning
  // null holds the slot out of the send AND the daily `notify_last_workout` marker:
  //   • active ⇒ HOLD — a live session is running; a "time to train" ping mid-workout is
  //     absurd (and its rest line would read "you're training now"). A discarded false
  //     start doesn't consume the day; the next scheduled attempt evaluates fresh.
  //   • a credit-bearing finish inside the finished window ⇒ SKIP this attempt — the
  //     finish/recap message (#921/#924) owns that moment. Strictly window-scoped, so a
  //     dog walk crediting a "walk 5×/week" habit quiets only THIS attempt, never the
  //     day's lift reminder; a finish crediting nothing tracked still fires.
  const presence = getWorkoutPresence(profileId, now);
  const finishCredit =
    presence.state === "finished" && presence.activityId != null
      ? getFinishedActivityCredit(profileId, presence.activityId)
      : null;
  const gate = workoutPresenceGate(
    presence,
    finishCredit,
    input.routine.map((t) => t.target)
  );
  if (gate !== "fire") return null;

  const nw = recommendNextWorkout(input);

  // Route through the shared findings-suppression bus (#227/#245): the nudge is
  // driven by the profile's behind (unmet) weekly targets, each surfaced on Upcoming
  // as a `training:<id>` finding via the SAME trainingSignalKey. When every one is
  // dismissed/snoozed there, return null — holding the recommendation out of BOTH the
  // send AND the daily `notify_last_workout` slot marker (the tick only marks the slot
  // on a delivered message), so un-dismissing resumes the normal lifecycle.
  const suppressions = getFindingSuppressions(profileId);
  if (
    isWorkoutNudgeSuppressed(
      nw.behind.map((t) => t.id),
      suppressions,
      input.today
    )
  )
    return null;

  // SAME-DAY DEFERRAL + ACKNOWLEDGMENT (#1672). The presence gates above are
  // window-scoped by design (#921/#981 — a finish quiets only the attempt inside the
  // post-finish window); nothing evaluated DAY-LEVEL trained state against WEEK PACE.
  // So: a completed TRAINING-class session today marks the day trained, and while every
  // remaining behind training-class target is still reachable without today, the nudge
  // HOLDS — marker-neutral (returning null keeps notify_last_workout unset, so
  // tomorrow's attempt evaluates fresh). Pace-tight overrides the hold, and the message
  // then opens with what they already did plus the pace fact that justifies pushing.
  //
  // An INCIDENTAL session (a walk, mobility work) marks nothing, so a dog-walk day
  // leaves the day's lift reminder exactly as it was — #921's pinned line, upheld from
  // this side too.
  const trainedToday =
    getActivitiesByDate(profileId, input.today).find(
      (a) => effortClass(a.type, a.title) === "training"
    ) ?? null;
  const behindPace: BehindTargetPace[] = input.routine
    .filter((t) => !t.met)
    .map((t) => ({
      scopeKind: t.target.scope_kind,
      scopeValue: t.target.scope_value,
      label: frequencyScopeLabel(t.target.scope_kind, t.target.scope_value),
      count: t.count,
      perWeek: t.per_week,
      // Absent only for a fixture-shaped target; 0 reads as "today is the last day",
      // the conservative direction (it can only make the nudge FIRE).
      daysLeftInWindow: t.daysLeftInWindow ?? 0,
    }));
  const deferral = workoutDeferralDecision({
    trainedToday: trainedToday?.title ?? null,
    behind: behindPace,
  });
  if (deferral.kind === "hold") return null;

  const recs = recommendCoaching(input);

  // The behind list keeps its STRUCTURE all the way to the formatter (#1709). It used
  // to be flattened to opaque strings right here, in routine-declaration order, so by
  // the time the formatter ran the connection between "Suggested: Back" and the list
  // that explains it was gone. Ordering + marking live in the pure core beside the
  // recommendation; label formatting belongs to the formatter.
  //
  // The DRIVERS come from the core, which names its own (#2015). This used to read
  // `items.find(routine-gap)?.target` — the FIRST routine-gap item — but the core pushes
  // them in a fixed order (cardio, then strength) while the focus/exercises/title all
  // come from the strength half. So any day behind on both marked Cardio on a message
  // that suggested a back workout, and pushed the larger deficit to second place.
  // `driverIds` is derived from the items the message names, so the two cannot disagree.
  const behind = orderBehindTargets(nw.behind, nw.driverIds);

  // The cardio session the core already picked (#2016). It is fully formed — the
  // activity chosen, weather-parked candidates excluded (#1724) — and used to be dropped
  // wholesale at this boundary, leaving only its `← today` marker pointing at a session
  // the message never suggested. Both sessions are named now; strength still leads.
  const cardioItem =
    nw.items.find((i) => i.reason === "routine-gap" && i.kind === "cardio") ??
    null;
  const cardio =
    cardioItem?.target != null
      ? {
          activity: cardioItem.activity?.activity ?? null,
          count: cardioItem.target.count,
          perWeek: cardioItem.target.perWeek,
        }
      : null;

  // Weather parking, disclosed (#2002). The dashboard card and the Training overview
  // already render these through contextNotes; the nudge rendered nothing, so an outdoor
  // ride silently became a stationary bike. Same formatter, canonical °C — the
  // notification path has no login whose temperature preference it could read.
  const parkedNotes = parkedDisclosureLines(nw.parked);

  // How well the reader already knows the lead lift (#2223), so the formatter can bound
  // the "📖 How to" button to a lift they have NOT done. No new read: these are the very
  // rows the core just frequency-ranked the exercise list from — the same bounded scan
  // answering one more question about itself — and both callers of recommendWorkout
  // (the once-per-tick gather of #447 and the request-time/manual re-gather) populate
  // them for free.
  //
  // The window is the gather's 56 days, deliberately: a lift dropped for two months
  // earns its cues back on return. See lib/exercise-familiarity.ts before shortening or
  // unbounding it.
  //
  // UNDEFINED when the gather carried no dated rows at all — "unknown", which the
  // formatter reads as "don't send". Counting 0 there would hand the button to every
  // history-less caller, the exact direction the attention doctrine forbids.
  const leadExercise = nw.exercises[0];
  const leadExerciseSessions =
    input.datedExercises && leadExercise
      ? exerciseSessionCount(input.datedExercises, leadExercise)
      : undefined;

  const top = recs[0];
  const rest =
    top?.kind === "rest"
      ? {
          title: top.title,
          detail: top.detail,
          // Carry the concurrent-signal list (#1148) so the nudge names every firing
          // reason exactly as the dashboard card does (one computation, #221).
          ...(top.also?.length ? { also: top.also } : {}),
        }
      : null;
  const onTrack =
    top?.kind === "ontrack" ? { title: top.title, detail: top.detail } : null;

  // Nothing to suggest and nothing to note → no reminder. A named cardio session counts
  // as something to suggest (#2016): a profile behind only on cardio, with no strength
  // history to fall back on, used to get silence even though the core had picked its
  // activity.
  if (!nw.focus.length && !nw.exercises.length && !cardio && !rest && !onTrack)
    return null;

  return {
    focus: nw.focus,
    exercises: nw.exercises,
    cardio,
    parkedNotes,
    behind,
    rest,
    onTrack,
    // Carry the resolved routine day label (#740) so the nudge names the actual
    // sequence day. Null when no active routine resolved a session.
    sessionLabel: nw.session?.label ?? null,
    // Deload-week softening (#741): the same flag every surface reads, carried from
    // the resolved session so the nudge phrases the deload instead of pushing hard.
    deloadWeek: nw.session?.deloadWeek ?? false,
    // The same-day acknowledgment (#1672), present only when firing on a day that
    // already saw a training session. Formatted from this same gathered computation, so
    // the dashboard/coaching surfaces reading the equivalent state agree.
    acknowledge: deferral.acknowledge,
    // The tight-week recovery override (#1673): the same pure line the dashboard and
    // Training overview render as a context note, so all three state the same two facts.
    recoveryOverride: nw.recovery.override
      ? recoveryOverrideLine(nw.recovery.override)
      : null,
    // Absent, not 0, when unknown (#2223) — the formatter's how-to button needs
    // positive evidence that the lift is new before it fires.
    ...(leadExerciseSessions !== undefined ? { leadExerciseSessions } : {}),
  };
}
