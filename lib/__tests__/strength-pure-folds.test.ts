import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  foldExerciseBests,
  foldExerciseLoadContexts,
  foldLoggedEquipmentByExercise,
  foldRecentExerciseHistory,
  type RecentSetRow,
} from "../strength-history";
import {
  foldExerciseComparison,
  type ComparisonSetRow,
} from "../strength-comparison";
import { foldE1rmSeries, type E1rmSetRow } from "../strength-series";
import { foldStrengthByExercise, type StrengthSetRow } from "../strength-stats";

// #5172 moved the set-level strength math out of lib/queries/training/strength.ts,
// which could only be exercised through a seeded database, into four pure modules.
// These tests state the RULES the move was made to protect, on typed fixtures with
// no DB: each one calls a pure fold directly, so re-inlining the rule into the query
// layer takes the fold with it and fails here. The lib/__db_tests__ strength suites
// remain the end-to-end pin over real rows and are not duplicated below.

const WEIGHTS = [
  { date: "2026-01-01", weight_kg: 80 },
  { date: "2026-06-01", weight_kg: 70 },
];

const MACHINE_ID = 7;
const OTHER_MACHINE_ID = 8;

function cmpRow(over: Partial<ComparisonSetRow> = {}): ComparisonSetRow {
  return {
    exercise: "Machine Chest Press",
    date: "2026-07-01",
    activity_id: 1,
    set_number: 1,
    weight_kg: 50,
    reps: 5,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    target_reps: null,
    to_failure: null,
    equipment_id: null,
    equipment: null,
    ...over,
  };
}

function seriesRow(over: Partial<E1rmSetRow> = {}): E1rmSetRow {
  return {
    exercise: "Overhead Press",
    date: "2026-07-01",
    weight_kg: 50,
    reps: 5,
    weight_kg_right: null,
    reps_right: null,
    equipmentId: null,
    equipment: null,
    equipmentCategory: null,
    ...over,
  };
}

function statRow(over: Partial<StrengthSetRow> = {}): StrengthSetRow {
  return {
    exercise: "Overhead Press",
    date: "2026-07-01",
    activity_id: 1,
    weight_kg: 50,
    reps: 5,
    weight_kg_right: null,
    reps_right: null,
    target_reps: null,
    to_failure: null,
    rpe: null,
    equipmentId: null,
    equipment: null,
    equipmentCategory: null,
    ...over,
  };
}

function recentRow(over: Partial<RecentSetRow> = {}): RecentSetRow {
  return {
    exercise: "Machine Chest Press",
    date: "2026-07-01",
    activity_id: 1,
    set_number: 1,
    weight_kg: 50,
    reps: 5,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    target_reps: null,
    to_failure: null,
    warmup: 0,
    rpe: null,
    equipment_id: null,
    equipment: null,
    ...over,
  };
}

// ── The equipment-lane rule (#1610) ────────────────────────────────────────────
describe("the equipment lane is a load identity, not a label", () => {
  it("narrows the comparison BEFORE the per-session fold, so a two-implement session reports only its comparable sets", () => {
    // One activity, one logged name, two machines at deliberately non-comparable
    // loads. Folding first and filtering after would blend them into a single
    // 80 kg top weight and a volume nobody lifted on either machine.
    const rows = [
      cmpRow({
        set_number: 1,
        equipment_id: MACHINE_ID,
        equipment: "Home",
        weight_kg: 80,
        reps: 5,
      }),
      cmpRow({
        set_number: 2,
        equipment_id: OTHER_MACHINE_ID,
        equipment: "Hotel",
        weight_kg: 50,
        reps: 5,
      }),
    ];
    const home = foldExerciseComparison(rows, WEIGHTS, "kg", {
      equipmentLane: String(MACHINE_ID),
    });
    expect(home).toHaveLength(1);
    expect(home[0].setCount).toBe(1);
    expect(home[0].topWeightKg).toBe(80);
    expect(home[0].volumeKg).toBe(400);
    expect(home[0].equipmentId).toBe(MACHINE_ID);

    const hotel = foldExerciseComparison(rows, WEIGHTS, "kg", {
      equipmentLane: String(OTHER_MACHINE_ID),
    });
    expect(hotel[0].setCount).toBe(1);
    expect(hotel[0].topWeightKg).toBe(50);

    // Omitting the lane keeps the movement-wide shape.
    expect(foldExerciseComparison(rows, WEIGHTS, "kg")[0].setCount).toBe(2);
  });

  it('treats "none" as the explicit unassigned lane, never a wildcard', () => {
    const rows = [
      cmpRow({ set_number: 1, equipment_id: null, weight_kg: 40 }),
      cmpRow({
        set_number: 2,
        equipment_id: MACHINE_ID,
        equipment: "Home",
        weight_kg: 80,
      }),
    ];
    const unassigned = foldExerciseComparison(rows, WEIGHTS, "kg", {
      equipmentLane: "none",
    });
    expect(unassigned[0].setCount).toBe(1);
    expect(unassigned[0].topWeightKg).toBe(40);
    // A lane nothing was logged in yields no sessions at all, rather than everything.
    expect(
      foldExerciseComparison(rows, WEIGHTS, "kg", { equipmentLane: "999" })
    ).toEqual([]);
  });

  it("keys load contexts on the lane and resolves id and label together", () => {
    // Two registry machines and the unassigned lane, under ONE logged name. Keying
    // on the implement NAME would merge the two identically-named rows a registry
    // permits; keying on the name-less lane would drop the unassigned one.
    const contexts = foldExerciseLoadContexts([
      {
        equipmentId: MACHINE_ID,
        equipment: "Press",
        date: "2026-05-01",
        activityId: 1,
      },
      {
        equipmentId: OTHER_MACHINE_ID,
        equipment: "Press",
        date: "2026-07-01",
        activityId: 2,
      },
      {
        equipmentId: OTHER_MACHINE_ID,
        equipment: "Press",
        date: "2026-07-01",
        activityId: 3,
      },
      { equipmentId: null, equipment: null, date: "2026-06-01", activityId: 4 },
    ]);
    expect(contexts.map((c) => c.lane)).toEqual([
      String(OTHER_MACHINE_ID),
      "none",
      String(MACHINE_ID),
    ]);
    // Most recently used first; the unassigned lane says so instead of repeating
    // the movement name a second, identical-looking time.
    expect(contexts.map((c) => c.label)).toEqual([
      "Press",
      "Unassigned",
      "Press",
    ]);
    // Sessions are DISTINCT DATES, not rows: two activities on one day are one session.
    expect(contexts[0].sessions).toBe(1);
    expect(contexts[0].equipmentId).toBe(OTHER_MACHINE_ID);
    expect(contexts.find((c) => c.lane === "none")!.equipmentId).toBeNull();
  });

  it("splits one logged name into one e1RM series per implement only when asked", () => {
    const rows = [
      seriesRow({
        exercise: "Machine Chest Press",
        date: "2026-07-01",
        weight_kg: 80,
        equipmentId: MACHINE_ID,
        equipment: "Home",
      }),
      seriesRow({
        exercise: "Machine Chest Press",
        date: "2026-07-02",
        weight_kg: 50,
        equipmentId: OTHER_MACHINE_ID,
        equipment: "Hotel",
      }),
    ];
    const wide = foldE1rmSeries(rows, WEIGHTS);
    expect(wide).toHaveLength(1);
    expect(wide[0].points).toHaveLength(2);
    expect(wide[0].equipmentId).toBeNull();

    const laned = foldE1rmSeries(rows, WEIGHTS, { byLoadContext: true });
    expect(laned).toHaveLength(2);
    expect(laned.map((r) => r.equipmentId).sort()).toEqual([
      MACHINE_ID,
      OTHER_MACHINE_ID,
    ]);
    expect(laned.every((r) => r.points.length === 1)).toBe(true);
  });

  it("keeps two machines' stats apart when laned, and short-circuits to identical lists when no set carries an implement", () => {
    const laneRows = [
      statRow({
        exercise: "Machine Chest Press",
        date: "2026-07-01",
        weight_kg: 80,
        equipmentId: MACHINE_ID,
        equipment: "Home",
      }),
      statRow({
        exercise: "Machine Chest Press",
        date: "2026-07-02",
        activity_id: 2,
        weight_kg: 50,
        equipmentId: OTHER_MACHINE_ID,
        equipment: "Hotel",
      }),
    ];
    const laned = foldStrengthByExercise(laneRows, WEIGHTS, "2026-07-03", true);
    expect(laned).toHaveLength(2);
    expect(laned.map((s) => s.topWeightKg).sort((a, b) => a - b)).toEqual([
      50, 80,
    ]);
    expect(
      foldStrengthByExercise(laneRows, WEIGHTS, "2026-07-03")
    ).toHaveLength(1);

    // No implement anywhere: the two groupings are not merely equivalent, they are
    // the same list — including the null equipment fields.
    const plain = [
      statRow({ date: "2026-07-01" }),
      statRow({ date: "2026-07-02", activity_id: 2 }),
    ];
    expect(foldStrengthByExercise(plain, WEIGHTS, "2026-07-03", true)).toEqual(
      foldStrengthByExercise(plain, WEIGHTS, "2026-07-03", false)
    );
  });

  it("resolves a recent session's implement id and label together off its first implement-bearing set", () => {
    const history = foldRecentExerciseHistory(
      [
        recentRow({ set_number: 1, equipment_id: null, equipment: null }),
        recentRow({
          set_number: 2,
          equipment_id: MACHINE_ID,
          equipment: "Home",
        }),
      ],
      WEIGHTS,
      new Map(),
      3
    );
    const session = history["machine chest press"].sessions[0];
    expect(session.equipmentId).toBe(MACHINE_ID);
    expect(session.equipment).toBe("Home");
  });
});

// ── The implement-CATEGORY axis (#2326) and the free-weight-only best ──────────
describe("the free-weight restriction is asked of the SET, not the name", () => {
  it("drops a machine-backed set from a free-weight series outright, rather than zeroing it", () => {
    const rows = [
      seriesRow({
        date: "2026-07-01",
        weight_kg: 100,
        equipmentId: MACHINE_ID,
        equipment: "Press machine",
        equipmentCategory: "Machine",
      }),
      seriesRow({
        date: "2026-07-02",
        weight_kg: 60,
        equipmentCategory: "Barbell",
      }),
    ];
    // Unrestricted: a machine press is a real set and a real e1RM.
    expect(foldE1rmSeries(rows, WEIGHTS).at(0)!.points).toHaveLength(2);
    // Restricted: the machine-only DAY yields no point at all — not a zero point
    // the standards table would then have to read.
    const free = foldE1rmSeries(rows, WEIGHTS, { freeWeightOnly: true });
    expect(free.at(0)!.points.map((p) => p.date)).toEqual(["2026-07-02"]);
  });

  it("yields NO series for a movement backed only by machine sets", () => {
    const rows = [
      seriesRow({ equipmentCategory: "Machine", equipmentId: MACHINE_ID }),
    ];
    expect(foldE1rmSeries(rows, WEIGHTS, { freeWeightOnly: true })).toEqual([]);
  });

  it("treats a set with no equipment row as no contradiction", () => {
    const rows = [seriesRow({ equipmentCategory: null })];
    expect(
      foldE1rmSeries(rows, WEIGHTS, { freeWeightOnly: true }).at(0)!.points
    ).toHaveLength(1);
  });

  it("scores a mixed history from its free-weight sets alone, while e1rmKg still counts every set", () => {
    // Same logged name, two implements: the machine set is the heavier one.
    const stats = foldStrengthByExercise(
      [
        statRow({
          date: "2026-07-01",
          weight_kg: 100,
          reps: 5,
          equipmentId: MACHINE_ID,
          equipment: "Press machine",
          equipmentCategory: "Machine",
        }),
        statRow({
          date: "2026-07-02",
          activity_id: 2,
          weight_kg: 60,
          reps: 5,
          equipmentCategory: "Barbell",
        }),
      ],
      WEIGHTS,
      "2026-07-03"
    );
    expect(stats).toHaveLength(1);
    // "What is this lifter's best e1RM?" — the machine set wins.
    expect(stats[0].e1rmKg).toBeCloseTo(116.667, 2);
    // "What can be scored against a barbell population table?" — the barbell set,
    // NOT suppressed by the heavier machine set logged under the same name.
    expect(stats[0].freeWeightE1rmKg).toBeCloseTo(70, 6);
  });

  it("reports 0, not a sentinel, when no free-weight set has ever backed the lift", () => {
    const stats = foldStrengthByExercise(
      [
        statRow({
          equipmentId: MACHINE_ID,
          equipment: "Press machine",
          equipmentCategory: "Machine",
        }),
      ],
      WEIGHTS,
      "2026-07-03"
    );
    expect(stats[0].freeWeightE1rmKg).toBe(0);
    expect(stats[0].e1rmKg).toBeGreaterThan(0);
  });
});

// ── The PR-date rule ──────────────────────────────────────────────────────────
describe("a PR date records when the load was FIRST reached", () => {
  it("keeps the earliest date of the heaviest load when it is repeated", () => {
    const stats = foldStrengthByExercise(
      [
        statRow({ date: "2026-07-01", weight_kg: 100, reps: 3 }),
        statRow({ date: "2026-07-02", activity_id: 2, weight_kg: 90, reps: 3 }),
        // The same 100 kg again, later: a repeat, not a new PR.
        statRow({
          date: "2026-07-03",
          activity_id: 3,
          weight_kg: 100,
          reps: 3,
        }),
      ],
      WEIGHTS,
      "2026-07-04"
    );
    expect(stats[0].topWeightKg).toBe(100);
    expect(stats[0].topWeightDate).toBe("2026-07-01");
    expect(stats[0].lastDate).toBe("2026-07-03");
  });

  it("breaks an equal-e1RM tie on more reps, moving bestDate with it", () => {
    const stats = foldStrengthByExercise(
      [
        statRow({ date: "2026-07-01", weight_kg: 100, reps: 1 }),
        // Same estimate, more reps — the better set, so bestDate advances.
        statRow({
          date: "2026-07-02",
          activity_id: 2,
          weight_kg: 100,
          reps: 1,
        }),
      ],
      WEIGHTS,
      "2026-07-03"
    );
    expect(stats[0].bestReps).toBe(1);
    expect(stats[0].bestDate).toBe("2026-07-01");

    const withMoreReps = foldStrengthByExercise(
      [
        statRow({ date: "2026-07-01", weight_kg: 0, reps: 5 }),
        statRow({ date: "2026-07-02", activity_id: 2, weight_kg: 0, reps: 9 }),
      ],
      WEIGHTS,
      "2026-07-03"
    );
    expect(withMoreReps[0].bestReps).toBe(9);
    expect(withMoreReps[0].bestDate).toBe("2026-07-02");
  });

  it("carries the same tie-breaker into a comparison session and its e1rmReps", () => {
    const sessions = foldExerciseComparison(
      [
        cmpRow({ set_number: 1, weight_kg: 100, reps: 1 }),
        cmpRow({ set_number: 2, weight_kg: 0, reps: 12 }),
      ],
      WEIGHTS,
      "kg"
    );
    expect(sessions[0].e1rmReps).toBe(1);
    expect(sessions[0].topWeightKg).toBe(100);
    expect(sessions[0].topReps).toBe(1);
  });

  it("keeps the day's best e1RM and, on a tie, the higher rep count behind it", () => {
    // 50 kg x 12, x 15 and x 20 all cap to the same estimate (E1RM_REP_CAP), so a
    // real rep progression reads as flat to the plateau detector unless the point
    // carries the HIGHEST rep count of the tie — its only escape hatch.
    const day = (reps: number) =>
      seriesRow({ date: "2026-07-01", weight_kg: 50, reps });
    const series = foldE1rmSeries([day(12), day(15), day(20)], WEIGHTS);
    expect(series[0].points).toHaveLength(1);
    expect(series[0].points[0].value).toBe(70);
    expect(series[0].points[0].reps).toBe(20);

    // A strictly better estimate still wins outright, whatever its rep count.
    const better = foldE1rmSeries(
      [day(20), seriesRow({ date: "2026-07-01", weight_kg: 100, reps: 1 })],
      WEIGHTS
    );
    expect(better[0].points[0].value).toBeCloseTo(103.333, 2);
    expect(better[0].points[0].reps).toBe(1);
  });
});

// ── The bodyweight fold ───────────────────────────────────────────────────────
describe("the athlete is (part of) the load, as of the session's own date", () => {
  it("folds the bodyweight in force on each session date, not today's", () => {
    // 80 kg until 2026-06-01, 70 kg after.
    const sessions = foldExerciseComparison(
      [
        cmpRow({
          exercise: "Pull Up",
          date: "2026-03-01",
          activity_id: 1,
          weight_kg: null,
          reps: 5,
        }),
        cmpRow({
          exercise: "Pull Up",
          date: "2026-07-01",
          activity_id: 2,
          weight_kg: null,
          reps: 5,
        }),
      ],
      WEIGHTS,
      "kg"
    );
    expect(sessions.map((s) => s.bodyweightBaseKg)).toEqual([80, 70]);
    expect(sessions.map((s) => s.topWeightKg)).toEqual([80, 70]);
    // The base is reported BESIDE the total, so a reader can subtract it: without
    // it these two identical sessions read as a ten-kilo regression (#3009).
    expect(sessions.map((s) => s.volumeKg)).toEqual([400, 350]);
  });

  it("adds a loaded plate to the base and SUBTRACTS an assist (#1922)", () => {
    const added = foldExerciseComparison(
      [cmpRow({ exercise: "Pull Up", weight_kg: 10, reps: 3 })],
      WEIGHTS,
      "kg"
    );
    expect(added[0].topWeightKg).toBe(80);

    const assisted = foldExerciseComparison(
      [cmpRow({ exercise: "Assisted Pull Up", weight_kg: 25, reps: 3 })],
      WEIGHTS,
      "kg"
    );
    expect(assisted[0].bodyweightBaseKg).toBe(70);
    expect(assisted[0].topWeightKg).toBe(45);
  });

  it("reports 0 for a lift the body is not part of, whatever the weight series says", () => {
    const sessions = foldExerciseComparison([cmpRow()], WEIGHTS, "kg");
    expect(sessions[0].bodyweightBaseKg).toBe(0);
    expect(sessions[0].topWeightKg).toBe(50);
  });

  it("omits a flat-zero e1RM series when the bodyweight is unknown", () => {
    const rows = [seriesRow({ exercise: "Pull Up", weight_kg: null, reps: 8 })];
    expect(foldE1rmSeries(rows, [])).toEqual([]);
    expect(
      foldE1rmSeries(rows, WEIGHTS).at(0)!.points[0].value
    ).toBeGreaterThan(0);
  });

  it("charts REPS instead of kilograms only when there is no usable load", () => {
    const unknown = foldStrengthByExercise(
      [
        statRow({
          exercise: "Pull Up",
          weight_kg: null,
          reps: 8,
          date: "2026-07-01",
        }),
        statRow({
          exercise: "Pull Up",
          weight_kg: null,
          reps: 4,
          activity_id: 2,
          date: "2026-07-01",
        }),
      ],
      [],
      "2026-07-02"
    );
    expect(unknown[0].bodyweight).toBe(true);
    expect(unknown[0].volumeIsReps).toBe(true);
    expect(unknown[0].volume).toEqual([{ date: "2026-07-01", volumeKg: 12 }]);

    const known = foldStrengthByExercise(
      [
        statRow({
          exercise: "Pull Up",
          weight_kg: null,
          reps: 8,
          date: "2026-07-01",
        }),
      ],
      WEIGHTS,
      "2026-07-02"
    );
    expect(known[0].volumeIsReps).toBe(false);
    expect(known[0].volume).toEqual([{ date: "2026-07-01", volumeKg: 560 }]);
  });

  it("dates the stats fold's base to each set, not to the newest weight known", () => {
    // 80 kg until 2026-06-01, 70 kg after. A pull-up session in March is an 80 kg
    // pull-up; scoring it against today's weight rewrites history.
    const stats = foldStrengthByExercise(
      [
        statRow({
          exercise: "Pull Up",
          date: "2026-03-01",
          weight_kg: null,
          reps: 5,
        }),
        statRow({
          exercise: "Pull Up",
          date: "2026-07-01",
          activity_id: 2,
          weight_kg: null,
          reps: 5,
        }),
      ],
      WEIGHTS,
      "2026-07-02"
    );
    expect(stats[0].topWeightKg).toBe(80);
    expect(stats[0].topWeightDate).toBe("2026-03-01");
    expect(stats[0].volume).toEqual([
      { date: "2026-03-01", volumeKg: 400 },
      { date: "2026-07-01", volumeKg: 350 },
    ]);
  });

  it("gives a recent session the same base the stats fold uses", () => {
    const history = foldRecentExerciseHistory(
      [recentRow({ exercise: "Pull Up", date: "2026-03-01", weight_kg: null })],
      WEIGHTS,
      new Map(),
      3
    );
    expect(history["pull up"].sessions[0].baseKg).toBe(80);
    // A non-bodyweight lift folds nothing.
    expect(
      foldRecentExerciseHistory([recentRow()], WEIGHTS, new Map(), 3)[
        "machine chest press"
      ].sessions[0].baseKg
    ).toBe(0);
  });
});

// ── Supporting folds the gathers no longer perform ────────────────────────────
describe("the folds the gathers hand off", () => {
  it("merges a variant onto its base and keeps the better of each best (#3220)", () => {
    const bests = foldExerciseBests([
      { exercise: "Barbell Curl", weightKg: 40, reps: 8, durationSec: 0 },
      { exercise: "Curl", weightKg: 30, reps: 12, durationSec: 45 },
    ]);
    expect(Object.keys(bests)).toEqual(["curl"]);
    expect(bests.curl).toEqual({ weightKg: 40, reps: 12, durationSec: 45 });
  });

  it("reads a zero best as NO best", () => {
    const bests = foldExerciseBests([
      { exercise: "Plank", weightKg: 0, reps: 0, durationSec: 60 },
    ]);
    expect(bests.plank).toEqual({
      weightKg: null,
      reps: null,
      durationSec: 60,
    });
  });

  it("collapses implements per movement key, de-duplicated and ordered", () => {
    expect(
      foldLoggedEquipmentByExercise([
        { exercise: "Barbell Curl", equipmentId: 9 },
        { exercise: "Curl", equipmentId: 3 },
        { exercise: "Curl", equipmentId: 9 },
        { exercise: "   ", equipmentId: 4 },
      ])
    ).toEqual({ curl: [3, 9] });
  });

  it("caps the recent window at perExercise SESSIONS and prefers the all-history bodyweight kind", () => {
    const rows = [1, 2, 3, 4].flatMap((n) => [
      recentRow({
        exercise: "Pull Up",
        activity_id: n,
        date: `2026-07-0${5 - n}`,
        set_number: 1,
        weight_kg: null,
      }),
      recentRow({
        exercise: "Pull Up",
        activity_id: n,
        date: `2026-07-0${5 - n}`,
        set_number: 2,
        weight_kg: null,
      }),
    ]);
    const capped = foldRecentExerciseHistory(rows, WEIGHTS, new Map(), 2);
    expect(capped["pull up"].sessions.map((s) => s.activityId)).toEqual([1, 2]);
    expect(capped["pull up"].sessions[0].sets).toHaveLength(2);

    // The window saw no external weight, but the ALL-HISTORY map did: the map wins,
    // so the editor chip and the detail panel cannot disagree about the kind (#331).
    expect(
      foldRecentExerciseHistory(
        rows,
        WEIGHTS,
        new Map([["pull up", false]]),
        2
      )["pull up"].bodyweight
    ).toBe(false);
    // Absent from the map, the window-local sighting is the fallback.
    expect(capped["pull up"].bodyweight).toBe(true);
  });
});

// ── The profile-scoping guard the extraction must not weaken ──────────────────
describe("the extracted modules stay off the database", () => {
  it("imports nothing from lib/db", () => {
    for (const mod of [
      "strength-history.ts",
      "strength-comparison.ts",
      "strength-series.ts",
      "strength-stats.ts",
    ]) {
      const src = fs.readFileSync(
        path.join(import.meta.dirname, "..", mod),
        "utf8"
      );
      expect(src, mod).not.toMatch(/from\s+"\.\/db"/);
      expect(src, mod).not.toMatch(/from\s+"\.\/queries/);
    }
  });
});
