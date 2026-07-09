// Bodyweight-strength standards (1RM as a multiple of bodyweight) for the main
// barbell + bodyweight lifts. Used to label an estimated 1RM relative to
// bodyweight. Approximate, blended from common strength-standard charts.
import { variantOf } from "./lifts";

export interface Standard {
  beginner: number;
  intermediate: number;
  advanced: number;
  elite: number;
}

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

export function standardFor(exercise: string): Standard | undefined {
  const direct = STANDARDS[exercise.trim().toLowerCase()];
  if (direct) return direct;
  // Equipment variants: a barbell (or bare-base) variant uses its base lift's
  // standard — "Barbell Bench Press" → bench press. Dumbbell/cable/machine
  // variants have no barbell standard.
  const v = variantOf(exercise);
  if (v && (v.equipment === "Barbell" || v.equipment === null)) {
    return STANDARDS[v.group.name.trim().toLowerCase()];
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
// alias of "back squat").
export const DISPLAYED_STANDARDS: { lift: string; standard: Standard }[] = [
  { lift: "Bench Press", standard: STANDARDS["bench press"] },
  { lift: "Incline Bench Press", standard: STANDARDS["incline bench press"] },
  { lift: "Overhead Press", standard: STANDARDS["overhead press"] },
  { lift: "Back Squat", standard: STANDARDS["back squat"] },
  { lift: "Front Squat", standard: STANDARDS["front squat"] },
  { lift: "Deadlift", standard: STANDARDS["deadlift"] },
  { lift: "Pull Up", standard: STANDARDS["pull up"] },
  { lift: "Chin Up", standard: STANDARDS["chin up"] },
];

// Epley estimated one-rep max: weight * (1 + reps/30). A single rep returns the
// weight itself; more reps at the same weight estimate a higher 1RM. Non-positive
// reps fall back to the weight (no rep bonus) so callers never get a value below
// the lifted weight.
export function estimate1RM(weightKg: number, reps: number): number {
  return reps > 0 ? weightKg * (1 + reps / 30) : weightKg;
}
