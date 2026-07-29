// DB INTEGRATION TIER — #1610: the same exact exercise string logged on TWO
// registry machines must stay separated end to end.
//
// The write path always had the datum (`exercise_sets.equipment_id`), but the read/
// identity layer dropped it: getRecentExerciseHistory joined only the equipment
// NAME, getStrengthByExercise never selected the column, and the plateau e1RM series
// grouped on `exerciseHistoryKey` alone. Two machines therefore shared one seed, one
// PR/e1RM track and one plateau signal — and a hotel machine whose stack geometry
// makes 50 kg correct inherited the home machine's 80 kg.
//
// This seeds a real profile with two "Machine Chest Press" machines at deliberately
// non-comparable loads and proves every load-sensitive builder keeps them apart,
// while a THIRD profile with no equipment at all proves the equipment-free behaviour
// is unchanged (#393).

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import {
  equipmentLoadLane,
  exerciseHistoryKey,
  loadContextLabel,
} from "@/lib/lifts";
import { recentPRs } from "@/lib/coaching";
import { deleteEquipment } from "@/lib/equipment";
import { buildTrainingObservationFindings } from "@/lib/rule-findings";
import {
  getExerciseComparison,
  getExerciseE1rmSeries,
  getExerciseLoadContexts,
  getGoalProgressMap,
  getGoals,
  getLoggedEquipmentByExercise,
  getRecentExerciseHistory,
  getStrengthByExercise,
} from "@/lib/queries";

const EXERCISE = "Machine Chest Press";

let profileId: number;
let homeId: number;
let hotelId: number;
let plainProfileId: number;

function addEquipment(profile: number, name: string, category: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO equipment (profile_id, name, category) VALUES (?, ?, ?)`
      )
      .run(profile, name, category).lastInsertRowid
  );
}

function addSession(
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
  return activityId;
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Load Context')").run()
      .lastInsertRowid
  );
  homeId = addEquipment(profileId, "Home chest press", "Machine");
  hotelId = addEquipment(profileId, "Hotel chest press", "Machine");
  const t = today(profileId);

  // Home machine: a flat ~80 kg block over six weeks (a plateau in its own right).
  // Hotel machine: a flat ~50 kg block over the same span, interleaved by date so a
  // builder that ignores equipment_id would see one jagged 50/80 series and a
  // fabricated "newest session" at whichever load happened to be logged last.
  for (const [ago, home, hotel] of [
    [42, 80, 50],
    [35, 80.5, 50.5],
    [28, 80, 50],
    [21, 80.5, 50.5],
    [14, 80, 50],
    [7, 80.5, 50.5],
    [3, 80, 50],
  ] as const) {
    addSession(profileId, shiftDateStr(t, -ago), EXERCISE, home, 5, homeId);
    addSession(
      profileId,
      shiftDateStr(t, -ago + 1),
      EXERCISE,
      hotel,
      5,
      hotelId
    );
  }

  // A profile with NO equipment rows at all — every set in the unassigned lane.
  plainProfileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('No Gear')").run()
      .lastInsertRowid
  );
  const pt = today(plainProfileId);
  addSession(
    plainProfileId,
    shiftDateStr(pt, -20),
    "Barbell Curl",
    40,
    8,
    null
  );
  addSession(plainProfileId, shiftDateStr(pt, -5), "Curl", 50, 6, null);
});

describe("getRecentExerciseHistory ships the load context (#1610)", () => {
  it("carries each session's equipment id alongside its label", () => {
    const hist = getRecentExerciseHistory(profileId, 20)[
      exerciseHistoryKey(EXERCISE)
    ];
    expect(hist).toBeDefined();
    const lanes = new Set(hist.sessions.map((s) => s.equipmentId));
    expect(lanes).toEqual(new Set([homeId, hotelId]));
    // The id and the rendered label are resolved together, so they can't disagree.
    for (const s of hist.sessions) {
      expect(s.equipment).toBe(
        s.equipmentId === homeId ? "Home chest press" : "Hotel chest press"
      );
    }
  });

  it("leaves an equipment-free profile's sessions in the unassigned lane", () => {
    const hist = getRecentExerciseHistory(plainProfileId, 20)[
      exerciseHistoryKey("Curl")
    ];
    expect(hist.sessions.every((s) => s.equipmentId === null)).toBe(true);
  });
});

describe("getStrengthByExercise seeds within one load context (#1610)", () => {
  it("keeps ONE movement row but seeds off the newest session's own machine", () => {
    const stat = getStrengthByExercise(profileId).find(
      (s) => exerciseHistoryKey(s.exercise) === exerciseHistoryKey(EXERCISE)
    )!;
    expect(stat).toBeDefined();
    // The newest session is the hotel machine's (t-2), so the seed must be its
    // ~50 kg — never the home machine's 80 kg, which is the reported bug.
    expect(stat.lastSessionBest).not.toBeNull();
    expect(stat.lastSessionBest!.weightKg).toBeLessThan(60);
    expect(stat.lastSessionSets.every((s) => s.weightKg < 60)).toBe(true);
  });
});

describe("getExerciseE1rmSeries load contexts (#1610)", () => {
  it("groups movement-wide by default, preserving the pre-#1610 shape", () => {
    const series = getExerciseE1rmSeries(profileId).filter(
      (s) => exerciseHistoryKey(s.exercise) === exerciseHistoryKey(EXERCISE)
    );
    expect(series).toHaveLength(1);
    expect(series[0].equipmentId).toBeNull();
    // One merged series over both machines: 14 sessions, 14 dated points.
    expect(series[0].points).toHaveLength(14);
  });

  it("splits one series per machine when asked for load contexts", () => {
    const series = getExerciseE1rmSeries(profileId, undefined, undefined, {
      byLoadContext: true,
    }).filter(
      (s) => exerciseHistoryKey(s.exercise) === exerciseHistoryKey(EXERCISE)
    );
    expect(series).toHaveLength(2);
    const home = series.find((s) => s.equipmentId === homeId)!;
    const hotel = series.find((s) => s.equipmentId === hotelId)!;
    expect(home.equipment).toBe("Home chest press");
    expect(hotel.equipment).toBe("Hotel chest press");
    expect(home.points).toHaveLength(7);
    expect(hotel.points).toHaveLength(7);
    // Each machine's series holds only its own loads — no interleaving.
    expect(home.points.every((p) => p.value > 60)).toBe(true);
    expect(hotel.points.every((p) => p.value < 60)).toBe(true);
  });

  it("still merges variant spellings within one lane (#432/#1399)", () => {
    // "Barbell Curl" and "Curl" remain ONE series even with load contexts on.
    const series = getExerciseE1rmSeries(plainProfileId, undefined, undefined, {
      byLoadContext: true,
    }).filter(
      (s) => exerciseHistoryKey(s.exercise) === exerciseHistoryKey("Curl")
    );
    expect(series).toHaveLength(1);
    expect(series[0].points).toHaveLength(2);
  });
});

describe("plateau findings never combine two machines (#1610/#1399)", () => {
  it("emits one plateau per load context with distinct, implement-named keys", () => {
    const t = today(profileId);
    const findings = buildTrainingObservationFindings(profileId, t).filter(
      (f) => f.domain === "training-plateau"
    );
    expect(findings).toHaveLength(2);

    // Distinct dedupe keys (and distinct legacy/supersedes keys), so dismissing the
    // home machine's plateau leaves the hotel machine's live.
    expect(new Set(findings.map((f) => f.dedupeKey)).size).toBe(2);
    expect(new Set(findings.map((f) => f.supersedes)).size).toBe(2);

    // Every registered training-observation key stays in its namespace.
    for (const f of findings)
      expect(f.dedupeKey.startsWith("training-obs:plateau:")).toBe(true);

    // The copy names the implement, so two same-movement findings are tellable apart.
    const titles = findings.map((f) => f.title);
    expect(titles.some((x) => x.includes("Home chest press"))).toBe(true);
    expect(titles.some((x) => x.includes("Hotel chest press"))).toBe(true);

    // Each key is exactly the identity its series was grouped on: the canonical
    // movement plus the equipment lane. (The variant-collapse half of the #1399
    // re-key — that two spellings of one lift share a key — is pinned in the pure
    // tier; "Machine Chest Press" is its own catalog lift, not a composed variant.)
    for (const f of findings) {
      expect(f.dedupeKey).toMatch(
        new RegExp(`^training-obs:plateau:.+@(${homeId}|${hotelId}):`)
      );
    }
  });
});

// ── The deferred half of #1610 (this change) ────────────────────────────────
// #1628 stopped at the identity layer because the surfaces that would have to
// RENDER a split were mid-rewrite, and #1610 forbids duplicate unlabeled rows. With
// those surfaces landed, the comparison, the PR engine and goals join the family.

describe("getExerciseLoadContexts (#1610)", () => {
  it("lists one entry per implement, most recently used first", () => {
    const contexts = getExerciseLoadContexts(profileId, EXERCISE);
    expect(contexts).toHaveLength(2);
    // The hotel machine carries the newest session (t-2), so it leads — #1610's
    // "default the detail/Analyze view to the most recently used context".
    expect(contexts[0].equipmentId).toBe(hotelId);
    expect(contexts[0].label).toBe("Hotel chest press");
    expect(contexts[1].equipmentId).toBe(homeId);
    expect(contexts.every((c) => c.sessions === 7)).toBe(true);
    // The lane string is the SHARED identity, not a second scheme.
    expect(contexts.map((c) => c.lane)).toEqual([
      equipmentLoadLane(hotelId),
      equipmentLoadLane(homeId),
    ]);
  });

  it("reports a single unassigned context for an equipment-free profile", () => {
    const contexts = getExerciseLoadContexts(plainProfileId, "Curl");
    // Variant spellings collapse on the NAME axis, so both curl sessions are one
    // context — and with only one there is nothing for a chooser to offer.
    expect(contexts).toHaveLength(1);
    expect(contexts[0].equipmentId).toBeNull();
    expect(contexts[0].lane).toBe(equipmentLoadLane(null));
    expect(contexts[0].label).toBe("Unassigned");
    expect(contexts[0].sessions).toBe(2);
  });
});

describe("getExerciseComparison never compares two machines (#1610)", () => {
  it("narrows every session metric to the requested lane", () => {
    const home = getExerciseComparison(profileId, EXERCISE, "kg", {
      equipmentLane: equipmentLoadLane(homeId),
    });
    const hotel = getExerciseComparison(profileId, EXERCISE, "kg", {
      equipmentLane: equipmentLoadLane(hotelId),
    });
    expect(home).toHaveLength(7);
    expect(hotel).toHaveLength(7);
    // Each lane's chart/table values come only from its own stack: the reported bug
    // is a chart that alternates 80 and 50 and calls it one progression.
    expect(home.every((s) => (s.topWeightKg ?? 0) > 60)).toBe(true);
    expect(hotel.every((s) => (s.topWeightKg ?? 0) < 60)).toBe(true);
    expect(home.every((s) => s.equipmentId === homeId)).toBe(true);
    expect(hotel.every((s) => s.equipmentId === hotelId)).toBe(true);
    // Id and label resolved together, so a row can't name one machine and belong
    // to another.
    expect(new Set(home.map((s) => s.equipment))).toEqual(
      new Set(["Home chest press"])
    );
  });

  it("stays movement-wide when no lane is asked for (pre-#1610 shape)", () => {
    const all = getExerciseComparison(profileId, EXERCISE, "kg");
    expect(all).toHaveLength(14);
  });

  it("treats the unassigned lane as a lane, never a wildcard", () => {
    const unassigned = getExerciseComparison(profileId, EXERCISE, "kg", {
      equipmentLane: equipmentLoadLane(null),
    });
    // Every set of this movement names a machine, so the unassigned lane is empty —
    // it must NOT fall back to "all sessions".
    expect(unassigned).toEqual([]);
  });
});

describe("PRs never combine two machines (#1610)", () => {
  const WINDOW = 60;

  it("reports one record per implement, each naming its own", () => {
    const t = today(profileId);
    const prs = recentPRs(getStrengthByExercise(profileId, true), t, WINDOW)
      .filter(
        (p) => exerciseHistoryKey(p.exercise) === exerciseHistoryKey(EXERCISE)
      )
      .sort((a, b) => (a.equipment ?? "").localeCompare(b.equipment ?? ""));
    expect(prs).toHaveLength(2);
    expect(prs.map((p) => p.equipment)).toEqual([
      "Home chest press",
      "Hotel chest press",
    ]);
    expect(prs.map((p) => p.equipmentId)).toEqual([homeId, hotelId]);
    // The hotel machine's record is its OWN 50.5 kg — not the home machine's 80.5,
    // which is what a movement-wide max reports for both.
    expect(prs[0].weightKg).toBeGreaterThan(60);
    expect(prs[1].weightKg).toBeLessThan(60);
    // Labeled, so the two rows are not two identical-looking "Machine Chest Press".
    expect(prs.map((p) => loadContextLabel(p.exercise, p.equipment))).toEqual([
      `${EXERCISE} (Home chest press)`,
      `${EXERCISE} (Hotel chest press)`,
    ]);
  });

  it("collapses to one movement-wide record when not grouped by load context", () => {
    const t = today(profileId);
    const prs = recentPRs(getStrengthByExercise(profileId), t, WINDOW).filter(
      (p) => exerciseHistoryKey(p.exercise) === exerciseHistoryKey(EXERCISE)
    );
    expect(prs).toHaveLength(1);
    expect(prs[0].equipment).toBeNull();
  });

  it("leaves an equipment-free profile's records byte-for-byte unchanged", () => {
    const t = today(plainProfileId);
    const wide = recentPRs(getStrengthByExercise(plainProfileId), t, 60);
    const laned = recentPRs(getStrengthByExercise(plainProfileId, true), t, 60);
    expect(laned).toEqual(wide);
  });
});

describe("getLoggedEquipmentByExercise (#1610)", () => {
  it("keys logged implements by the canonical movement", () => {
    const map = getLoggedEquipmentByExercise(profileId);
    expect(map[exerciseHistoryKey(EXERCISE)]).toEqual(
      [homeId, hotelId].sort((a, b) => a - b)
    );
  });

  it("is empty for a profile whose sets name no implement", () => {
    expect(getLoggedEquipmentByExercise(plainProfileId)).toEqual({});
  });
});

describe("goal load context (#1610, migration 120)", () => {
  function addGoal(equipment: number | null): number {
    return Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, category, status, created_at, exercise, metric,
              equipment_id, target_weight_kg)
           VALUES (?, ?, 'strength', 'active', '2026-01-01', ?, 'weight', ?, 80)`
        )
        .run(profileId, "Chest press target", EXERCISE, equipment)
        .lastInsertRowid
    );
  }

  it("adds a nullable goals.equipment_id column", () => {
    const cols = (
      db.prepare("PRAGMA table_info(goals)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).filter((c) => c.name === "equipment_id");
    expect(cols).toHaveLength(1);
    expect(cols[0].notnull).toBe(0);
    expect(cols[0].dflt_value).toBeNull();
  });

  it("measures a machine-scoped goal on that machine only", () => {
    const hotelGoal = addGoal(hotelId);
    const homeGoal = addGoal(homeId);
    const goals = getGoals(profileId).filter((g) =>
      [hotelGoal, homeGoal].includes(g.id)
    );
    const progress = getGoalProgressMap(profileId, goals);

    // The hotel machine tops out at 50.5 kg, so an 80 kg target is NOT met there —
    // the bug is the home machine's 80.5 kg quietly completing it.
    expect(progress.get(hotelGoal)!.lifetimeBest).toBeCloseTo(50.5, 5);
    expect(progress.get(hotelGoal)!.done).toBe(false);
    // The home machine did reach it.
    expect(progress.get(homeGoal)!.lifetimeBest).toBeCloseTo(80.5, 5);
    expect(progress.get(homeGoal)!.done).toBe(true);
  });

  it("keeps a goal that names no machine movement-wide", () => {
    const wideGoal = addGoal(null);
    const goals = getGoals(profileId).filter((g) => g.id === wideGoal);
    const progress = getGoalProgressMap(profileId, goals);
    // NULL is an UNDECLARED SCOPE, not an unassigned lane: the goal folds every
    // implement, exactly as every goal stored before this column does.
    expect(progress.get(wideGoal)!.lifetimeBest).toBeCloseTo(80.5, 5);
    expect(progress.get(wideGoal)!.done).toBe(true);
  });

  it("detaches a goal back to movement-wide when its implement is deleted", () => {
    const scoped = addGoal(hotelId);
    const doomed = addEquipment(profileId, "Loaner chest press", "Machine");
    db.prepare(`UPDATE goals SET equipment_id = ? WHERE id = ?`).run(
      doomed,
      scoped
    );
    deleteEquipment(profileId, doomed);
    const goal = getGoals(profileId).find((g) => g.id === scoped)!;
    expect(goal.equipment_id).toBeNull();
    // …and it measures the whole movement again rather than nothing at all.
    expect(
      getGoalProgressMap(profileId, [goal]).get(scoped)!.lifetimeBest
    ).toBeCloseTo(80.5, 5);
  });
});
