// Bodyweight-strength standards (1RM as a multiple of bodyweight) for the main
// barbell + bodyweight lifts. Used to label an estimated 1RM relative to
// bodyweight. Approximate, blended from common strength-standard charts.
import { variantOf } from "./lifts";
import type { Sex } from "./types";

export interface Standard {
  beginner: number;
  intermediate: number;
  advanced: number;
  elite: number;
}

// The default table is the male/unspecified set; STANDARDS_FEMALE holds the
// female set (see below). Both are approximate and blended from common
// strength-standard charts.
export const STANDARDS: Record<string, Standard> = {
  "bench press": {
    beginner: 0.75,
    intermediate: 1.0,
    advanced: 1.5,
    elite: 2.0,
  },
  "incline bench press": {
    beginner: 0.6,
    intermediate: 0.85,
    advanced: 1.25,
    elite: 1.65,
  },
  "overhead press": {
    beginner: 0.45,
    intermediate: 0.7,
    advanced: 1.0,
    elite: 1.4,
  },
  squat: { beginner: 1.0, intermediate: 1.5, advanced: 2.0, elite: 2.75 },
  "back squat": {
    beginner: 1.0,
    intermediate: 1.5,
    advanced: 2.0,
    elite: 2.75,
  },
  "front squat": {
    beginner: 0.85,
    intermediate: 1.25,
    advanced: 1.7,
    elite: 2.3,
  },
  deadlift: { beginner: 1.25, intermediate: 1.75, advanced: 2.5, elite: 3.0 },
  // Bodyweight pulls: ratio is the estimated 1RM (bodyweight + any added load)
  // over bodyweight, so ~1.0 is a clean rep and >1 means added weight.
  "pull up": { beginner: 1.0, intermediate: 1.25, advanced: 1.5, elite: 1.9 },
  "chin up": { beginner: 1.0, intermediate: 1.3, advanced: 1.6, elite: 2.0 },
};

// Female bodyweight-strength standards. Common charts set women's absolute
// bodyweight ratios below men's (roughly 0.55–0.8× for upper-body lifts, closer
// for lower-body), so a shared table would mislabel most women as "Beginner".
// These are the same approximate/blended framing as STANDARDS, scaled to the
// female column of those charts. Selected by profile sex; unspecified sex keeps
// the default (male) table so existing behavior is unchanged.
export const STANDARDS_FEMALE: Record<string, Standard> = {
  "bench press": {
    beginner: 0.5,
    intermediate: 0.75,
    advanced: 1.0,
    elite: 1.5,
  },
  "incline bench press": {
    beginner: 0.4,
    intermediate: 0.6,
    advanced: 0.85,
    elite: 1.2,
  },
  "overhead press": {
    beginner: 0.3,
    intermediate: 0.5,
    advanced: 0.75,
    elite: 1.0,
  },
  squat: { beginner: 0.75, intermediate: 1.25, advanced: 1.75, elite: 2.25 },
  "back squat": {
    beginner: 0.75,
    intermediate: 1.25,
    advanced: 1.75,
    elite: 2.25,
  },
  "front squat": {
    beginner: 0.65,
    intermediate: 1.0,
    advanced: 1.4,
    elite: 1.85,
  },
  deadlift: { beginner: 1.0, intermediate: 1.5, advanced: 2.0, elite: 2.5 },
  "pull up": { beginner: 0.8, intermediate: 1.0, advanced: 1.25, elite: 1.6 },
  "chin up": { beginner: 0.8, intermediate: 1.05, advanced: 1.3, elite: 1.65 },
};

// The standards table for a given sex — female gets STANDARDS_FEMALE; male or
// unspecified gets the default STANDARDS.
export function standardsTableFor(sex?: Sex | null): Record<string, Standard> {
  return sex === "female" ? STANDARDS_FEMALE : STANDARDS;
}

export interface Level {
  label: string;
  color: string;
}

export function levelFor(ratio: number, s: Standard): Level {
  if (ratio >= s.elite)
    return { label: "Elite", color: "text-violet-600 dark:text-violet-400" };
  if (ratio >= s.advanced)
    return { label: "Advanced", color: "text-sky-600 dark:text-sky-400" };
  if (ratio >= s.intermediate)
    return {
      label: "Intermediate",
      color: "text-brand-600 dark:text-brand-400",
    };
  if (ratio >= s.beginner)
    return { label: "Novice", color: "text-amber-600 dark:text-amber-400" };
  return { label: "Beginner", color: "text-slate-500 dark:text-slate-400" };
}

export function standardFor(
  exercise: string,
  sex?: Sex | null
): Standard | undefined {
  const table = standardsTableFor(sex);
  const direct = table[exercise.trim().toLowerCase()];
  if (direct) return direct;
  // Equipment variants: a barbell (or bare-base) variant uses its base lift's
  // standard — "Barbell Bench Press" → bench press. Dumbbell/cable/machine
  // variants have no barbell standard.
  const v = variantOf(exercise);
  if (v && (v.equipment === "Barbell" || v.equipment === null)) {
    return table[v.group.name.trim().toLowerCase()];
  }
  return undefined;
}

// The standards table for the reference card. Columns map to levels: "Novice" is
// the entry threshold (Standard.beginner); below it is "Beginner".
export const STANDARD_LEVELS: {
  label: string;
  key: keyof Standard;
  color: string;
}[] = [
  {
    label: "Novice",
    key: "beginner",
    color: "text-amber-600 dark:text-amber-400",
  },
  {
    label: "Intermediate",
    key: "intermediate",
    color: "text-brand-600 dark:text-brand-400",
  },
  {
    label: "Advanced",
    key: "advanced",
    color: "text-sky-600 dark:text-sky-400",
  },
  {
    label: "Elite",
    key: "elite",
    color: "text-violet-600 dark:text-violet-400",
  },
];

// Curated, de-duplicated lift list for the reference table (skips the "squat"
// alias of "back squat"), resolved against the sex-appropriate table so a
// female profile sees the female column — and so a highlighted standard (which
// comes from standardFor(exercise, sex)) is the SAME object as its row here,
// keeping StrengthStandards' identity-based row highlight working.
export function displayedStandards(
  sex?: Sex | null
): { lift: string; standard: Standard }[] {
  const t = standardsTableFor(sex);
  return [
    { lift: "Bench Press", standard: t["bench press"] },
    { lift: "Incline Bench Press", standard: t["incline bench press"] },
    { lift: "Overhead Press", standard: t["overhead press"] },
    { lift: "Back Squat", standard: t["back squat"] },
    { lift: "Front Squat", standard: t["front squat"] },
    { lift: "Deadlift", standard: t["deadlift"] },
    { lift: "Pull Up", standard: t["pull up"] },
    { lift: "Chin Up", standard: t["chin up"] },
  ];
}

// Backward-compatible default (male/unspecified) reference list.
export const DISPLAYED_STANDARDS: { lift: string; standard: Standard }[] =
  displayedStandards();

// Reps past which Epley's linear rep bonus is no longer trustworthy. Epley
// (weight * (1 + reps/30)) is fit to the low-rep strength range and overestimates
// sharply for high-rep/endurance sets — a 20-rep set is nowhere near 1.67× its
// weight in true 1RM. We CAP the rep contribution at this many reps: any set with
// more reps is scored as if it were exactly this many. Chosen at 12 because ~1–12
// reps is the range single-formula estimators are reasonable over; blending in
// Brzycki was considered but it has its own high-rep blow-up (undefined at 37
// reps), whereas a hard cap is simple, bounded, and leaves the accurate 1–12
// range untouched.
export const E1RM_REP_CAP = 12;

// Epley estimated one-rep max with a high-rep cap (see E1RM_REP_CAP). A single
// rep returns the weight itself; more reps at the same weight estimate a higher
// 1RM up to the cap, past which the estimate no longer climbs. Non-positive reps
// fall back to the weight (no rep bonus) so callers never get a value below the
// lifted weight.
export function estimate1RM(weightKg: number, reps: number): number {
  if (reps <= 0) return weightKg;
  return weightKg * (1 + Math.min(reps, E1RM_REP_CAP) / 30);
}
