"use server";
// Travel timezone actions (issue #3263) — the three writes behind the shell's
// travel banner.
//
// ALL THREE ARE OWN-PROFILE ONLY, and that is the gate that matters here. The
// browser zone is a fact about the DEVICE, and a device is not a subject: a
// caregiver holding the traveller's phone, or a member logging a dose for a parent
// from an airport, must never have "this device is in Tokyo" turned into "your
// mother's day is now Tokyo's". So every action resolves the login's OWN profile
// and refuses unless it is also the acting one — the banner that offers them is
// gated the same way, and this is the half a forged POST meets.

import { requireWriteAccess } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { isViewingSelf } from "@/lib/own-profile";
import { revalidateRoute } from "@/lib/revalidate";
import { isValidTimezone } from "@/lib/timezone";
import {
  clearDismissedTravelZone,
  clearHomeTimezone,
  getHomeTimezone,
  getTimezone,
  setDismissedTravelZone,
  switchProfileTimezone,
} from "@/lib/settings";

export interface TravelSwitchResult {
  ok: boolean;
  // The zone the day now runs on, when the write landed.
  timezone?: string;
  // Populated by the explicit return only.
  homeZone?: string;
  awayZone?: string;
}

// The login's own profile id, or null when this caller may not move a day at all.
async function ownProfileForTravel(): Promise<number | null> {
  await requireWriteAccess();
  const scope = await requireScope();
  return isViewingSelf(scope) ? scope.ownProfileId : null;
}

// The shared tail of a travel switch: every day-shaped surface has to re-render.
//
// IT DELETES NOTHING, and that is the fix for #3524. It used to sweep a trailing window
// of Health Connect `body_metrics` rows on the way out, on the argument that the next
// push would repopulate them under the new keys (#608). The exporter re-sends one day,
// not three, so the sweep destroyed a day of resting HR per switch — four days on a real
// profile across two travel switches. The re-key it existed to prevent is now handled
// where the evidence for it is, at ingest: lib/integrations/ingest-timezone-reconcile.ts
// deletes the row an incoming reading is actually re-keying, and only that row.
function afterTimezoneMoved(): void {
  revalidateRoute("/", "layout");
}

// Accept the offer: move the day to the device's zone and remember where it came
// from, so the return can be recognised. ASKED rather than automatic (#2471) — a
// layover or a VPN must not move somebody's day.
export async function acceptTravelTimezone(
  zone: string
): Promise<TravelSwitchResult> {
  const profileId = await ownProfileForTravel();
  if (profileId === null) return { ok: false };
  if (!isValidTimezone(zone)) return { ok: false };
  const from = getTimezone(profileId);
  if (from === zone) return { ok: true, timezone: zone };
  // The zone being left is home for the duration of the trip. A SECOND switch while
  // already away keeps the ORIGINAL home rather than adopting the last airport as
  // one: two legs of one journey are still one journey away from home.
  const home = getHomeTimezone(profileId) ?? from;
  switchProfileTimezone(profileId, zone, home);
  // A new zone is a new question, so a dismissal from the last one is spent.
  clearDismissedTravelZone(profileId);
  afterTimezoneMoved();
  return { ok: true, timezone: zone };
}

// Not now. The offer stays down for THIS device zone until the zone changes again —
// a long trip somebody is deliberately spending on home time must not become a
// daily nag.
export async function dismissTravelTimezone(
  zone: string
): Promise<TravelSwitchResult> {
  const profileId = await ownProfileForTravel();
  if (profileId === null) return { ok: false };
  if (!isValidTimezone(zone)) return { ok: false };
  setDismissedTravelZone(profileId, zone);
  return { ok: true };
}

// Coming home, only after the person accepts the return offer. A browser timezone
// can be set by a VPN, so it is a hint rather than authority to move a profile's
// day (#3684). Clears `timezone_home` — the trip is over — and the dismissal with it.
export async function revertTravelTimezone(): Promise<TravelSwitchResult> {
  const profileId = await ownProfileForTravel();
  if (profileId === null) return { ok: false };
  const homeZone = getHomeTimezone(profileId);
  if (!homeZone) return { ok: false };
  const awayZone = getTimezone(profileId);
  // The return leg is a switch like any other: it leaves the same seam in the wall
  // clock, so it goes through the same chokepoint and joins the same history.
  switchProfileTimezone(profileId, homeZone, null);
  clearHomeTimezone(profileId);
  clearDismissedTravelZone(profileId);
  afterTimezoneMoved();
  return { ok: true, timezone: homeZone, homeZone, awayZone };
}
