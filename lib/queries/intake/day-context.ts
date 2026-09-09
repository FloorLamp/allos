// THE INTAKE DAY CONTEXT, BUILT ONCE (issue #5321).
//
// `IntakeDayContext` (lib/intake-schedule.ts) is the object every dueness question is
// asked against: doseDueOn, isDueOn, isOfferedOn and conditionAppliesOn all read it.
// Its five fields were assembled inline by each surface, and a surface that assembled
// only some of them did not merely lose a condition — it got a DIFFERENT ANSWER about
// the same dose on the same day:
//
//   • a missing `predictedWorkoutDay` keys a pre-workout item on "a session is already
//     logged" instead of the inferred cadence (#558), so the surface OMITS a dose the
//     medications page offers on a predicted training day;
//   • a missing `postWorkoutReady` falls to `?? true` in conditionAppliesOn, so the
//     surface OFFERS a post-workout dose the page holds until the session has ended.
//
// The defaults are not neutral, and that is what made the omission silent. So the
// answer is a builder rather than a longer checklist: reuse the existing substrate, no
// parallel concept for the same question. /offline is what someone reads with NO
// SIGNAL, and it renders the schedule as rows with no control on them — a divergence
// there is about what was OWED, not about what is shown.
//
// DATED, like everything else this layer answers (#3993). `date` is the profile-LOCAL
// calendar day being asked about, and each field is read as of that day: the prediction
// ends its inference window on it, the situations are the effective set that held it,
// and the post-workout gate is a clock question only on the day still in progress — a
// past day's session is over, which is exactly the `null` isPostWorkoutReady takes.
//
// FOUR FACTS AND ONE VERDICT, which is the distinction `asOfWholeDay` below exists for:
// `postWorkoutReady` is a statement about the current minute, and a caller that STORES
// its context rather than rendering it must ask for the day's converged answer instead.
//
// No new SQL: every field is asked through the reader its own domain already owns.

import { today } from "../../db";
import {
  getActivitiesByDate,
  isPredictedWorkoutDay,
} from "../training/activities";
import { getEffectiveActiveSituations } from "../derived-situations";
import {
  isPostWorkoutReady,
  type IntakeDayContext,
} from "../../intake-schedule";
import { getTimezone } from "../../settings";
import { now as clockNow } from "../../clock";
import { hhmmToMinutes, zonedDateParts } from "../../date";

export interface IntakeDayContextInputs {
  // BOTH INPUTS BELOW CHANGE THE ANSWER, so passing one is an ASSERTION that it equals
  // what this builder would otherwise have read — not a cost knob. They exist because
  // the callers that hold these values hold them for a reason, and reading a second
  // copy here would be the divergence this builder exists to end, one level down.

  // The effective active-situation set for `date`. The medications board holds a
  // windowed resolver for its adherence strip and its today row reads that same
  // resolver, so passing it is what keeps the row and the strip beside it answering
  // alike — and re-reading would pay for the profile's whole derived history twice per
  // render. Omitted ⇒ the single-day entry point, which is that same resolver over a
  // one-day window.
  activeSituations?: Set<string>;
  // The caller's own server-clock instant, when it stamps other values from one (#1005)
  // — passing it is what stops this context and those stamps straddling a minute.
  // Omitted ⇒ the clock seam.
  now?: Date;

  // ASK ABOUT THE DAY AS A WHOLE, not as of this minute (#5321, falsifying pass).
  //
  // `postWorkoutReady` is the one field here that is a verdict about NOW rather than a
  // fact about the day: it is false before the earliest logged session's end time and
  // true after, and `conditionAppliesOn` ANDs it. A caller that RENDERS LIVE wants that
  // — a post-workout dose should stay held while the session is still running. A caller
  // that STORES its answer to be read later must not have it, because a frozen monotone
  // gate can only be wrong one way: it withholds, for the whole rest of the day, and the
  // reader has no way to tell.
  //
  // With this set, the day is asked about as a closed day would be — the same `null`
  // minute-of-day any other date already gets here, so there is one rule, not two. The
  // other four fields are facts about the date and are unaffected.
  asOfWholeDay?: boolean;
}

// The day context for one profile on one day.
export function intakeDayContext(
  profileId: number,
  date: string,
  inputs: IntakeDayContextInputs = {}
): IntakeDayContext {
  const activities = getActivitiesByDate(profileId, date);
  // The wall clock only decides the day IN PROGRESS, and only for a caller asking about
  // this minute. On any other day — or for a caller asking about the day as a whole —
  // the session it would gate has already ended (or was never logged).
  const nowMinutes =
    date === today(profileId) && !inputs.asOfWholeDay
      ? hhmmToMinutes(
          zonedDateParts(getTimezone(profileId), inputs.now ?? clockNow()).hhmm
        )
      : null;
  return {
    date,
    isWorkoutDay: activities.length > 0,
    activeSituations:
      inputs.activeSituations ?? getEffectiveActiveSituations(profileId, date),
    predictedWorkoutDay: isPredictedWorkoutDay(profileId, date),
    postWorkoutReady: isPostWorkoutReady(
      activities.map((a) => a.end_time ?? a.start_time),
      nowMinutes
    ),
  };
}
