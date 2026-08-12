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
  judgeTargetDetail,
  summarizeExercise,
  type SetRow,
  type SetStatus,
} from "./training-log-format";
import { exerciseHistoryKey, isBodyweight } from "./lifts";
import { pickSeedSessions } from "./exercise-window";
import type { WeightUnit } from "./settings";
import { fmtWeight, kgTo, toKg, round } from "./units";
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
  // The registry implement the session's sets were performed on (first non-null),
  // or null for the unassigned lane — the LOAD CONTEXT the vs-last delta compares
  // within (#1610). Optional so a caller with no implement data reads as unassigned.
  equipmentId?: number | null;
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
  // The prior session's load context (#1610) — RecentSession ships it, so an
  // ExerciseHistoryMap stays structurally assignable with no mapping layer.
  equipmentId?: number | null;
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
  // HOW FAR SHORT (issue #2172), from the same judgeTargets pass that produced
  // `verdict` — never recomputed beside it. `missedSets` counts the targeted working
  // sets that fell short and `shortfall` is the largest of them ("7/8"); both are the
  // verdict's own arithmetic, so a formatter can state the magnitude instead of
  // collapsing one rep on one set into the same phrase as failing every target.
  // Zero/null whenever `verdict` is not "missed".
  missedSets: number;
  shortfall: { reps: number; target: number } | null;
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

// Map a RecapSet onto the training log SetRow shape so volume + verdict reuse the ONE
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

    const setRows = ex.sets.map(toSetRow);
    const summary = summarizeExercise(setRows, "kg");
    // The verdict's OWN magnitude (#2172). Read from the shared judgement rather than
    // re-derived here, and kept only when `summary.status` actually says "missed" — so
    // the timed/per-side paths, which decline to judge at all, cannot acquire a
    // shortfall the verdict does not claim.
    const judgment = judgeTargetDetail(setRows);
    const missed = summary.status === "missed";
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
      // Same LOAD CONTEXT as the session just logged (#1610): a hotel machine's
      // numbers are not a delta against the home machine's, so when this session's
      // implement has no prior history the recap shows no delta rather than a
      // meaningless one. RecentSession ships equipmentId, so pickSeedSessions
      // resolves the lane here exactly as the editor and coaching surfaces do.
      const seed = pickSeedSessions(prior, ex.exercise, ex.equipmentId ?? null);
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
      missedSets: missed ? judgment.missedSets : 0,
      shortfall: missed ? judgment.worst : null,
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
  rows: { exercise: string; equipmentId: number | null; set: RecapSet }[]
): RecapExercise[] {
  const out: RecapExercise[] = [];
  for (const { exercise, equipmentId, set } of rows) {
    let e = out.find((x) => x.exercise === exercise);
    if (!e) {
      e = { exercise, equipmentId: null, sets: [] };
      out.push(e);
    }
    // First non-null implement of the exercise, exactly how RecentSession resolves a
    // session's equipment — so the recap's load context matches the history's.
    if (e.equipmentId == null && equipmentId != null)
      e.equipmentId = equipmentId;
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
    equipmentId: s.equipmentId,
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
    equipmentId: s.equipment_id,
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

// ── THE RECAP LINE (issue #2172) ───────────────────────────────────────────────
//
// The compact one-liner LEADS the recap-led finish nudge (#924) and can title a card.
// Two of its segments used to carry almost no information: "15 sets" is a count with no
// comparator (the duration beside it already says the session happened), and "some
// targets missed" was the same phrase for one rep short on the only targeted lift as for
// failing every target of the session. In a chat there is no detail below to correct
// that impression — the line IS the message.
//
// So the line restates what the Recap already computed. Same computation, better
// restatement: no new engine, no new read, and one function with a `detail` knob rather
// than a second formatter for the chat — a copied-and-drifted twin is exactly what #221
// exists to prevent.
//
//   compact  (default)  — byte-for-byte what it always was. The in-app card titles
//                         itself with this and renders every fact below it.
//   detail: true        — the chat form: a PROGRESS fact in place of the bare set count,
//                         and a target rollup that names and quantifies the miss.
//
// TONE (#992/#716): numbers, never adjectives. "Missed" survives only because targets
// are the user's own vocabulary, and the shortfall is stated as arithmetic ("7/8"), not
// as failure.

// Past this width the named form degrades to the counted one: a chat line stays ONE
// line, and many misses (or long lift names) must not wrap the message into a report.
const RECAP_LINE_MAX = 120;

// Naming more than this many missed lifts is a list, not a line.
const MAX_NAMED_MISSES = 2;

export interface RecapLineOptions {
  // Expand the progress and target segments (the chat form). Default false.
  detail?: boolean;
}

// The PR segment, unchanged in both forms — a PR is the strongest progress fact the
// session has, so it keeps the slot whenever one exists.
function prSegment(recap: Recap): string | null {
  if (recap.prExercises.length === 1) return `${recap.prExercises[0]} PR`;
  if (recap.prExercises.length > 1) return `${recap.prExercises.length} PRs`;
  return null;
}

// The best vs-last movement of the session, kg — canonical, per the notification unit
// policy (a chat has no login-unit context). The MAXIMUM is a selection, not a claim
// about the session, so it is stated whichever way it went: hiding a negative best
// would make "no delta segment" mean two different things.
function deltaSegment(recap: Recap): string | null {
  let best: RecapExerciseLine | null = null;
  for (const l of recap.exercises) {
    if (l.deltaE1rmKg == null || l.deltaE1rmKg === 0) continue;
    if (best == null || l.deltaE1rmKg > best.deltaE1rmKg!) best = l;
  }
  if (!best) return null;
  const d = best.deltaE1rmKg!;
  return `${best.exercise} ${d > 0 ? "+" : "−"}${fmtWeight(Math.abs(d), "kg")} vs last`;
}

function setsSegment(recap: Recap): string | null {
  if (recap.totalWorkingSets <= 0) return null;
  return `${recap.totalWorkingSets} set${recap.totalWorkingSets === 1 ? "" : "s"}`;
}

// One missed lift, quantified: "Lat Pulldown 7/8 on one set".
function missClause(line: RecapExerciseLine): string {
  if (!line.shortfall) return line.exercise;
  const sets = line.missedSets === 1 ? "one set" : `${line.missedSets} sets`;
  return `${line.exercise} ${line.shortfall.reps}/${line.shortfall.target} on ${sets}`;
}

// COVERAGE AWARENESS. When most of the session's lifts carried no target at all, a bare
// miss phrase reads as a verdict on the whole session. Saying so is what makes the
// fixture's line honest: one lift was judged, three were not.
function untargetedTail(recap: Recap): string {
  const untargeted = recap.exercises.filter((l) => l.verdict === null).length;
  const judged = recap.exercises.length - untargeted;
  return untargeted > judged ? ", rest untargeted" : "";
}

export function formatRecapLine(
  recap: Recap,
  opts: RecapLineOptions = {}
): string {
  const detail = opts.detail === true;
  const lead = recap.title.trim() || "Workout";
  const head: string[] = [`${lead} done`];
  if (recap.durationMin != null && recap.durationMin > 0)
    head.push(`${recap.durationMin} min`);

  const pr = prSegment(recap);
  const progress = detail ? (pr ?? deltaSegment(recap)) : pr;

  // A recap's question is "did I progress"; the set count answers "did I show up",
  // which the message's existence already says. In the detailed form it therefore
  // becomes a FALLBACK — kept only when the line would otherwise have nothing but the
  // session and its duration, so this never produces a thinner message than before.
  const sets = setsSegment(recap);

  const missed = recap.exercises.filter((l) => l.verdict === "missed");
  function targetSegment(named: boolean): string | null {
    if (recap.targetRollup === "all-hit") return "all targets hit";
    if (recap.targetRollup !== "some-missed") return null;
    if (!detail) return "some targets missed";
    const body =
      named && missed.length > 0 && missed.length <= MAX_NAMED_MISSES
        ? missed.map(missClause).join(", ")
        : `${missed.length} target${missed.length === 1 ? "" : "s"} missed`;
    return `${body}${untargetedTail(recap)}`;
  }

  function compose(named: boolean): string {
    const target = targetSegment(named);
    const segs = [...head];
    if (detail) {
      if (progress) segs.push(progress);
      if (!progress && !target && sets) segs.push(sets);
    } else {
      if (sets) segs.push(sets);
      if (progress) segs.push(progress);
    }
    if (target) segs.push(target);
    return segs.join(" · ");
  }

  const line = compose(true);
  // LENGTH DISCIPLINE: degrade to the counted form rather than wrap into a report.
  return line.length > RECAP_LINE_MAX ? compose(false) : line;
}
