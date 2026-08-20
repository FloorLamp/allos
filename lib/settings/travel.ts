// Travel state, per profile (issue #3263) — the storage half of
// lib/travel-timezone.ts.
//
// Three keys in `profile_settings`, no new table:
//   timezone_home       — the zone the profile left, recorded by the one-tap
//                         switch so the return can be recognised and reverted.
//                         Absent means "not away".
//   timezone_switches   — the bounded switch history the switch-day rules read.
//   timezone_travel_dismissed — the device zone an offer was last dismissed for.
//
// PER PROFILE rather than per login, deliberately: every one of them is a fact
// about the PROFILE's day (where it runs, where it came from, which offer about it
// was declined), and the banner they feed exists only for the login's OWN profile,
// so there is never a second login with a different answer for the same row.

import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "./kv";
import { getTimezone, setTimezone } from "./display";
import { isValidTimezone } from "../timezone";
import { instantNow, now as clockNow } from "../clock";
import {
  appendTimezoneSwitch,
  parseTimezoneSwitches,
  serializeTimezoneSwitches,
  type TimezoneSwitch,
} from "../travel-timezone";

const HOME_KEY = "timezone_home";
const SWITCHES_KEY = "timezone_switches";
const DISMISSED_KEY = "timezone_travel_dismissed";

// The zone this profile's day came from while it is away, or null when it is home.
// A stored value equal to the profile's CURRENT zone is stale bookkeeping (a manual
// edit in Settings undid the switch without going through the revert), so it reads
// as null — the same rule `travelPrompt` applies, kept here so no caller can see a
// home zone the prompt would ignore.
export function getHomeTimezone(profileId: number): string | null {
  const stored = getProfileSetting(profileId, HOME_KEY);
  if (!stored || !isValidTimezone(stored)) return null;
  return stored === getTimezone(profileId) ? null : stored;
}

export function clearHomeTimezone(profileId: number): void {
  deleteProfileSetting(profileId, HOME_KEY);
}

export function getTravelSwitches(profileId: number): TimezoneSwitch[] {
  return parseTimezoneSwitches(getProfileSetting(profileId, SWITCHES_KEY));
}

// The device zone the person last dismissed an offer for. Suppresses the offer for
// THAT zone only; landing somewhere new re-raises it.
export function getDismissedTravelZone(profileId: number): string | null {
  return getProfileSetting(profileId, DISMISSED_KEY) ?? null;
}

export function setDismissedTravelZone(profileId: number, zone: string): void {
  setProfileSetting(profileId, DISMISSED_KEY, zone);
}

export function clearDismissedTravelZone(profileId: number): void {
  deleteProfileSetting(profileId, DISMISSED_KEY);
}

// THE TRAVEL CHOKEPOINT. Move a profile's day to `tz` and record the seam that
// leaves in its wall clock, so the switch-day rules can be asked about it later.
//
// Deliberately NOT folded into `setTimezone`. That setter is the primitive every
// seed, fixture and onboarding path binds, and a first-ever zone or a fixture's
// setup is not a journey — recording those would fill the history with switches
// nobody took and excuse slots nobody flew over. Travel goes through here; the
// Settings form keeps its own path unchanged (#3263 leaves that form alone).
//
// Returns the switch it recorded, or null when the zone did not actually move.
export function switchProfileTimezone(
  profileId: number,
  tz: string,
  homeZone: string | null
): TimezoneSwitch | null {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  const from = getTimezone(profileId);
  if (from === tz) return null;
  const at = instantNow();
  setTimezone(profileId, tz);
  const record: TimezoneSwitch = { at, from, to: tz };
  const history = appendTimezoneSwitch(
    getTravelSwitches(profileId),
    record,
    clockNow()
  );
  setProfileSetting(
    profileId,
    SWITCHES_KEY,
    serializeTimezoneSwitches(history)
  );
  if (homeZone) setProfileSetting(profileId, HOME_KEY, homeZone);
  else clearHomeTimezone(profileId);
  return record;
}
