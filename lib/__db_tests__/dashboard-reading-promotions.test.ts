// DB integration for #3137's closed reading-promotion registry. The pure tier
// owns transition truth tables; this tier proves the dashboard gathers expose the
// prior comparable state without per-candidate reads or cross-profile leakage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentPRs } from "@/lib/coaching";
import { progressCandidates } from "@/lib/dashboard-candidates";
import {
  rankDashboardCandidates,
  type DashboardCandidate,
} from "@/lib/dashboard-relevance";
import {
  clinicalResultBecameNotable,
  outcomeGoalProgressChanged,
} from "@/lib/dashboard-reading-promotions";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getDashboardClinicalObservations,
  getOutcomeGoalProgressMap,
  getOutcomeGoals,
  getStrengthByExercise,
} from "@/lib/queries";
import { logPracticeSession } from "@/lib/practice-log";
import { getFrequencyTargetProgress } from "@/lib/queries";
import { setTimezone, setWeekStart, type WeekStart } from "@/lib/settings";
import { weekdayOfDateStr } from "@/lib/date";

const NOW = new Date("2026-06-17T12:00:00Z");

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function gatheredOutcome(profileId: number, goalId: number) {
  const goal = getOutcomeGoals(profileId).find(({ id }) => id === goalId)!;
  return {
    goal,
    progress: getOutcomeGoalProgressMap(profileId, [goal]).get(goalId)!,
  };
}

function moveToDay(date: string): void {
  vi.setSystemTime(new Date(`${date}T12:00:00Z`));
}

function addStrengthSet(profileId: number, date: string, weight: number): void {
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
}

function addLdl(profileId: number, date: string, value: number): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, unit, flag)
     VALUES (?, ?, 'lab', 'LDL Cholesterol', 'LDL Cholesterol', ?, ?,
             'mg/dL', 'normal')`
  ).run(profileId, date, String(value), value);
}

describe("dashboard reading-promotion gathers (#3137)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // THE MOMENT THE PROMOTION USED TO FIRE (#4756 / #5064), driven through a real
  // write rather than a steady-state render — the receipt row the owner photographed
  // appeared on the FIRST dashboard after the session was logged, and a fixture that
  // only ever renders a settled week never visits that moment at all.
  //
  // The week is pinned to start today, so one session meets a 1x/week floor with six
  // days still to run: `met` flips inside one render of the same week, which is the
  // only shape in which a met-transition promotion could ever have been minted.
  it("seats nothing in Now when a target is met by the write that meets it", () => {
    const profileId = newProfile("dashboard-target-met-write");
    const anchor = today(profileId);
    setWeekStart(profileId, weekdayOfDateStr(anchor) as WeekStart);
    db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, per_week, scope_identity, created_at)
       VALUES (?, 'practice', 'Sauna', 1, 'sauna', ?)`
    ).run(profileId, `${shiftDateStr(anchor, -30)} 08:00:00`);

    const readingNow = () => {
      const [progress] = getFrequencyTargetProgress(profileId);
      return {
        progress,
        candidate: progressCandidates.targetProgress(
          { subject: { scope: "profile", profileId }, sourceOrder: 0 },
          progress.target.id,
          progress.pace === "behind"
        ),
      };
    };
    const placementsOf = (candidate: DashboardCandidate) =>
      rankDashboardCandidates([candidate], {
        activeProfileId: profileId,
        minutesOfDay: 12 * 60,
        today: anchor,
        upcoming: [],
      }).map(({ candidate: placed, lane }) => [placed.candidateId, lane]);

    // The control, and it is the half that proves the assertion below can fail: an
    // unmet target holds a real standing seat, so "no Now row" after the write is
    // about the MET state rather than about this family having left the page.
    const before = readingNow();
    expect(before.progress.met).toBe(false);
    expect(placementsOf(before.candidate)).toEqual([
      [`target.weekly-progress:${before.progress.target.id}`, "standing"],
    ]);

    expect(logPracticeSession(profileId, "Sauna", anchor, "page").kind).toBe(
      "logged"
    );

    const after = readingNow();
    expect(after.progress.met).toBe(true);
    expect(after.candidate.readingPromotion).toBeUndefined();
    expect(after.candidate.rankReasons.changed).toBe(false);
    expect(
      placementsOf(after.candidate).filter(([, lane]) => lane === "now")
    ).toEqual([]);
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

  it("keeps a body-goal transition through same-state evidence and ends it on reversion or period close", () => {
    const profileId = newProfile("dashboard-goal-transition");
    const anchor = today(profileId);
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 80, 'manual')`
    ).run(profileId, shiftDateStr(anchor, -3));
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, status, body_metric, baseline_value,
              target_value, target_date, created_at)
           VALUES (?, 'Reach 70 kg', 'active', 'weight', 80, 70, ?, ?)`
        )
        .run(
          profileId,
          shiftDateStr(anchor, 2),
          `${shiftDateStr(anchor, -2)} 08:00:00`
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 70, 'manual')`
    ).run(profileId, shiftDateStr(anchor, -1));

    let gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({
      current: 70,
      done: true,
      previous: { pct: 0, done: false },
    });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, anchor)
    ).toBe(true);

    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 69, 'manual')`
    ).run(profileId, anchor);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, anchor)
    ).toBe(true);

    const nextDay = shiftDateStr(anchor, 1);
    moveToDay(nextDay);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, nextDay)
    ).toBe(true);

    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 72, 'manual')`
    ).run(profileId, nextDay);
    gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({ pct: 80, done: false });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, nextDay)
    ).toBe(false);

    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, 69, 'manual')`
    ).run(profileId, shiftDateStr(anchor, 2));
    const afterTarget = shiftDateStr(anchor, 3);
    moveToDay(afterTarget);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, afterTarget)
    ).toBe(false);
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

  it("admits goal-period evidence on the profile-local creation day across UTC midnight", () => {
    for (const scenario of [
      {
        name: "west",
        timezone: "America/Los_Angeles",
        createdAt: "2026-06-17 00:30:00",
        before: "2026-06-15",
        opening: "2026-06-16",
      },
      {
        name: "east",
        timezone: "Asia/Tokyo",
        createdAt: "2026-06-16 23:30:00",
        before: "2026-06-16",
        opening: "2026-06-17",
      },
    ]) {
      const profileId = newProfile(`dashboard-goal-${scenario.name}`);
      setTimezone(profileId, scenario.timezone);
      const goalId = Number(
        db
          .prepare(
            `INSERT INTO goals
               (profile_id, title, status, body_metric, baseline_value,
                target_value, target_date, created_at)
             VALUES (?, 'Local opening', 'active', 'weight', 80, 70,
                     '2026-06-30', ?)`
          )
          .run(profileId, scenario.createdAt).lastInsertRowid
      );
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, 70, 'manual')`
      ).run(profileId, scenario.before);

      expect(gatheredOutcome(profileId, goalId).progress.previous).toBeNull();

      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, 69, 'manual')`
      ).run(profileId, scenario.opening);
      expect(gatheredOutcome(profileId, goalId).progress).toMatchObject({
        periodStartDate: scenario.opening,
        previous: { pct: 0, done: false },
      });
    }
  });

  it("keeps a biomarker transition through later results and ends it on reversion or period close", () => {
    const profileId = newProfile("dashboard-biomarker-lifecycle");
    const anchor = today(profileId);
    addLdl(profileId, shiftDateStr(anchor, -3), 120);
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, status, biomarker_name, baseline_value,
              target_value, target_direction, unit, target_date, created_at)
           VALUES (?, 'LDL under 100', 'active', 'LDL Cholesterol', 120,
                   100, 'below', 'mg/dL', ?, ?)`
        )
        .run(
          profileId,
          shiftDateStr(anchor, 2),
          `${shiftDateStr(anchor, -2)} 08:00:00`
        ).lastInsertRowid
    );
    addLdl(profileId, shiftDateStr(anchor, -1), 95);

    let gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({
      current: 95,
      done: true,
      previous: { pct: 0, done: false },
    });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, anchor)
    ).toBe(true);

    addLdl(profileId, anchor, 90);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, anchor)
    ).toBe(true);

    const nextDay = shiftDateStr(anchor, 1);
    moveToDay(nextDay);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, nextDay)
    ).toBe(true);

    addLdl(profileId, nextDay, 105);
    gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({ pct: 75, done: false });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, nextDay)
    ).toBe(false);

    addLdl(profileId, shiftDateStr(anchor, 2), 90);
    const afterTarget = shiftDateStr(anchor, 3);
    moveToDay(afterTarget);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, afterTarget)
    ).toBe(false);
  });

  it("keeps an exercise pace transition through same-state evidence and ends it on reversion or period close", () => {
    const profileId = newProfile("dashboard-exercise-lifecycle");
    const anchor = today(profileId);
    addStrengthSet(profileId, shiftDateStr(anchor, -7), 50);
    const goalId = Number(
      db
        .prepare(
          `INSERT INTO goals
             (profile_id, title, status, exercise, metric, target_weight_kg,
              target_date, created_at)
           VALUES (?, 'Bench 100 kg', 'active', 'Bench Press', 'weight', 100, ?, ?)`
        )
        .run(
          profileId,
          shiftDateStr(anchor, 4),
          `${shiftDateStr(anchor, -6)} 08:00:00`
        ).lastInsertRowid
    );
    addStrengthSet(profileId, anchor, 55);

    let gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({
      current: 55,
      done: false,
      previous: { pct: 50, done: false },
    });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, anchor)
    ).toBe(true);

    const nextDay = shiftDateStr(anchor, 1);
    addStrengthSet(profileId, nextDay, 55);
    moveToDay(nextDay);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, nextDay)
    ).toBe(true);

    const revertedDay = shiftDateStr(anchor, 2);
    addStrengthSet(profileId, revertedDay, 80);
    moveToDay(revertedDay);
    gathered = gatheredOutcome(profileId, goalId);
    expect(gathered.progress).toMatchObject({ pct: 80, done: false });
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, revertedDay)
    ).toBe(false);

    const afterTarget = shiftDateStr(anchor, 5);
    moveToDay(afterTarget);
    gathered = gatheredOutcome(profileId, goalId);
    expect(
      outcomeGoalProgressChanged(gathered.goal, gathered.progress, afterTarget)
    ).toBe(false);
  });

  it("reuses the existing all-history strength verdict for today's record", () => {
    const profileId = newProfile("dashboard-training-transition");
    const anchor = today(profileId);
    addStrengthSet(profileId, shiftDateStr(anchor, -2), 50);
    addStrengthSet(profileId, anchor, 60);

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
  });
});
