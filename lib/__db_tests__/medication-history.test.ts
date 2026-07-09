// DB INTEGRATION TIER (not the pure unit suite). Exercises the #209 medication
// history schema + query helpers against a real (in-memory / temp-file) SQLite
// handle: the boot backfill, the stop/restart course machinery, side-effect CRUD
// + promote-to-intolerance, ON DELETE CASCADE via the parent, and two-profile
// scoping on the new child-table reads. Runs via `npm run test:db`.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { migrate, db, today } from "@/lib/db";
import { seedProfile } from "./fixtures";
import {
  ensureMedicationCourse,
  getMedicationCourses,
  getMedicationSideEffects,
  stopMedicationCourses,
  restartMedicationCourse,
  setMedicationActive,
  insertMedicationSideEffect,
  updateMedicationSideEffect,
  toggleMedicationSideEffectResolved,
  deleteMedicationSideEffect,
  promoteMedicationSideEffect,
  ownedMedicationId,
  getOwnedSideEffect,
} from "@/lib/queries";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

// A standalone migrated handle (separate from the singleton) so the backfill can
// be observed across repeated migrate() runs without touching other tests' data.
function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.pragma("busy_timeout = 10000");
  migrate(d);
  return d;
}

describe("medication_courses backfill (boot)", () => {
  it("creates exactly one open course per existing medication, idempotently", () => {
    const d = freshDb();
    // A medication inserted the way an old release would have — no course yet.
    const medId = Number(
      d
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, created_at)
           VALUES (1, 'Old Med', 1, 'medication', 'daily', 'high', '2024-01-15 08:00:00')`
        )
        .run().lastInsertRowid
    );
    // An ALREADY-DISCONTINUED med (active=0) must backfill to a CLOSED course so
    // it lands in Past, never contradicting its active flag (the F1 regression).
    const inactiveMedId = Number(
      d
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, created_at)
           VALUES (1, 'Finished Antibiotic', 0, 'medication', 'daily', 'high', '2023-05-10 08:00:00')`
        )
        .run().lastInsertRowid
    );
    // A supplement must NEVER get a course.
    d.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
       VALUES (1, 'Vitamin C', 1, 'supplement', 'daily', 'high')`
    ).run();

    const countCourses = (itemId: number) =>
      (
        d
          .prepare(
            "SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ?"
          )
          .get(itemId) as { c: number }
      ).c;
    const countAll = () =>
      (
        d.prepare("SELECT COUNT(*) AS c FROM medication_courses").get() as {
          c: number;
        }
      ).c;

    // The upgrade boot: re-run migrate() → each med gets its one initial course.
    migrate(d);
    expect(countCourses(medId)).toBe(1);
    expect(countCourses(inactiveMedId)).toBe(1);
    expect(countAll()).toBe(2); // supplement got none

    const activeCourse = d
      .prepare("SELECT * FROM medication_courses WHERE item_id = ?")
      .get(medId) as { started_on: string; stopped_on: string | null };
    expect(activeCourse.started_on).toBe("2024-01-15"); // date part of created_at
    expect(activeCourse.stopped_on).toBeNull(); // active med → left open

    const inactiveCourse = d
      .prepare("SELECT * FROM medication_courses WHERE item_id = ?")
      .get(inactiveMedId) as { started_on: string; stopped_on: string | null };
    // active=0 → CLOSED course (stopped_on = created_at date), so it's Past.
    expect(inactiveCourse.started_on).toBe("2023-05-10");
    expect(inactiveCourse.stopped_on).toBe("2023-05-10");

    // Idempotent: a second (and third) boot never adds a duplicate.
    migrate(d);
    migrate(d);
    expect(countCourses(medId)).toBe(1);
    expect(countCourses(inactiveMedId)).toBe(1);
    d.close();
  });
});

describe("stop / restart produces separate courses", () => {
  it("stop closes the open course + clears active; restart opens a new one", () => {
    const p = seedProfile("stoprestart");
    ensureMedicationCourse(p.profileId, p.medicationId, "2025-01-01");
    expect(getMedicationCourses(p.profileId)).toHaveLength(1);

    stopMedicationCourses(p.profileId, p.medicationId, {
      date: "2025-03-01",
      reason: "side_effect",
      note: "rash",
    });
    let courses = getMedicationCourses(p.profileId);
    expect(courses).toHaveLength(1);
    expect(courses[0].stopped_on).toBe("2025-03-01");
    expect(courses[0].stop_reason).toBe("side_effect");
    // active flag cleared so scheduling stops.
    const activeAfterStop = (
      db
        .prepare("SELECT active FROM intake_items WHERE id = ?")
        .get(p.medicationId) as { active: number }
    ).active;
    expect(activeAfterStop).toBe(0);

    restartMedicationCourse(p.profileId, p.medicationId, "2025-04-01");
    courses = getMedicationCourses(p.profileId);
    expect(courses).toHaveLength(2); // a NEW course, history preserved
    const open = courses.filter((c) => c.stopped_on == null);
    expect(open).toHaveLength(1);
    expect(open[0].started_on).toBe("2025-04-01");
    const activeAfterRestart = (
      db
        .prepare("SELECT active FROM intake_items WHERE id = ?")
        .get(p.medicationId) as { active: number }
    ).active;
    expect(activeAfterRestart).toBe(1);
  });

  it("ensureMedicationCourse opens a course for an active med but CLOSES it for a paused one (kind-flip)", () => {
    // Active med → open course.
    const active = seedProfile("ensure-active");
    ensureMedicationCourse(active.profileId, active.medicationId, "2025-01-01");
    const activeCourses = getMedicationCourses(active.profileId);
    expect(activeCourses).toHaveLength(1);
    expect(activeCourses[0].stopped_on).toBeNull();

    // Simulate flipping a PAUSED supplement to a medication: active=0, no course
    // yet. ensureMedicationCourse must create a CLOSED course so it lands in Past,
    // never Current (the F2 regression).
    const paused = seedProfile("ensure-paused");
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(
      paused.medicationId
    );
    ensureMedicationCourse(paused.profileId, paused.medicationId, "2025-01-01");
    const pausedCourses = getMedicationCourses(paused.profileId);
    expect(pausedCourses).toHaveLength(1);
    expect(pausedCourses[0].stopped_on).toBe("2025-01-01"); // closed
  });

  it("setMedicationActive keeps the active flag in sync with course state", () => {
    const p = seedProfile("syncflag");
    ensureMedicationCourse(p.profileId, p.medicationId, "2025-01-01");
    // Pause → open course closes.
    setMedicationActive(p.profileId, p.medicationId, 0, "2025-02-01");
    expect(
      getMedicationCourses(p.profileId).filter((c) => c.stopped_on == null)
    ).toHaveLength(0);
    // Resume → a fresh open course.
    setMedicationActive(p.profileId, p.medicationId, 1, "2025-02-10");
    expect(
      getMedicationCourses(p.profileId).filter((c) => c.stopped_on == null)
    ).toHaveLength(1);
  });

  it("ownedMedicationId gates a forged / cross-profile id", () => {
    const a = seedProfile("owner-a");
    const b = seedProfile("owner-b");
    expect(ownedMedicationId(a.profileId, a.medicationId)).toBe(a.medicationId);
    // b's med isn't a's.
    expect(ownedMedicationId(a.profileId, b.medicationId)).toBeNull();
    // a supplement isn't a medication.
    expect(ownedMedicationId(a.profileId, a.supplementId)).toBeNull();
    // A stop against a non-owned id is a silent no-op (no course created).
    stopMedicationCourses(a.profileId, b.medicationId, {
      date: "2025-01-01",
      reason: "other",
    });
    expect(getMedicationCourses(a.profileId)).toHaveLength(0);

    // setMedicationActive must ALSO gate a non-owned id (F3): a's call against b's
    // med changes nothing on b.
    ensureMedicationCourse(b.profileId, b.medicationId, "2025-01-01");
    const bActiveBefore = (
      db
        .prepare("SELECT active FROM intake_items WHERE id = ?")
        .get(b.medicationId) as { active: number }
    ).active;
    setMedicationActive(a.profileId, b.medicationId, 0, "2025-06-01");
    const bActiveAfter = (
      db
        .prepare("SELECT active FROM intake_items WHERE id = ?")
        .get(b.medicationId) as { active: number }
    ).active;
    expect(bActiveAfter).toBe(bActiveBefore); // untouched
    expect(
      getMedicationCourses(b.profileId).filter((c) => c.stopped_on == null)
    ).toHaveLength(1); // b's open course not closed by a's call
  });
});

describe("side effect CRUD + promote-to-intolerance", () => {
  it("adds, edits, resolves, promotes, and deletes side effects", () => {
    const p = seedProfile("sideeffects");
    ensureMedicationCourse(p.profileId, p.medicationId, "2025-01-01");
    const courseId = getMedicationCourses(p.profileId)[0].id;

    insertMedicationSideEffect(p.profileId, p.medicationId, {
      effect: "Dizziness",
      severity: "moderate",
      notedOn: "2025-01-05",
      notes: "on standing",
      courseId,
    });
    let effects = getMedicationSideEffects(p.profileId);
    expect(effects).toHaveLength(1);
    expect(effects[0].effect).toBe("Dizziness");
    expect(effects[0].severity).toBe("moderate");
    expect(effects[0].course_id).toBe(courseId);
    const seId = effects[0].id;

    // Edit.
    updateMedicationSideEffect(p.profileId, seId, {
      effect: "Dizzy spells",
      severity: "severe",
      notedOn: "2025-01-06",
      notes: null,
      resolved: 0,
    });
    effects = getMedicationSideEffects(p.profileId);
    expect(effects[0].effect).toBe("Dizzy spells");
    expect(effects[0].severity).toBe("severe");

    // Toggle resolved.
    toggleMedicationSideEffectResolved(p.profileId, seId);
    expect(getMedicationSideEffects(p.profileId)[0].resolved).toBe(1);
    toggleMedicationSideEffectResolved(p.profileId, seId);
    expect(getMedicationSideEffects(p.profileId)[0].resolved).toBe(0);

    // Promote → an allergies row is created and the side effect is resolved.
    const allergiesBefore = (
      db
        .prepare("SELECT COUNT(*) AS c FROM allergies WHERE profile_id = ?")
        .get(p.profileId) as { c: number }
    ).c;
    const ok = promoteMedicationSideEffect(
      p.profileId,
      seId,
      today(p.profileId)
    );
    expect(ok).toBe(true);
    const allergy = db
      .prepare(
        "SELECT * FROM allergies WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(p.profileId) as { substance: string; severity: string | null };
    expect(allergy.substance).toBe("Dizzy spells");
    expect(allergy.severity).toBe("Severe");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM allergies WHERE profile_id = ?")
          .get(p.profileId) as { c: number }
      ).c
    ).toBe(allergiesBefore + 1);
    expect(getMedicationSideEffects(p.profileId)[0].resolved).toBe(1);

    // Promoting the SAME side effect again is idempotent (F4): the deterministic
    // external_id (`med-se:<id>`) + INSERT OR IGNORE dedups, so no second allergy
    // row is created.
    promoteMedicationSideEffect(p.profileId, seId, today(p.profileId));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM allergies WHERE profile_id = ?")
          .get(p.profileId) as { c: number }
      ).c
    ).toBe(allergiesBefore + 1); // still just one
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM allergies WHERE profile_id = ? AND external_id = ?"
          )
          .get(p.profileId, `med-se:${seId}`) as { c: number }
      ).c
    ).toBe(1);

    // Delete.
    deleteMedicationSideEffect(p.profileId, seId);
    expect(getMedicationSideEffects(p.profileId)).toHaveLength(0);
  });

  it("a cross-profile side-effect id is not owned and mutations no-op", () => {
    const a = seedProfile("se-a");
    const b = seedProfile("se-b");
    ensureMedicationCourse(b.profileId, b.medicationId, "2025-01-01");
    insertMedicationSideEffect(b.profileId, b.medicationId, {
      effect: "Bnausea",
      notedOn: "2025-01-02",
    });
    const bSeId = getMedicationSideEffects(b.profileId)[0].id;
    // a can't see or touch b's side effect.
    expect(getOwnedSideEffect(a.profileId, bSeId)).toBeUndefined();
    deleteMedicationSideEffect(a.profileId, bSeId);
    expect(getMedicationSideEffects(b.profileId)).toHaveLength(1);
    expect(promoteMedicationSideEffect(a.profileId, bSeId, "2025-01-03")).toBe(
      false
    );
  });
});

describe("ON DELETE CASCADE via the parent intake_items row", () => {
  it("deleting the medication removes its courses + side effects", () => {
    const p = seedProfile("cascade");
    ensureMedicationCourse(p.profileId, p.medicationId, "2025-01-01");
    stopMedicationCourses(p.profileId, p.medicationId, {
      date: "2025-02-01",
      reason: "completed_course",
      effect: "Fatigue",
      severity: "mild",
    });
    restartMedicationCourse(p.profileId, p.medicationId, "2025-03-01");
    expect(getMedicationCourses(p.profileId).length).toBeGreaterThanOrEqual(2);
    expect(getMedicationSideEffects(p.profileId).length).toBeGreaterThanOrEqual(
      1
    );

    // Deleting the parent cascades (foreign_keys = ON in createDb).
    db.prepare("DELETE FROM intake_items WHERE id = ? AND profile_id = ?").run(
      p.medicationId,
      p.profileId
    );
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ?"
          )
          .get(p.medicationId) as { c: number }
      ).c
    ).toBe(0);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM intake_item_side_effects WHERE item_id = ?"
          )
          .get(p.medicationId) as { c: number }
      ).c
    ).toBe(0);
  });
});

describe("two-profile scoping on the new child-table reads", () => {
  it("never surfaces another profile's courses or side effects", () => {
    const a = seedProfile("scope-a");
    const b = seedProfile("scope-b");
    ensureMedicationCourse(a.profileId, a.medicationId, "2025-01-01");
    ensureMedicationCourse(b.profileId, b.medicationId, "2025-01-01");
    insertMedicationSideEffect(a.profileId, a.medicationId, {
      effect: "A-only effect",
      notedOn: "2025-01-02",
    });
    insertMedicationSideEffect(b.profileId, b.medicationId, {
      effect: "B-only effect",
      notedOn: "2025-01-02",
    });

    const aCourses = getMedicationCourses(a.profileId);
    const bCourses = getMedicationCourses(b.profileId);
    expect(aCourses.every((c) => c.item_id === a.medicationId)).toBe(true);
    expect(bCourses.every((c) => c.item_id === b.medicationId)).toBe(true);
    expect(aCourses.some((c) => c.item_id === b.medicationId)).toBe(false);

    const aEffects = getMedicationSideEffects(a.profileId);
    expect(aEffects.map((e) => e.effect)).toContain("A-only effect");
    expect(aEffects.map((e) => e.effect)).not.toContain("B-only effect");
  });
});
