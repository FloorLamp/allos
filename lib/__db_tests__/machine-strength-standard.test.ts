// DB INTEGRATION TIER — #2326: a machine lift logged under a BARE BASE NAME must not
// be scored against the barbell population standard.
//
// `tableFor` reads equipment from the exercise NAME only, so a bare `Overhead Press`
// resolved to `equipment: null` and was accepted as barbell — while the set's own
// `equipment_id` pointed at a `Machine` row. The guard existed, the evidence existed
// on the same row, and they never met. Observed on real data: a plate-loaded shoulder
// press yielded an e1RM ~94% of the same profile's best bench, and a badge two bands
// above that profile's actual standing.
//
// The fix is a SECOND aggregate, not a filter: `ExerciseStat.e1rmKg` still answers
// "what is this lifter's best e1RM?" over every set, and `freeWeightE1rmKg` answers
// the different question "what can be scored against a barbell table?". This pins
// both, plus the three cases in the issue's Behaviour section (all-machine, mixed,
// NULL equipment) end to end through the standings path.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { contradictsFreeWeightStandard } from "@/lib/equipment-availability";
import { estimate1RM } from "@/lib/strength";
import { strengthStanding } from "@/lib/strength-standards";
import { EQUIPMENT_CATEGORIES } from "@/lib/types";
import { getStrengthByExercise } from "@/lib/queries";

// A bare base name that HAS a barbell standards table — the whole point of the bug.
const BARE = "Overhead Press";

let machineOnlyId: number;
let mixedId: number;
let noGearId: number;
let barbellRackId: number;

function addProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
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

function statFor(profile: number, exercise: string) {
  const s = getStrengthByExercise(profile).find((e) => e.exercise === exercise);
  expect(s, `no stat for ${exercise}`).toBeDefined();
  return s!;
}

beforeAll(() => {
  // 1. Every backing set on a Machine, logged under the bare base name.
  machineOnlyId = addProfile("Machine Presser");
  const mOnly = addEquipment(
    machineOnlyId,
    "Shoulder press machine",
    "Machine"
  );
  const mt = today(machineOnlyId);
  addSet(machineOnlyId, shiftDateStr(mt, -20), BARE, 90, 5, mOnly);
  addSet(machineOnlyId, shiftDateStr(mt, -6), BARE, 95, 5, mOnly);

  // 2. Mixed history under ONE name: real barbell work plus heavier machine work.
  //    The machine sets are deliberately the heavier ones, so a standing scored from
  //    the raw best e1RM would be visibly inflated over the barbell-only one.
  mixedId = addProfile("Mixed Presser");
  const mixMachine = addEquipment(mixedId, "Selectorised press", "Machine");
  barbellRackId = addEquipment(mixedId, "Power rack", "Barbell");
  const xt = today(mixedId);
  addSet(mixedId, shiftDateStr(xt, -30), BARE, 45, 5, barbellRackId);
  addSet(mixedId, shiftDateStr(xt, -16), BARE, 50, 5, barbellRackId);
  addSet(mixedId, shiftDateStr(xt, -9), BARE, 100, 5, mixMachine);

  // 3. No equipment rows at all — the overwhelmingly common case, and the one where
  //    reading absence as "machine" would silently strip everyone's standing.
  noGearId = addProfile("No Gear Presser");
  const nt = today(noGearId);
  addSet(noGearId, shiftDateStr(nt, -18), BARE, 50, 5, null);
  addSet(noGearId, shiftDateStr(nt, -4), BARE, 55, 5, null);
});

describe("contradictsFreeWeightStandard (#2326)", () => {
  it("names Machine and nothing else in the category vocabulary", () => {
    const contradicting = EQUIPMENT_CATEGORIES.filter((c) =>
      contradictsFreeWeightStandard(c)
    );
    expect(contradicting).toEqual(["Machine"]);
  });

  it("treats an absent or unknown category as no contradiction", () => {
    // Unknown must keep meaning "nothing contradicts", never "machine": most sets
    // carry no equipment row, and the other reading would strip nearly every badge.
    expect(contradictsFreeWeightStandard(null)).toBe(false);
    expect(contradictsFreeWeightStandard(undefined)).toBe(false);
    expect(contradictsFreeWeightStandard("")).toBe(false);
    expect(contradictsFreeWeightStandard("Barbell")).toBe(false);
    expect(contradictsFreeWeightStandard("Dumbbell")).toBe(false);
    expect(contradictsFreeWeightStandard("Kettlebell")).toBe(false);
  });

  it("matches case- and whitespace-insensitively, like the other category readers", () => {
    expect(contradictsFreeWeightStandard("  machine ")).toBe(true);
    expect(contradictsFreeWeightStandard("MACHINE")).toBe(true);
  });
});

describe("a bare base name backed only by machine sets (#2326)", () => {
  it("keeps its real best e1RM — the machine set is a real set", () => {
    const stat = statFor(machineOnlyId, BARE);
    expect(stat.e1rmKg).toBeCloseTo(estimate1RM(95, 5), 6);
  });

  it("has no free-weight e1RM to be scored with", () => {
    expect(statFor(machineOnlyId, BARE).freeWeightE1rmKg).toBe(0);
  });

  it("gets NO standing — untested against the standard, not untrained", () => {
    const stat = statFor(machineOnlyId, BARE);
    // The lift resolves to a real table and the raw e1RM WOULD place, which is the
    // defect: the standings input is what declines, so the surfaces hide the badge
    // exactly as they do for a machine-NAMED variant.
    expect(strengthStanding(BARE, stat.e1rmKg, "male", 80)).not.toBeNull();
    expect(
      strengthStanding(BARE, stat.freeWeightE1rmKg, "male", 80)
    ).toBeNull();
  });
});

describe("mixed barbell + machine history under one name (#2326)", () => {
  it("scores from the free-weight sets alone, so the barbell standing survives", () => {
    const stat = statFor(mixedId, BARE);
    expect(stat.e1rmKg).toBeCloseTo(estimate1RM(100, 5), 6); // machine set is the best
    expect(stat.freeWeightE1rmKg).toBeCloseTo(estimate1RM(50, 5), 6);
    expect(stat.freeWeightE1rmKg).toBeLessThan(stat.e1rmKg);
  });

  it("places lower than the inflated raw e1RM would have", () => {
    const stat = statFor(mixedId, BARE);
    const honest = strengthStanding(BARE, stat.freeWeightE1rmKg, "male", 80);
    const inflated = strengthStanding(BARE, stat.e1rmKg, "male", 80);
    expect(honest).not.toBeNull();
    expect(inflated).not.toBeNull();
    expect(honest!.e1rmKg).toBeLessThan(inflated!.e1rmKg);
  });
});

describe("sets carrying no equipment link (#2326)", () => {
  it("are unchanged — the two aggregates agree", () => {
    const stat = statFor(noGearId, BARE);
    expect(stat.freeWeightE1rmKg).toBe(stat.e1rmKg);
    expect(stat.freeWeightE1rmKg).toBeCloseTo(estimate1RM(55, 5), 6);
  });

  it("still place against the standard", () => {
    const stat = statFor(noGearId, BARE);
    expect(
      strengthStanding(BARE, stat.freeWeightE1rmKg, "male", 80)
    ).not.toBeNull();
  });
});

describe("an equipment row with a NULL category (#2326)", () => {
  it("does not contradict — the row exists but states nothing about the implement", () => {
    const p = addProfile("Unclassified Gear");
    const gear = addEquipment(p, "Unlabelled bar", null);
    const t = today(p);
    addSet(p, shiftDateStr(t, -5), BARE, 60, 5, gear);
    const stat = statFor(p, BARE);
    expect(stat.freeWeightE1rmKg).toBe(stat.e1rmKg);
  });
});
