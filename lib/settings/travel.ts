// Travel state, per profile (issue #3263) — the storage half of
// lib/travel-timezone.ts.
//
// Three keys in `profile_settings`, no new table:
//   timezone_home       — the zone the profile left, recorded by the one-tap
//                         switch so the return can be recognised and reverted.
//                         Absent means "not away".
//   timezone_switches   — the zone-switch history. Owned and written by
//                         `setTimezone` (lib/settings/display.ts) since #3428 item 2;
//                         read back here.
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
import { getTimezone, setTimezone, TIMEZONE_SWITCHES_KEY } from "./display";
import { isValidTimezone } from "../timezone";
import { parseTimezoneSwitches, type TimezoneSwitch } from "../travel-timezone";

const HOME_KEY = "timezone_home";
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

// The profile's WHOLE recorded zone history, both kinds — the name predates #3428
// item 2, which made `setTimezone` the writer and gave every record a `kind`. Readers
// that must not see a Settings correction say so themselves: `resolveSwitchHistory`
// takes the travel sub-chain for the excusal predicates, and it is the only one that
// needs to.
export function getTravelSwitches(profileId: number): TimezoneSwitch[] {
  return parseTimezoneSwitches(
    getProfileSetting(profileId, TIMEZONE_SWITCHES_KEY)
  );
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

// THE TRAVEL CHOKEPOINT. Move a profile's day to `tz`, mark the seam as a JOURNEY,
// and keep the home marker the return offer is recognised against.
//
// The recording itself is `setTimezone`'s (#3428 item 2) and is not repeated here —
// there is one appender, so a switch cannot be written twice. What stays here is the
// part that is about travel rather than about the zone: this path, and only this path,
// says `kind: "travel"`, which is what lets a dose slot be excused for it.
//
// Returns the switch that was recorded, or null when there was none — the zone did not
// move, or the profile had no zone of its own to move from (`setTimezone`'s two
// exemptions). The home marker follows the explicit user choice either way.
export function switchProfileTimezone(
  profileId: number,
  tz: string,
  homeZone: string | null
): TimezoneSwitch | null {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  if (getTimezone(profileId) === tz) return null;
  const record = setTimezone(profileId, tz, "travel");
  if (homeZone) setProfileSetting(profileId, HOME_KEY, homeZone);
  else clearHomeTimezone(profileId);
  return record;
}

// A timezone selected explicitly in Settings is normally a correction, not proof of
// travel. Both are recorded now (#3428 item 2) — what this decides is the KIND, and
// with it whether the seam can excuse a dose slot. During an active trip, changing the
// away zone or selecting home crosses the same wall-clock seam as the travel prompt and
// counts as travel; otherwise a stale outbound jump can keep suppressing a slot after
// the person has returned. The original home remains stable across intermediate legs.
export function setProfileTimezoneFromSettings(
  profileId: number,
  tz: string
): void {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
  if (getTimezone(profileId) === tz) return;

  const homeZone = getHomeTimezone(profileId);
  if (!homeZone) {
    setTimezone(profileId, tz);
    return;
  }

  switchProfileTimezone(profileId, tz, tz === homeZone ? null : homeZone);
  clearDismissedTravelZone(profileId);
}
