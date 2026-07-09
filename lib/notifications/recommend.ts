// Heuristic "what should I train today" recommendation for the workout reminder.
// Inputs: the user's usual weekday pattern, weekly targets they're behind on, and
// what was trained yesterday (avoid that whole region for recovery). Deterministic,
// no API. All day boundaries follow the configured app timezone (today()/yesterday()).

import { today, yesterday } from "../db";
import {
  getRecentDatedExercises,
  getFrequencyTargetProgress,
} from "../queries";
import { weekdayOfDateStr } from "../date";
import {
  regionForExercise,
  regionsForGroup,
  LIFT_OPTIONS,
  type MuscleRegion,
  type BodyGroup,
} from "../lifts";
import { frequencyScopeLabel } from "../goals";

const weekdayOf = (date: string) => weekdayOfDateStr(date);

export interface WorkoutRecommendation {
  focus: MuscleRegion[];
  exercises: string[];
  behind: string[]; // behind-target labels, for message context
}

export function recommendWorkout(
  profileId: number
): WorkoutRecommendation | null {
  const rows = getRecentDatedExercises(profileId, 56);
  const y = yesterday(profileId);
  const todayWeekday = weekdayOf(today(profileId));

  // Regions trained yesterday → excluded today (recovery).
  const excluded = new Set<MuscleRegion>();
  for (const r of rows) {
    if (r.date !== y) continue;
    const reg = regionForExercise(r.exercise);
    if (reg) excluded.add(reg);
  }

  // Regions usually trained on this weekday (habitual = ≥2 distinct such dates).
  const wdRegionDates = new Map<MuscleRegion, Set<string>>();
  for (const r of rows) {
    if (weekdayOf(r.date) !== todayWeekday) continue;
    const reg = regionForExercise(r.exercise);
    if (!reg) continue;
    let s = wdRegionDates.get(reg);
    if (!s) wdRegionDates.set(reg, (s = new Set()));
    s.add(r.date);
  }
  const usualRegions = [...wdRegionDates.entries()]
    .filter(([, d]) => d.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([reg]) => reg);

  // Weekly targets behind: regions to prioritize + labels for context.
  const behindProgress = getFrequencyTargetProgress(profileId).filter(
    (t) => !t.met
  );
  const behind = behindProgress.map(
    (t) =>
      `${frequencyScopeLabel(t.target.scope_kind, t.target.scope_value)} ${t.count}/${t.per_week}`
  );
  const behindRegions: MuscleRegion[] = [];
  for (const t of behindProgress) {
    if (t.target.scope_kind === "region")
      behindRegions.push(t.target.scope_value as MuscleRegion);
    else if (t.target.scope_kind === "group")
      behindRegions.push(...regionsForGroup(t.target.scope_value as BodyGroup));
    // 'type' targets (cardio/sport/strength) surface via `behind`, not a region.
  }

  // Focus: behind ∩ usual, then behind, then usual — excluding yesterday's regions.
  const focus: MuscleRegion[] = [];
  const add = (r: MuscleRegion) => {
    if (!excluded.has(r) && !focus.includes(r)) focus.push(r);
  };
  for (const r of usualRegions) if (behindRegions.includes(r)) add(r);
  for (const r of behindRegions) add(r);
  for (const r of usualRegions) add(r);

  // Fallback when nothing matched (no targets/pattern, or all excluded): the
  // user's least-recently-trained regions (overdue) that weren't done yesterday.
  // Only regions with history — never-trained ones have no exercises to suggest.
  if (focus.length === 0) {
    const lastByRegion = new Map<MuscleRegion, string>();
    for (const r of rows) {
      const reg = regionForExercise(r.exercise);
      if (!reg) continue;
      const cur = lastByRegion.get(reg);
      if (!cur || r.date > cur) lastByRegion.set(reg, r.date);
    }
    [...lastByRegion.entries()]
      .filter(([r]) => !excluded.has(r))
      .sort((a, b) => a[1].localeCompare(b[1])) // oldest last-trained first
      .slice(0, 2)
      .forEach(([r]) => add(r));
  }

  const focusRegions = focus.slice(0, 3);

  // Candidate exercises per focus region, ranked by recent frequency.
  const exCount = new Map<string, number>();
  for (const r of rows)
    exCount.set(r.exercise, (exCount.get(r.exercise) ?? 0) + 1);
  const perRegion = new Map<MuscleRegion, string[]>();
  for (const reg of focusRegions) perRegion.set(reg, []);
  for (const [ex] of [...exCount.entries()].sort((a, b) => b[1] - a[1])) {
    const reg = regionForExercise(ex);
    if (reg && perRegion.has(reg) && !perRegion.get(reg)!.includes(ex))
      perRegion.get(reg)!.push(ex);
  }
  // Catalog fallback for a focus region with no logged history.
  for (const reg of focusRegions) {
    if (perRegion.get(reg)!.length === 0) {
      const cat = LIFT_OPTIONS.find((n) => regionForExercise(n) === reg);
      if (cat) perRegion.get(reg)!.push(cat);
    }
  }
  // Round-robin across focus regions, up to 5 exercises.
  const exercises: string[] = [];
  for (let i = 0; exercises.length < 5; i++) {
    let added = false;
    for (const reg of focusRegions) {
      const pick = perRegion.get(reg)![i];
      if (pick) {
        exercises.push(pick);
        added = true;
        if (exercises.length >= 5) break;
      }
    }
    if (!added) break;
  }

  if (focusRegions.length === 0 && exercises.length === 0) return null;
  return { focus: focusRegions, exercises, behind };
}
