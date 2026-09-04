import { db, today } from "../../db";
import { cache } from "../../request-cache";
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
import { biomarkerFamily } from "../../canonical-name";
import { getTimezone } from "../../settings";
import { dateFromCreatedAt } from "../../timeline-format";
import {
  goalMatchesExercise,
  isGoalLive,
  outcomeGoalKind,
} from "../../outcome-goals";
import type { BodyMetricKind, OutcomeGoal } from "../../types";
import { biomarkerPlots } from "../biomarker-plot";
import { getLatestBodyMetricDailyPoints } from "../metrics";

// Training-SPECIFIC goal reads. The scope-kind-generic `frequency_targets`
// machinery that used to sit below them serves five domains, only one of which is
// training, and moved to lib/queries/frequency-targets.ts in #1637.

// ---- Goals ----
type StoredOutcomeGoal = Omit<OutcomeGoal, "kind" | "categoryLabel"> & {
  category: string | null;
};

// REQUEST-CACHED (#3369 item 2): four separate readers ask one render for the same
// profile's goals — the dashboard's live-goal band, the upcoming plan items, the
// trends context's goal metrics and the rule findings — and each re-reads the whole
// list to filter it differently. Keyed on profileId, so a household render still
// reads once per profile. NO WRITER CAN INTERVENE (lib/queries/AGENTS.md): no module
// that writes `goals` reads this list, in a Server Action or anywhere else. The
// returned array is derived (each row is remapped), and every caller filters or finds
// on it rather than sorting it in place, so sharing it is safe.
export const getOutcomeGoals = cache(function getOutcomeGoals(
  profileId: number
): OutcomeGoal[] {
  // Archived goals sink to the bottom; within each, active before achieved.
  // status is exactly ('active' | 'achieved') (OutcomeGoalStatus / migration 016 CHECK),
  // so the CASE covers the whole set — 'active' first, everything else (achieved)
  // after; there is no dead third arm.
  // `id ASC` settles goals written in the SAME second (#4069): created_at has second
  // granularity, so an import left their order undefined — and the goal-pacing cap
  // truncates on this list. Ascending, so an imported set keeps the order it was
  // written in and the list people already see does not reverse; "newest first"
  // governs across different creation instants, which is the only span it can speak
  // for (owner ruling 2026-09-02).
  const rows = db
    .prepare(
      `SELECT * FROM goals
       WHERE profile_id = ?
       ORDER BY archived ASC,
                CASE status WHEN 'active' THEN 0 ELSE 1 END,
                created_at DESC,
                id ASC`
    )
    .all(profileId) as StoredOutcomeGoal[];
  return rows.map(({ category, ...goal }) => {
    const kind = outcomeGoalKind(goal);
    return {
      ...goal,
      kind,
      categoryLabel: kind === "freeform" ? category : null,
    };
  });
});

export type { GoalProgress } from "../../goal-progress";

// Auto-derived progress for exercise-linked and body-metric goals. Freeform
// goals (manual) are omitted. One scan over the relevant sets.
export function getOutcomeGoalProgressMap(
  profileId: number,
  goals: OutcomeGoal[]
): Map<number, GoalProgress> {
  const out = new Map<number, GoalProgress>();
  const measuredGoals = goals.filter(
    (goal) =>
      goal.body_metric ||
      isBiomarkerGoal(goal) ||
      (goal.exercise && goal.metric)
  );
  if (measuredGoals.length === 0) return out;
  const timezone = getTimezone(profileId);
  const periodStartDates = new Map(
    measuredGoals.map((goal) => [
      goal.id,
      dateFromCreatedAt(goal.created_at, timezone),
    ])
  );

  // Body-metric goals: latest body-metric value vs baseline → target.
  const bodyGoals = goals.filter((g) => g.body_metric);
  if (bodyGoals.length) {
    const points: Record<BodyMetricKind, { date: string; value: number }[]> = {
      weight: getLatestBodyMetricDailyPoints(profileId, "weight"),
      body_fat: getLatestBodyMetricDailyPoints(profileId, "body_fat"),
      resting_hr: getLatestBodyMetricDailyPoints(profileId, "resting_hr"),
    };
    for (const g of bodyGoals) {
      const series = points[g.body_metric!];
      const current = computeBodyGoalProgress(g, series.at(-1)?.value ?? null);
      const createdDay = periodStartDates.get(g.id) ?? null;
      const hasGoalPeriodEvidence =
        createdDay != null && series.some((point) => point.date >= createdDay);
      const baseline =
        hasGoalPeriodEvidence && g.baseline_value != null
          ? computeBodyGoalProgress(g, g.baseline_value)
          : null;
      out.set(g.id, {
        ...current,
        ...(createdDay ? { periodStartDate: createdDay } : {}),
        previous:
          baseline && createdDay
            ? {
                pct: baseline.pct,
                done: baseline.done,
                comparisonDate: createdDay,
              }
            : null,
      });
    }
  }

  // Biomarker goals (#1853): the latest reading of the analyte's #482 FAMILY, in the
  // unit its own chart is labelled with. Both come from `biomarkerPlot` — the SAME
  // plot the biomarker detail page draws — so a goal card and the chart it describes
  // can never disagree about the value or the unit (#221). The check-in rhythm is the
  // analyte's curated retest cadence, resolved through the shared
  // retestDaysForBiomarker lookup rather than a goals-only interval table.
  //
  // The plots are gathered for EVERY targeted analyte in one pass (#1961), the same
  // shape as the exercise-goal loop below: a per-goal `biomarkerPlot` re-queried the
  // series and re-read the profile's demographics once per goal, which is an N+1 in
  // the goal count.
  const bmTargets = goals.filter(isBiomarkerGoal).flatMap((g) => {
    const target = biomarkerTargetOf(g);
    return target ? [{ g, target }] : [];
  });
  if (bmTargets.length) {
    const plots = biomarkerPlots(
      profileId,
      bmTargets.map((x) => x.target.name)
    );
    const bmToday = today(profileId);
    for (const { g, target } of bmTargets) {
      const plot = plots.get(target.name) ?? null;
      const progress = computeBiomarkerGoalProgress(
        target,
        plot?.points ?? [],
        plot?.unit ?? target.unit
      );
      const createdDay = periodStartDates.get(g.id) ?? null;
      const hasGoalPeriodEvidence =
        createdDay != null &&
        (plot?.points.some((point) => point.date >= createdDay) ?? false);
      const baseline =
        hasGoalPeriodEvidence && target.baselineValue != null
          ? computeBiomarkerGoalProgress(
              target,
              [{ date: createdDay, value: target.baselineValue }],
              plot?.unit ?? target.unit
            )
          : null;
      out.set(g.id, {
        ...progress,
        ...(createdDay ? { periodStartDate: createdDay } : {}),
        previous:
          baseline && createdDay
            ? {
                pct: baseline.pct,
                done: baseline.done,
                asOf: baseline.asOf,
                comparisonDate: createdDay,
              }
            : null,
        checkIn: biomarkerGoalCheckIn(
          progress.asOf,
          retestDaysForBiomarker(target.name),
          bmToday
        ),
      });
    }
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
    for (const g of exGoals)
      out.set(g.id, { ...computeGoalProgress(g, [], t), previous: null });
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
    const progress = computeGoalProgress(g, matched, t);
    const createdDay = periodStartDates.get(g.id) ?? null;
    const baselineRows = matched.filter(
      (row) => createdDay != null && row.date != null && row.date < createdDay
    );
    const hasGoalPeriodEvidence = matched.some(
      (row) => createdDay != null && row.date != null && row.date >= createdDay
    );
    const baseline = computeGoalProgress(
      g,
      baselineRows,
      createdDay ?? undefined
    );
    out.set(g.id, {
      ...progress,
      ...(createdDay ? { periodStartDate: createdDay } : {}),
      previous:
        baselineRows.length > 0 && hasGoalPeriodEvidence && createdDay
          ? {
              pct: baseline.pct,
              done: baseline.done,
              comparisonDate: createdDay,
            }
          : null,
    });
  }
  return out;
}

// The LIVE biomarker goals a given analyte carries (#1853) — what a biomarker's own
// detail page needs in order to show the target beside the series it describes,
// which is the whole point of the issue: "LDL under 100 by June" belonged next to the
// LDL chart, not in a freeform text field on another page.
//
// Matching is by the #482 FAMILY, not by raw name, and deliberately so: the readings
// that advance the goal are the family's readings (getBiomarkerSeries collapses them
// into one series), so the goal must appear on exactly the page that charts them. A
// goal anchored on "Hemoglobin A1c" therefore also shows on the page for its eAG
// re-expression — one series, one target, one answer.
//
// Reads through getOutcomeGoals, which is already profile-scoped; no new owned SQL.
export function getBiomarkerOutcomeGoals(
  profileId: number,
  canonical: string
): OutcomeGoal[] {
  const family = biomarkerFamily(canonical).toLowerCase();
  return getOutcomeGoals(profileId).filter(
    (g) =>
      isGoalLive(g) &&
      isBiomarkerGoal(g) &&
      biomarkerFamily(g.biomarker_name!).toLowerCase() === family
  );
}
