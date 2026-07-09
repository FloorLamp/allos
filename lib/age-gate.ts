import { getSetting, setSetting, deleteSetting, getUserAge } from "./settings";

// Age gating for the fitness-oriented surfaces. When a profile's known age is
// below the configured minimum, the Journal, Training, and AI Insights pages —
// plus the Equipment settings tab and their dashboard widgets — are hidden and
// direct navigation to them is bounced back to the dashboard.
//
// The threshold is an instance-wide global setting (`min_training_age`, whole
// years), managed by an admin on Settings → Server. Unset or non-positive
// disables the gate and every profile keeps full access.

const SETTING_KEY = "min_training_age";

// Parse a raw threshold value into a positive whole-year age, or null (gate
// off). Pure — shared by the reader and unit-tested directly.
export function parseMinAge(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// The instance-wide minimum age, read from the global setting. Null = gate off.
export function minTrainingAge(): number | null {
  return parseMinAge(getSetting(SETTING_KEY));
}

// Set (or clear, with null / non-positive) the instance-wide minimum age.
export function setMinTrainingAge(age: number | null): void {
  if (age === null || !Number.isFinite(age) || age <= 0) {
    deleteSetting(SETTING_KEY);
    return;
  }
  setSetting(SETTING_KEY, String(Math.floor(age)));
}

// True only when the profile's age is KNOWN and below the configured minimum.
// An unknown age (no birthdate and no stored age fallback) is never restricted —
// we don't hide content on missing data, only on a positive under-age match.
export function isTrainingRestricted(profileId: number): boolean {
  const min = minTrainingAge();
  if (min === null) return false;
  const age = getUserAge(profileId);
  if (age === null) return false;
  return age < min;
}
