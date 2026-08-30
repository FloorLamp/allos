import { today } from "@/lib/db";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import { getUnitPrefs, type TemperatureUnit, type WeightUnit } from "@/lib/settings";
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
// The freshness the lazy path bought is genuinely given up here: `statedAt` and
// `defaultDate` are now as fresh as the page rather than as fresh as the tap. That
// is the same freshness the inline widget had, and `defaultStatedAt` only ever
// seeds the form's initial state, so a mid-session tab that crosses midnight opens
// on the day it was rendered.
export interface MeasurementsQuickEntry {
  form: "measurements";
  defaultDate: string;
  // The stated instant already on today's manual body-metrics row, or null —
  // seeds the form's Time control (#2235 decision 5).
  statedAt: string | null;
  // Scopes the form's last-written-group memory (#2014) to the data subject.
  profileId: number;
  weightUnit: WeightUnit;
  temperatureUnit: TemperatureUnit;
  showBodyFat: boolean;
  showGrowth: boolean;
  showHeadCirc: boolean;
}

export function measurementsQuickEntry(
  loginId: number,
  profileId: number
): MeasurementsQuickEntry {
  const date = today(profileId);
  const age = getProfileAge(profileId);
  const birthdate = getProfileBirthdate(profileId);
  const prefs = getUnitPrefs(loginId);
  return {
    form: "measurements",
    defaultDate: date,
    statedAt: getManualBodyMetricStatedAt(profileId, date),
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
