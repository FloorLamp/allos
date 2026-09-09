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
import { zonedDateParts } from "../../date";

export interface IntakeDayContextInputs {
  // The effective active-situation set for `date`, when the caller has ALREADY resolved
  // it. The medications board holds a windowed resolver for its adherence strip and its
  // today row reads that same resolver; re-reading here would pay for the profile's
  // whole derived history a second time on every render. Omitted ⇒ read through the
  // single-day entry point, which is the same resolver over a one-day window.
  activeSituations?: Set<string>;
  // The caller's own server-clock instant, when it stamps other values from one (#1005).
  // Omitted ⇒ the clock seam.
  now?: Date;
}

// The day context for one profile on one day.
export function intakeDayContext(
  profileId: number,
  date: string,
  inputs: IntakeDayContextInputs = {}
): IntakeDayContext {
  const activities = getActivitiesByDate(profileId, date);
  // The wall clock only decides the day IN PROGRESS. On any other day the session it
  // would gate has already ended (or has not been logged at all).
  const nowMinutes =
    date === today(profileId)
      ? minutesOfDay(
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

function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
