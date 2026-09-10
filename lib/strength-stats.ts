// PURE per-exercise strength aggregates (#5172). The gather (`strengthSetRows` +
// `getStrengthByExercise` in lib/queries/training/strength.ts) performs the one
// all-history scan and hands the rows here; every rule about what they mean is stated
// in this module exactly once:
//
//   - the GROUPING axis (#1610): movement-wide, or one row per (movement, implement)
//     when the caller opts in — so a top weight, an e1RM or a PR is never assembled
//     from two registry machines that both serialize as the same logged name.
//   - the bodyweight fold: for a catalog bodyweight lift the body is (part of) the
//     load, resolved as of each set's own date, and `assisted` lifts subtract (#1922).
//   - the PR DATE rule: `topWeightDate` records when the heaviest load was FIRST
//     reached (a strict compare, never Math.max), and `bestDate` follows the best
//     e1RM with more reps breaking a tie.
//   - the FREE-WEIGHT-ONLY best (#2326): `freeWeightE1rmKg` is the same maximum
//     restricted to sets whose implement does not contradict a free-weight population
//     standard — asked per SET, because a name's history routinely mixes implements
//     and the row knows something the name does not. 0 is the honest answer, not a
//     sentinel.
//   - the forward-looking SEED: withheld unless the newest session is inside the
//     recent window, and taken from that session's own logged name AND equipment lane.
//
// Pure — no DB, no clock, no network: the caller supplies today's date.

import { bodyweightAsOf } from "./bodyweight";
import {
  sessionBestSet,
  sessionWorkSets,
  type SessionWorkSet,
} from "./coaching";
import { contradictsFreeWeightStandard } from "./equipment-availability";
import { isSeedFresh, pickSeedSessions } from "./exercise-window";
import {
  effectiveLoadKg,
  exerciseHistoryKey,
  isBodyweight,
  loadKindOf,
  movementLoadKey,
  resolveBodyweightKind,
  type LoadKind,
} from "./lifts";
import { estimate1RM } from "./strength";

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
  // The best e1RM among sets whose equipment does not CONTRADICT a free-weight
  // population standard (#2326) — 0 when every backing set was logged on a machine.
  //
  // This is the aggregate the strength-STANDING path consumes, and only that path.
  // `e1rmKg` above answers "what is this lifter's best e1RM?" and every set counts
  // toward it, machine included: a machine press is a real set and a real PR. This
  // one answers the different question "what can be scored against a barbell
  // population table?", which a fixed-path machine's mechanical advantage
  // disqualifies a set from. A bare base name like `Overhead Press` used to reach
  // the barbell table on the strength of the NAME while the row's own equipment link
  // said Machine — the guard existed, the evidence existed, and they never met.
  //
  // Mixed history scores from the free-weight sets alone, so genuine barbell work
  // keeps its standing rather than being suppressed by machine sets logged under the
  // same name. Nothing else reads this: PRs, progression seeds and volume are
  // unchanged, and nothing is filtered out of storage.
  freeWeightE1rmKg: number;
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
  // Activity id of the most recent session, for linking to its training log entry.
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
// aggregator below reads it.
export interface StrengthSetRow {
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
  // The implement's registry CATEGORY (#2326) — the axis that decides whether a set
  // can be scored against a free-weight population table. NULL for a set with no
  // equipment row, which is not a contradiction (see contradictsFreeWeightStandard).
  equipmentCategory: string | null;
}

// Fold the all-history strength scan (date+id ascending) into one stat row per group.
// `weights` is the profile's bodyweight series ascending by date; `todayStr` is the
// profile's today, read only to decide whether the forward-looking seed is fresh.
//
// `byLoadContext` (#1610) groups on `movementLoadKey` instead of `exerciseHistoryKey`
// — one row per (movement, implement) rather than one per movement. The two groupings
// are different AGGREGATES of the same history, not two answers to one question:
// bodyweight resolution, the session-seed lane and the per-day volume base are all
// resolved per GROUP, so a lane list cannot simply be folded back into a movement
// list. A profile whose sets carry no implement link short-circuits to the identical
// movement-wide result outright.
export function foldStrengthByExercise(
  rows: StrengthSetRow[],
  weights: { date: string; weight_kg: number }[],
  todayStr: string,
  byLoadContext = false
): ExerciseStat[] {
  // For a profile whose sets carry no implement link at all, every set is already in
  // the same (unassigned) lane: `movementLoadKey` partitions exactly as
  // `exerciseHistoryKey` does and every emitted equipment field is null either way.
  // Normalize to the movement-wide grouping so the two lists are not merely equivalent
  // but IDENTICAL — the promise #1610's comment makes, now made structurally.
  const laned = byLoadContext && rows.some((r) => r.equipmentId != null);

  const bwAsOf = (date: string) => bodyweightAsOf(weights, date);

  interface Acc {
    exercise: string;
    // The group's load context when grouping by it; both null movement-wide.
    equipmentId: number | null;
    equipment: string | null;
    addBodyweight: boolean; // catalog bodyweight lift → fold bodyweight into load
    loadKind: LoadKind; // …and whether a logged weight adds to it or subtracts (#1922)
    sawExternalWeight: boolean; // any set logged a weight
    dates: Set<string>;
    totalSets: number;
    topWeightKg: number;
    topWeightDate: string;
    e1rmKg: number;
    // #2326: the same max, restricted to sets whose equipment doesn't contradict a
    // free-weight standard. No sentinel — 0 is the honest answer for "no free-weight
    // set has ever backed this lift", and it is exactly the value strengthStanding
    // already declines to place.
    freeWeightE1rmKg: number;
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
    lastSessionRows: StrengthSetRow[];
    volByDate: Map<string, number>;
    repsByDate: Map<string, number>;
  }
  const t = todayStr;
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
        loadKind: loadKindOf(r.exercise),
        sawExternalWeight: false,
        dates: new Set(),
        totalSets: 0,
        topWeightKg: 0,
        topWeightDate: r.date,
        // Sentinel so the first set always seeds the "best" fields, even for
        // bodyweight lifts where every set's estimated 1RM is 0.
        e1rmKg: -1,
        freeWeightE1rmKg: 0,
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
      sides.push({
        weight: effectiveLoadKg(cur.loadKind, base, r.weight_kg),
        reps: r.reps,
      });
    if (r.reps_right != null)
      sides.push({
        weight: effectiveLoadKg(cur.loadKind, base, r.weight_kg_right),
        reps: r.reps_right,
      });
    let setVol = 0;
    let setReps = 0;
    // Does THIS set's own implement rule it out of a free-weight comparison (#2326)?
    // Asked per set, not per group: a name's history routinely mixes implements, and
    // the whole point is that the row knows something the name does not.
    const freeWeight = !contradictsFreeWeightStandard(r.equipmentCategory);
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
      if (freeWeight && e1rm > cur.freeWeightE1rmKg)
        cur.freeWeightE1rmKg = e1rm;
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
        freeWeightE1rmKg: Math.max(0, c.freeWeightE1rmKg),
        bestWeightKg: c.bestWeightKg,
        bestReps: c.bestReps,
        bestDate: c.bestDate,
        lastActivityId: c.lastActivityId,
        lastSessionBest: seedFresh
          ? sessionBestSet(seedRows, seedBase, c.loadKind)
          : null,
        lastSessionSets: seedFresh
          ? sessionWorkSets(seedRows, seedBase, c.loadKind)
          : [],
        lastDate: c.lastDate,
        bodyweight,
        volumeIsReps,
        volume: [...(volumeIsReps ? c.repsByDate : c.volByDate).entries()]
          .map(([date, volumeKg]) => ({ date, volumeKg }))
          .sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    })
    .sort((a, b) => b.e1rmKg - a.e1rmKg);
}
