// The situational-due COUNT gather (issue #1221 part 6). The Supplements bar's
// activation acknowledgment ("N situational items now active") is
// situationActivationLine(countSituationalDue(supplements, ctx)) — computed inline on
// the Supplements tab from its already-gathered supplements + workout/situation context.
// The dashboard check-in "Anything going on?" chips need the SAME number, so this gather
// assembles the identical inputs (the tab's ctx build, verbatim) and calls the SAME pure
// countSituationalDue engine — so the two surfaces can never disagree (#221). Pure engine
// (countSituationalDue) shared; this is just the second surface's gather half.

import { today } from "../../db";
import { getSupplements } from "./schedule";
import {
  getActivitiesByDate,
  isPredictedWorkoutDay,
} from "../training/activities";
import {
  countSituationalDue,
  isPostWorkoutReady,
} from "../../supplement-schedule";
import { getTimezone } from "../../settings";
import { getEffectiveActiveSituations } from "../derived-situations";
import { zonedDateParts } from "../../date";

// The count of situational supplements currently DUE for the profile given its active
// situations — the SAME figure the Supplements-bar activation line uses. Mirrors the
// tab's ctx build (isWorkoutDay / activeSituations / predictedWorkoutDay /
// postWorkoutReady) exactly so both read one truth.
export function getSituationalDueCount(profileId: number): number {
  const on = today(profileId);
  const supplements = getSupplements(profileId);
  // Derived context widens the active set (#1292/#1298): a Poor sleep / Period item
  // counts as due exactly while its derived context holds — the SAME set the bar uses.
  const activeSituations = getEffectiveActiveSituations(profileId, on);
  const todaysActivities = getActivitiesByDate(profileId, on);
  const isWorkoutDay = todaysActivities.length > 0;
  const predictedWorkoutDay = isPredictedWorkoutDay(profileId, on);
  const { hhmm } = zonedDateParts(getTimezone(profileId), new Date());
  const nowMinutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const postWorkoutReady = isPostWorkoutReady(
    todaysActivities.map((a) => a.end_time ?? a.start_time),
    nowMinutes
  );
  return countSituationalDue(supplements, {
    isWorkoutDay,
    activeSituations,
    predictedWorkoutDay,
    postWorkoutReady,
  });
}
