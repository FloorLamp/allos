// Post-workout session recap (issue #924) — the ONE pure computation that turns a
// just-completed strength session (+ its recent per-exercise history) into a
// factual recap: duration, per-exercise + total working sets/volume, a
// target-verdict rollup, PR flags, a delta vs the previous session of each lift,
// and the session's logged effort/RPE. No DB, no network, no AI — so it runs on
// BOTH input paths and can't drift (#221 one-question-one-computation):
//
//   • CLIENT (the live "Session complete" step): the activity form's parts/sets
//     state → recapSessionFromParts → sessionRecap, over the shipped
//     ExerciseHistoryMap.
//   • SERVER (the finished-window dashboard card + the recap-led finish nudge):
//     the stored activity rows → recapSessionFromEditData → sessionRecap, over
//     the same history gather.
//
// A pure test pins that the SAME session, fed through both mappers, yields an
// identical Recap. The three surfaces (form step, dashboard card, Telegram recap
// line) are pure formatters over the Recap result — never a second engine.
//
// Target verdicts reuse the shared judgeTargets rule (to-failure / untargeted sets
// are NEVER misses); PR flags follow lastSessionPR semantics (an all-time best set
// on the just-finished session, gated on there being prior history, weight PRs
// suppressed for bodyweight lifts); the vs-last delta seeds off pickSeedSessions so
// it uses the implement-appropriate previous session, exactly like the editor's
// next-set suggestion.

import { estimate1RM } from "./strength";
import {
  summarizeExercise,
  type SetRow,
  type SetStatus,
} from "./journal-format";
import { exerciseHistoryKey, isBodyweight } from "./lifts";
import { pickSeedSessions } from "./exercise-window";
import type { WeightUnit } from "./settings";
import { kgTo, toKg, round } from "./units";
import type { ActivitySetPayload } from "./activity-form-validate";
import type { ActivityEditData } from "./activity-form-model";

// One set of the recapped session, canonical (kg/seconds). Both mappers normalize
// onto this shape so the recap is computed identically from form state or stored
// rows.
export interface RecapSet {
  weightKg: number | null;
  reps: number | null;
  weightKgRight?: number | null;
  repsRight?: number | null;
  durationSec?: number | null;
  durationSecRight?: number | null;
  targetReps?: number | null;
  toFailure?: boolean;
  warmup?: boolean;
  rpe?: number | null;
}

export interface RecapExercise {
  exercise: string; // the logged variant name
  sets: RecapSet[];
}

// The normalized session the recap is computed over. Both input paths produce this.
export interface RecapInputSession {
  title: string;
  // Routine day / session label used to lead the compact recap line ("Push day
  // done"); falls back to `title` when absent.
  durationMin: number | null;
  // easy/moderate/hard session effort — the existing activities.intensity (#924
  // reuses it, no new column). Null when not rated.
  intensity: string | null;
  // The user's bodyweight (kg) at the session, folded into bodyweight lifts' loads
  // for e1RM/PR/delta so a pullup PR is detectable. 0 for a weighted-only session.
  bodyweightKg: number;
  exercises: RecapExercise[];
}

// The minimal per-exercise history the recap reads for PR flags + vs-last delta.
// The `sets` are the snake_case shape ExerciseHistoryMap already ships (a
// RecentSession's sets), so an ExerciseHistoryMap is structurally assignable
// without a mapping layer.
export interface RecapHistorySet {
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  warmup?: number | null;
}
export interface RecapHistorySession {
  activityId: number;
  date: string;
  exercise: string;
  baseKg: number; // bodyweight folded into loads for this session (0 = none)
  sets: RecapHistorySet[];
}
export interface RecapExerciseHistory {
  bodyweight: boolean;
  sessions: RecapHistorySession[]; // newest first
}
export type RecapHistory = Record<string, RecapExerciseHistory>;

export interface RecapExerciseLine {
  exercise: string;
  workingSets: number;
  volumeKg: number;
  verdict: SetStatus; // met / missed / null (to-failure & untargeted are never a miss)
  bodyweight: boolean;
  e1rmPR: boolean;
  weightPR: boolean;
  // Change in the session's best working-set e1RM vs the previous session of this
  // lift (implement-appropriate via pickSeedSessions), kg. Null when there is no
  // prior session to compare against.
  deltaE1rmKg: number | null;
}

export type TargetRollup = "all-hit" | "some-missed" | "none-targeted";

export interface Recap {
  title: string;
  durationMin: number | null;
  intensity: string | null;
  exercises: RecapExerciseLine[];
  totalWorkingSets: number;
  totalVolumeKg: number;
  targetRollup: TargetRollup;
  // Exercises that set a PR this session (either kind), in session order.
  prExercises: string[];
  // Average logged working-set RPE across the session (5–10), null when none logged.
  avgRpe: number | null;
}

export interface RecapOptions {
  // The activity being recapped — always excluded from its OWN prior-history so a
  // just-finished session (already in the history map, server-side) doesn't
  // out-PR or zero-delta against itself. Null client-side (not yet saved).
  currentActivityId?: number | null;
}

// Whether a set carries any logged rep/hold content on either side (a "working"
// count candidate). A blank placeholder set contributes nothing.
function hasContent(s: RecapSet): boolean {
  return (
    s.reps != null ||
    s.repsRight != null ||
    s.durationSec != null ||
    s.durationSecRight != null
  );
}

// Map a RecapSet onto the journal SetRow shape so volume + verdict reuse the ONE
// shared summarizeExercise/judgeTargets computation (never a second rule).
function toSetRow(s: RecapSet, i: number): SetRow {
  return {
    set_number: i + 1,
    weight_kg: s.weightKg,
    reps: s.reps,
    weight_kg_right: s.weightKgRight ?? null,
    reps_right: s.repsRight ?? null,
    duration_sec: s.durationSec ?? null,
    duration_sec_right: s.durationSecRight ?? null,
    target_reps: s.targetReps ?? null,
    to_failure: s.toFailure ? 1 : 0,
    warmup: s.warmup ? 1 : 0,
    rpe: s.rpe ?? null,
  };
}

// Best (highest e1RM) and heaviest folded load over a session's working sets. Each
// side of a per-side set is its own candidate; `baseKg` folds bodyweight into the
// load (0 otherwise); warmups are excluded. Null e1rm/top when no rep-bearing
// working set exists.
function sessionBest(
  sides: { weightKg: number; reps: number }[]
): { e1rm: number; topKg: number } | null {
  let e1rm = -1;
  let topKg = -1;
  for (const s of sides) {
    e1rm = Math.max(e1rm, estimate1RM(s.weightKg, s.reps));
    topKg = Math.max(topKg, s.weightKg);
  }
  return e1rm < 0 ? null : { e1rm, topKg };
}

function currentSides(
  sets: RecapSet[],
  baseKg: number
): { weightKg: number; reps: number }[] {
  const out: { weightKg: number; reps: number }[] = [];
  for (const s of sets) {
    if (s.warmup) continue;
    if (s.reps != null)
      out.push({ weightKg: baseKg + (s.weightKg ?? 0), reps: s.reps });
    if (s.repsRight != null)
      out.push({
        weightKg: baseKg + (s.weightKgRight ?? 0),
        reps: s.repsRight,
      });
  }
  return out;
}

function historySides(
  sets: RecapHistorySet[],
  baseKg: number
): { weightKg: number; reps: number }[] {
  const out: { weightKg: number; reps: number }[] = [];
  for (const s of sets) {
    if (s.warmup) continue;
    if (s.reps != null)
      out.push({ weightKg: baseKg + (s.weight_kg ?? 0), reps: s.reps });
    if (s.reps_right != null)
      out.push({
        weightKg: baseKg + (s.weight_kg_right ?? 0),
        reps: s.reps_right,
      });
  }
  return out;
}

// Compute the recap. Pure: identical output for equivalent inputs regardless of
// which mapper built the session (the two-input-paths pin).
export function sessionRecap(
  session: RecapInputSession,
  history: RecapHistory,
  opts: RecapOptions = {}
): Recap {
  const currentId = opts.currentActivityId ?? null;
  const lines: RecapExerciseLine[] = [];
  const rpes: number[] = [];

  for (const ex of session.exercises) {
    const key = exerciseHistoryKey(ex.exercise);
    const hist = history[key];
    const bodyweight = hist?.bodyweight ?? isBodyweight(ex.exercise);
    const baseKg = bodyweight ? session.bodyweightKg : 0;

    const summary = summarizeExercise(ex.sets.map(toSetRow), "kg");
    const workingSets = ex.sets.filter(
      (s) => !s.warmup && hasContent(s)
    ).length;

    for (const s of ex.sets) {
      if (!s.warmup && s.rpe != null) rpes.push(s.rpe);
    }

    // Prior sessions of this lift (all history except the current activity).
    const prior = (hist?.sessions ?? []).filter(
      (s) => s.activityId !== currentId
    );
    const curBest = sessionBest(currentSides(ex.sets, baseKg));

    // PR flags (lastSessionPR semantics): an all-time best on THIS session, gated
    // on prior history existing; weight PRs are meaningless for bodyweight lifts.
    let e1rmPR = false;
    let weightPR = false;
    if (curBest && prior.length > 0) {
      let priorBestE1rm = -1;
      let priorTopKg = -1;
      for (const ps of prior) {
        const pb = sessionBest(historySides(ps.sets, ps.baseKg));
        if (pb) {
          priorBestE1rm = Math.max(priorBestE1rm, pb.e1rm);
          priorTopKg = Math.max(priorTopKg, pb.topKg);
        }
      }
      if (priorBestE1rm >= 0) {
        e1rmPR = curBest.e1rm > priorBestE1rm;
        weightPR =
          !bodyweight && curBest.topKg > 0 && curBest.topKg > priorTopKg;
      }
    }

    // Delta vs the previous session (implement-appropriate seed), by best e1RM.
    let deltaE1rmKg: number | null = null;
    if (curBest && prior.length > 0) {
      const seed = pickSeedSessions(prior, ex.exercise);
      const seedSides = seed.flatMap((s) => historySides(s.sets, s.baseKg));
      const prevBest = sessionBest(seedSides);
      if (prevBest) deltaE1rmKg = round(curBest.e1rm - prevBest.e1rm, 1);
    }

    lines.push({
      exercise: ex.exercise,
      workingSets,
      volumeKg: summary.totalKg,
      verdict: summary.status,
      bodyweight,
      e1rmPR,
      weightPR,
      deltaE1rmKg,
    });
  }

  const anyMissed = lines.some((l) => l.verdict === "missed");
  const anyMet = lines.some((l) => l.verdict === "met");
  const targetRollup: TargetRollup = anyMissed
    ? "some-missed"
    : anyMet
      ? "all-hit"
      : "none-targeted";

  const avgRpe =
    rpes.length > 0
      ? round(rpes.reduce((a, b) => a + b, 0) / rpes.length, 1)
      : null;

  return {
    title: session.title,
    durationMin: session.durationMin,
    intensity: session.intensity,
    exercises: lines,
    totalWorkingSets: lines.reduce((a, l) => a + l.workingSets, 0),
    totalVolumeKg: lines.reduce((a, l) => a + l.volumeKg, 0),
    targetRollup,
    prExercises: lines
      .filter((l) => l.e1rmPR || l.weightPR)
      .map((l) => l.exercise),
    avgRpe,
  };
}

// ---- Input mappers (the two paths onto RecapInputSession) ----

// Group flattened set rows (first-seen order) into RecapExercises. Shared by both
// mappers so exercise ordering + grouping can't diverge between the paths.
function groupExercises(
  rows: { exercise: string; set: RecapSet }[]
): RecapExercise[] {
  const out: RecapExercise[] = [];
  for (const { exercise, set } of rows) {
    let e = out.find((x) => x.exercise === exercise);
    if (!e) {
      e = { exercise, sets: [] };
      out.push(e);
    }
    e.sets.push(set);
  }
  return out;
}

export interface RecapSessionMeta {
  title: string;
  durationMin: number | null;
  intensity: string | null;
  bodyweightKg: number;
}

// CLIENT path: the activity form's already-built save payload (ActivitySetPayload
// carries display-unit weights, so the mapper converts to canonical kg with the
// SAME toKg the save action uses). Reusing the payload builder means there is ONE
// parse of the form state, not a second.
export function recapSessionFromPayload(
  flat: readonly ActivitySetPayload[],
  meta: RecapSessionMeta,
  unit: WeightUnit
): RecapInputSession {
  const rows = flat.map((s) => ({
    exercise: s.exercise,
    set: {
      weightKg: s.weight != null ? toKg(s.weight, unit) : null,
      reps: s.reps,
      weightKgRight: s.weightRight != null ? toKg(s.weightRight, unit) : null,
      repsRight: s.repsRight,
      durationSec: s.durationSec,
      durationSecRight: s.durationSecRight,
      targetReps: s.targetReps,
      toFailure: s.toFailure,
      warmup: s.warmup,
      rpe: s.rpe,
    } satisfies RecapSet,
  }));
  return { ...meta, exercises: groupExercises(rows) };
}

// SERVER path: stored activity rows (canonical kg already). Groups the flat
// exercise_sets by exercise, preserving set order.
export function recapSessionFromEditData(
  data: ActivityEditData,
  meta: Pick<RecapSessionMeta, "bodyweightKg">
): RecapInputSession {
  const ordered = [...data.sets].sort((a, b) => a.set_number - b.set_number);
  const rows = ordered.map((s) => ({
    exercise: s.exercise,
    set: {
      weightKg: s.weight_kg,
      reps: s.reps,
      weightKgRight: s.weight_kg_right,
      repsRight: s.reps_right,
      durationSec: s.duration_sec,
      durationSecRight: s.duration_sec_right,
      targetReps: s.target_reps,
      toFailure: s.to_failure === 1,
      warmup: s.warmup === 1,
      rpe: s.rpe,
    } satisfies RecapSet,
  }));
  return {
    title: data.title,
    durationMin: data.duration_min,
    intensity: data.intensity,
    bodyweightKg: meta.bodyweightKg,
    exercises: groupExercises(rows),
  };
}

// ---- Formatters (surfaces over the ONE Recap) ----

// Display volume for a card/step, in the login's unit ("2,450 kg" / "5,400 lb").
export function fmtRecapVolume(volumeKg: number, unit: WeightUnit): string {
  return `${Math.round(kgTo(volumeKg, unit)).toLocaleString("en-US")} ${unit}`;
}

// The compact one-liner that LEADS the recap-led finish nudge (#924) and can title
// a card: "Push day done · 47 min · 14 sets · Bench press PR · all targets hit".
// Segments with nothing to say are dropped. Unit-free (counts only).
export function formatRecapLine(recap: Recap): string {
  const segs: string[] = [];
  const lead = recap.title.trim() || "Workout";
  segs.push(`${lead} done`);
  if (recap.durationMin != null && recap.durationMin > 0)
    segs.push(`${recap.durationMin} min`);
  if (recap.totalWorkingSets > 0)
    segs.push(
      `${recap.totalWorkingSets} set${recap.totalWorkingSets === 1 ? "" : "s"}`
    );
  if (recap.prExercises.length === 1) segs.push(`${recap.prExercises[0]} PR`);
  else if (recap.prExercises.length > 1)
    segs.push(`${recap.prExercises.length} PRs`);
  if (recap.targetRollup === "all-hit") segs.push("all targets hit");
  else if (recap.targetRollup === "some-missed")
    segs.push("some targets missed");
  return segs.join(" · ");
}
