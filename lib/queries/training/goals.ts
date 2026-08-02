import { db, today } from "../../db";
import type { GoalProgress, GoalSetRow } from "../../goal-progress";
import {
  computeBodyGoalProgress,
  computeGoalProgress,
} from "../../goal-progress";
import {
  biomarkerGoalCheckIn,
  biomarkerTargetOf,
  computeBiomarkerGoalProgress,
  isBiomarkerGoal,
} from "../../biomarker-goal";
import { retestDaysForBiomarker } from "../../biomarker-retest";
import { goalMatchesExercise } from "../../goals";
import type { BodyMetricKind, Goal } from "../../types";
import { biomarkerPlot } from "../biomarker-plot";
import { getLatestBodyMetric } from "../metrics";

// Training-SPECIFIC goal reads. The scope-kind-generic `frequency_targets`
// machinery that used to sit below them serves five domains, only one of which is
// training, and moved to lib/queries/frequency-targets.ts in #1637.

// ---- Goals ----
export function getGoals(profileId: number): Goal[] {
  // Archived goals sink to the bottom; within each, active before achieved.
  // status is exactly ('active' | 'achieved') (GoalStatus / migration 016 CHECK),
  // so the CASE covers the whole set — 'active' first, everything else (achieved)
  // after; there is no dead third arm.
  return db
    .prepare(
      `SELECT * FROM goals
       WHERE profile_id = ?
       ORDER BY archived ASC,
                CASE status WHEN 'active' THEN 0 ELSE 1 END,
                created_at DESC`
    )
    .all(profileId) as Goal[];
}

export type { GoalProgress } from "../../goal-progress";

// Auto-derived progress for exercise-linked and body-metric goals. Freeform
// goals (manual) are omitted. One scan over the relevant sets.
export function getGoalProgressMap(
  profileId: number,
  goals: Goal[]
): Map<number, GoalProgress> {
  const out = new Map<number, GoalProgress>();

  // Body-metric goals: latest body-metric value vs baseline → target.
  const bodyGoals = goals.filter((g) => g.body_metric);
  if (bodyGoals.length) {
    const latest: Record<BodyMetricKind, number | null> = {
      weight: getLatestBodyMetric(profileId, "weight"),
      body_fat: getLatestBodyMetric(profileId, "body_fat"),
      resting_hr: getLatestBodyMetric(profileId, "resting_hr"),
    };
    for (const g of bodyGoals) {
      out.set(g.id, computeBodyGoalProgress(g, latest[g.body_metric!]));
    }
  }

  // Biomarker goals (#1853): the latest reading of the analyte's #482 FAMILY, in the
  // unit its own chart is labelled with. Both come from `biomarkerPlot` — the SAME
  // plot the biomarker detail page draws — so a goal card and the chart it describes
  // can never disagree about the value or the unit (#221). The check-in rhythm is the
  // analyte's curated retest cadence, resolved through the shared
  // retestDaysForBiomarker lookup rather than a goals-only interval table.
  for (const g of goals.filter(isBiomarkerGoal)) {
    const target = biomarkerTargetOf(g);
    if (!target) continue;
    const plot = biomarkerPlot(profileId, target.name);
    const progress = computeBiomarkerGoalProgress(
      target,
      plot?.points ?? [],
      plot?.unit ?? target.unit
    );
    out.set(g.id, {
      ...progress,
      checkIn: biomarkerGoalCheckIn(
        progress.asOf,
        retestDaysForBiomarker(target.name),
        today(profileId)
      ),
    });
  }

  const exGoals = goals.filter((g) => g.exercise && g.metric);
  if (exGoals.length === 0) return out;

  // "Today" in the profile's timezone anchors the trailing recent-form window
  // computeGoalProgress uses to derive `current` (vs the lifetime PR).
  const t = today(profileId);

  // Resolve which exercise NAMES satisfy some goal from the cheap distinct-name
  // list (goal→set matching folds equipment variants to their base — see
  // goalMatchesExercise — which SQL can't express), then load only those sets
  // instead of every set ever. Users routinely log many exercises but set goals
  // on a few, so this skips the bulk of the table.
  const exNames = (
    db
      .prepare(
        `SELECT DISTINCT s.exercise AS exercise
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         WHERE a.profile_id = ?`
      )
      .all(profileId) as { exercise: string }[]
  ).map((r) => r.exercise);
  const matchingNames = exNames.filter((name) =>
    exGoals.some((g) => goalMatchesExercise(g, name))
  );
  if (matchingNames.length === 0) {
    // Every exGoal still gets an entry (empty progress), matching the old loop.
    for (const g of exGoals) out.set(g.id, computeGoalProgress(g, [], t));
    return out;
  }
  const rows = db
    .prepare(
      `SELECT a.id AS activity_id, a.date AS date, s.exercise AS exercise,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right,
              -- The per-set implement link (#1610): a goal that names an equipment
              -- context reads only that context's sets, so a light hotel machine
              -- can't advance a goal set on the home stack. computeGoalProgress
              -- applies the rule (goalContextSets) — a goal naming NO implement
              -- keeps folding every lane, exactly as before.
              s.equipment_id AS equipment_id
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ? AND s.warmup = 0 AND s.exercise IN (${matchingNames
         .map(() => "?")
         .join(",")})`
    )
    .all(profileId, ...matchingNames) as GoalSetRow[];

  // Index the loaded sets by their (trimmed, lowercased) exercise name once, so
  // each goal gathers its rows by name-key lookup rather than re-scanning the
  // whole array. Keys are deduped per goal so a set can't be double-counted when
  // two spellings of a name both match.
  const byExercise = new Map<string, GoalSetRow[]>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    const arr = byExercise.get(key);
    if (arr) arr.push(r);
    else byExercise.set(key, [r]);
  }
  for (const g of exGoals) {
    const keys = new Set<string>();
    for (const name of matchingNames)
      if (goalMatchesExercise(g, name)) keys.add(name.trim().toLowerCase());
    const matched: GoalSetRow[] = [];
    for (const k of keys) {
      const arr = byExercise.get(k);
      if (arr) matched.push(...arr);
    }
    out.set(g.id, computeGoalProgress(g, matched, t));
  }
  return out;
}
