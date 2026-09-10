// GATHERS for the strength surfaces: ten statements and the calls. Every set-level
// rule these read — the equipment lane (#1610), the variant merge (#331), the
// bodyweight fold, the PR-date rule, the free-weight-only best and the implement
// category axis (#2326) — is stated ONCE in the pure tier and never re-decided here:
//
//   lib/strength-history.ts     recent-session window, load contexts, logged
//                               implements, lifetime bests
//   lib/strength-comparison.ts  the Training comparison tab's per-session math
//   lib/strength-series.ts      the dated e1RM series (plateau / progression / ladder)
//   lib/strength-stats.ts       the per-exercise all-history aggregates
//
// The split is the one lib/sleep-summary.ts + lib/queries/sleep.ts already use: rows
// in, one pure call, rows out. These modules import nothing from lib/db, so the same
// math runs in a test with typed fixtures and no database (#5172).

import { trainingActivityPageHref } from "../../hrefs";
import type { AppRoute } from "../../hrefs";
import { db, today } from "../../db";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "../../format-date";
import { summarizeExercise } from "../../training-log-format";
import {
  classifyBodyweightByExercise,
  exerciseHistoryKey,
  exerciseHistoryNames,
} from "../../lifts";
import { getProfileSex, type WeightUnit } from "../../settings";
import { shiftDateStr } from "../../date";
import {
  foldExerciseBests,
  foldExerciseLoadContexts,
  foldLoggedEquipmentByExercise,
  foldRecentExerciseHistory,
  type RecentSetRow,
} from "../../strength-history";
import {
  foldExerciseComparison,
  type ComparisonSetRow,
} from "../../strength-comparison";
import { foldE1rmSeries, type E1rmSetRow } from "../../strength-series";
import {
  foldStrengthByExercise,
  type StrengthSetRow,
} from "../../strength-stats";
import {
  strengthLadderRows,
  type StrengthLadderRow,
} from "../../strength-ladder";
import { getLatestBodyMetric } from "../metrics";
import { cache, loadWeightsAsc, recentWindowStart } from "./common";

// The pure tier owns these shapes; re-exported here so every consumer keeps reaching
// them through the `lib/queries` barrel exactly as before.
export type {
  ExerciseBest,
  ExerciseHistory,
  ExerciseHistoryMap,
  ExerciseLoadContext,
  RecentSession,
} from "../../strength-history";
export type { ExerciseCompareSession } from "../../strength-comparison";
export type { E1rmSeriesRow } from "../../strength-series";
export type { ExerciseStat, StrengthSetRow } from "../../strength-stats";

// Authoritative bodyweight KIND per exercise, resolved over ALL history (not a
// recent slice), keyed by the canonical exerciseHistoryKey so a variant and its
// base classify as one lift. Both strength builders classify through this so a
// lift last loaded with external weight >12 months ago and bodyweight-only since
// gets ONE suggestion kind on every surface — the detail panel/coaching and the
// editor chip can't disagree (#331). Mirrors strengthSetRows' filter (rep-bearing
// sets) so the shared classifier sees exactly the sets that builder counts; a lift
// with no rep-bearing set in all history is simply absent, and callers fall back to a
// name-only classification. The SQL pre-groups by raw lowercased name;
// classifyBodyweightByExercise then re-groups by the canonical key and ORs the
// external-weight sighting across variants.
// cache(): one cheap grouped scan per profile per request.
export const getExerciseBodyweightMap = cache(function getExerciseBodyweightMap(
  profileId: number
): Map<string, boolean> {
  const rows = db
    .prepare(
      `SELECT s.exercise AS exercise,
              MAX(CASE WHEN s.weight_kg IS NOT NULL OR s.weight_kg_right IS NOT NULL
                       THEN 1 ELSE 0 END) AS saw
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ?
          AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
        GROUP BY LOWER(TRIM(s.exercise))`
    )
    .all(profileId) as { exercise: string; saw: number }[];
  return classifyBodyweightByExercise(
    rows.map((r) => ({ exercise: r.exercise, hasExternalWeight: r.saw === 1 }))
  );
});

// cache(): resolved on every app navigation (the layout's activity editor) and
// again via getRecentByExercise on the Training Log and Strength pages. cache() dedupes to
// one scan per (profile, perExercise) per request. The scan is bounded to the
// recent window — the editor only needs the last few sessions, so a session older
// than 12 months is never shown. The bodyweight KIND, however, is resolved over
// ALL history via getExerciseBodyweightMap, so the editor chip classifies exactly
// like getStrengthByExercise and the detail panel (#331).
export const getRecentExerciseHistory = cache(function getRecentExerciseHistory(
  profileId: number,
  perExercise = 3
) {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              s.warmup, s.rpe, s.equipment_id, eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND a.date >= ?
       ORDER BY a.date DESC, a.id DESC, s.set_number ASC`
    )
    .all(profileId, recentWindowStart(profileId)) as RecentSetRow[];

  return foldRecentExerciseHistory(
    rows,
    loadWeightsAsc(profileId),
    getExerciseBodyweightMap(profileId),
    perExercise
  );
});

// One summarized recent session of an exercise, for the exercise detail panel.
// `href` links to the session's activity in the training log; `date`/`text` are
// preformatted so the (client) panel needs no units or formatting.
export interface RecentSessionSummary {
  date: string;
  href: AppRoute;
  equipment: string | null;
  text: string;
}

// Recent sessions per exercise, keyed by lowercased exercise name (newest first).
export type RecentByExercise = Record<string, RecentSessionSummary[]>;

// The last `limit` sessions per exercise, summarized and linked to their training log
// entry. Shared by the training log feed and the strength page so both surface the
// same history. Links are absolute so they work from any page.
export function getRecentByExercise(
  profileId: number,
  unit: WeightUnit,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  limit = 10
): RecentByExercise {
  const out: RecentByExercise = {};
  for (const [key, h] of Object.entries(
    getRecentExerciseHistory(profileId, limit)
  )) {
    out[key] = h.sessions.map((s) => ({
      date: formatLongDate(s.date, prefs),
      href: trainingActivityPageHref(s.activityId),
      equipment: s.equipment,
      text: summarizeExercise(s.sets, unit).text,
    }));
  }
  return out;
}

export type ExerciseCompareMetric = "volume" | "e1rm" | "top" | "reps";

// The load contexts one movement has been logged in, most recently used first —
// the labeled children #1610 asks Training to expose under a single top-level
// movement. Variant-collapsed by the same `exerciseHistoryNames` preimage the
// comparison scan uses, so "Barbell Curl" and "Curl" contribute to one context list
// while two registry machines stay two contexts. Profile-scoped via the JOIN.
export function getExerciseLoadContexts(profileId: number, exercise: string) {
  const key = exerciseHistoryKey(exercise);
  if (!key) return [];
  const names = exerciseHistoryNames(exercise);
  const placeholders = names.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT s.equipment_id AS equipmentId, eq.name AS equipment,
              a.date AS date, a.id AS activityId
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         LEFT JOIN equipment eq ON eq.id = s.equipment_id
        WHERE a.profile_id = ? AND LOWER(TRIM(s.exercise)) IN (${placeholders})
          AND s.warmup = 0 -- same working-set basis as the comparison itself (#338)`
    )
    .all(profileId, ...names) as {
    equipmentId: number | null;
    equipment: string | null;
    date: string;
    activityId: number;
  }[];

  return foldExerciseLoadContexts(rows);
}

// Which registry implements each MOVEMENT has been logged on, keyed by the canonical
// `exerciseHistoryKey` — the goal form's answer to "does this lift even have a load
// context to choose?" (#1610). Only real, non-null links appear: the unassigned lane
// is not an implement a goal can be scoped to, it is the absence of one.
//
// One distinct-pair scan for the whole profile, so the client form can look a lift up
// as the user types instead of round-tripping per keystroke. Profile-scoped via the
// JOIN to activities.
export function getLoggedEquipmentByExercise(
  profileId: number
): Record<string, number[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.exercise AS exercise, s.equipment_id AS equipmentId
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.equipment_id IS NOT NULL`
    )
    .all(profileId) as { exercise: string; equipmentId: number }[];
  return foldLoggedEquipmentByExercise(rows);
}

/**
 * The best the profile has already done, per logged movement (#3220) — what lets the
 * goal form state where a new target is STARTING FROM instead of asking someone to
 * remember their own PR.
 *
 * THE THREE METRICS ARE THE THREE `bestValueForGoal` CAN ANSWER FROM SQL. Weight and
 * hold fold both sides of a per-side set with MAX, exactly as that function does;
 * reps is the best single side. The `sets` metric is deliberately absent — it counts,
 * per session, the sets that clear the goal's OWN rep (and weight) bar, so it is not
 * a property of the movement's history at all and there is nothing honest to state
 * before the target exists.
 *
 * Warm-ups are excluded, matching every other read of this table for progress.
 */
export function getExerciseBests(profileId: number) {
  const rows = db
    .prepare(
      `SELECT s.exercise AS exercise,
              MAX(MAX(COALESCE(s.weight_kg, 0), COALESCE(s.weight_kg_right, 0))) AS weightKg,
              MAX(MAX(COALESCE(s.reps, 0), COALESCE(s.reps_right, 0))) AS reps,
              MAX(MAX(COALESCE(s.duration_sec, 0), COALESCE(s.duration_sec_right, 0))) AS durationSec
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND s.warmup = 0
        GROUP BY s.exercise`
    )
    .all(profileId) as {
    exercise: string;
    weightKg: number | null;
    reps: number | null;
    durationSec: number | null;
  }[];
  return foldExerciseBests(rows);
}

// Full per-session history for one exercise, used by the Training comparison tab.
//
// `opts.equipmentLane` narrows the scan to ONE load context (#1610) — the shared
// `equipmentLoadLane` string, so "none" is the explicit unassigned lane and never a
// wildcard. Omitted, the scan stays movement-wide. The narrowing itself is
// `foldExerciseComparison`'s, so the rule is stated once (#5172).
export function getExerciseComparison(
  profileId: number,
  exercise: string,
  unit: WeightUnit,
  opts: { equipmentLane?: string } = {}
) {
  // Canonical, variant-collapsed key so the comparison series merges a lift's
  // variants ("Barbell Curl"/"Curl") into one history like the other builders
  // (#331). SQLite can't call baseLiftName, but the key's preimage is a small
  // finite name set (the variant group's composed names + bare base, or just the
  // one name for a non-catalog lift), so push the filter back into SQL as an
  // `IN (...)` bound scan instead of scanning every profile row and filtering in
  // JS — identical semantics, still profile-scoped via the JOIN (#394).
  const key = exerciseHistoryKey(exercise);
  if (!key) return [];
  const names = exerciseHistoryNames(exercise);
  const placeholders = names.map(() => "?").join(", ");

  const all = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              s.equipment_id AS equipment_id, eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND LOWER(TRIM(s.exercise)) IN (${placeholders})
         AND s.warmup = 0 -- exclude warmups from the comparison metrics (#338)
       ORDER BY a.date ASC, a.id ASC, s.set_number ASC`
    )
    .all(profileId, ...names) as ComparisonSetRow[];

  return foldExerciseComparison(all, loadWeightsAsc(profileId), unit, opts);
}

// Set counts per exercise since `since` (YYYY-MM-DD, inclusive), for the training-
// balance observation (issue #45, domain 4): the push/pull volume split over a
// trailing window. One exercise_sets row = one set (a per-side set counts once). The
// pure lib/training-observations maps each exercise → movement pattern and sums.
// Profile-scoped via the activities JOIN.
export function getExerciseSetCountsSince(
  profileId: number,
  since: string
): { exercise: string; sets: number }[] {
  return db
    .prepare(
      `SELECT s.exercise AS exercise, COUNT(*) AS sets
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND a.date >= ?
          AND s.warmup = 0 -- warmups don't count toward push/pull volume (#338)
        GROUP BY s.exercise`
    )
    .all(profileId, since) as { exercise: string; sets: number }[];
}

// Per-exercise dated estimated-1RM series (best e1RM per session date, ascending),
// for plateau detection (issue #45, domain 4). The fold is `foldE1rmSeries`, which
// mirrors the per-exercise stats' per-set e1RM math (Epley, with bodyweight folded
// into the load for catalog bodyweight lifts) but keys by session DATE so the pure
// lib/training-observations can fit a robust slope over the recent window.
//
// `since` (YYYY-MM-DD, inclusive) optionally bounds the scan to a trailing window.
// The only caller (buildTrainingObservationFindings → detectPlateaus) windows each
// series to the last PLATEAU_WINDOW_DAYS anyway, so passing that cutoff makes the
// rep-bearing-history scan a free win (issue #389) with no change to the plateau
// output. `until` closes the other end for the Trends → Fitness strength-
// progression section (#1492), which reads this SAME series inside the hub's
// shared window instead of forking a windowed 1RM engine of its own. Omit both for
// the full lifetime series.
//
// `opts.byLoadContext` (#1610) adds the EQUIPMENT axis to the grouping, and
// `opts.freeWeightOnly` (#3132) the EQUIPMENT-CATEGORY restriction. Both stay OPT-IN
// because the lanes answer different questions — plateau detection and the Trends
// progression chart want the lifter's real e1RM history, machine included, while the
// standards ladder must place BOTH of its dots from the one lane it can score. The
// SQL scan and per-set math are identical either way (one computation, one grouping
// choice); see lib/strength-series.ts for what each flag decides.
export function getExerciseE1rmSeries(
  profileId: number,
  since?: string,
  until?: string,
  opts: { byLoadContext?: boolean; freeWeightOnly?: boolean } = {}
) {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.equipment_id AS equipmentId, eq.name AS equipment,
              -- …and the implement's CATEGORY, the axis a free-weight-restricted
              -- series reads (#2326/#3132). Always selected; only read when asked for.
              eq.category AS equipmentCategory
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
         LEFT JOIN equipment eq ON eq.id = s.equipment_id
        WHERE a.profile_id = ? AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
          AND s.warmup = 0 -- warmups don't seed the plateau e1RM series (#338)
          AND (? IS NULL OR a.date >= ?)
          AND (? IS NULL OR a.date <= ?)
        ORDER BY a.date ASC, a.id ASC`
    )
    .all(
      profileId,
      since ?? null,
      since ?? null,
      until ?? null,
      until ?? null
    ) as E1rmSetRow[];

  return foldE1rmSeries(rows, loadWeightsAsc(profileId), opts);
}

// Total working volume (kg lifted) per session date, ascending. `since`/`until`
// (YYYY-MM-DD, inclusive) optionally bound it to a window — the SAME computation,
// windowed (#1492/#221): the Trends → Fitness volume chart passes the hub's shared
// range, /training passes neither and keeps its full-history series.
//
// No pure fold: the sum IS the SQL aggregate, with no set-level arithmetic in JS to
// extract. Bodyweight is deliberately NOT folded in here — this series answers "how
// much external load moved", which is why a bodyweight-only day contributes nothing.
export function getVolumeByDate(
  profileId: number,
  since?: string,
  until?: string
) {
  return db
    .prepare(
      `SELECT a.date AS date,
              SUM(COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
                  + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)) AS volume
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ?
         AND ((s.weight_kg IS NOT NULL AND s.reps IS NOT NULL)
          OR (s.weight_kg_right IS NOT NULL AND s.reps_right IS NOT NULL))
         AND s.warmup = 0 -- warmups aren't working volume (#338)
         AND (? IS NULL OR a.date >= ?)
         AND (? IS NULL OR a.date <= ?)
       GROUP BY a.date ORDER BY a.date ASC`
    )
    .all(
      profileId,
      since ?? null,
      since ?? null,
      until ?? null,
      until ?? null
    ) as {
    date: string;
    volume: number;
  }[];
}

// THE all-history strength scan — the single unbounded read every strength aggregate
// is folded from, hoisted out of getStrengthByExercise so the two GROUPINGS of it
// (#1610's movement-wide and load-context lists) share ONE scan (#1654).
//
// cache(): a single Training render asks for this 3–5× (Log, Overview, Analyze and
// Strength sections, plus the dashboard coaching context), and since #1610 two of
// those surfaces ask for BOTH groupings in the same request. Keyed on profileId
// alone, so a grouping choice can never mint a second scan. Safe: it's a pure read,
// and write actions revalidate rather than re-reading in the same request.
export const strengthSetRows = cache(function strengthSetRows(
  profileId: number
): StrengthSetRow[] {
  return db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.target_reps, s.to_failure, s.rpe,
              -- The per-set implement link (#1610): the newest session's own load
              -- context, so the forward-looking seed can't blend two machines
              -- that were both logged under the same exact exercise name — and the
              -- grouping lane itself when byLoadContext is asked for.
              s.equipment_id AS equipmentId, eq.name AS equipment,
              -- …and its category, the axis the free-weight standing reads (#2326).
              eq.category AS equipmentCategory
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       -- Any set with reps, weighted OR bodyweight (bodyweight sets store a
       -- NULL weight); the load is resolved per exercise in the fold. Warmups are
       -- excluded (#338) — inert to e1RM, best/top weight, volume, PRs and the
       -- next-set seed alike.
       WHERE a.profile_id = ? AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
         AND s.warmup = 0
       -- date+id ascending so the last row of an exercise is its newest session.
       ORDER BY a.date ASC, a.id ASC`
    )
    .all(profileId) as StrengthSetRow[];
});

// `byLoadContext` (#1610) groups on `movementLoadKey` instead of `exerciseHistoryKey`
// — one row per (movement, implement) rather than one per movement. It is a PRIMITIVE
// second argument on purpose: cache() keys on argument identity, and an options object
// literal would mint a fresh key (and a fresh regrouping) on every call.
//
// Opt-in, like `getExerciseE1rmSeries`'s: a movement-wide list (Analyze's picker, the
// exercise detail panel, the coaching seed) must stay one row per movement, and a
// caller that DOES split must label its rows through `loadContextLabel` — #1610
// forbids duplicate unlabeled rows.
//
// What the two groupings must never do is read the history twice — since #1654 both
// fold the one cached `strengthSetRows` scan. `foldStrengthByExercise` owns everything
// after that, including the short-circuit that makes an implement-free profile's two
// lists identical rather than merely equivalent.
export const getStrengthByExercise = cache(function getStrengthByExercise(
  profileId: number,
  byLoadContext = false
) {
  return foldStrengthByExercise(
    strengthSetRows(profileId),
    loadWeightsAsc(profileId),
    today(profileId),
    byLoadContext
  );
});

// The Overview strength-standards ladder's rows (#3089), assembled here rather than
// in the page so BOTH of its dots are read from ONE measurement lane and that choice
// is provable (#3132).
//
// The current dot is `freeWeightE1rmKg` — a machine-backed set states nothing against
// a barbell population table (#2326) — so the prior dot has to come from the SAME
// free-weight-restricted history. Reading it from the unfiltered series compared two
// different measurements: it placed a prior standing bands above a lifter's real
// free-weight standing (a regression they never had), and the inflated prior held
// `moved` false so a genuine free-weight PR lost its "· PR" suffix and its place in
// the movement sort.
//
// `PRIOR_WINDOW_DAYS` back is "about 90 days ago" as the ladder labels it. A lift
// with no free-weight point that old simply gets no prior dot — the one-dot state the
// Longevity pillar already renders.
const PRIOR_WINDOW_DAYS = 90;
export function getStrengthLadder(
  profileId: number,
  todayStr: string
): StrengthLadderRow[] {
  const series = new Map(
    getExerciseE1rmSeries(profileId, undefined, undefined, {
      freeWeightOnly: true,
    }).map((row) => [exerciseHistoryKey(row.exercise), row])
  );
  return strengthLadderRows(
    getStrengthByExercise(profileId).map((stat) => ({
      exercise: stat.exercise,
      currentE1rmKg: stat.freeWeightE1rmKg,
      points: series.get(exerciseHistoryKey(stat.exercise))?.points ?? [],
    })),
    shiftDateStr(todayStr, -PRIOR_WINDOW_DAYS),
    getProfileSex(profileId),
    getLatestBodyMetric(profileId, "weight")
  );
}
