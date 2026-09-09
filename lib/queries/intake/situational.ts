// The situational-due COUNT gather (issue #1221 part 6). The Supplements bar's
// activation acknowledgment ("N situational items now active") is
// situationActivationLine(countSituationalDue(supplements, ctx)) — computed inline on
// the Supplements tab from its already-gathered supplements + workout/situation context.
// The dashboard check-in "Anything going on?" chips need the SAME number, so this gather
// assembles the identical inputs (the tab's ctx build, verbatim) and calls the SAME pure
// countSituationalDue engine — so the two surfaces can never disagree (#221). Pure engine
// (countSituationalDue) shared; this is just the second surface's gather half.

import { today } from "../../db";
import { getIntakeItems } from "./schedule";
import { intakeDayContext } from "./day-context";
import { countSituationalDue } from "../../intake-schedule";

// The count of situational intake items currently DUE for the profile given its active
// situations — the SAME figure the intake activation line uses, over the SAME day
// context builder the tab and the medications page read, so both read one truth.
export function getSituationalDueCount(profileId: number): number {
  const on = today(profileId);
  const items = getIntakeItems(profileId);
  // The SHARED day-context builder (#5321) — the bar's ctx build was a verbatim copy of
  // the medications page's, and a copy is what drifts. Derived context widens the active
  // set inside it (#1292/#1298): a Poor sleep / Period item counts as due exactly while
  // its derived context holds.
  return countSituationalDue(items, intakeDayContext(profileId, on));
}
