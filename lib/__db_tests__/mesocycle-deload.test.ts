// DB INTEGRATION TIER — mesocycle deload flag end-to-end (#741, per #448).
//
// Seeds a realistic profile with an ACTIVE routine whose cycle_weeks + started_date
// place today in its LAST (deload) week, and asserts the ONE gather
// (getRoutineCycleStatus) drives every downstream surface consistently:
//   • the volume-band `below` finding (#742 hook) is held during deload;
//   • the region/group frequency-target `behind` Upcoming finding is suppressed;
//   • with NO cycle (cycle_weeks NULL) BOTH fire — byte-for-byte the prior behavior.
// The pure week-in-cycle / re-anchoring math has its own boundary tests
// (lib/__tests__/mesocycle.test.ts); this tier proves the wiring through real rows.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  createCustomRoutine,
  activateRoutine,
  getRoutineCycleStatus,
} from "@/lib/routines";
import { buildMuscleVolumeFindings } from "@/lib/rule-findings";
import { collectUpcoming } from "@/lib/queries/upcoming";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// A strength session on `anchor + day` of `n` sets of `exercise`.
function logSets(
  profileId: number,
  anchor: string,
  day: number,
  exercise: string,
  n: number
): void {
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profileId, shiftDateStr(anchor, day)).lastInsertRowid
  );
  const ins = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, ?, 10, 12)`
  );
  for (let s = 1; s <= n; s++) ins.run(actId, exercise, s);
}

// A behind region frequency target: per_week high, no sessions of that region this
// week ⇒ it surfaces as a `training:<id>` Upcoming finding.
function addRegionTarget(
  profileId: number,
  region: string,
  perWeek: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets (scope_kind, scope_value, per_week, profile_id)
           VALUES ('region', ?, ?, ?)`
      )
      .run(region, perWeek, profileId).lastInsertRowid
  );
}

// Build a cycled active routine and place today in a chosen 0-based cycle week by
// backdating started_date; returns the routine id.
function seedCycledRoutine(
  profileId: number,
  anchor: string,
  cycleWeeks: number,
  weekOffset: number
): number {
  const rid = createCustomRoutine(profileId, {
    name: "Legs cycle",
    cycleWeeks,
    days: [
      {
        label: "Legs",
        focus: ["Legs"],
        slots: [{ candidates: ["Back Squat"], sets: 3, repMin: 5, repMax: 8 }],
      },
    ],
  });
  activateRoutine(profileId, rid);
  // started_date = anchor - 7*weekOffset ⇒ weekInCycle == weekOffset % cycleWeeks.
  db.prepare(`UPDATE routines SET started_date = ? WHERE id = ?`).run(
    shiftDateStr(anchor, -7 * weekOffset),
    rid
  );
  return rid;
}

// Two distinct training weeks of an under-floor lift (side delts), so the volume
// builder is past cold start and would otherwise flag "below".
function seedUnderVolume(profileId: number, anchor: string): void {
  logSets(profileId, anchor, 0, "Lateral Raise", 2); // this week: 2 sets < floor 8
  logSets(profileId, anchor, -14, "Lateral Raise", 3); // a second distinct week
}

describe("getRoutineCycleStatus — deload week resolution (#741)", () => {
  it("reports the LAST week of the cycle as the deload week", () => {
    const { profileId, anchor } = makeProfile("meso-status");
    seedCycledRoutine(profileId, anchor, 2, 1); // 2-week cycle, week 1 = deload
    const status = getRoutineCycleStatus(profileId, anchor)!;
    expect(status).not.toBeNull();
    expect(status.cycleWeeks).toBe(2);
    expect(status.weekInCycle).toBe(1);
    expect(status.isDeloadWeek).toBe(true);
    expect(status.weeksUntilDeload).toBe(0);
  });

  it("reports a non-deload week and returns null with no cycle", () => {
    const { profileId, anchor } = makeProfile("meso-status-2");
    const rid = seedCycledRoutine(profileId, anchor, 4, 0); // week 0 of 4
    const status = getRoutineCycleStatus(profileId, anchor)!;
    expect(status.weekInCycle).toBe(0);
    expect(status.isDeloadWeek).toBe(false);
    expect(status.weeksUntilDeload).toBe(3);

    db.prepare(`UPDATE routines SET cycle_weeks = NULL WHERE id = ?`).run(rid);
    expect(getRoutineCycleStatus(profileId, anchor)).toBeNull();
  });
});

describe("deload week suppresses coaching + behind findings (#741)", () => {
  it("holds the volume-band `below` finding during deload; fires without a cycle", () => {
    // Deload profile: cycle in its deload week → the shortfall is expected, held.
    const deload = makeProfile("meso-vol-deload");
    seedCycledRoutine(deload.profileId, deload.anchor, 2, 1);
    seedUnderVolume(deload.profileId, deload.anchor);
    expect(
      getRoutineCycleStatus(deload.profileId, deload.anchor)!.isDeloadWeek
    ).toBe(true);
    expect(buildMuscleVolumeFindings(deload.profileId, deload.anchor)).toEqual(
      []
    );

    // Control profile: SAME shortfall, routine has no cycle → the finding fires.
    const control = makeProfile("meso-vol-control");
    const rid = seedCycledRoutine(control.profileId, control.anchor, 2, 1);
    db.prepare(`UPDATE routines SET cycle_weeks = NULL WHERE id = ?`).run(rid);
    seedUnderVolume(control.profileId, control.anchor);
    const findings = buildMuscleVolumeFindings(
      control.profileId,
      control.anchor
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => (f.detail ?? "").includes("Side delts"))).toBe(
      true
    );
  });

  it("suppresses a behind region target on Upcoming during deload; keeps it without a cycle", () => {
    // Deload profile: a behind Legs target should NOT surface this (deload) week.
    const deload = makeProfile("meso-behind-deload");
    seedCycledRoutine(deload.profileId, deload.anchor, 2, 1);
    // Activation derived a Legs target; replace targets with a clearly-behind one.
    db.prepare(`DELETE FROM frequency_targets WHERE profile_id = ?`).run(
      deload.profileId
    );
    const tid = addRegionTarget(deload.profileId, "Legs", 3);
    const deloadItems = collectUpcoming(deload.profileId, deload.anchor);
    expect(deloadItems.some((i) => i.key === `training:${tid}`)).toBe(false);

    // Control profile: same behind target, no cycle → the finding surfaces.
    const control = makeProfile("meso-behind-control");
    const rid = seedCycledRoutine(control.profileId, control.anchor, 2, 1);
    db.prepare(`UPDATE routines SET cycle_weeks = NULL WHERE id = ?`).run(rid);
    db.prepare(`DELETE FROM frequency_targets WHERE profile_id = ?`).run(
      control.profileId
    );
    const cid = addRegionTarget(control.profileId, "Legs", 3);
    const controlItems = collectUpcoming(control.profileId, control.anchor);
    expect(controlItems.some((i) => i.key === `training:${cid}`)).toBe(true);
  });
});
