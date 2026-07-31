import { bodyweightAsOf } from "../../bodyweight";
import { journalActivityHref } from "../../timeline-format";
import type { AppRoute } from "../../hrefs";
import {
  sessionBestSet,
  sessionWorkSets,
  type SessionWorkSet,
} from "../../coaching";
import { db, today } from "../../db";
import { isSeedFresh, pickSeedSessions } from "../../exercise-window";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "../../format-date";
import type { SetStatus } from "../../journal-format";
import { judgeTargets, summarizeExercise } from "../../journal-format";
import {
  classifyBodyweightByExercise,
  equipmentLoadLane,
  exerciseHistoryKey,
  exerciseHistoryNames,
  isBodyweight,
  movementLoadKey,
  resolveBodyweightKind,
} from "../../lifts";
import type { WeightUnit } from "../../settings";
import { estimate1RM } from "../../strength";
import { cache, loadWeightsAsc, recentWindowStart } from "./common";

export interface RecentSession {
  date: string;
  // The exact exercise name logged for this session's sets. History now merges a
  // lift's variants under one canonical key (#331), so each session carries its
  // own logged name — the only place the specific variant spelling survives the
  // merge, so the editor can still recover the last-used variant/implement.
  exercise: string;
  // The activity this session belongs to (for linking to it in the journal).
  activityId: number;
  // User-defined implement used in the session (first non-null), else null.
  equipment: string | null;
  // The registry equipment id behind `equipment` (first non-null), else null — the
  // session's LOAD CONTEXT (#1610). Two machines serialize as the same exact
  // exercise name, so this is the only datum that keeps their seeds, "Recent"
  // reference and next-set suggestions from bleeding into each other. null is the
  // explicit unassigned/default lane, never a wildcard.
  equipmentId: number | null;
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
    // Warmup flag (#338), shipped so the editor's seed excludes it (via
    // sessionBestSet/sessionWorkSets) and its status judgment ignores it, while
    // the Recent panel still SHOWS it.
    warmup: number | null;
    // Logged RPE (5–10) for the set, or null. Shipped so the editor's seed can
    // carry the anchor's rating into the progression modifier (#743) and the
    // Recent panel can show it.
    rpe: number | null;
  }[];
}

// One exercise's recent history for the activity editor.
export interface ExerciseHistory {
  // Body is (part of) the load: a catalog bodyweight lift, or an exercise
  // never logged with an external weight anywhere in its history. Sourced from
  // getExerciseBodyweightMap (resolved over ALL history, not just this window's
  // shipped sessions, and keyed by the canonical exerciseHistoryKey) so the
  // editor's next-set suggestion classifies exactly like getStrengthByExercise
  // and the exercise detail panel (#331).
  bodyweight: boolean;
  // Most recent sessions, newest first.
  sessions: RecentSession[];
}

// exercise history key (canonical, variant-collapsed) -> history
export type ExerciseHistoryMap = Record<string, ExerciseHistory>;

// Authoritative bodyweight KIND per exercise, resolved over ALL history (not a
// recent slice), keyed by the canonical exerciseHistoryKey so a variant and its
// base classify as one lift. Both strength builders classify through this so a
// lift last loaded with external weight >12 months ago and bodyweight-only since
// gets ONE suggestion kind on every surface — the detail panel/coaching and the
// editor chip can't disagree (#331). Mirrors getStrengthByExercise's row filter
// (rep-bearing sets) so the shared classifier sees exactly the sets that builder
// counts; a lift with no rep-bearing set in all history is simply absent, and
// callers fall back to a name-only classification. The SQL pre-groups by raw
// lowercased name; classifyBodyweightByExercise then re-groups by the canonical
// key and ORs the external-weight sighting across variants.
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
// again via getRecentByExercise on the journal/strength pages. cache() dedupes to
// one scan per (profile, perExercise) per request. The scan is bounded to the
// recent window — the editor only needs the last few sessions, so a session older
// than 12 months is never shown. The bodyweight KIND, however, is resolved over
// ALL history via getExerciseBodyweightMap, so the editor chip classifies exactly
// like getStrengthByExercise and the detail panel (#331).
export const getRecentExerciseHistory = cache(function getRecentExerciseHistory(
  profileId: number,
  perExercise = 3
): ExerciseHistoryMap {
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
    warmup: number | null;
    rpe: number | null;
    equipment_id: number | null;
    equipment: string | null;
  }[];

  const weights = loadWeightsAsc(profileId);

  type AccumSession = Omit<RecentSession, "status">;
  interface AccumExercise {
    addBodyweight: boolean; // catalog bodyweight lift
    // Window-local external-weight sighting, used ONLY as a fallback classifier
    // for an exercise absent from the all-history bodyweight map (one with no
    // rep-bearing set anywhere); the shipped flag prefers the map (#331).
    sawExternalWeight: boolean;
    sessions: AccumSession[];
  }
  const acc = new Map<string, AccumExercise>();
  for (const r of rows) {
    // Canonical, variant-collapsed key so "Barbell Curl"/"Curl" merge into one
    // history here exactly as in getStrengthByExercise (#331).
    const key = exerciseHistoryKey(r.exercise);
    let e = acc.get(key);
    if (!e) {
      e = {
        addBodyweight: isBodyweight(r.exercise),
        sawExternalWeight: false,
        sessions: [],
      };
      acc.set(key, e);
    }
    // Fallback-only sighting (see AccumExercise.sawExternalWeight): the shipped
    // KIND comes from the all-history map below.
    if (r.weight_kg != null || r.weight_kg_right != null)
      e.sawExternalWeight = true;
    let last = e.sessions[e.sessions.length - 1];
    if (!last || last.activityId !== r.activity_id) {
      if (e.sessions.length >= perExercise) continue; // have enough sessions
      last = {
        exercise: r.exercise,
        activityId: r.activity_id,
        date: r.date,
        equipment: null,
        equipmentId: null,
        baseKg: e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0,
        sets: [],
      };
      e.sessions.push(last);
    }
    // First non-null implement of the session, id and label resolved together so
    // the load context (#1610) and the rendered label can never disagree.
    if (last.equipmentId == null && r.equipment_id != null) {
      last.equipmentId = r.equipment_id;
      last.equipment = r.equipment;
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
      warmup: r.warmup,
      rpe: r.rpe,
    });
  }

  // Authoritative all-history classification (#331). An exercise present here but
  // absent from the map has no rep-bearing set in all history — fall back to its
  // window-local sighting so the classifier still answers.
  const bwMap = getExerciseBodyweightMap(profileId);
  const out: ExerciseHistoryMap = {};
  for (const [key, e] of acc) {
    out[key] = {
      // `key` is the lowercased/trimmed name; isBodyweight (via liftInfo) is
      // case-insensitive, so it classifies the fallback correctly.
      bodyweight: bwMap.has(key)
        ? bwMap.get(key)!
        : resolveBodyweightKind(key, e.sawExternalWeight),
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
  href: AppRoute;
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
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS,
  limit = 10
): RecentByExercise {
  const out: RecentByExercise = {};
  for (const [key, h] of Object.entries(
    getRecentExerciseHistory(profileId, limit)
  )) {
    out[key] = h.sessions.map((s) => ({
      date: formatLongDate(s.date, prefs),
      href: journalActivityHref(s.activityId),
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
  // The session's LOAD CONTEXT (#1610): the registry implement its sets were
  // performed on, or null for the unassigned lane. `equipment` is the same lane's
  // display label, resolved together with the id so the two cannot disagree.
  equipmentId: number | null;
  equipment: string | null;
  setCount: number;
  totalReps: number;
  volumeKg: number;
  topWeightKg: number | null;
  topReps: number | null;
  e1rmKg: number | null;
  summary: string;
}

// One selectable LOAD CONTEXT of a movement (#1610): a registry implement it has
// actually been logged on, or the unassigned lane. `lane` is the shared
// `equipmentLoadLane` string — the same identity every load-sensitive builder keys
// on, and the value the Analyze URL carries — so the chooser can never invent a
// second lane scheme.
export interface ExerciseLoadContext {
  lane: string;
  equipmentId: number | null;
  // The implement's registry name, or null for the unassigned lane.
  equipment: string | null;
  // What the chooser renders. Named for the attribute that actually DISTINGUISHES
  // the choices (#531): two machines share the exercise name, so the implement is
  // the label, and the lane with no implement says so rather than repeating the
  // movement name a second, identical-looking time.
  label: string;
  sessions: number;
  lastDate: string;
}

// The load contexts one movement has been logged in, most recently used first —
// the labeled children #1610 asks Training to expose under a single top-level
// movement. Variant-collapsed by the same `exerciseHistoryNames` preimage the
// comparison scan uses, so "Barbell Curl" and "Curl" contribute to one context list
// while two registry machines stay two contexts. Profile-scoped via the JOIN.
export function getExerciseLoadContexts(
  profileId: number,
  exercise: string
): ExerciseLoadContext[] {
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

  const acc = new Map<
    string,
    {
      equipmentId: number | null;
      equipment: string | null;
      dates: Set<string>;
      lastDate: string;
    }
  >();
  for (const r of rows) {
    const lane = equipmentLoadLane(r.equipmentId);
    let e = acc.get(lane);
    if (!e)
      acc.set(
        lane,
        (e = {
          equipmentId: r.equipmentId,
          equipment: r.equipment,
          dates: new Set(),
          lastDate: r.date,
        })
      );
    e.dates.add(r.date);
    if (r.date > e.lastDate) e.lastDate = r.date;
  }

  return [...acc.entries()]
    .map(([lane, e]) => ({
      lane,
      equipmentId: e.equipmentId,
      equipment: e.equipment,
      label: e.equipment ?? "Unassigned",
      sessions: e.dates.size,
      lastDate: e.lastDate,
    }))
    .sort(
      (a, b) =>
        b.lastDate.localeCompare(a.lastDate) || a.label.localeCompare(b.label)
    );
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
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const key = exerciseHistoryKey(r.exercise);
    if (!key) continue;
    const ids = (out[key] ??= []);
    if (!ids.includes(r.equipmentId)) ids.push(r.equipmentId);
  }
  for (const ids of Object.values(out)) ids.sort((a, b) => a - b);
  return out;
}

// Full per-session history for one exercise, used by the Training comparison
// tab. This keeps the set-level math in the query layer so the page component can
// stay focused on controls and presentation.
//
// `opts.equipmentLane` narrows the scan to ONE load context (#1610) — the shared
// `equipmentLoadLane` string, so "none" is the explicit unassigned lane and never a
// wildcard. Two registry machines both serialize as the same exact logged name, so
// without the lane a hotel chest press's 50 kg and a home machine's 80 kg would be
// charted as one progression and their session table read as one history. Omitted,
// the scan stays movement-wide exactly as before — the shape a profile with no
// registry equipment (a single lane) gets either way.
export function getExerciseComparison(
  profileId: number,
  exercise: string,
  unit: WeightUnit,
  opts: { equipmentLane?: string } = {}
): ExerciseCompareSession[] {
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
    .all(profileId, ...names) as {
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
    equipment_id: number | null;
    equipment: string | null;
  }[];

  // Narrow to the requested load context BEFORE the per-session fold, so a session
  // that touched two implements contributes only its comparable sets rather than a
  // blended top weight / e1RM / volume (#1610).
  const rows =
    opts.equipmentLane == null
      ? all
      : all.filter(
          (r) => equipmentLoadLane(r.equipment_id) === opts.equipmentLane
        );

  if (rows.length === 0) return [];

  const addBodyweight = isBodyweight(rows[0].exercise);
  const weights = loadWeightsAsc(profileId);
  const bySession = new Map<
    number,
    {
      date: string;
      activityId: number;
      equipmentId: number | null;
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
        equipmentId: null,
        equipment: null,
        rows: [],
      };
      bySession.set(r.activity_id, session);
    }
    // Id and label resolved TOGETHER off the first implement-bearing set, so the
    // lane a row reports and the name it renders can never disagree (#1610).
    if (session.equipmentId == null && r.equipment_id != null) {
      session.equipmentId = r.equipment_id;
      session.equipment = r.equipment;
    }
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
      equipmentId: s.equipmentId,
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
          AND s.warmup = 0 -- warmups don't count toward push/pull volume (#338)
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
//
// Keyed by the canonical exerciseHistoryKey — the SAME #331 merge getStrengthByExercise
// uses (#432): "Barbell Curl"/"Curl" are ONE plateau series, not two sub-series that
// each fall under PLATEAU_MIN_POINTS and hide a real plateau. Each point also carries
// `reps` — the rep count of the best-e1RM set that day — so the plateau detector can
// tell a genuine flat lift from high-rep progression the E1RM_REP_CAP flattens
// (12→15→18 reps at fixed load caps to one e1RM; the rising reps are the escape hatch).
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
// `opts.byLoadContext` (#1610) adds the EQUIPMENT axis to the grouping: with it, a
// movement logged on two registry machines yields one series PER machine (keyed by
// movementLoadKey — still variant-collapsed on the name axis, so #432/#1399's
// "Barbell Curl"/"Curl" merge is untouched) plus an unassigned lane for sets with no
// implement link. Plateau detection reads it that way, because a home chest press
// and a hotel chest press are not one progression — averaging them fabricates a flat
// slope from two perfectly healthy ones. It stays OPT-IN so the Trends → Fitness
// strength-progression chart keeps its movement-wide series until that surface can
// render labeled load contexts; the SQL scan and per-set math are identical either
// way (one computation, one grouping choice).
export interface E1rmSeriesRow {
  exercise: string;
  // The load context this series belongs to when grouped by it — the registry
  // equipment id and its label, both null for the unassigned lane and always null
  // when grouping movement-wide.
  equipmentId: number | null;
  equipment: string | null;
  points: { date: string; value: number; reps: number }[];
}
export function getExerciseE1rmSeries(
  profileId: number,
  since?: string,
  until?: string,
  opts: { byLoadContext?: boolean } = {}
): E1rmSeriesRow[] {
  const byLoadContext = opts.byLoadContext === true;
  const rows = db
    .prepare(
      `SELECT s.exercise, a.date,
              s.weight_kg, s.reps, s.weight_kg_right, s.reps_right,
              s.equipment_id AS equipmentId, eq.name AS equipment
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
    ) as {
    exercise: string;
    date: string;
    weight_kg: number | null;
    reps: number | null;
    weight_kg_right: number | null;
    reps_right: number | null;
    equipmentId: number | null;
    equipment: string | null;
  }[];

  const weights = loadWeightsAsc(profileId);
  // grouping key -> { display name (first-seen), load context, date -> best }
  const acc = new Map<
    string,
    {
      exercise: string;
      equipmentId: number | null;
      equipment: string | null;
      addBodyweight: boolean;
      byDate: Map<string, { e1rm: number; reps: number }>;
    }
  >();
  for (const r of rows) {
    // Canonical, variant-collapsed key so a lift's variants merge into ONE series
    // exactly as getStrengthByExercise aggregates them (#331/#432) — plus the
    // equipment lane when the caller asked for load contexts (#1610).
    const key = byLoadContext
      ? movementLoadKey(r.exercise, r.equipmentId)
      : exerciseHistoryKey(r.exercise);
    let e = acc.get(key);
    if (!e) {
      e = {
        exercise: r.exercise,
        equipmentId: byLoadContext ? r.equipmentId : null,
        equipment: byLoadContext ? r.equipment : null,
        addBodyweight: isBodyweight(r.exercise),
        byDate: new Map(),
      };
      acc.set(key, e);
    }
    const base = e.addBodyweight ? (bodyweightAsOf(weights, r.date) ?? 0) : 0;
    const sides: { e1rm: number; reps: number }[] = [];
    if (r.reps != null)
      sides.push({
        e1rm: estimate1RM(base + (r.weight_kg ?? 0), r.reps),
        reps: r.reps,
      });
    if (r.reps_right != null)
      sides.push({
        e1rm: estimate1RM(base + (r.weight_kg_right ?? 0), r.reps_right),
        reps: r.reps_right,
      });
    for (const side of sides) {
      const prev = e.byDate.get(r.date);
      // Best e1RM that day; on a tie (e.g. reps past the cap, or bodyweight lifts)
      // keep the higher rep count so the rep-progression escape hatch can see it.
      if (
        !prev ||
        side.e1rm > prev.e1rm ||
        (side.e1rm === prev.e1rm && side.reps > prev.reps)
      )
        e.byDate.set(r.date, side);
    }
  }

  const out: E1rmSeriesRow[] = [];
  for (const e of acc.values()) {
    const points = [...e.byDate.entries()]
      .filter(([, v]) => v.e1rm > 0)
      .map(([date, v]) => ({ date, value: v.e1rm, reps: v.reps }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length > 0)
      out.push({
        exercise: e.exercise,
        equipmentId: e.equipmentId,
        equipment: e.equipment,
        points,
      });
  }
  return out;
}

// Total working volume (kg lifted) per session date, ascending. `since`/`until`
// (YYYY-MM-DD, inclusive) optionally bound it to a window — the SAME computation,
// windowed (#1492/#221): the Trends → Fitness volume chart passes the hub's shared
// range, /training passes neither and keeps its full-history series.
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

// Per-exercise strength stats for the combined Strength page: best set,
// Epley estimated 1RM, top weight, session count, and a training-volume
// series over time (one point per session date, ascending).
export interface ExerciseStat {
  exercise: string;
  // The LOAD CONTEXT these stats belong to when grouped by it (#1610) — the
  // registry equipment id and its label, both null for the unassigned lane and
  // always null when grouping movement-wide. A surface that renders a
  // load-context-grouped list MUST label its rows through `loadContextLabel`;
  // #1610 forbids duplicate unlabeled rows.
  equipmentId: number | null;
  equipment: string | null;
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
    // The anchor set's logged RPE (5–10), or null — read by the progression
    // modifier (#743).
    rpe: number | null;
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

// One rep-bearing working set of the profile's whole strength history, as the
// aggregators below read it.
interface StrengthSetRow {
  exercise: string;
  date: string;
  activity_id: number;
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  target_reps: number | null;
  to_failure: number | null;
  rpe: number | null;
  equipmentId: number | null;
  equipment: string | null;
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
              -- context, so the forward-looking seed below can't blend two machines
              -- that were both logged under the same exact exercise name — and the
              -- grouping lane itself when byLoadContext is asked for.
              s.equipment_id AS equipmentId, eq.name AS equipment
       FROM exercise_sets s JOIN activities a ON a.id = s.activity_id
       LEFT JOIN equipment eq ON eq.id = s.equipment_id
       -- Any set with reps, weighted OR bodyweight (bodyweight sets store a
       -- NULL weight); the load is resolved per exercise below. Warmups are
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
// — one row per (movement, implement) rather than one per movement — so a top weight,
// an e1RM or a PR can never be assembled from two registry machines that both
// serialize as the same exact logged name. It is a PRIMITIVE second argument on
// purpose: cache() keys on argument identity, and an options object literal would
// mint a fresh key (and a fresh regrouping) on every call.
//
// Opt-in, like `getExerciseE1rmSeries`'s: a movement-wide list (Analyze's picker,
// the exercise detail panel, the coaching seed) must stay one row per movement, and
// a caller that DOES split must label its rows through `loadContextLabel` — #1610
// forbids duplicate unlabeled rows.
//
// The two groupings are different AGGREGATES of the same history, not two answers to
// one question: bodyweight resolution, the session-seed lane and the per-day volume
// base are all resolved per GROUP, so a lane list cannot simply be folded back into a
// movement list. What they must never do is read the history twice — since #1654 both
// fold the one cached `strengthSetRows` scan, and a profile whose sets carry no
// implement link short-circuits to the identical movement-wide result outright.
export const getStrengthByExercise = cache(function getStrengthByExercise(
  profileId: number,
  byLoadContext = false
): ExerciseStat[] {
  const rows = strengthSetRows(profileId);
  // For a profile whose sets carry no implement link at all, every set is already in
  // the same (unassigned) lane: `movementLoadKey` partitions exactly as
  // `exerciseHistoryKey` does and every emitted equipment field is null either way.
  // Normalize to the movement-wide grouping so the two lists are not merely equivalent
  // but IDENTICAL — the promise #1610's comment makes, now made structurally.
  const laned = byLoadContext && rows.some((r) => r.equipmentId != null);

  const weights = loadWeightsAsc(profileId);
  const bwAsOf = (date: string) => bodyweightAsOf(weights, date);

  interface Acc {
    exercise: string;
    // The group's load context when grouping by it; both null movement-wide.
    equipmentId: number | null;
    equipment: string | null;
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
    // The exact logged name of the newest session (highest date+id). Since #331
    // a base's implements merge under one key, so the newest date can interleave
    // variants (a Barbell Curl and a Dumbbell Curl activity same day); this is the
    // implement pickSeedSessions prefers so the seed doesn't mix them (#393).
    newestExercise: string;
    // …and the newest session's own LOAD CONTEXT (#1610). Two registry machines
    // both serialize as the same exact name, so the name alone can't stop a
    // same-day hotel-machine set from seeding off the home machine.
    newestEquipmentId: number | null;
    // Raw rows of the most recent session (same date, across activities),
    // ranked into lastSessionBest by sessionBestSet at the end — the single
    // shared definition of a session's seeding set (lib/coaching).
    lastSessionRows: (typeof rows)[number][];
    volByDate: Map<string, number>;
    repsByDate: Map<string, number>;
  }
  const t = today(profileId);
  const map = new Map<string, Acc>();
  for (const r of rows) {
    // Canonical, variant-collapsed key: a variant and its base ("Barbell Curl"
    // vs "Curl") aggregate into ONE history — sessions, PRs, and the progression
    // seed no longer split on a rename (#331). getRecentExerciseHistory /
    // getExerciseBodyweightMap key the same way, so every surface agrees.
    const key = laned
      ? movementLoadKey(r.exercise, r.equipmentId)
      : exerciseHistoryKey(r.exercise);
    let cur = map.get(key);
    if (!cur) {
      cur = {
        exercise: r.exercise,
        equipmentId: laned ? r.equipmentId : null,
        equipment: laned ? r.equipment : null,
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
        newestExercise: r.exercise,
        newestEquipmentId: r.equipmentId,
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
    // Rows are date+id ascending, so after the advance r.date === cur.lastDate and
    // the last row processed is the newest activity — its name is the implement
    // pickSeedSessions seeds from (#393).
    cur.newestExercise = r.exercise;
    cur.newestEquipmentId = r.equipmentId;
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
      // no weight at all. Routed through the shared classifier over this all-history
      // sawExternalWeight so the editor's getRecentExerciseHistory (which reads the
      // same all-history map) can't disagree about the suggestion KIND (#331). The
      // chart falls back to reps only when there's no usable load (bodyweight
      // unknown), since weight×reps would be flat zero.
      const bodyweight = resolveBodyweightKind(c.exercise, c.sawExternalWeight);
      const volumeIsReps = bodyweight && c.topWeightKg === 0;
      // A next-set seed only fires off a session inside the recent window. When
      // the newest session is >1yr old the editor already shows no chip (its scan
      // is windowed); withhold the seed here too so a stale year-old session
      // suggests a next set on NEITHER surface (#331). Historical stats below are
      // unaffected — only the forward-looking seed is dropped.
      const seedFresh = isSeedFresh(c.lastDate, t);
      // Seed off the newest session's own implement, never a heavier/lighter
      // sibling variant that happens to share the newest date (#393) and never a
      // different registry machine logged under the same exact name (#1610). All
      // buffered rows share lastDate, so pickSeedSessions filters that date to the
      // newest logged name AND its equipment lane — the same ONE decision the
      // editor chip uses.
      const seedRows = pickSeedSessions(
        c.lastSessionRows,
        c.newestExercise,
        c.newestEquipmentId
      );
      const seedBase = c.addBodyweight ? (bwAsOf(c.lastDate) ?? 0) : 0;
      return {
        exercise: c.exercise,
        equipmentId: c.equipmentId,
        equipment: c.equipment,
        sessions: c.dates.size,
        totalSets: c.totalSets,
        topWeightKg: c.topWeightKg,
        topWeightDate: c.topWeightDate,
        e1rmKg: Math.max(0, c.e1rmKg),
        bestWeightKg: c.bestWeightKg,
        bestReps: c.bestReps,
        bestDate: c.bestDate,
        lastActivityId: c.lastActivityId,
        lastSessionBest: seedFresh ? sessionBestSet(seedRows, seedBase) : null,
        lastSessionSets: seedFresh ? sessionWorkSets(seedRows, seedBase) : [],
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
