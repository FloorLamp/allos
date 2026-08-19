// DB INTEGRATION TIER — #3132: both dots of the Overview strength ladder must be
// placed from ONE measurement lane.
//
// The ladder's CURRENT dot reads `ExerciseStat.freeWeightE1rmKg`, so it already
// honours #2326: a machine-backed set states nothing against a barbell population
// table. Its PRIOR dot took the newest point at or before the 90-day cutoff from
// `getExerciseE1rmSeries`, which has no free-weight filter and folds every non-warmup
// set, machine included. One ladder, two lanes — and the comparison between them
// (`moved`, the "· PR" suffix, the movement sort of the top rows) computed across
// both.
//
// This runs the REAL Overview wiring — getStrengthByExercise → the free-weight
// series' pre-cutoff point → strengthLadderRows — over the issue's own probe, and
// pins the failure in BOTH directions, because they fail opposite ways:
//
//   1. a spurious regression: a machine-inflated prior lands bands above the current
//      dot, so the lifter reads as having fallen off a number they never lifted
//      free-weight;
//   2. a masked PR: that same inflated prior keeps `moved` false, so a genuine
//      free-weight PR loses its "· PR" suffix AND its place in the movement sort.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { exerciseHistoryKey } from "@/lib/lifts";
import { estimate1RM } from "@/lib/strength";
import { strengthLevelRank } from "@/lib/strength-standards";
import { getExerciseE1rmSeries, getStrengthLadder } from "@/lib/queries";

const BENCH = "Bench Press";
const OHP = "Overhead Press";
const SEX = "male" as const;
const BODYWEIGHT_KG = 80;

let mixedId: number;
let machineOnlyPriorId: number;
let noGearId: number;

// A profile the standards tables can actually place: a known sex and a known
// bodyweight, which is what strengthStanding requires before it says anything.
function addProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'sex', ?)`
  ).run(id, SEX);
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
  ).run(id, today(id), BODYWEIGHT_KG);
  return id;
}

function addEquipment(
  profile: number,
  name: string,
  category: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, ?, ?)`
      )
      .run(profile, name, category).lastInsertRowid
  );
}

function addSet(
  profile: number,
  date: string,
  exercise: string,
  weightKg: number,
  reps: number,
  equipmentId: number | null
) {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profile, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, equipment_id)
     VALUES (?, ?, 1, ?, ?, ?)`
  ).run(activityId, exercise, weightKg, reps, equipmentId);
}

// The Overview ladder's own entry point — the SAME call the page makes, so a call
// site that drops the free-weight lane fails here rather than passing on a
// re-implementation of the wiring.
function ladderFor(profile: number) {
  return getStrengthLadder(profile, today(profile));
}

function rowFor(profile: number, exercise: string) {
  const row = ladderFor(profile).find((r) => r.exercise === exercise);
  expect(row, `no ladder row for ${exercise}`).toBeDefined();
  return row!;
}

beforeAll(() => {
  // 1. THE ISSUE'S PROBE, plus the free-weight history that makes the masked PR
  //    visible: 100 days ago this lifter pressed 120kg×5 on a machine AND 50kg×5 on
  //    the bar; today they pressed 60kg×5 on the bar — a genuine free-weight PR.
  //    A second lift that genuinely did not move gives the sort something to rank.
  mixedId = addProfile("Mixed Lanes Lifter");
  const mixMachine = addEquipment(mixedId, "Chest press machine", "Machine");
  const mixRack = addEquipment(mixedId, "Power rack", "Barbell");
  const xt = today(mixedId);
  addSet(mixedId, shiftDateStr(xt, -100), BENCH, 120, 5, mixMachine);
  addSet(mixedId, shiftDateStr(xt, -100), BENCH, 50, 5, mixRack);
  addSet(mixedId, shiftDateStr(xt, -2), BENCH, 60, 5, mixRack);
  addSet(mixedId, shiftDateStr(xt, -100), OHP, 40, 5, mixRack);
  addSet(mixedId, shiftDateStr(xt, -2), OHP, 40, 5, mixRack);

  // 2. The issue's probe on its own: the ONLY pre-cutoff work was machine work.
  machineOnlyPriorId = addProfile("Machine Prior Lifter");
  const onlyMachine = addEquipment(
    machineOnlyPriorId,
    "Chest press machine",
    "Machine"
  );
  const onlyRack = addEquipment(machineOnlyPriorId, "Power rack", "Barbell");
  const ot = today(machineOnlyPriorId);
  addSet(machineOnlyPriorId, shiftDateStr(ot, -100), BENCH, 120, 5, onlyMachine);
  addSet(machineOnlyPriorId, shiftDateStr(ot, -2), BENCH, 60, 5, onlyRack);

  // 3. The overwhelmingly common case: no equipment rows at all. Restricting the
  //    lane must change nothing here.
  noGearId = addProfile("No Gear Lifter");
  const nt = today(noGearId);
  addSet(noGearId, shiftDateStr(nt, -100), BENCH, 50, 5, null);
  addSet(noGearId, shiftDateStr(nt, -2), BENCH, 60, 5, null);
});

describe("the free-weight-restricted e1RM series (#3132)", () => {
  it("drops a machine set's point, keeping the free-weight best of that day", () => {
    const free = getExerciseE1rmSeries(mixedId, undefined, undefined, {
      freeWeightOnly: true,
    }).find((r) => exerciseHistoryKey(r.exercise) === exerciseHistoryKey(BENCH));
    const priorPoint = free!.points.at(0)!;
    expect(priorPoint.value).toBeCloseTo(estimate1RM(50, 5), 6);
    expect(priorPoint.value).not.toBeCloseTo(estimate1RM(120, 5), 6);
  });

  it("emits no series at all for a movement backed only by machine sets", () => {
    const machineOnly = addProfile("Machine Only Lifter");
    const gear = addEquipment(machineOnly, "Chest press machine", "Machine");
    addSet(
      machineOnly,
      shiftDateStr(today(machineOnly), -5),
      BENCH,
      120,
      5,
      gear
    );
    expect(
      getExerciseE1rmSeries(machineOnly, undefined, undefined, {
        freeWeightOnly: true,
      })
    ).toEqual([]);
    // …while the default lane still carries it: a machine press is a real set and a
    // real plateau, and plateau detection reads that history unchanged.
    expect(
      getExerciseE1rmSeries(machineOnly).find(
        (r) => exerciseHistoryKey(r.exercise) === exerciseHistoryKey(BENCH)
      )?.points.at(-1)?.value
    ).toBeCloseTo(estimate1RM(120, 5), 6);
  });

  it("leaves a history with no equipment rows untouched", () => {
    const withFilter = getExerciseE1rmSeries(noGearId, undefined, undefined, {
      freeWeightOnly: true,
    });
    expect(withFilter).toEqual(getExerciseE1rmSeries(noGearId));
  });
});

describe("a machine-backed prior no longer invents a regression (#3132)", () => {
  it("places the prior dot at the free-weight e1RM, not the machine one", () => {
    const { placement } = rowFor(mixedId, BENCH);
    expect(placement.prior).not.toBeNull();
    expect(placement.prior!.e1rmKg).toBeCloseTo(estimate1RM(50, 5), 6);
    expect(placement.prior!.e1rmKg).not.toBeCloseTo(estimate1RM(120, 5), 6);
  });

  it("keeps the prior dot at or below the current one — no phantom fall", () => {
    const { placement } = rowFor(mixedId, BENCH);
    expect(placement.priorPercent).not.toBeNull();
    expect(placement.priorPercent!).toBeLessThanOrEqual(
      placement.currentPercent
    );
    expect(strengthLevelRank(placement.prior!.level)).toBeLessThanOrEqual(
      strengthLevelRank(placement.current.level)
    );
  });

  it("declines the prior dot outright when the pre-cutoff work was all machine", () => {
    // The issue's probe exactly. There is no free-weight standing to compare
    // against, so the ladder shows one dot — the state the Longevity pillar already
    // renders — rather than a standing the standards rule says must not exist.
    const { placement } = rowFor(machineOnlyPriorId, BENCH);
    expect(placement.prior).toBeNull();
    expect(placement.priorPercent).toBeNull();
    expect(placement.current.e1rmKg).toBeCloseTo(estimate1RM(60, 5), 6);
  });
});

describe("a genuine free-weight PR is no longer masked (#3132)", () => {
  it("marks the lift as moved, which is what renders the '· PR' suffix", () => {
    expect(rowFor(mixedId, BENCH).placement.moved).toBe(true);
  });

  it("sorts the moved lift above one that did not move", () => {
    const rows = ladderFor(mixedId);
    expect(rows.map((r) => r.exercise)).toEqual([BENCH, OHP]);
    expect(rows[1].placement.moved).toBe(false);
  });

  it("does not claim a PR when there is no comparable prior", () => {
    // Declining the prior is not the same as declaring a PR: with nothing in the
    // lane to compare against, the ladder says nothing about movement.
    expect(rowFor(machineOnlyPriorId, BENCH).placement.moved).toBe(false);
  });
});
