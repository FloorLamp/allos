// DB INTEGRATION TIER — routine schema + write cores (#738).
//
// Exercises the migration-039 tables and the auth-blind cores in lib/routines.ts
// against the real schema (the db singleton is a per-file temp DB; profile 1 exists):
//   • the three tables + columns exist;
//   • adopt copies a template into routines/routine_days/routine_slots;
//   • activate materializes the derived training frequency_targets and REPLACES only
//     region/group/type rows — food_group (nutrition) survives;
//   • single-active is enforced;
//   • deactivate keeps targets; delete removes the routine + its children (no
//     orphaned days/slots) and leaves targets in place;
//   • everything is profile-scoped (a second profile is untouched).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  adoptTemplate,
  activateRoutine,
  deactivateRoutine,
  deleteRoutine,
  getActiveRoutine,
  getRoutines,
  getRoutineWithDays,
  getTrainingTargetsToReplace,
} from "@/lib/routines";
import { getRoutineTemplate } from "@/lib/routine-templates";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Clear a profile's routine state, children first (FK on in the db tier).
function resetProfile(profileId: number) {
  db.prepare(
    `DELETE FROM routine_slots WHERE routine_day_id IN (
       SELECT rd.id FROM routine_days rd JOIN routines r ON r.id = rd.routine_id
        WHERE r.profile_id = ?)`
  ).run(profileId);
  db.prepare(
    `DELETE FROM routine_days WHERE routine_id IN (
       SELECT id FROM routines WHERE profile_id = ?)`
  ).run(profileId);
  db.prepare("DELETE FROM routines WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM frequency_targets WHERE profile_id = ?").run(
    profileId
  );
}

function targets(profileId: number) {
  return db
    .prepare(
      `SELECT scope_kind, scope_value, per_week FROM frequency_targets
        WHERE profile_id = ? ORDER BY scope_kind, scope_value`
    )
    .all(profileId) as {
    scope_kind: string;
    scope_value: string;
    per_week: number;
  }[];
}

describe("routine schema (migration 039)", () => {
  it("creates the three tables with the declared columns", () => {
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name)
    );
    for (const t of ["routines", "routine_days", "routine_slots"])
      expect(tables.has(t)).toBe(true);

    const cols = (t: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
          (r) => r.name
        )
      );
    expect(cols("routines")).toEqual(
      new Set([
        "id",
        "name",
        "source",
        "template_id",
        "active",
        "started_date",
        "position",
        "cycle_weeks",
        "created_at",
        "profile_id",
      ])
    );
    expect(cols("routine_days")).toEqual(
      new Set(["id", "routine_id", "ordinal", "label", "focus"])
    );
    expect(cols("routine_slots")).toEqual(
      new Set([
        "id",
        "routine_day_id",
        "ordinal",
        "candidates",
        "sets",
        "rep_min",
        "rep_max",
      ])
    );
  });

  it("enforces the source CHECK", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO routines (name, source, profile_id) VALUES ('x','bogus',1)"
        )
        .run()
    ).toThrow();
  });
});

describe("adoptTemplate", () => {
  it("copies a template into the routine tables (inactive), no targets touched", () => {
    const before = targets(1);
    const rid = adoptTemplate(1, "push-pull-legs-6x");
    const tpl = getRoutineTemplate("push-pull-legs-6x")!;

    const routine = getRoutineWithDays(1, rid)!;
    expect(routine.source).toBe("template");
    expect(routine.template_id).toBe("push-pull-legs-6x");
    expect(routine.active).toBe(0);
    expect(routine.name).toBe(tpl.name);
    expect(routine.days.length).toBe(tpl.days.length);
    // Slots + candidates round-trip through JSON.
    expect(routine.days[0].label).toBe(tpl.days[0].label);
    expect(routine.days[0].focus).toEqual(tpl.days[0].focus);
    expect(routine.days[0].slots.length).toBe(tpl.days[0].slots.length);
    expect(routine.days[0].slots[0].candidates).toEqual(
      tpl.days[0].slots[0].candidates
    );
    // Adoption does not activate or write targets.
    expect(targets(1)).toEqual(before);
  });

  it("rejects an unknown template id", () => {
    expect(() => adoptTemplate(1, "no-such-template")).toThrow();
  });
});

describe("activateRoutine — replaces training-scope targets, food_group survives", () => {
  beforeEach(() => resetProfile(1));

  it("replaces region/group/type targets with the routine's derived ones", () => {
    // Pre-existing mixed targets: two training-scope + one nutrition food_group.
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (1,'group','Upper',2),(1,'region','Chest',3),(1,'food_group','fatty_fish',2)`
    ).run();

    const rid = adoptTemplate(1, "push-pull-legs-6x");
    expect(getTrainingTargetsToReplace(1).length).toBe(2); // the two training rows

    const ok = activateRoutine(1, rid);
    expect(ok).toBe(true);

    const after = targets(1);
    // food_group row is untouched.
    const food = after.filter((t) => t.scope_kind === "food_group");
    expect(food).toEqual([
      { scope_kind: "food_group", scope_value: "fatty_fish", per_week: 2 },
    ]);
    // The old training rows are gone; the PPL template's declared region targets
    // are present.
    const tpl = getRoutineTemplate("push-pull-legs-6x")!;
    const training = after.filter((t) => t.scope_kind !== "food_group");
    expect(training.length).toBe(tpl.frequencyTargets.length);
    for (const ft of tpl.frequencyTargets) {
      expect(training).toContainEqual({
        scope_kind: ft.scopeKind,
        scope_value: ft.scopeValue,
        per_week: ft.perWeek,
      });
    }

    const active = getActiveRoutine(1)!;
    expect(active.id).toBe(rid);
    expect(active.active).toBe(1);
    expect(active.started_date).toBeTruthy();
    expect(active.position).toBe(0);
  });

  it("fresh profile has nothing to replace (confirm-free path, #719)", () => {
    const rid = adoptTemplate(1, "bodyweight-minimal");
    expect(getTrainingTargetsToReplace(1)).toEqual([]);
    expect(activateRoutine(1, rid)).toBe(true);
    // Now the derived targets exist.
    expect(targets(1).length).toBeGreaterThan(0);
  });

  it("enforces single-active (activating one deactivates the rest)", () => {
    const a = adoptTemplate(1, "full-body-3x");
    const b = adoptTemplate(1, "upper-lower-4x");
    activateRoutine(1, a);
    activateRoutine(1, b);
    const active = getRoutines(1).filter((r) => r.active === 1);
    expect(active.map((r) => r.id)).toEqual([b]);
  });
});

describe("deactivate / delete side-state", () => {
  beforeEach(() => resetProfile(1));

  it("deactivate keeps the derived targets", () => {
    const rid = adoptTemplate(1, "full-body-3x");
    activateRoutine(1, rid);
    const before = targets(1);
    expect(before.length).toBeGreaterThan(0);
    expect(deactivateRoutine(1, rid)).toBe(true);
    expect(getRoutines(1).find((r) => r.id === rid)!.active).toBe(0);
    // Targets survive deactivation (now ordinary user targets).
    expect(targets(1)).toEqual(before);
  });

  it("delete removes the routine + its children, leaves targets in place", () => {
    const rid = adoptTemplate(1, "full-body-3x");
    activateRoutine(1, rid);
    const before = targets(1);

    const dayIds = (
      db
        .prepare("SELECT id FROM routine_days WHERE routine_id = ?")
        .all(rid) as { id: number }[]
    ).map((r) => r.id);
    expect(dayIds.length).toBeGreaterThan(0);

    expect(deleteRoutine(1, rid)).toBe(true);
    expect(getRoutineWithDays(1, rid)).toBeNull();
    // No orphaned children.
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM routine_days WHERE routine_id = ?")
        .get(rid)
    ).toEqual({ c: 0 });
    const placeholders = dayIds.map(() => "?").join(",");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM routine_slots WHERE routine_day_id IN (${placeholders})`
        )
        .get(...dayIds)
    ).toEqual({ c: 0 });
    // Targets are left alone by delete.
    expect(targets(1)).toEqual(before);
  });
});

describe("profile scoping", () => {
  it("cores never reach another profile's routine", () => {
    const other = newProfile("Other");
    const rid = adoptTemplate(other, "full-body-3x");
    // Profile 1 can't see, activate, or delete profile `other`'s routine.
    expect(getRoutineWithDays(1, rid)).toBeNull();
    expect(activateRoutine(1, rid)).toBe(false);
    expect(deactivateRoutine(1, rid)).toBe(false);
    expect(deleteRoutine(1, rid)).toBe(false);
    // It still exists for its owner.
    expect(getRoutineWithDays(other, rid)).not.toBeNull();
  });
});
