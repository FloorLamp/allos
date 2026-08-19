// DB integration for #3137's closed reading-promotion registry. The pure tier
// owns transition truth tables; this tier proves the dashboard gathers expose the
// prior comparable state without per-candidate reads or cross-profile leakage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentPRs } from "@/lib/coaching";
import {
  clinicalResultBecameNotable,
  outcomeGoalProgressChanged,
  weeklyTargetStateChanged,
} from "@/lib/dashboard-reading-promotions";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getDashboardClinicalObservations,
  getFrequencyTargetProgress,
  getOutcomeGoalProgressMap,
  getOutcomeGoals,
  getStrengthByExercise,
} from "@/lib/queries";
import { setWeekMode, setWeekStart } from "@/lib/settings";

const NOW = new Date("2026-06-17T12:00:00Z");

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("dashboard reading-promotion gathers (#3137)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairs each current clinical family with only its prior profile-scoped result", () => {
    const profileId = newProfile("dashboard-clinical-transition");
    const otherProfileId = newProfile("dashboard-clinical-other");
    const insert = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
       VALUES (?, ?, 'lab', ?, ?, ?, ?, 'mg/dL', ?)`
    );

    insert.run(
      profileId,
      "2026-06-15",
      "LDL Cholesterol",
      "LDL Cholesterol",
      "98",
      98,
      "normal"
    );
    insert.run(
      profileId,
      "2026-06-17",
      "LDL Cholesterol",
      "LDL Cholesterol",
      "145",
      145,
      "high"
    );
    insert.run(
      profileId,
      "2026-06-17",
      "HDL Cholesterol",
      "HDL Cholesterol",
      "35",
      35,
      "low"
    );
    insert.run(
      otherProfileId,
      "2026-06-18",
      "LDL Cholesterol",
      "LDL Cholesterol",
      "160",
      160,
      "high"
    );

    const rows = getDashboardClinicalObservations(profileId);
    const ldl = rows.find((row) => row.canonical_name === "LDL Cholesterol");
    const hdl = rows.find((row) => row.canonical_name === "HDL Cholesterol");

    expect(ldl).toMatchObject({
      profile_id: profileId,
      value_num: 145,
      flag: "high",
      previous_flag: "normal",
    });
    expect(clinicalResultBecameNotable(ldl!.flag, ldl!.previous_flag)).toBe(
      true
    );
    expect(hdl).toMatchObject({ previous_id: null, previous_flag: null });
    expect(
      clinicalResultBecameNotable(
        hdl!.flag,
        hdl!.previous_id == null ? undefined : hdl!.previous_flag
      )
    ).toBe(false);
  });

  it("carries the preceding local-week verdict from the same cadence gather", () => {
    const profileId = newProfile("dashboard-target-transition");
    setWeekMode(profileId, "rolling");
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'vegetables', 2, ?)`
    ).run(profileId, `${shiftDateStr(anchor, -30)} 08:00:00`);
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (?, ?, 'vegetables', 1), (?, ?, 'vegetables', 1)`
    ).run(profileId, shiftDateStr(anchor, -1), profileId, anchor);

    const [progress] = getFrequencyTargetProgress(profileId);
    expect(progress).toMatchObject({
      count: 2,
      met: true,
    });
    expect(progress.previous).toMatchObject({ met: false });
    expect(weeklyTargetStateChanged(progress, progress.previous ?? null)).toBe(
      true
    );
  });

  it("ends weekly promotion at local-week close until new evidence lands", () => {
    const profileId = newProfile("dashboard-target-week-close");
    setWeekStart(profileId, 3);
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'fruit', 1, ?)`
    ).run(profileId, `${shiftDateStr(anchor, -30)} 08:00:00`);
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (?, ?, 'fruit', 1)`
    ).run(profileId, shiftDateStr(anchor, -7));

    const [progress] = getFrequencyTargetProgress(profileId);
    expect(progress).toMatchObject({
      count: 0,
      previous: { met: false },
    });
    expect(weeklyTargetStateChanged(progress, progress.previous ?? null)).toBe(
      false
    );
  });

  it("keeps a calendar-week crossing live after its crossing day", () => {
    const profileId = newProfile("dashboard-target-persistence");
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'vegetables', 2, ?)`
    ).run(profileId, `${shiftDateStr(anchor, -30)} 08:00:00`);
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (?, ?, 'vegetables', 1), (?, ?, 'vegetables', 1)`
    ).run(
      profileId,
      shiftDateStr(anchor, -2),
      profileId,
      shiftDateStr(anchor, -1)
    );

    const [progress] = getFrequencyTargetProgress(profileId);
    expect(progress).toMatchObject({
      count: 2,
      met: true,
      previous: { met: false },
    });
    expect(weeklyTargetStateChanged(progress, progress.previous ?? null)).toBe(
      true
    );
  });

  it("promotes a zero-count rolling target when its last log ages out", () => {
    const profileId = newProfile("dashboard-target-zero-count-transition");
    setWeekMode(profileId, "rolling");
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week, created_at)
       VALUES (?, 'food_group', 'fruit', 1, ?)`
    ).run(profileId, `${shiftDateStr(anchor, -30)} 08:00:00`);
    db.prepare(
      `INSERT INTO food_daily_totals
         (profile_id, date, group_key, servings)
       VALUES (?, ?, 'fruit', 1)`
    ).run(profileId, shiftDateStr(anchor, -7));

    const [progress] = getFrequencyTargetProgress(profileId);
    expect(progress).toMatchObject({
      count: 0,
      pace: "behind",
      previous: { pace: "met", met: true },
    });
    expect(weeklyTargetStateChanged(progress, progress.previous ?? null)).toBe(
      true
    );
  });

  it("carries the prior body-goal result and promotes completion", () => {
    const profileId = newProfile("dashboard-goal-transition");
    const anchor = today(profileId);
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, status, body_metric, baseline_value,
              target_value, target_date, created_at)
           VALUES (?, 'Reach 70 kg', 'active', 'weight', 80, 70, ?, ?)`
        )
        .run(profileId, shiftDateStr(anchor, 30), shiftDateStr(anchor, -30))
        .lastInsertRowid
    );
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 70, 'manual'), (?, ?, 69, 'manual')`
    ).run(profileId, shiftDateStr(anchor, -1), profileId, anchor);

    const goal = getOutcomeGoals(profileId).find(({ id }) => id === goalId)!;
    const progress = getOutcomeGoalProgressMap(profileId, [goal]).get(goalId)!;
    expect(progress).toMatchObject({
      current: 69,
      done: true,
      previous: { pct: 0, done: false },
    });
    expect(outcomeGoalProgressChanged(goal, progress, anchor)).toBe(true);
    expect(
      outcomeGoalProgressChanged(goal, progress, shiftDateStr(anchor, 1))
    ).toBe(true);
  });

  it("does not fabricate outcome transitions from pre-goal evidence", () => {
    const profileId = newProfile("dashboard-goal-pre-period-control");
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 70, 'manual')`
    ).run(profileId, shiftDateStr(anchor, -1));
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
       VALUES (?, ?, 'lab', 'LDL Cholesterol', 'LDL Cholesterol', '90', 90,
               'mg/dL', 'normal')`
    ).run(profileId, shiftDateStr(anchor, -1));
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, source)
           VALUES (?, ?, 'strength', 'Strength', 'manual')`
        )
        .run(profileId, shiftDateStr(anchor, -1)).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets
         (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, 'Bench Press', 1, 60, 5)`
    ).run(activityId);
    const insertGoal = db.prepare(
      `INSERT INTO goals
         (profile_id, title, status, body_metric, baseline_value, target_value,
          biomarker_name, target_direction, unit, exercise, metric,
          target_weight_kg, target_date, created_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const bodyId = Number(
      insertGoal.run(
        profileId,
        "Historical body",
        "weight",
        80,
        70,
        null,
        null,
        null,
        null,
        null,
        null,
        shiftDateStr(anchor, 30),
        anchor
      ).lastInsertRowid
    );
    const biomarkerId = Number(
      insertGoal.run(
        profileId,
        "Historical LDL",
        null,
        120,
        100,
        "LDL Cholesterol",
        "below",
        "mg/dL",
        null,
        null,
        null,
        shiftDateStr(anchor, 30),
        anchor
      ).lastInsertRowid
    );
    const exerciseId = Number(
      insertGoal.run(
        profileId,
        "Historical bench",
        null,
        null,
        null,
        null,
        null,
        null,
        "Bench Press",
        "weight",
        60,
        shiftDateStr(anchor, 30),
        anchor
      ).lastInsertRowid
    );
    const goals = getOutcomeGoals(profileId).filter(({ id }) =>
      [bodyId, biomarkerId, exerciseId].includes(id)
    );
    const progress = getOutcomeGoalProgressMap(profileId, goals);
    for (const goal of goals) {
      const result = progress.get(goal.id)!;
      expect(result.previous).toBeNull();
      expect(outcomeGoalProgressChanged(goal, result, anchor)).toBe(false);
    }
  });

  it("reuses the existing all-history strength verdict for today's record", () => {
    const profileId = newProfile("dashboard-training-transition");
    const anchor = today(profileId);
    const addSet = (date: string, weight: number) => {
      const activityId = Number(
        db
          .prepare(
            `INSERT INTO activities (profile_id, date, type, title, source)
             VALUES (?, ?, 'strength', 'Strength', 'manual')`
          )
          .run(profileId, date).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO exercise_sets
           (activity_id, exercise, set_number, weight_kg, reps)
         VALUES (?, 'Bench Press', 1, ?, 5)`
      ).run(activityId, weight);
    };
    addSet(shiftDateStr(anchor, -2), 50);
    addSet(anchor, 60);

    const records = recentPRs(
      getStrengthByExercise(profileId, true),
      anchor,
      0
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exercise: "Bench Press",
          date: anchor,
          kind: "1rm",
        }),
      ])
    );

    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, status, exercise, metric, target_weight_kg,
              target_date, created_at)
           VALUES (?, 'Bench 60 kg', 'active', 'Bench Press', 'weight', 60, ?, ?)`
        )
        .run(profileId, shiftDateStr(anchor, 30), shiftDateStr(anchor, -1))
        .lastInsertRowid
    );
    const goal = getOutcomeGoals(profileId).find(({ id }) => id === goalId)!;
    const progress = getOutcomeGoalProgressMap(profileId, [goal]).get(goalId)!;
    expect(progress).toMatchObject({
      done: true,
      previous: { done: false },
    });
    expect(outcomeGoalProgressChanged(goal, progress, anchor)).toBe(true);
  });
});
