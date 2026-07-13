import { getSetting, setSetting, deleteSetting, getUserAge } from "./settings";
import type { ActivityType } from "./types";

// Age gating for the fitness-oriented surfaces. When a profile's known age is
// below the configured minimum, the ADULT fitness-CONTENT layer is hidden and
// direct navigation to it bounces to the dashboard: strength e1RM/standards, the
// fitness-age/VO2 percentiles + coaching + workout recommendation + benchmarks on
// Trends, AI Insights, and the Equipment registry (/equipment, issue #343).
//
// TYPE-AWARE DOMAIN SPLIT (issue #489). The restriction protects that adult
// CONTENT, NOT the activity DOMAIN. Duration-based logging — SPORT and CARDIO —
// is age-neutral (a child tracking soccer/swim practice is a natural fit), so it
// SURVIVES the gate: a restricted profile keeps a lightweight activity log at
// /training and its create/edit write path, while STRENGTH (the adult e1RM /
// strength-standard / fitness-age framing) stays gated. The two axes were formerly
// conflated as one all-or-nothing surface switch; `isActivityTypeAllowed` below is
// the single computation the write path and the Training page both read.
//
// The threshold is an instance-wide global setting (`min_training_age`, whole
// years), managed by an admin on Settings → Server. Unset or non-positive
// disables the gate and every profile keeps full access.

// The duration-based, age-NEUTRAL activity types (issue #489): logging that a
// sport/practice or cardio session happened carries none of the adult fitness
// framing, so it is never removed by the training restriction. Strength is the
// complement — the adult e1RM/standards apparatus the gate exists to protect.
export const DURATION_ACTIVITY_TYPES: readonly ActivityType[] = [
  "cardio",
  "sport",
];

// True when an activity of `type` is duration-based (sport/cardio) rather than
// the adult-framed strength domain. Pure — unit-tested directly.
export function isDurationActivityType(type: ActivityType): boolean {
  return DURATION_ACTIVITY_TYPES.includes(type);
}

// Whether a `restricted` profile may log/keep an activity of this type. When the
// profile is not restricted, every type is allowed; when it is, only the age-
// neutral duration types (sport/cardio) survive — strength is blocked. Pure, so
// the write boundary and the UI gating agree on one rule (issue #489).
export function isActivityTypeAllowed(
  type: ActivityType,
  restricted: boolean
): boolean {
  return !restricted || isDurationActivityType(type);
}

// SQL fragment (with a leading " AND ", or empty) restricting an activity query's
// type column to the types a `restricted` profile may SEE — the age-neutral
// duration types /training's RestrictedActivityView shows and the write path
// allows. Empty when unrestricted (every type visible). Shared by the Timeline,
// sidebar calendar, and Search so a restricted profile's sport/cardio sessions
// surface identically everywhere and can't drift from the page (#618). `col` lets
// a JOINed query qualify the column; the type list is trusted constant literals.
export function restrictedActivityTypeClause(
  restricted: boolean,
  col = "type"
): string {
  if (!restricted) return "";
  const list = DURATION_ACTIVITY_TYPES.map((t) => `'${t}'`).join(", ");
  return ` AND ${col} IN (${list})`;
}

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
