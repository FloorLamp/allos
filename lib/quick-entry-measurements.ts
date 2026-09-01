import { today } from "@/lib/db";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import {
  getUnitPrefs,
  type TemperatureUnit,
  type WeightUnit,
} from "@/lib/settings";
import {
  getProfileAge,
  getProfileBirthdate,
} from "@/lib/settings/profile-attrs";
import {
  showBodyFat,
  showGrowthQuickAdd,
  showHeadCircEntry,
} from "@/lib/growth-metrics";
import { getManualBodyMetricStatedAt } from "@/lib/queries";

// The measurements form's props — the ONE quick-write surface that has to be
// reachable with no connection (#4091, ruling on #4083).
//
// ── WHY THIS ONE IS NOT GATHERED ON OPEN ─────────────────────────────────────
//
// Every other quick-entry body gathers its props through `loadQuickEntry`, and
// that is right: they are lazy because they are expensive, and fresher for being
// lazy (quick-entry-actions.ts states both). A Server Action REJECTS offline,
// though, so any surface behind one is a surface you cannot reach in a gym
// basement — which is the whole of #28's promise. The dashboard's retired weight
// widget was reachable precisely because it was server-rendered INLINE and needed
// no round trip; retiring it removed the last such weigh-in door and every guard
// stayed green, because a census of what the sheet OFFERS cannot see a
// precondition the retired mount never had.
//
// So this one payload is resolved in the app shell and handed to the overlay host
// as a prop. It costs the shell two reads it does not already make — the
// birthdate and the day's stated instant; the unit prefs, the age and the
// profile-local day are already resolved there for the nav and the dock — which is
// the price of the capability, paid on every app route.
//
// The freshness the lazy path bought is genuinely given up here: `defaultStatedAt` and
// `defaultDate` are now as fresh as the page rather than as fresh as the tap. That
// is the same freshness the inline widget had, and `defaultStatedAt` only ever
// seeds the form's initial state, so a mid-session tab that crosses midnight opens
// on the day it was rendered.
// EVERY FIELD BELOW IS A PROP OF `MeasurementsQuickAdd`, SPELLED AS THAT COMPONENT
// SPELLS IT (#4424 ruling 1), so a mount spreads this shape rather than re-listing
// seven props — which is how the sheet and a second surface come to hand one form two
// different field sets. `form` is the union's discriminant and the component ignores it.
export interface MeasurementsQuickEntry {
  form: "measurements";
  defaultDate: string;
  // The stated instant already on that day's manual body-metrics row, or null —
  // seeds the form's Time control (#2235 decision 5).
  defaultStatedAt: string | null;
  // THE DAY BOUND, AS THE CORE HOLDS IT (#4425). `addMeasurements` refuses any day
  // that has not happened, so the control that collects the day says so rather than
  // letting a submission travel to find out. It is the SUBJECT's today: a caregiver
  // in another zone must not be able to write a day that has not started for them.
  maxDate: string;
  // Scopes the form's last-written-group memory (#2014) to the data subject.
  profileId: number;
  weightUnit: WeightUnit;
  temperatureUnit: TemperatureUnit;
  showBodyFat: boolean;
  showGrowth: boolean;
  showHeadCirc: boolean;
}

// `date` is THE DAY THE FORM WILL STAND ON, defaulting to the profile's today — the
// sheet and the Trends panel open on today; the `/history` add door opens on the day
// the reader was looking at (#4424 ruling 2), which is the whole reason to add from
// there. One reader answers "what does the measurements form need on day D" so a
// second surface cannot assemble a different set of props for the same form.
export function measurementsQuickEntry(
  loginId: number,
  profileId: number,
  date: string = today(profileId)
): MeasurementsQuickEntry {
  const age = getProfileAge(profileId);
  const birthdate = getProfileBirthdate(profileId);
  const prefs = getUnitPrefs(loginId);
  return {
    form: "measurements",
    defaultDate: date,
    defaultStatedAt: getManualBodyMetricStatedAt(profileId, date),
    maxDate: today(profileId),
    profileId,
    weightUnit: prefs.weightUnit,
    temperatureUnit: prefs.temperatureUnit,
    // #493: body fat isn't tracked for a growth-tracked profile, and the page
    // mount hides the field — the overlay asks the SAME questions (the same
    // lib/growth-metrics gates) so the two mounts of one component can't
    // disagree about what's enterable.
    showBodyFat: showBodyFat(age),
    showGrowth: showGrowthQuickAdd(age),
    showHeadCirc: showHeadCircEntry(
      birthdate ? ageInMonthsFromBirthdate(birthdate, date) : null
    ),
  };
}
