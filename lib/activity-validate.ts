import { isBodyweight, isTimed, variantOf } from "./lifts";
import { parseComponents } from "./types";
import type { Activity, ActivityComponent, ExerciseSet } from "./types";

// The row subsets the validator needs. Pick<> so schema evolution in
// lib/types.ts flags this module instead of silently drifting past it.
export type StoredSet = Pick<
  ExerciseSet,
  | "exercise"
  | "weight_kg"
  | "reps"
  | "weight_kg_right"
  | "reps_right"
  | "duration_sec"
  | "duration_sec_right"
  | "equipment_id"
>;

export type StoredActivity = Pick<
  Activity,
  | "type"
  | "title"
  | "start_time"
  | "end_time"
  | "components"
  | "distance_km"
  | "duration_min"
>;

// Presence-based completeness rules, shared with the editor (which feeds
// trimmed-string presence — see ActivityForm's sideComplete/sidePartial):
// a hold time for timed lifts, reps for bodyweight lifts, both weight and
// reps otherwise.
export const sideCompleteBy = (
  name: string,
  hasW: boolean,
  hasR: boolean,
  hasD: boolean
) => (isTimed(name) ? hasD : isBodyweight(name) ? hasR : hasW && hasR);

// A side someone started that doesn't count — saving would silently drop it.
// Only the inputs the lift type uses matter.
export const sidePartialBy = (
  name: string,
  hasW: boolean,
  hasR: boolean,
  hasD: boolean
) =>
  isTimed(name)
    ? !hasD && hasW
    : isBodyweight(name)
      ? !hasR && hasW
      : hasW !== hasR;

const setComplete = (name: string, s: StoredSet) =>
  sideCompleteBy(
    name,
    s.weight_kg != null,
    s.reps != null,
    s.duration_sec != null
  ) ||
  sideCompleteBy(
    name,
    s.weight_kg_right != null,
    s.reps_right != null,
    s.duration_sec_right != null
  );

const setPartial = (name: string, s: StoredSet) =>
  sidePartialBy(
    name,
    s.weight_kg != null,
    s.reps != null,
    s.duration_sec != null
  ) ||
  sidePartialBy(
    name,
    s.weight_kg_right != null,
    s.reps_right != null,
    s.duration_sec_right != null
  );

/**
 * Why a stored activity can't be re-saved by the editor as-is — the first
 * fault found, in the same order as ActivityForm's saveBlocker — or null when
 * it's fine. Form-authored activities always pass; this exists to flag
 * imported or legacy rows in the journal. Once opened, the editor shows the
 * corresponding blocker in its own words (its messages lean on field
 * highlights; these name the exercise instead).
 *
 * Names are never a fault: strength set names and component names feed the
 * picker's suggestions themselves, and a cardio/sport name the picker doesn't
 * know loads as a committed custom activity (typed by the stored row) — the
 * editor accepts free-text cardio/sport.
 */
export function storedActivityFault(
  a: StoredActivity,
  sets: StoredSet[]
): string | null {
  const timeError = !!a.start_time && !!a.end_time && a.end_time < a.start_time;

  // Group sets by exercise, case-insensitively like the editor, keeping the
  // stored casing for messages.
  const byExercise = new Map<string, { name: string; sets: StoredSet[] }>();
  for (const s of sets) {
    const key = s.exercise.trim().toLowerCase();
    const g = byExercise.get(key);
    if (g) g.sets.push(s);
    else byExercise.set(key, { name: s.exercise, sets: [s] });
  }

  // Parse components (shared parseComponents); an absent string stays legacy
  // (null), a present one is the structured path — a stored empty list is NOT
  // legacy: the editor renders zero parts from it and blocks.
  const comps: ActivityComponent[] | null = a.components
    ? parseComponents(a.components)
    : null;

  // The editor only loads the parts named in components; other set groups
  // never appear in the form (they're judged as orphans below, not by the
  // part rules).
  const listed = comps
    ? new Set(
        comps
          .filter((c) => c.type === "strength")
          .map((c) => c.name.trim().toLowerCase())
      )
    : null;
  const judged = [...byExercise.entries()]
    .filter(([key]) => listed == null || listed.has(key))
    .map(([, g]) => g);

  // Same order as the editor's saveBlocker: equipment → time → half-filled →
  // content.
  for (const g of judged) {
    const bareBase = variantOf(g.name)?.equipment === null;
    if (bareBase && g.sets.every((s) => s.equipment_id == null))
      return `“${g.name}” needs its equipment picked.`;
  }

  if (timeError) return "The end time is before the start time.";
  // Past the early return, a present time pair is always a valid range.
  const timeRange = !!a.start_time && !!a.end_time;

  // A half-filled set pauses the editor's auto-save until fixed.
  for (const g of judged) {
    if (g.sets.some((s) => setPartial(g.name, s)))
      return `A set of “${g.name}” is only half-filled.`;
  }

  if (comps) {
    if (comps.length === 0) return "No activities listed.";
    // Every part needs its own content: a completed set for strength, a
    // distance/duration (or the session's time range) for cardio/sport.
    for (const c of comps) {
      if (c.type === "strength") {
        const g = byExercise.get(c.name.trim().toLowerCase());
        if (!g || !g.sets.some((s) => setComplete(c.name, s)))
          return `“${c.name}” has no completed set.`;
      } else if (
        c.distance_km == null &&
        c.duration_min == null &&
        !timeRange
      ) {
        return `“${c.name}” has no distance, duration, or time range.`;
      }
    }
    // Sets under exercises the components don't list never load into the
    // editor — an edit would silently drop them.
    for (const [key, g] of byExercise) {
      if (!listed!.has(key))
        return `“${g.name}” has sets the activity doesn’t list — an edit would drop them.`;
    }
    return null;
  }

  // Legacy rows without a components list.
  if (a.type === "strength") {
    // The editor rebuilds one part per exercise and requires each to have a
    // completed set.
    if (byExercise.size === 0) return "No completed set.";
    for (const [, g] of byExercise) {
      if (!g.sets.some((s) => setComplete(g.name, s)))
        return `“${g.name}” has no completed set.`;
    }
    return null;
  }
  // Legacy cardio/sport: the editor derives the single part's name from the
  // freeform title; an unrecognized one loads as a custom activity, so the
  // name itself is never a fault.
  if (byExercise.size > 0)
    return "Has exercise sets a non-strength activity can’t show — an edit would drop them.";
  if (a.distance_km == null && a.duration_min == null && !timeRange)
    return "No distance, duration, or time range.";
  return null;
}
