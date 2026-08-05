// The dashboard "Now" strip ranker (issue #1413, section A).
//
// A phone dashboard costs a screenful of scrolling before anything relevant
// appears, and the grid's persisted order — correct as a STANDING preference —
// never responds to the moment: at 7am you scroll past labs to find sleep, right
// after a workout the recap is wherever you left it, at dinner nutrition is
// buried. This module decides which one or two of the EXISTING cards deserve to
// be repeated at the top of the page right now.
//
// THE HARD CONSTRAINTS THIS FILE EXISTS TO KEEP:
//
//   1. It is a RANKER, NOT AN ENGINE (#221). Every signal it consumes is already
//      computed by somebody else for another purpose — `typicalWakeTime` (#1117,
//      the wake-aware morning notify slot), `getWorkoutPresence` (#924, the
//      finish nudge + the recap card), `getNotifySchedule().supplementMinutes` (the
//      existing mealtime-shaped anchors), `getMoodOnDate` (the check-in card),
//      `getLastNightSummary` (the sleep widget). Nothing here reads a DB, derives
//      a new health fact, or invents a second definition of anything. That is
//      also why it is pure: the caller gathers, this scores.
//
//   2. Every card it can name is an EXISTING renderable. There is no "now strip
//      card" component set — the strip renders the SAME widget node the grid
//      would have rendered, so a promotion is a reference, never a move, and the
//      user's manual order below is untouched.
//
//   3. It NEVER promotes something the user turned off. `eligible` is the caller's
//      already-resolved visible+available set; a hidden widget cannot be dragged
//      back into view by the clock. A ranker that overrides a hide preference is
//      the same liability as a dashboard that hides "three doses overdue".
//
//   4. Silence is a valid answer. No signal firing → an EMPTY strip (zero height),
//      never a filler card. A strip that always shows something teaches the user
//      to ignore it, which costs exactly the relevance it was built to buy.
//
// Time windows are all minute-of-day in the PROFILE's timezone (#1186/#450): the
// caller resolves "what minute is it for this person" once via
// `hhmmToMinutes(zonedDateParts(tz, now()).hhmm)` and passes the number in. No
// client clock, no UTC day math, and no `new Date()` anywhere below this line.

import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";

// The cards the strip can promote. Three are dashboard widget ids (the strip
// renders the grid's own node for them); `session-recap` is the post-workout card
// the page already renders standalone above the grid (#924), named here so the
// ranker can decide its position too rather than leaving one promotion path out.
export const NOW_CARD_IDS = [
  "session-recap",
  "sleep-last-night",
  "nutrition-today",
  "symptom-log",
] as const;

export type NowCardId = (typeof NOW_CARD_IDS)[number];

// At most two. The strip is a compact BAND, not a second dashboard: a third card
// would push the user's own grid below the fold again, which is the problem.
export const NOW_STRIP_CAP = 2;

// How long after the typical wake time the "just woke up" window stays open.
// Generous (3h) because `typicalWakeTime` is a 28-night MEDIAN — an actual wake
// scatters around it — and because the morning is when the sleep card is the
// thing you reach for at all.
export const WAKE_WINDOW_MIN = 180;

// How close to a mealtime anchor counts as "it's about mealtime". Symmetric, so
// the nutrition card leads INTO a meal (deciding what to eat) as well as trailing
// it (logging what you ate) — the log-shaped half is the one with a real action.
export const MEAL_WINDOW_MIN = 60;

// The wake anchor used when the profile has no `typicalWakeTime` yet (it needs 14
// nights in the trailing window before it returns anything). This is deliberately
// the SAME fallback the wake-aware morning notify slot uses
// (`wakeMinute ?? DEFAULT_INTAKE_REMINDER_MINUTES.Morning`, lib/settings/notifications),
// so a profile without sleep history gets one answer to "when does this person's
// morning start", not two.
export const DEFAULT_WAKE_MINUTES = DEFAULT_INTAKE_REMINDER_MINUTES.Morning;

// Tier weights. Deliberately coarse and FIXED rather than a tuned continuous
// score: the strip's job is "which of these is most worth a glance", and a
// user-visible ordering that shifts on a few minutes' drift reads as broken.
// Proximity only breaks ties WITHIN a tier (see `rankNowCards`).
//
// The ordering rationale, highest first:
//   - session-recap  A just-finished workout is the most time-boxed thing on the
//                    page: the recap window is 60 minutes and then it is gone
//                    forever. It outranks sleep on purpose (an early-morning
//                    workout puts both in range; the recap is the perishable one).
//   - sleep          The morning ritual, and the reason the wake signal exists.
//   - symptom-log    The evening check-in, but only while it is still UNDONE —
//                    a completed check-in scores nothing at all.
//   - nutrition      The most frequent signal (three anchors a day), so it sits
//                    lowest: it should fill the second slot, not own the first.
const TIER: Record<NowCardId, number> = {
  "session-recap": 400,
  "sleep-last-night": 300,
  "symptom-log": 200,
  "nutrition-today": 100,
};

export interface NowSignals {
  // Current time as minutes since local midnight (0..1439) in the PROFILE's
  // timezone. The caller derives it once; nothing here reads a clock.
  minutesOfDay: number;
  // `typicalWakeTime(profileId)` — a minute-of-day, or null when there is not
  // enough sleep history (fewer than 14 nights in the trailing window).
  wakeMinutes: number | null;
  // A last-night sleep summary exists AND it is actually last night's. The
  // summary read returns the most recent recorded wake-day, which may be days
  // old, so the caller compares its `wakeDay` to today before setting this.
  freshSleepSummary: boolean;
  // The profile is in the morning WAITING window (#2097) — last night is not in
  // hand but is expected, so the sleep card has a named state to render rather
  // than a different night's figures. That is a real answer to "how did I sleep",
  // not filler, so it promotes on the same terms as a fresh summary; the wake
  // window below still decides WHEN, which keeps the pre-wake in-progress state
  // off the strip by construction.
  sleepWaiting: boolean;
  // Minutes since a just-finished workout that has something to recap, or null.
  // Sourced from `getWorkoutPresence().sinceMin` while state is "finished" and
  // the recap carries working sets — the SAME gate the standalone card uses.
  workoutFinishedMinAgo: number | null;
  // The profile's mealtime-shaped anchors as minutes-of-day. These are the
  // existing intake reminder slots (Morning/Midday/Evening); the food log
  // deliberately cannot supply a better distribution — `food_log_events.logged_at`
  // is TAP time, documented as explicitly NOT eating time, and reinterpreting it
  // would invent an eating-time engine this issue's scope guard forbids.
  mealAnchors: readonly number[];
  // The profile's evening anchor (minutes-of-day) — when the check-in becomes the
  // thing worth surfacing — or null when the profile has no evening slot.
  eveningAnchor: number | null;
  // Today's check-in is already logged (`getMoodOnDate(profileId, today) != null`).
  checkInDone: boolean;
  // The cards that MAY be promoted: the caller's already-resolved visible +
  // available set. Anything absent here is unreachable no matter how it scores.
  eligible: readonly NowCardId[];
}

// The signed distance from `minutes` to the nearest of `anchors`, or null when
// there are none. Same-day only: a 23:30 anchor and a 00:30 clock are 23 hours
// apart, not one — a wrap-around window would surface "dinner" after midnight.
function nearestDistance(
  minutes: number,
  anchors: readonly number[]
): number | null {
  let best: number | null = null;
  for (const a of anchors) {
    const d = Math.abs(minutes - a);
    if (best === null || d < best) best = d;
  }
  return best;
}

// A card's score right now, or null when its signal is not firing. Split out from
// `rankNowCards` so each rule reads as one self-contained condition — and so a
// future card is an added branch rather than an edit to the sort.
//
// The returned number is `TIER[id]` minus a small proximity penalty, so tiers
// never interleave (the penalty is bounded well below the 100-point tier gap) but
// two cards in the same tier order by how close their anchor is.
function scoreCard(id: NowCardId, s: NowSignals): number | null {
  switch (id) {
    case "session-recap": {
      // The presence model already closes this window at 60 minutes; the guard is
      // belt-and-braces so a caller passing a stale value can't pin the strip.
      if (s.workoutFinishedMinAgo === null) return null;
      if (s.workoutFinishedMinAgo < 0) return null;
      if (s.workoutFinishedMinAgo > 60) return null;
      // Fresher finish ranks higher (only matters against itself).
      return TIER["session-recap"] - s.workoutFinishedMinAgo;
    }
    case "sleep-last-night": {
      // Nothing to show without an actual last-night summary OR the named waiting
      // state — the wake window alone would promote an empty card, which is the
      // filler this file refuses.
      if (!s.freshSleepSummary && !s.sleepWaiting) return null;
      const wake = s.wakeMinutes ?? DEFAULT_WAKE_MINUTES;
      const since = s.minutesOfDay - wake;
      if (since < 0 || since > WAKE_WINDOW_MIN) return null;
      // Earlier in the window ranks higher: the sleep card matters most the
      // moment you pick up the phone, and fades as the day starts.
      return TIER["sleep-last-night"] - since / 2;
    }
    case "symptom-log": {
      // Evening, and only while today's check-in is still undone. A completed
      // check-in scores nothing — re-promoting it would be the filler case again.
      if (s.checkInDone) return null;
      if (s.eveningAnchor === null) return null;
      if (s.minutesOfDay < s.eveningAnchor) return null;
      // Later in the evening ranks higher: the window closes at midnight, so the
      // nudge should get MORE insistent, not less.
      return TIER["symptom-log"] + (s.minutesOfDay - s.eveningAnchor) / 100;
    }
    case "nutrition-today": {
      const d = nearestDistance(s.minutesOfDay, s.mealAnchors);
      if (d === null || d > MEAL_WINDOW_MIN) return null;
      return TIER["nutrition-today"] - d / 2;
    }
  }
}

// The ranked cards for the strip, most relevant first, capped at NOW_STRIP_CAP.
// Empty when nothing is firing — the caller renders NO strip in that case (zero
// height), never a placeholder.
//
// Ties break by the fixed NOW_CARD_IDS order so the result is deterministic: two
// cards can only tie within a tier, and a stable order beats an arbitrary one for
// a surface the user is trying to build muscle memory against.
export function rankNowCards(s: NowSignals): NowCardId[] {
  const eligible = new Set(s.eligible);
  return NOW_CARD_IDS.filter((id) => eligible.has(id))
    .map((id, index) => ({ id, index, score: scoreCard(id, s) }))
    .filter(
      (c): c is { id: NowCardId; index: number; score: number } =>
        c.score !== null
    )
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, NOW_STRIP_CAP)
    .map((c) => c.id);
}
