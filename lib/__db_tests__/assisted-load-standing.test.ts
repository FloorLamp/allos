// DB INTEGRATION TIER — #1922: an ASSISTED lift's load must reach the standings
// path already flipped, and must reach the record path not at all.
//
// The pure class guard (lib/__tests__/assisted-load-guard.test.ts) pins the
// property over the catalog; this pins that the REAL aggregate honours it. The two
// are different claims: the fold lives in `getStrengthByExercise`, and a builder
// that quietly kept `base + weight` would satisfy every pure test while shipping
// the inversion. So the assertions here run over rows in the database.
//
// The reported shape, stated as a story: a lifter starts on the assist machine at
// 40 kg of counterweight and works down to 10 kg — real, visible progress. Read
// with the load ADDED, that history is a lifter whose top load FELL from 120 kg to
// 90 kg: a regression, a lost PR, and eventually a plateau finding advising a
// deload. Read with the load SUBTRACTED it is what it is — 40 kg of system load
// rising to 70 kg.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { recentPRs } from "@/lib/coaching";
import { estimate1RM } from "@/lib/strength";
import {
  strengthStanding,
  strengthStandingPercent,
} from "@/lib/strength-standards";
import { detectPlateaus } from "@/lib/training-observations";
import { getExerciseE1rmSeries, getStrengthByExercise } from "@/lib/queries";

const ASSISTED = "Assisted Pull Up";
const WEIGHTED = "Pull Up";
const SEX = "male" as const;
const BODYWEIGHT_KG = 80;
const REPS = 5;

let assistedId: number;
let weightedId: number;

// A profile the standards tables can actually place: known sex, known bodyweight.
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
  ).run(id, shiftDateStr(today(id), -90), BODYWEIGHT_KG);
  return id;
}

function addSet(
  profile: number,
  date: string,
  exercise: string,
  weightKg: number,
  reps: number
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
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, ?, ?)`
  ).run(activityId, exercise, weightKg, reps);
}

function statFor(profile: number, exercise: string) {
  const s = getStrengthByExercise(profile).find((e) => e.exercise === exercise);
  expect(s, `no stat for ${exercise}`).toBeDefined();
  return s!;
}

// Assistance falling 40 → 10 kg: the lifter needing less help each session.
const ASSISTANCE_DAYS_AGO = [
  { ago: 40, kg: 40 },
  { ago: 28, kg: 30 },
  { ago: 14, kg: 20 },
  { ago: 3, kg: 10 },
];

beforeAll(() => {
  assistedId = addProfile("Assisted Puller");
  const at = today(assistedId);
  for (const s of ASSISTANCE_DAYS_AGO)
    addSet(assistedId, shiftDateStr(at, -s.ago), ASSISTED, s.kg, REPS);

  // The control profile logs the SAME numbers against the weighted pull-up, where
  // they are added weight. Every claim below that differs between the two profiles
  // is a claim about load KIND rather than about these particular numbers.
  weightedId = addProfile("Weighted Puller");
  const wt = today(weightedId);
  for (const s of ASSISTANCE_DAYS_AGO)
    addSet(weightedId, shiftDateStr(wt, -s.ago), WEIGHTED, s.kg, REPS);
});

describe("assisted lift — the aggregate folds the counterweight out (#1922)", () => {
  it("keeps it a SEPARATE history from the movement it substitutes for", () => {
    // #482/#836: distinct equipment, distinct history. An assisted rep and a full
    // rep are different loads, so they must not blend into one progression.
    const names = getStrengthByExercise(assistedId).map((s) => s.exercise);
    expect(names).toContain(ASSISTED);
    expect(names).not.toContain(WEIGHTED);
  });

  it("reports the effective load, never bodyweight PLUS the assistance", () => {
    const stat = statFor(assistedId, ASSISTED);
    // Best session: 10 kg of assistance ⇒ 70 kg of system load.
    expect(stat.topWeightKg).toBe(70);
    expect(stat.bestWeightKg).toBe(70);
    expect(stat.e1rmKg).toBeCloseTo(estimate1RM(70, REPS), 6);
    // The inverted reading would have made the FIRST session the best one, at
    // 80 + 40 = 120 kg. Nothing in the aggregate carries that number.
    expect(stat.topWeightKg).toBeLessThan(BODYWEIGHT_KG);
    // Same rows read as ADDED weight give exactly the inverted answer, which is
    // what makes the assertion above about the fold and not about the fixture.
    expect(statFor(weightedId, WEIGHTED).topWeightKg).toBe(BODYWEIGHT_KG + 40);
  });

  it("places the standing at bodyweight MINUS assistance, on the base bands", () => {
    const stat = statFor(assistedId, ASSISTED);
    const standing = strengthStanding(
      stat.exercise,
      stat.freeWeightE1rmKg,
      SEX,
      BODYWEIGHT_KG
    );
    expect(standing).not.toBeNull();
    expect(standing!.lift).toBe(WEIGHTED); // scored against Pull Up's own bands
    expect(standing!.exercise).toBe(ASSISTED); // named by what was logged (#1921)
    expect(standing!.e1rmKg).toBeCloseTo(estimate1RM(70, REPS), 6);
    // …and strictly below where the same lifter's unassisted rep would land.
    const unassisted = strengthStanding(
      WEIGHTED,
      estimate1RM(BODYWEIGHT_KG, REPS),
      SEX,
      BODYWEIGHT_KG
    )!;
    expect(strengthStandingPercent(standing)!).toBeLessThan(
      strengthStandingPercent(unassisted)!
    );
  });

  it("trends UP over the sessions where the lifter needed less help", () => {
    const series = getExerciseE1rmSeries(assistedId).find(
      (s) => s.exercise === ASSISTED
    )!;
    const byDate = [...series.points].sort((a, b) =>
      a.date < b.date ? -1 : 1
    );
    expect(byDate).toHaveLength(ASSISTANCE_DAYS_AGO.length);
    for (let i = 1; i < byDate.length; i++) {
      expect(
        byDate[i].value,
        `session ${i} must be stronger than ${i - 1}, not weaker`
      ).toBeGreaterThan(byDate[i - 1].value);
    }
  });

  it("makes no ascending-load CLAIM about it: no PR, no plateau", () => {
    const t = today(assistedId);
    expect(recentPRs(getStrengthByExercise(assistedId), t, 365)).toEqual([]);
    expect(detectPlateaus(getExerciseE1rmSeries(assistedId), t)).toEqual([]);
    // Control: the same rows under the weighted name DO mint a record, so the
    // empty lists above are the exclusion rather than an inert fixture.
    const wt = today(weightedId);
    expect(
      recentPRs(getStrengthByExercise(weightedId), wt, 365).length
    ).toBeGreaterThan(0);
  });
});

describe("PIN: the weighted pull-up path is untouched (#1922)", () => {
  it("still folds bodyweight PLUS the added load, and still places there", () => {
    const stat = statFor(weightedId, WEIGHTED);
    // 40 kg added at 80 kg bodyweight ⇒ 120 kg of system load, exactly as before.
    expect(stat.topWeightKg).toBe(120);
    expect(stat.e1rmKg).toBeCloseTo(estimate1RM(120, REPS), 6);
    const standing = strengthStanding(
      WEIGHTED,
      stat.freeWeightE1rmKg,
      SEX,
      BODYWEIGHT_KG
    )!;
    expect(standing.lift).toBe(WEIGHTED);
    expect(standing.bodyweightLift).toBe(true);
    // @80 kg the Pull Up floors are [68, 80, 100, 120, 152]; an e1RM of 140 clears
    // advanced (120) and falls short of elite (152).
    expect(standing.e1rmKg).toBeCloseTo(140, 6);
    expect(standing.level).toBe("advanced");
    expect(standing.levelFloorKg).toBe(120);
    expect(standing.nextLevel).toBe("elite");
    expect(standing.nextFloorKg).toBe(152);
  });
});
