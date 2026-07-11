import { bodyweightAsOf } from "../../bodyweight";
import {
  sessionBestSet,
  sessionWorkSets,
  type SessionWorkSet,
} from "../../coaching";
import { db } from "../../db";
import { formatLongDate } from "../../format-date";
import type { SetStatus } from "../../journal-format";
import { judgeTargets, summarizeExercise } from "../../journal-format";
import { isBodyweight } from "../../lifts";
import type { WeightUnit } from "../../settings";
import { estimate1RM } from "../../strength";
import { cache, loadWeightsAsc, recentWindowStart } from "./common";

export interface RecentSession {
  date: string;
  // The activity this session belongs to (for linking to it in the journal).
  activityId: number;
  // User-defined implement used in the session (first non-null), else null.
  equipment: string | null;
  // Bodyweight to fold into set loads when ranking this session's sets for
  // next-set seeding: the bodyweight as of the session date for catalog
  // bodyweight lifts, 0 otherwise — the same base getStrengthByExercise folds.
  baseKg: number;
  // Hit/missed the declared rep targets (null when none were declared).
  // Judged here so the journal card and editor needn't re-derive it.
  status: SetStatus;
  sets: {
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    // Declared intent (planned reps / AMRAP), shipped so the activity editor
    // can seed next-set suggestions off the newest session.
    target_reps: number | null;
    to_failure: number | null;
  }[];
}

// One exercise's recent history for the activity editor.
export interface ExerciseHistory {
  // Body is (part of) the load: a catalog bodyweight lift, or an exercise
  // never logged with an external weight anywhere in its history. Resolved
  // here (over ALL rows, not just the shipped sessions) so the editor's
  // next-set suggestion classifies exactly like getStrengthByExercise and the
  // exercise detail panel.
  bodyweight: boolean;
  // Most recent sessions, newest first.
  sessions: RecentSession[];
}

// exercise name (lowercased) -> history
export type ExerciseHistoryMap = Record<string, ExerciseHistory>;

// cache(): resolved on every app navigation (the layout's activity editor) and
// again via getRecentByExercise on the journal/strength pages. cache() dedupes to
// one scan per (profile, perExercise) per request. The scan is bounded to the
// recent window — the editor only needs the last few sessions, so a session older
// than 12 months is never shown (and the bodyweight classification below is
// resolved over that same window rather than all-time).
export const getRecentExerciseHistory = cache(function getRecentExerciseHistory(
  profileId: number,
  perExercise = 3
): ExerciseHistoryMap {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND a.date >= ?
       ORDER BY a.date DESC, a.id DESC, s.set_number ASC`
    )
    .all(profileId, recentWindowStart(profileId)) as {
    exercise: string;
    date: string;
    activity_id: number;
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
    equipment: string | null;
  }[];

  const weights = loadWeightsAsc(profileId);

  type AccumSession = Omit<RecentSession, "status">;
  interface AccumExercise {
    addBodyweight: boolean; // catalog bodyweight lift
    sawExternalWeight: boolean; // any set in the recent window logged a weight
    sessions: AccumSession[];
  }
  const acc = new Map<string, AccumExercise>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    let e = acc.get(key);
    if (!e) {
      e = {
        addBodyweight: isBodyweight(r.exercise),
        sawExternalWeight: false,
        sessions: [],
      };
      acc.set(key, e);
    }
    // Tracked across every row in the window — including sessions past the cap
    // below — so the resolved bodyweight flag reflects all recent history, not
    // just the shipped sessions.
    if (r.weight_kg != null || r.weight_kg_right != null)
      e.sawExternalWeight = true;
    let last = e.sessions[e.sessions.length - 1];
    if (!last || last.activityId !== r.activity_id) {
      if (e.sessions.length >= perExercise) continue; // have enough sessions
      last = {
        activityId: r.activity_id,
        date: r.date,
        equipment: null,
        baseKg: e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0,
        sets: [],
      };
      e.sessions.push(last);
    }
    if (last.equipment == null && r.equipment) last.equipment = r.equipment;
    last.sets.push({
      set_number: r.set_number,
      weight_kg: r.weight_kg,
      reps: r.reps,
      weight_kg_right: r.weight_kg_right,
      reps_right: r.reps_right,
      duration_sec: r.duration_sec,
      duration_sec_right: r.duration_sec_right,
      target_reps: r.target_reps,
      to_failure: r.to_failure,
    });
  }

  const out: ExerciseHistoryMap = {};
  for (const [key, e] of acc) {
    out[key] = {
      bodyweight: e.addBodyweight || !e.sawExternalWeight,
      sessions: e.sessions.map((sess) => ({
        ...sess,
        status: judgeTargets(sess.sets),
      })),
    };
  }
  return out;
});

// One summarized recent session of an exercise, for the exercise detail panel.
// `href` links to the session's activity in the journal; `date`/`text` are
// preformatted so the (client) panel needs no units or formatting.
export interface RecentSessionSummary {
  date: string;
  href: string;
  equipment: string | null;
  text: string;
}

// Recent sessions per exercise, keyed by lowercased exercise name (newest first).
export type RecentByExercise = Record<string, RecentSessionSummary[]>;

// The last `limit` sessions per exercise, summarized and linked to their journal
// entry. Shared by the journal feed and the strength page so both surface the
// same history. Links are absolute so they work from any page.
export function getRecentByExercise(
  profileId: number,
  unit: WeightUnit,
  limit = 10
): RecentByExercise {
  const out: RecentByExercise = {};
  for (const [key, h] of Object.entries(
    getRecentExerciseHistory(profileId, limit)
  )) {
    out[key] = h.sessions.map((s) => ({
      date: formatLongDate(s.date),
      href: `/training?tab=log#activity-${s.activityId}`,
      equipment: s.equipment,
      text: summarizeExercise(s.sets, unit).text,
    }));
  }
  return out;
}

export type ExerciseCompareMetric = "volume" | "e1rm" | "top" | "reps";

export interface ExerciseCompareSession {
  date: string;
  activityId: number;
  equipment: string | null;
  setCount: number;
  totalReps: number;
  volumeKg: number;
  topWeightKg: number | null;
  topReps: number | null;
  e1rmKg: number | null;
  summary: string;
}

// Full per-session history for one exercise, used by the Training comparison
// tab. This keeps the set-level math in the query layer so the page component can
// stay focused on controls and presentation.
export function getExerciseComparison(
  profileId: number,
  exercise: string,
  unit: WeightUnit
): ExerciseCompareSession[] {
  const key = exercise.trim().toLowerCase();
  if (!key) return [];

  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id, s.set_number,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.duration_sec, s.duration_sec_right, s.target_reps, s.to_failure,
              eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       WHERE a.profile_id = ? AND LOWER(TRIM(s.exercise)) = ?
       ORDER BY a.date ASC, a.id ASC, s.set_number ASC`
    )
    .all(profileId, key) as {
    exercise: string;
    date: string;
    activity_id: number;
    set_number: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    duration_sec: number | null;
    duration_sec_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
    equipment: string | null;
  }[];

  if (rows.length === 0) return [];

  const addBodyweight = isBodyweight(rows[0].exercise);
  const weights = loadWeightsAsc(profileId);
  const bySession = new Map<
    number,
    {
      date: string;
      activityId: number;
      equipment: string | null;
      rows: typeof rows;
    }
  >();

  for (const r of rows) {
    let session = bySession.get(r.activity_id);
    if (!session) {
      session = {
        date: r.date,
        activityId: r.activity_id,
        equipment: null,
        rows: [],
      };
      bySession.set(r.activity_id, session);
    }
    if (session.equipment == null && r.equipment)
      session.equipment = r.equipment;
    session.rows.push(r);
  }

  return [...bySession.values()].map((s) => {
    const baseKg = addBodyweight ? (bodyweightAsOf(weights, s.date) ?? 0) : 0;
    let totalReps = 0;
    let volumeKg = 0;
    let topWeightKg: number | null = null;
    let topReps: number | null = null;
    let e1rmKg: number | null = null;

    for (const r of s.rows) {
      const sides: { weight: number; reps: number }[] = [];
      if (r.reps != null)
        sides.push({ weight: baseKg + (r.weight_kg ?? 0), reps: r.reps });
      if (r.reps_right != null)
        sides.push({
          weight: baseKg + (r.weight_kg_right ?? 0),
          reps: r.reps_right,
        });

      for (const side of sides) {
        totalReps += side.reps;
        volumeKg += side.weight * side.reps;
        if (topWeightKg == null || side.weight > topWeightKg) {
          topWeightKg = side.weight;
          topReps = side.reps;
        }
        const estimate = estimate1RM(side.weight, side.reps);
        if (
          e1rmKg == null ||
          estimate > e1rmKg ||
          (estimate === e1rmKg && side.reps > (topReps ?? 0))
        ) {
          e1rmKg = estimate;
        }
      }
    }

    return {
      date: s.date,
      activityId: s.activityId,
      equipment: s.equipment,
      setCount: s.rows.length,
      totalReps,
      volumeKg,
      topWeightKg,
      topReps,
      e1rmKg,
      summary: summarizeExercise(s.rows, unit).text,
    };
  });
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
        GROUP BY s.exercise`
    )
    .all(profileId, since) as { exercise: string; sets: number }[];
}

// Per-exercise dated estimated-1RM series (best e1RM per session date, ascending),
// for plateau detection (issue #45, domain 4). Mirrors getStrengthByExercise's
// per-set e1RM math (Epley, with bodyweight folded into the load for catalog
// bodyweight lifts) but keyed by session DATE so the pure lib/training-observations
// can fit a robust slope over the recent window. Sessions whose best e1RM is 0
// (bodyweight lifts with no known bodyweight) are omitted — a flat-zero series is not
// a plateau. Profile-scoped via the activities JOIN.
export function getExerciseE1rmSeries(
  profileId: number
): { exercise: string; points: { date: string; value: number }[] }[] {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right
         FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
        WHERE a.profile_id = ? AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
        ORDER BY a.date ASC`
    )
    .all(profileId) as {
    exercise: string;
    date: string;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
  }[];

  const weights = loadWeightsAsc(profileId);
  // exercise (lower) -> { display name, date -> best e1rm }
  const acc = new Map<
    string,
    { exercise: string; addBodyweight: boolean; byDate: Map<string, number> }
  >();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    let e = acc.get(key);
    if (!e) {
      e = {
        exercise: r.exercise,
        addBodyweight: isBodyweight(r.exercise),
        byDate: new Map(),
      };
      acc.set(key, e);
    }
    const base = e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0;
    const sides: number[] = [];
    if (r.reps != null)
      sides.push(estimate1RM(base + (r.weight_kg ?? 0), r.reps));
    if (r.reps_right != null)
      sides.push(estimate1RM(base + (r.weight_kg_right ?? 0), r.reps_right));
    for (const e1rm of sides) {
      const prev = e.byDate.get(r.date) ?? 0;
      if (e1rm > prev) e.byDate.set(r.date, e1rm);
    }
  }

  const out: { exercise: string; points: { date: string; value: number }[] }[] =
    [];
  for (const e of acc.values()) {
    const points = [...e.byDate.entries()]
      .filter(([, v]) => v > 0)
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length > 0) out.push({ exercise: e.exercise, points });
  }
  return out;
}

export function getVolumeByDate(profileId: number) {
  return db
    .prepare(
      `SELECT a.date AS date,
              SUM(COALESCE(s.weight_kg, 0) * COALESCE(s.reps, 0)
                  + COALESCE(s.weight_kg_right, 0) * COALESCE(s.reps_right, 0)) AS volume
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       WHERE a.profile_id = ?
         AND ((s.weight_kg IS NOT NULL AND s.reps IS NOT NULL)
          OR (s.weight_kg_right IS NOT NULL AND s.reps_right IS NOT NULL))
       GROUP BY a.date ORDER BY a.date ASC`
    )
    .all(profileId) as { date: string; volume: number }[];
}

// Per-exercise strength stats for the combined Strength page: best set,
// Epley estimated 1RM, top weight, session count, and a training-volume
// series over time (one point per session date, ascending).
export interface ExerciseStat {
  exercise: string;
  sessions: number; // distinct dates trained
  totalSets: number;
  topWeightKg: number;
  e1rmKg: number;
  bestWeightKg: number;
  bestReps: number;
  bestDate: string;
  // Date the heaviest load (topWeightKg) was first hit — for PR detection.
  topWeightDate: string;
  lastDate: string;
  // Best working set of the most recent session (highest estimated 1RM, then
  // most reps), used to seed next-set suggestions. Null when the newest session
  // had no usable set. Carries that set's declared intent (planned rep count /
  // AMRAP) so progression can honor the user's rep scheme.
  lastSessionBest: {
    weightKg: number;
    reps: number;
    targetReps: number | null;
    toFailure: boolean;
  } | null;
  // Every rep-bearing set of the most recent session (bodyweight folded into the
  // load, each side of a per-side set its own entry), so next-set progression
  // can judge the whole session's working sets rather than the single best set
  // (#330). Empty when the newest session had no usable set.
  lastSessionSets: SessionWorkSet[];
  // Activity id of the most recent session, for linking to its journal entry.
  lastActivityId: number;
  // Body itself is the load (pull ups, dips), so per-set numbers show "BW".
  // topWeightKg/e1rmKg/bestWeightKg still carry the real load (bodyweight + any
  // added weight) for the volume chart and × bodyweight multiple.
  bodyweight: boolean;
  // The volume series holds total reps (not kg) — true only for bodyweight lifts
  // with no known bodyweight, where weight×reps would be a flat zero.
  volumeIsReps: boolean;
  volume: { date: string; volumeKg: number }[];
}

// cache(): a single Training render aggregates every set 3–4× (Log, Overview,
// Analyze, Strength sections all call this), and the dashboard coaching context
// reads it again — cache() collapses the all-history scan to one per profile per
// request. Safe: it's a pure read, and write actions revalidate rather than
// re-reading in the same request.
export const getStrengthByExercise = cache(function getStrengthByExercise(
  profileId: number
): ExerciseStat[] {
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date, a.id AS activity_id,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.target_reps, s.to_failure
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       -- Any set with reps, weighted OR bodyweight (bodyweight sets store a
       -- NULL weight); the load is resolved per exercise below.
       WHERE a.profile_id = ? AND (s.reps IS NOT NULL OR s.reps_right IS NOT NULL)
       -- date+id ascending so the last row of an exercise is its newest session.
       ORDER BY a.date ASC, a.id ASC`
    )
    .all(profileId) as {
    exercise: string;
    date: string;
    activity_id: number;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    target_reps: number | null;
    to_failure: number | null;
  }[];

  const weights = loadWeightsAsc(profileId);
  const bwAsOf = (date: string) => bodyweightAsOf(weights, date);

  interface Acc {
    exercise: string;
    addBodyweight: boolean; // catalog bodyweight lift → fold bodyweight into load
    sawExternalWeight: boolean; // any set logged a weight
    dates: Set<string>;
    totalSets: number;
    topWeightKg: number;
    topWeightDate: string;
    e1rmKg: number;
    bestWeightKg: number;
    bestReps: number;
    bestDate: string;
    lastDate: string;
    lastActivityId: number;
    // Raw rows of the most recent session (same date, across activities),
    // ranked into lastSessionBest by sessionBestSet at the end — the single
    // shared definition of a session's seeding set (lib/coaching).
    lastSessionRows: (typeof rows)[number][];
    volByDate: Map<string, number>;
    repsByDate: Map<string, number>;
  }
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const key = r.exercise.trim().toLowerCase();
    let cur = map.get(key);
    if (!cur) {
      cur = {
        exercise: r.exercise,
        addBodyweight: isBodyweight(r.exercise),
        sawExternalWeight: false,
        dates: new Set(),
        totalSets: 0,
        topWeightKg: 0,
        topWeightDate: r.date,
        // Sentinel so the first set always seeds the "best" fields, even for
        // bodyweight lifts where every set's estimated 1RM is 0.
        e1rmKg: -1,
        bestWeightKg: 0,
        bestReps: 0,
        bestDate: r.date,
        lastDate: r.date,
        lastActivityId: r.activity_id,
        lastSessionRows: [],
        volByDate: new Map(),
        repsByDate: new Map(),
      };
      map.set(key, cur);
    }
    cur.dates.add(r.date);
    cur.totalSets += 1;
    // Advance the most-recent-session pointer (rows are date+id ascending). On a
    // strictly newer date, reset the per-session row buffer so it reflects only
    // the latest session.
    if (r.date > cur.lastDate) {
      cur.lastDate = r.date;
      cur.lastActivityId = r.activity_id;
      cur.lastSessionRows = [];
    } else if (r.date === cur.lastDate) {
      cur.lastActivityId = r.activity_id; // keep the latest activity id for the day
    }
    cur.lastSessionRows.push(r); // r.date === cur.lastDate after the advance
    if (r.weight_kg != null || r.weight_kg_right != null)
      cur.sawExternalWeight = true;
    // For bodyweight lifts the body is the load: total = bodyweight + any added
    // weight. For everything else the logged weight is the total.
    const base = cur.addBodyweight ? (bwAsOf(r.date) ?? 0) : 0;
    // For per-side sets, evaluate each side as its own candidate so a stronger
    // side isn't hidden; volume below counts both sides. Each side counts only
    // when it has reps.
    const sides: { weight: number; reps: number }[] = [];
    if (r.reps != null)
      sides.push({ weight: base + (r.weight_kg ?? 0), reps: r.reps });
    if (r.reps_right != null)
      sides.push({
        weight: base + (r.weight_kg_right ?? 0),
        reps: r.reps_right,
      });
    let setVol = 0;
    let setReps = 0;
    for (const side of sides) {
      // Strict compare (not Math.max) so topWeightDate records when the heaviest
      // load was *first* reached.
      if (side.weight > cur.topWeightKg) {
        cur.topWeightKg = side.weight;
        cur.topWeightDate = r.date;
      }
      const e1rm = estimate1RM(side.weight, side.reps);
      // Better = higher estimated 1RM; on a tie (e.g. bodyweight lifts), more reps.
      if (
        e1rm > cur.e1rmKg ||
        (e1rm === cur.e1rmKg && side.reps > cur.bestReps)
      ) {
        cur.e1rmKg = e1rm;
        cur.bestWeightKg = side.weight;
        cur.bestReps = side.reps;
        cur.bestDate = r.date;
      }
      setVol += side.weight * side.reps;
      setReps += side.reps;
    }
    cur.volByDate.set(r.date, (cur.volByDate.get(r.date) ?? 0) + setVol);
    cur.repsByDate.set(r.date, (cur.repsByDate.get(r.date) ?? 0) + setReps);
  }

  return [...map.values()]
    .map((c) => {
      // Show "BW" for catalog bodyweight lifts, and for any exercise logged with
      // no weight at all. The chart falls back to reps only when there's no
      // usable load (bodyweight unknown), since weight×reps would be flat zero.
      const bodyweight = c.addBodyweight || !c.sawExternalWeight;
      const volumeIsReps = bodyweight && c.topWeightKg === 0;
      return {
        exercise: c.exercise,
        sessions: c.dates.size,
        totalSets: c.totalSets,
        topWeightKg: c.topWeightKg,
        topWeightDate: c.topWeightDate,
        e1rmKg: Math.max(0, c.e1rmKg),
        bestWeightKg: c.bestWeightKg,
        bestReps: c.bestReps,
        bestDate: c.bestDate,
        lastActivityId: c.lastActivityId,
        // All buffered rows share lastDate, so the bodyweight base is constant.
        lastSessionBest: sessionBestSet(
          c.lastSessionRows,
          c.addBodyweight ? (bwAsOf(c.lastDate) ?? 0) : 0
        ),
        lastSessionSets: sessionWorkSets(
          c.lastSessionRows,
          c.addBodyweight ? (bwAsOf(c.lastDate) ?? 0) : 0
        ),
        lastDate: c.lastDate,
        bodyweight,
        volumeIsReps,
        volume: [...(volumeIsReps ? c.repsByDate : c.volByDate).entries()]
          .map(([date, volumeKg]) => ({ date, volumeKg }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    })
    .sort((a, b) => b.e1rmKg - a.e1rmKg);
});
