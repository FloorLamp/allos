// Training coaching — strength: double-progression next-set targets and
// strength personal records. Pure and client-safe — no DB/network.
import { isTimed, liftInfo } from "../lifts";
import { judgeTargets } from "../journal-format";
import { estimate1RM } from "../strength";
import { dispWeight, kgTo, toKg, round } from "../units";
import type { WeightUnit } from "../settings";
import { fmtRpe } from "../rpe";
import { within, byDateDesc } from "./common";

// ---- Strength ----

// The slice of per-exercise stats this module needs. ExerciseStat (lib/queries)
// structurally satisfies it; a local shape keeps coaching decoupled from the DB
// layer and trivially testable.
export interface ExerciseSummary {
  exercise: string;
  sessions: number; // distinct dates trained
  bodyweight: boolean; // body is (part of) the load — progress by reps
  e1rmKg: number;
  bestWeightKg: number;
  bestReps: number;
  bestDate: string; // date of the all-time best estimated 1RM
  topWeightKg: number;
  topWeightDate: string; // date the heaviest load was first hit
  lastDate: string; // most recent date trained
  // Best working set of the most recent session, used to seed progression and
  // as the WEIGHT anchor (the load a next-set suggestion adds to).
  // targetReps/toFailure carry that set's declared intent when one was logged;
  // optional so plain {weight, reps} summaries keep working.
  lastSessionBest: {
    weightKg: number;
    reps: number;
    targetReps?: number | null;
    toFailure?: boolean;
    // The anchor set's logged RPE (5–10) when one was recorded, else null. The
    // double-progression MODIFIER reads only the anchor's rating (#743); a null
    // leaves every verdict byte-for-byte the pre-RPE behavior.
    rpe?: number | null;
  } | null;
  // Every rep-bearing set of the most recent session (each side of a per-side
  // set is its own entry, bodyweight folded into the load), so progression can
  // judge the WORKING sets rather than the single best one (#330). Optional: a
  // seed without it falls back to judging the anchor (lastSessionBest) alone.
  lastSessionSets?: SessionWorkSet[];
}

// One rep-bearing set of a session, folded to a single load+reps candidate with
// its declared intent — the unit progression judges. Shared by the seed list
// and the working-set filter.
export interface SessionWorkSet {
  weightKg: number; // bodyweight folded in for bodyweight lifts (0 = weightless)
  reps: number;
  targetReps: number | null;
  toFailure: boolean;
}

// Single-joint movements progress in smaller jumps and higher rep ranges than
// compound lifts. Matched by movement name (plus the Arms region, all isolation).
const ISOLATION_RE =
  /curl|extension|raise|fly|pushdown|kickback|shrug|pec deck|crunch|adduction|abduction|face pull|wrist|calf/i;

export function isIsolation(exercise: string): boolean {
  if (liftInfo(exercise)?.region === "Arms") return true;
  return ISOLATION_RE.test(exercise);
}

// Working rep range for double progression: compounds 5–8, isolation 8–12.
export function repRangeFor(exercise: string): { low: number; high: number } {
  return isIsolation(exercise) ? { low: 8, high: 12 } : { low: 5, high: 8 };
}

// Smallest sensible load jump (kg): big lower-body compounds take 5 kg;
// isolation and upper-body accessories take 2.5 kg.
export function weightIncrementKg(exercise: string): number {
  if (isIsolation(exercise)) return 2.5;
  if (/squat|deadlift|leg press|hip thrust/i.test(exercise)) return 5;
  const region = liftInfo(exercise)?.region;
  return region === "Legs" || region === "Glutes" ? 5 : 2.5;
}

// The same jump for lb loading: 10 lb for the big lower-body lifts, 5 lb
// otherwise. Native lb steps (not converted kg) so targets stay plate-loadable.
export function weightIncrementLb(exercise: string): number {
  return weightIncrementKg(exercise) === 5 ? 10 : 5;
}

// ---- RPE progression modifier (#743) ----
// When the ANCHOR set of the seed session carried an RPE, the double-progression
// verdict is nudged by how hard that set felt. These bounds are the only tuning
// knobs, and they're boundary-tested. A seed with NO RPE leaves every branch
// byte-for-byte the pre-RPE behavior (the nullable-signal invariant).
//
// At/below this, a set that hit the top of its range felt easy — bank a bigger
// jump instead of the standard single increment.
export const RPE_EASY_MAX = 7;
// At/above this, the anchor was at or near true failure. Reaching it while still
// short of the range floor means the load is too heavy to build reps under — hold
// (repeat) rather than chasing the floor, and phrase toward deload/variation.
export const RPE_HARD_MIN = 9.5;
// "A larger load increment" = two standard steps rather than one.
export const RPE_EASY_INCREMENTS = 2;

export interface NextSet {
  weightKg: number; // 0 for a bodyweight movement
  reps: number;
  bodyweight: boolean;
  // The declared rep target the suggestion progresses toward, when it came from
  // the user's scheme (null for heuristic suggestions). Logging the next
  // session with this intent keeps target-driven progression going.
  targetReps: number | null;
  rationale: string;
}

// The suggested top set as display text: "62.5 kg × 5", or "BW × 13" for
// bodyweight lifts.
export function nextSetText(ns: NextSet, wu: WeightUnit): string {
  if (ns.bodyweight) return `BW × ${ns.reps}`;
  return `${dispWeight(ns.weightKg, wu, 1)} ${wu} × ${ns.reps}`;
}

// The set shape sessionBestSet reads — matches the recent-session history the
// activity editor is shipped (lib/queries' RecentSession sets).
interface SessionSet {
  weight_kg: number | null;
  reps: number | null;
  weight_kg_right: number | null;
  reps_right: number | null;
  target_reps?: number | null;
  to_failure?: number | null;
  // Warmup flag (#338, 1 = warmup): excluded from the progression anchor and the
  // working-set list so a flagged warmup can't seed or fail the session. The
  // #330 load-based working-set heuristic remains the fallback for import-only
  // histories that carry no flag.
  warmup?: number | null;
  // Logged RPE (5–10) for the set, when recorded. Carried onto the anchor by
  // sessionBestSet so the progression modifier can read it (#743).
  rpe?: number | null;
}

// The seeding set of one session: highest estimated 1RM, then most reps —
// mirroring getStrengthByExercise's lastSessionBest so a suggestion built from
// shipped history matches the exercise detail panel's. Each side of a per-side
// set is its own candidate. `baseKg` folds the user's bodyweight into the load
// for bodyweight movements (pass 0 otherwise). Null when no set has reps.
export function sessionBestSet(
  sets: SessionSet[],
  baseKg = 0
): {
  weightKg: number;
  reps: number;
  targetReps: number | null;
  toFailure: boolean;
  // The anchor set's RPE (5–10), or null. Rides onto the seed so the
  // progression modifier reads the rating of the SAME set it progresses (#743).
  rpe: number | null;
} | null {
  let best: ReturnType<typeof sessionBestSet> = null;
  let bestE1rm = -1;
  for (const s of sets) {
    if (s.warmup) continue; // warmups never anchor the progression (#338)
    const sides: { weight: number; reps: number }[] = [];
    if (s.reps != null)
      sides.push({ weight: baseKg + (s.weight_kg ?? 0), reps: s.reps });
    if (s.reps_right != null)
      sides.push({
        weight: baseKg + (s.weight_kg_right ?? 0),
        reps: s.reps_right,
      });
    for (const side of sides) {
      const e1rm = estimate1RM(side.weight, side.reps);
      if (e1rm > bestE1rm || (e1rm === bestE1rm && side.reps > best!.reps)) {
        bestE1rm = e1rm;
        best = {
          weightKg: side.weight,
          reps: side.reps,
          targetReps: s.target_reps ?? null,
          toFailure: s.to_failure === 1,
          rpe: s.rpe ?? null,
        };
      }
    }
  }
  return best;
}

// Every rep-bearing set of one session flattened to a SessionWorkSet — the
// companion to sessionBestSet's single anchor. Each side of a per-side set is
// its own entry, `baseKg` folds bodyweight into the load the same way (pass 0
// otherwise), and each entry keeps its declared intent so progression can judge
// the whole session. Rep-less sets (e.g. a logged weight with no reps) drop out.
export function sessionWorkSets(
  sets: SessionSet[],
  baseKg = 0
): SessionWorkSet[] {
  const out: SessionWorkSet[] = [];
  for (const s of sets) {
    if (s.warmup) continue; // warmups aren't working sets (#338)
    const targetReps = s.target_reps ?? null;
    const toFailure = s.to_failure === 1;
    if (s.reps != null)
      out.push({
        weightKg: baseKg + (s.weight_kg ?? 0),
        reps: s.reps,
        targetReps,
        toFailure,
      });
    if (s.reps_right != null)
      out.push({
        weightKg: baseKg + (s.weight_kg_right ?? 0),
        reps: s.reps_right,
        targetReps,
        toFailure,
      });
  }
  return out;
}

// One side of a per-side session's sets, projected onto the bilateral shape so
// sessionBestSet/sessionWorkSets/suggestNextSet judge that side on its OWN
// history (#335). A per-side suggestion seeds each side independently — the
// weaker side is never loaded off the stronger one's numbers.
export function sideSets(
  sets: SessionSet[],
  side: "left" | "right"
): SessionSet[] {
  return sets.map((s) => ({
    weight_kg: side === "left" ? s.weight_kg : s.weight_kg_right,
    reps: side === "left" ? s.reps : s.reps_right,
    weight_kg_right: null,
    reps_right: null,
    target_reps: s.target_reps,
    to_failure: s.to_failure,
    warmup: s.warmup,
    rpe: s.rpe,
  }));
}

// The load after one increment, chosen in the user's unit so it stays loadable.
// kg users get the canonical 2.5/5 kg jump; lb users get a native 5/10 lb jump
// snapped to the nearest multiple of 5 lb (a plate-loadable number, not a
// converted-kg fraction like 181.9 lb). weightKg stays canonical; incDisp is
// the jump in `wu` for the rationale text.
// `steps` scales the jump: 1 is the normal double-progression increment, 2 is the
// "easy set" bump the RPE modifier banks when the anchor was logged at RPE ≤ 7
// (#743). incDisp reflects the TOTAL jump so the rationale text names it directly.
function addIncrement(
  exercise: string,
  lastKg: number,
  wu: WeightUnit,
  steps = 1
): { weightKg: number; incDisp: number } {
  if (wu === "lb") {
    const incLb = weightIncrementLb(exercise) * steps;
    // When the last weight is already a multiple of 5 lb (the norm for an lb
    // lifter) this is exactly lastLb + incLb; a kg-entered oddball still lands
    // on a loadable number nearby.
    const nextLb = Math.round((kgTo(lastKg, "lb") + incLb) / 5) * 5;
    return { weightKg: toKg(nextLb, "lb"), incDisp: incLb };
  }
  const inc = weightIncrementKg(exercise) * steps;
  return { weightKg: lastKg + inc, incDisp: round(inc, 1) };
}

// Fraction of the session's top working load a set must reach to count as a
// WORKING set. Warmup/ramp-up sets sit well below this and are excluded; a
// back-off set within ~10% still counts. Load is the only signal available —
// the data model has no warmup flag (#330), so a lighter set can't be told
// apart from a warmup any other way.
const WORKING_SET_LOAD_FRACTION = 0.9;

// The working sets of the seed session: those loaded at/near the anchor (the
// heaviest-e1RM set's load). Falls back to the anchor alone when the seed
// carries no set list (hand-built or pre-#330 seeds), and to every set when the
// anchor is weightless (bodyweight-unknown / weightless imports — there's no
// load to rank warmups by, so every set is "working").
function workingSets(seed: NextSetSeed): SessionWorkSet[] {
  const anchor = seed.lastSessionBest;
  if (!anchor) return [];
  const all =
    seed.lastSessionSets && seed.lastSessionSets.length > 0
      ? seed.lastSessionSets
      : [
          {
            weightKg: anchor.weightKg,
            reps: anchor.reps,
            targetReps: anchor.targetReps ?? null,
            toFailure: anchor.toFailure ?? false,
          },
        ];
  if (anchor.weightKg <= 0) return all;
  const floor = anchor.weightKg * WORKING_SET_LOAD_FRACTION;
  const near = all.filter((s) => s.weightKg >= floor);
  return near.length > 0 ? near : all;
}

// Did EVERY working set meet its own declared rep target? Uses the shared
// judgeTargets rule (a to-failure / untargeted working set is not a miss), so
// the suggestion and the journal card's met/missed badge can't fork. A session
// with no targeted set returns true (there's nothing to have missed).
function allWorkingSetsMetTarget(working: SessionWorkSet[]): boolean {
  return (
    judgeTargets(
      working.map((w) => ({
        reps: w.reps,
        target_reps: w.targetReps,
        to_failure: w.toFailure ? 1 : 0,
      }))
    ) !== "missed"
  );
}

// Suggest the next session's top set, judging the last session's WORKING sets
// (those at/near the anchor load) rather than its single best set (#330) — so a
// 3×8 that went 8/6/5 holds and builds instead of adding weight off the one set
// that met its target. lastSessionBest stays the WEIGHT anchor.
//
// When the anchor set declared a rep target (set intent, not AMRAP), progression
// honors the user's scheme instead of the heuristic range:
//   every working set met the target → add weight, keep the same rep target
//   any working set fell short        → hold weight, build to the target
// Otherwise (no intent, or a to-failure set), double progression within the
// heuristic range:
//   every working set reached the top → add weight, reset to the bottom
//   best set still below the bottom   → hold weight, build back to the bottom
//   best at the top but a set lagged  → hold weight, get all sets to the top
//   otherwise                         → hold weight, chase one more rep
// The anchor set's RPE (#743), when logged, MODIFIES this heuristic branch:
//   top of range at RPE ≤ 7  → add TWO increments, not one (it felt easy)
//   below the floor at RPE ≥ 9.5 → hold the load and repeat (near-failure and still
//                                  short means the weight is too heavy to build under)
// The target-driven and bodyweight branches are unchanged, and a seed with no RPE
// leaves the heuristic branch byte-for-byte its pre-RPE behavior.
// Bodyweight movements progress by reps; timed holds (planks) get no suggestion.
//
// Takes just the slice of ExerciseSummary it reads, so callers without full
// stats (the activity editor, seeding from shipped history) can call it too.
export type NextSetSeed = Pick<
  ExerciseSummary,
  "exercise" | "bodyweight" | "lastSessionBest" | "lastSessionSets"
>;
export function suggestNextSet(
  s: NextSetSeed,
  wu: WeightUnit = "kg"
): NextSet | null {
  if (isTimed(s.exercise)) return null;
  const last = s.lastSessionBest;
  if (!last) return null;
  const working = workingSets(s);

  // Declared rep target of the anchor set. An AMRAP has no meaningful rep plan
  // (its count is an outcome, not a goal), so it falls to the heuristic.
  const target = last.toFailure ? null : (last.targetReps ?? null);

  if (s.bodyweight) {
    if (target != null && !allWorkingSetsMetTarget(working)) {
      return {
        weightKg: 0,
        reps: target,
        bodyweight: true,
        targetReps: target,
        rationale: `Build to your ${target}-rep target`,
      };
    }
    return {
      weightKg: 0,
      reps: last.reps + 1,
      bodyweight: true,
      targetReps: null,
      rationale: `Beat ${last.reps} reps`,
    };
  }

  if (target != null) {
    if (allWorkingSetsMetTarget(working)) {
      const { weightKg, incDisp } = addIncrement(s.exercise, last.weightKg, wu);
      return {
        weightKg,
        reps: target,
        bodyweight: false,
        targetReps: target,
        rationale: `Hit your ${target}-rep target on every set — add ${incDisp} ${wu}`,
      };
    }
    return {
      weightKg: last.weightKg,
      reps: target,
      bodyweight: false,
      targetReps: target,
      rationale: `Build every set to your ${target}-rep target at this weight`,
    };
  }

  const { low, high } = repRangeFor(s.exercise);
  // The anchor set's RPE (null when unlogged) gates the two modifiers below. A
  // null rpe leaves easy/hard both false, so every branch is byte-for-byte the
  // pre-RPE behavior (#743).
  const rpe = last.rpe ?? null;
  const easy = rpe != null && rpe <= RPE_EASY_MAX;
  const hard = rpe != null && rpe >= RPE_HARD_MIN;

  if (working.every((w) => w.reps >= high)) {
    const steps = easy ? RPE_EASY_INCREMENTS : 1;
    const { weightKg, incDisp } = addIncrement(
      s.exercise,
      last.weightKg,
      wu,
      steps
    );
    return {
      weightKg,
      reps: low,
      bodyweight: false,
      targetReps: null,
      rationale: easy
        ? `Hit ${high}+ reps at RPE ${fmtRpe(rpe!)} — add ${incDisp} ${wu} and reset to ${low}`
        : `Hit ${high}+ reps on every set — add ${incDisp} ${wu} and reset to ${low}`,
    };
  }
  if (last.reps < low) {
    if (hard) {
      // Near-failure and still under the floor: the load is too heavy to build
      // reps under. Hold it and repeat the same effort; if it keeps stalling,
      // the plateau vocabulary points at a deload or a variation swap.
      return {
        weightKg: last.weightKg,
        reps: last.reps,
        bodyweight: false,
        targetReps: null,
        rationale: `RPE ${fmtRpe(rpe!)} and still under ${low} reps — hold this load and repeat; if it keeps stalling, deload or change the variation`,
      };
    }
    return {
      weightKg: last.weightKg,
      reps: low,
      bodyweight: false,
      targetReps: null,
      rationale: `Build back to ${low} reps at this weight`,
    };
  }
  // The best set reached the top of the range but a working set lagged: hold and
  // consolidate every set at the top before adding load.
  if (last.reps >= high) {
    return {
      weightKg: last.weightKg,
      reps: high,
      bodyweight: false,
      targetReps: null,
      rationale: `Hold weight — get all sets to ${high} reps`,
    };
  }
  return {
    weightKg: last.weightKg,
    reps: last.reps + 1,
    bodyweight: false,
    targetReps: null,
    rationale: `Add a rep toward ${high}`,
  };
}

// ---- Deload adjustment (#741) ----

// A deload week keeps the movement but pulls the stress back so accumulated fatigue
// can clear before the next cycle turns over. Two conservative, FIXED levers — the
// cycle is a user-set counter, not a readiness model (#559), so these are constants,
// not fatigue-driven:
//   • load: ~10% lighter (rounded to a loadable jump), and
//   • volume: one fewer working set per slot (never below one).
export const DELOAD_LOAD_FACTOR = 0.9; // −10% load
export const DELOAD_SET_REDUCTION = 1; // −1 working set per slot
export const DELOAD_MIN_SETS = 1; // never drop below a single working set

// The deload-adjusted prescription for one routine slot: fewer working sets and a
// lighter top-set target. ONE pure function so every surface that renders a deload
// week (the Training-overview session card, the dashboard/Telegram recommendation)
// shares the same math and can't drift (#221). A bodyweight / loadless next-set keeps
// its reps unchanged (there's no load to shave); a null next-set (cold start) stays
// null. Load is rounded to the exercise's own increment so the result stays
// plate-loadable (reusing weightIncrementKg, the engine's loading step).
export function deloadAdjust(slot: {
  exercise: string;
  sets: number;
  nextSet: NextSet | null;
}): { sets: number; nextSet: NextSet | null } {
  const sets = Math.max(DELOAD_MIN_SETS, slot.sets - DELOAD_SET_REDUCTION);
  return { sets, nextSet: deloadNextSet(slot.exercise, slot.nextSet) };
}

// The activity form's next-set suggestion, deload-aware (#923). The free-form logger
// has no routine/slot context and no slot set-count, so on a deload week — for a lift
// that resolves (variant-collapsed) to a slot in the active routine — it consumes ONLY
// the LOAD half of the shared deloadAdjust by passing `sets: 0`, exactly as the engine's
// compact card does (lib/coaching/engine.ts). Every surface that renders a deload week
// (the Training-overview session card, the recommendation copy, and now the form) reads
// the ONE deloadAdjust, so the shaved load can never drift (#221/#741). Off a deload
// week, or for a non-routine accessory, the plain progression is returned unchanged.
export function deloadFormSuggestion(
  base: NextSet | null,
  exercise: string,
  deload: boolean
): NextSet | null {
  if (!base || !deload) return base;
  return deloadAdjust({ exercise, sets: 0, nextSet: base }).nextSet;
}

function deloadNextSet(exercise: string, ns: NextSet | null): NextSet | null {
  if (!ns || ns.bodyweight || ns.weightKg <= 0) return ns;
  const inc = weightIncrementKg(exercise);
  const raw = ns.weightKg * DELOAD_LOAD_FACTOR;
  // Round the reduced load to the nearest loadable increment, never below one step.
  const weightKg = Math.max(inc, Math.round(raw / inc) * inc);
  return {
    ...ns,
    weightKg,
    rationale: "Deload week — ~10% lighter to recover",
  };
}

// Whether the most recent session set a new all-time record. Gated on more than
// one session so a brand-new exercise's first log isn't flagged as a "record".
// Weight PRs are meaningless for bodyweight lifts (their "top weight" tracks
// bodyweight), so they're suppressed there.
export function lastSessionPR(s: ExerciseSummary): {
  e1rm: boolean;
  weight: boolean;
} {
  const established = s.sessions > 1;
  return {
    e1rm: established && s.bestDate === s.lastDate,
    weight:
      established &&
      !s.bodyweight &&
      s.topWeightKg > 0 &&
      s.topWeightDate === s.lastDate,
  };
}

export interface PR {
  exercise: string;
  kind: "1rm" | "weight";
  date: string;
  e1rmKg: number;
  weightKg: number;
  reps: number;
  // Body is (part of) the load — render "BW × reps", not an absolute weight
  // (weightKg folds in bodyweight for these lifts, so it's not a plate count).
  bodyweight: boolean;
}

// Strength records set within the last `withinDays`, newest first. An exercise
// can contribute both a 1RM PR and a separately dated top-weight PR. Bodyweight
// lifts have no weight PR. First-ever logs (one session) are excluded.
export function recentPRs(
  stats: ExerciseSummary[],
  today: string,
  withinDays = 30
): PR[] {
  const prs: PR[] = [];
  for (const s of stats) {
    if (s.sessions < 2) continue;
    if (within(s.bestDate, today, withinDays)) {
      prs.push({
        exercise: s.exercise,
        kind: "1rm",
        date: s.bestDate,
        e1rmKg: s.e1rmKg,
        weightKg: s.bestWeightKg,
        reps: s.bestReps,
        bodyweight: s.bodyweight,
      });
    }
    if (
      !s.bodyweight &&
      s.topWeightKg > 0 &&
      s.topWeightDate !== s.bestDate &&
      within(s.topWeightDate, today, withinDays)
    ) {
      prs.push({
        exercise: s.exercise,
        kind: "weight",
        date: s.topWeightDate,
        e1rmKg: s.e1rmKg,
        weightKg: s.topWeightKg,
        reps: 0,
        bodyweight: false, // gated on !s.bodyweight above
      });
    }
  }
  return prs.sort(byDateDesc);
}
