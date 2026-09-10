// PURE folds over one profile's logged strength history (#5172): the activity editor's
// recent-session window, a movement's LOAD CONTEXTS (#1610), the implements it has been
// logged on, and the lifetime best per goal metric. The gathers in
// lib/queries/training/strength.ts read the rows; the rules about what those rows mean
// live here, once each:
//
//   - the EQUIPMENT-LANE rule (#1610): lanes are keyed on the shared
//     `equipmentLoadLane` string — never on the implement NAME, which two registry
//     machines can share — and each lane's id and label are resolved TOGETHER off the
//     first implement-bearing row so the lane a chooser reports and the name it renders
//     can never disagree. The unassigned lane is a real, selectable lane, not a
//     wildcard.
//   - the VARIANT MERGE (#331): everything keys on the canonical `exerciseHistoryKey`,
//     so "Barbell Curl" and "Curl" are one history while two machines stay two lanes.
//   - the BODYWEIGHT KIND (#331): resolved from the all-history classification the
//     caller passes in, with the window-local sighting used only as the fallback for a
//     lift the map has never seen.
//   - "a zero best is NO best" (#3220): every SQL column is COALESCEd to 0, so 0 means
//     the movement has never carried a load or a hold, and stating "from 0 kg" would be
//     a claim about a history that does not exist.
//
// Pure — no DB, no clock, no network.

import { bodyweightAsOf } from "./bodyweight";
import {
  equipmentLoadLane,
  exerciseHistoryKey,
  isBodyweight,
  loadKindOf,
  resolveBodyweightKind,
  type LoadKind,
} from "./lifts";
import type { SetStatus } from "./training-log-format";
import { judgeTargets } from "./training-log-format";

export interface RecentSession {
  date: string;
  // The exact exercise name logged for this session's sets. History now merges a
  // lift's variants under one canonical key (#331), so each session carries its
  // own logged name — the only place the specific variant spelling survives the
  // merge, so the editor can still recover the last-used variant/implement.
  exercise: string;
  // The activity this session belongs to (for linking to it in the training log).
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
  // bodyweight lifts, 0 otherwise — the same base the per-exercise stats fold.
  baseKg: number;
  // Hit/missed the declared rep targets (null when none were declared).
  // Judged here so the training log card and editor needn't re-derive it.
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
  // the all-history bodyweight map (resolved over ALL history, not just this
  // window's shipped sessions, and keyed by the canonical exerciseHistoryKey) so the
  // editor's next-set suggestion classifies exactly like the per-exercise stats
  // and the exercise detail panel (#331).
  bodyweight: boolean;
  // Most recent sessions, newest first.
  sessions: RecentSession[];
}

// exercise history key (canonical, variant-collapsed) -> history
export type ExerciseHistoryMap = Record<string, ExerciseHistory>;

// One set row of the recent window, as the gather selects it (date+id descending,
// set_number ascending).
export interface RecentSetRow {
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
}

// Fold the recent window into at most `perExercise` sessions per movement, newest
// first. `weights` is the profile's bodyweight series ascending by date; `bwMap` is the
// authoritative all-history bodyweight classification keyed by `exerciseHistoryKey`.
export function foldRecentExerciseHistory(
  rows: RecentSetRow[],
  weights: { date: string; weight_kg: number }[],
  bwMap: Map<string, boolean>,
  perExercise: number
): ExerciseHistoryMap {
  type AccumSession = Omit<RecentSession, "status">;
  interface AccumExercise {
    addBodyweight: boolean; // catalog bodyweight lift
    loadKind: LoadKind; // whether a logged weight adds to or subtracts from it (#1922)
    // Window-local external-weight sighting, used ONLY as a fallback classifier
    // for an exercise absent from the all-history bodyweight map (one with no
    // rep-bearing set anywhere); the shipped flag prefers the map (#331).
    sawExternalWeight: boolean;
    sessions: AccumSession[];
  }
  const acc = new Map<string, AccumExercise>();
  for (const r of rows) {
    // Canonical, variant-collapsed key so "Barbell Curl"/"Curl" merge into one
    // history here exactly as in the per-exercise stats (#331).
    const key = exerciseHistoryKey(r.exercise);
    let e = acc.get(key);
    if (!e) {
      e = {
        addBodyweight: isBodyweight(r.exercise),
        loadKind: loadKindOf(r.exercise),
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

// Fold one movement's warmup-free rows into its load contexts, most recently used
// first. The gather has already narrowed the rows to the movement's variant preimage.
export function foldExerciseLoadContexts(
  rows: {
    equipmentId: number | null;
    equipment: string | null;
    date: string;
    activityId: number;
  }[]
): ExerciseLoadContext[] {
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

// Fold the profile's distinct (exercise, implement) pairs into the registry
// implements each MOVEMENT has been logged on, keyed by the canonical
// `exerciseHistoryKey` — the goal form's answer to "does this lift even have a load
// context to choose?" (#1610). Only real, non-null links reach here: the unassigned
// lane is not an implement a goal can be scoped to, it is the absence of one.
export function foldLoggedEquipmentByExercise(
  rows: { exercise: string; equipmentId: number }[]
): Record<string, number[]> {
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

/** The lifetime best this profile has logged for one movement, per goal metric. */
export interface ExerciseBest {
  /** Heaviest set, canonical kg. Null when the movement has no loaded set. */
  weightKg: number | null;
  /** Most reps in one set, either side. */
  reps: number | null;
  /** Longest hold, seconds, either side. */
  durationSec: number | null;
}

/**
 * Fold the per-name SQL maxima into the best the profile has already done, per logged
 * movement (#3220) — what lets the goal form state where a new target is STARTING FROM
 * instead of asking someone to remember their own PR.
 *
 * SAME SHAPE AS `foldLoggedEquipmentByExercise` ABOVE, and keyed the same way
 * (`exerciseHistoryKey`), because the goal form already indexes by that key and a
 * second keying convention for the same question is the thing #221 forbids.
 */
export function foldExerciseBests(
  rows: {
    exercise: string;
    weightKg: number | null;
    reps: number | null;
    durationSec: number | null;
  }[]
): Record<string, ExerciseBest> {
  const out: Record<string, ExerciseBest> = {};
  // A zero best is NO best: every column here is COALESCEd to 0 so the row-wise MAX
  // is total, which means 0 is what "this movement has never carried a load / a hold"
  // reduces to. Stating "from 0 kg" would be a claim about history rather than the
  // absence of one.
  const positive = (n: number | null): number | null =>
    n != null && n > 0 ? n : null;
  for (const r of rows) {
    const key = exerciseHistoryKey(r.exercise);
    if (!key) continue;
    const prior = out[key];
    const next: ExerciseBest = {
      weightKg: positive(r.weightKg),
      reps: positive(r.reps),
      durationSec: positive(r.durationSec),
    };
    // Two spellings can fold onto one history key, so keep the better of each.
    out[key] = prior
      ? {
          weightKg: Math.max(prior.weightKg ?? 0, next.weightKg ?? 0) || null,
          reps: Math.max(prior.reps ?? 0, next.reps ?? 0) || null,
          durationSec:
            Math.max(prior.durationSec ?? 0, next.durationSec ?? 0) || null,
        }
      : next;
  }
  return out;
}
