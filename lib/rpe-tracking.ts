import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "@/lib/settings/kv";
// eslint-disable-next-line no-restricted-imports -- the seam module mints on one branch, reached only when the profile's opt-in row was found (#3335)
import { mintRpeTracking, type RpeTracking } from "@/lib/rpe";

// Whether a profile logs per-set RPE (#3335) — the opt-in seam for the set grid's
// effort column, and THE ONLY MINTER of an `RpeTracking`.
//
// The seam is the ROW, not a boolean anybody could read and forget to check. The
// value the set grid needs to render the control is minted on one branch here and
// nowhere else, so a surface belonging to a profile that never opted in holds
// `null` and has nothing to render — the shape #3323 gave reduction caps
// (docs/internals/substances.md, "Where the opt-in boundary is").
//
// The row's VALUE carries no meaning; presence is the whole signal. It stores "on"
// so a human reading the settings table sees something sensible, and opting out
// DELETES rather than writing "off" — two ways to say "not tracking" is the drift
// this shape exists to prevent.
//
// A profile that was already logging RPE before the opt-in existed carries the row
// from migration 20260820-rpe-column-opt-in, so migrating a shipped behaviour to
// opt-in never reads as data loss. That back-fill is a one-time migration and NOT a
// read-time "…or has some RPE data" fallback: a second way to be opted in would be
// a second producer, and the two would drift.
// eslint-disable-next-line no-restricted-syntax -- the seam module is where the opt-in key is spelled; every other reader imports RPE_TRACKING_KEY from here
export const RPE_TRACKING_KEY = "strength_rpe";

/** The profile's RPE scale, or null when it never opted in. THE producer. */
export function getRpeTracking(profileId: number): RpeTracking | null {
  return getProfileSetting(profileId, RPE_TRACKING_KEY) != null
    ? mintRpeTracking()
    : null;
}

/** Turn the set grid's effort column on or off, and answer with what now holds. */
export function setRpeTracking(
  profileId: number,
  on: boolean
): RpeTracking | null {
  if (on) setProfileSetting(profileId, RPE_TRACKING_KEY, "on");
  else deleteProfileSetting(profileId, RPE_TRACKING_KEY);
  return getRpeTracking(profileId);
}
