// SERVER-ACTION TIER — deleteProfile leaves no orphaned child-table PHI (#2126).
//
// The profile-delete sweep runs with `foreign_keys = OFF` (#729), so ON DELETE
// CASCADE never fires and every child table must be deleted explicitly. The old
// hand-maintained child list missed `allergy_reactions`, `medication_courses`, and
// `intake_item_side_effects` — deleting a profile left graded anaphylaxis details,
// prescriber history, and side-effect notes orphaned in the database forever,
// invisible in normal use because the parent rows were gone. This is the executed
// proof: seed exactly those shapes, delete the profile end-to-end through the real
// action, and assert zero surviving rows. It FAILS against the pre-#2126 sweep.
// The structural guard (every FK-reachable child is in the derived plan) lives in
// lib/__db_tests__/profile-delete-fk-scan.test.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

interface Seeded {
  allergyId: number;
  itemId: number;
  doseId: number;
  courseId: number;
}

// An allergy with graded reactions, and a medication with a dose, a schedule
// version, a course, and a course-linked side effect — the exact shapes the stale
// hand list orphaned, plus a grandchild for depth.
function seedClinicalSubtree(profileId: number): Seeded {
  const allergyId = Number(
    db
      .prepare(
        "INSERT INTO allergies (profile_id, substance, reaction, severity) VALUES (?, 'Peanut', 'Anaphylaxis', 'severe')"
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO allergy_reactions (allergy_id, manifestation, severity, position) VALUES (?, 'Anaphylaxis', 'severe', 0), (?, 'Hives', 'mild', 1)"
  ).run(allergyId, allergyId);

  const itemId = Number(
    db
      .prepare(
        "INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Amoxicillin', 'medication')"
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        "INSERT INTO intake_item_doses (item_id, amount, time_of_day) VALUES (?, '500 mg', 'morning')"
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO intake_dose_schedule_versions (dose_id, effective_from, time_of_day) VALUES (?, '2026-01-01', 'evening')"
  ).run(doseId);
  const courseId = Number(
    db
      .prepare(
        "INSERT INTO medication_courses (item_id, started_on, stop_reason, prescriber) VALUES (?, '2026-01-01', NULL, 'Dr. Fictional')"
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO intake_item_side_effects (item_id, course_id, effect, severity, notes) VALUES (?, ?, 'Nausea', 'moderate', 'after breakfast dose')"
  ).run(itemId, courseId);

  return { allergyId, itemId, doseId, courseId };
}

function childCounts(s: Seeded) {
  const count = (sql: string, bind: number) =>
    (db.prepare(sql).get(bind) as { c: number }).c;
  return {
    reactions: count(
      "SELECT COUNT(*) AS c FROM allergy_reactions WHERE allergy_id = ?",
      s.allergyId
    ),
    courses: count(
      "SELECT COUNT(*) AS c FROM medication_courses WHERE item_id = ?",
      s.itemId
    ),
    sideEffects: count(
      "SELECT COUNT(*) AS c FROM intake_item_side_effects WHERE item_id = ?",
      s.itemId
    ),
    doses: count(
      "SELECT COUNT(*) AS c FROM intake_item_doses WHERE item_id = ?",
      s.itemId
    ),
    scheduleVersions: count(
      "SELECT COUNT(*) AS c FROM intake_dose_schedule_versions WHERE dose_id = ?",
      s.doseId
    ),
  };
}

describe("deleteProfile clears allergy reactions, courses, and side effects (#2126)", () => {
  it("no child row survives the delete; a bystander profile's subtree is untouched", async () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    const bystander = createProfile("Ada Lovelace");
    actAs(admin, acting);

    const victimRows = seedClinicalSubtree(victim.id);
    const bystanderRows = seedClinicalSubtree(bystander.id);
    expect(childCounts(victimRows)).toEqual({
      reactions: 2,
      courses: 1,
      sideEffects: 1,
      doses: 1,
      scheduleVersions: 1,
    });

    const res = await deleteProfile(fd({ id: victim.id }));
    expect(res.ok).toBe(true);

    // The victim's entire subtree is gone — including the three tables the stale
    // hand list orphaned (pre-fix: reactions/courses/sideEffects survive as 2/1/1).
    expect(childCounts(victimRows)).toEqual({
      reactions: 0,
      courses: 0,
      sideEffects: 0,
      doses: 0,
      scheduleVersions: 0,
    });
    expect(
      db.prepare("SELECT id FROM profiles WHERE id = ?").get(victim.id)
    ).toBeUndefined();

    // The bystander's identical subtree survives intact.
    expect(childCounts(bystanderRows)).toEqual({
      reactions: 2,
      courses: 1,
      sideEffects: 1,
      doses: 1,
      scheduleVersions: 1,
    });

    // foreign_keys is restored after the sweep.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
