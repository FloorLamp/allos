// Per-profile HOME LOCATION setting (issue #570) — the "where am I" tier, the same
// tier and Settings → Profile page as timezone. Stored as two profile_settings keys
// (home_lat / home_lng), so no migration is needed (profile_settings is key/value).
//
// Coordinates are stored COARSE (~0.1°, ~11 km) — the write goes through
// normalizeHome so a street-precise value can never land in the DB (see
// lib/home-location.ts for the privacy rationale). Home location is PHI-adjacent and
// must NEVER be written to any log. Absent → sun features quietly stay off.

import {
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "./kv";
import { normalizeHome, type HomeLocation } from "../home-location";

const LAT_KEY = "home_lat";
const LNG_KEY = "home_lng";

// The profile's coarse home location, or null when unset/malformed (feature off).
export function getHomeLocation(profileId: number): HomeLocation | null {
  const lat = getProfileSetting(profileId, LAT_KEY);
  const lng = getProfileSetting(profileId, LNG_KEY);
  if (lat == null || lng == null) return null;
  return normalizeHome(Number(lat), Number(lng));
}

// Set (coarsening first) or, with null, CLEAR the profile's home location. Throws on
// an out-of-range coordinate so a bad input can't persist a garbage value.
export function setHomeLocation(
  profileId: number,
  home: HomeLocation | null
): void {
  if (home == null) {
    deleteProfileSetting(profileId, LAT_KEY);
    deleteProfileSetting(profileId, LNG_KEY);
    return;
  }
  const coarse = normalizeHome(home.lat, home.lng);
  if (!coarse) throw new Error("Invalid home location coordinates");
  setProfileSetting(profileId, LAT_KEY, String(coarse.lat));
  setProfileSetting(profileId, LNG_KEY, String(coarse.lng));
}
