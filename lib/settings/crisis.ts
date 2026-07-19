import {
  getSetting,
  setSetting,
  getProfileSetting,
  setProfileSetting,
  deleteProfileSetting,
} from "./kv";
import {
  parseCrisisResources,
  serializeCrisisResources,
  resolveCrisisResources,
  type CrisisResource,
} from "../crisis-resources";

// Crisis-resource configuration storage (issue #996). Two tiers, no schema:
//   - GLOBAL `settings.crisis_resources`  — the operator's instance default
//     (admin-managed on Settings → Server), region-correct for a self-hosted box.
//   - PER-PROFILE `profile_settings.crisis_resources` — an optional override for a
//     mixed-region household (Settings → Profile). Absent/empty ⇒ inherit global.
// The override is PRIVATE to the profile: getResolvedCrisisResources reads only the
// given profile's own settings — a crisis signal or its configuration never crosses
// to another profile/login. There is no hardcoded number in any tier; an
// unconfigured instance resolves to [] and the surfaces show the neutral fallback.

const KEY = "crisis_resources";

// ---- Global (admin) instance default ----

export function getGlobalCrisisResources(): CrisisResource[] {
  return parseCrisisResources(getSetting(KEY));
}

export function setGlobalCrisisResources(list: CrisisResource[]): void {
  setSetting(KEY, serializeCrisisResources(list));
}

// ---- Per-profile override ----

// The profile's override, or null when it has none (inherit the global default). An
// explicitly-empty stored value also reads as "no override".
export function getProfileCrisisResourcesOverride(
  profileId: number
): CrisisResource[] | null {
  const raw = getProfileSetting(profileId, KEY);
  if (raw == null) return null;
  const list = parseCrisisResources(raw);
  return list.length > 0 ? list : null;
}

// Set (non-empty) or clear (empty ⇒ delete the key, reverting to inherit-global).
export function setProfileCrisisResourcesOverride(
  profileId: number,
  list: CrisisResource[]
): void {
  if (list.length > 0) {
    setProfileSetting(profileId, KEY, serializeCrisisResources(list));
  } else {
    deleteProfileSetting(profileId, KEY);
  }
}

// The resources that apply to THIS profile (override wins, else global). Reads only
// this profile's settings — never another profile's.
export function getResolvedCrisisResources(
  profileId: number
): CrisisResource[] {
  return resolveCrisisResources(
    getGlobalCrisisResources(),
    getProfileCrisisResourcesOverride(profileId)
  );
}
