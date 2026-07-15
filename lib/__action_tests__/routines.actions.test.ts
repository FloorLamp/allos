// SERVER-ACTION TIER — routine write paths (#738).
//
// Drives the gated actions in app/(app)/training/actions.ts through the mocked auth
// boundary (setup.ts) against the real temp DB: adopt / create / activate /
// deactivate / edit / delete, the training-scope target replacement (food_group
// survives), single-active enforcement, the confirm-free fresh-profile path, profile
// scoping, and the read-only refusal.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  adoptRoutineTemplateAction,
  createRoutineAction,
  updateRoutineAction,
  activateRoutineAction,
  deactivateRoutineAction,
  deleteRoutineAction,
} from "@/app/(app)/training/actions";
import { getRoutines, getRoutineWithDays } from "@/lib/routines";
import { getRoutineTemplate } from "@/lib/routine-templates";
import { createLogin, createProfile, actAs, seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

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

const customPayload = (name = "My Split") =>
  JSON.stringify({
    name,
    days: [
      {
        label: "Push",
        focus: ["Chest", "Shoulders"],
        slots: [{ candidates: ["Bench Press"], sets: 3, repMin: 5, repMax: 8 }],
      },
      {
        label: "Pull",
        focus: ["Back"],
        slots: [
          { candidates: ["Barbell Row"], sets: 3, repMin: 6, repMax: 10 },
        ],
      },
    ],
  });

describe("adoptRoutineTemplateAction", () => {
  it("copies a template into the profile's routine tables and revalidates", async () => {
    const { profile } = seedActor();
    const res = await adoptRoutineTemplateAction(
      fd({ template_id: "full-body-3x" })
    );
    expect(res.ok).toBe(true);
    const rid = res.ok ? res.routineId! : 0;
    const routine = getRoutineWithDays(profile.id, rid)!;
    expect(routine.source).toBe("template");
    expect(routine.active).toBe(0);
    expect(routine.days.length).toBe(
      getRoutineTemplate("full-body-3x")!.days.length
    );
    expect(revalidate).toHaveBeenCalledWith("/training");
  });

  it("rejects an unknown template", async () => {
    seedActor();
    const res = await adoptRoutineTemplateAction(fd({ template_id: "nope" }));
    expect(res).toEqual({ ok: false, error: "unknown template" });
  });
});

describe("createRoutineAction / updateRoutineAction", () => {
  it("authors a custom routine from a JSON payload", async () => {
    const { profile } = seedActor();
    const res = await createRoutineAction(fd({ routine: customPayload() }));
    expect(res.ok).toBe(true);
    const rid = res.ok ? res.routineId! : 0;
    const routine = getRoutineWithDays(profile.id, rid)!;
    expect(routine.source).toBe("custom");
    expect(routine.name).toBe("My Split");
    expect(routine.days.map((d) => d.label)).toEqual(["Push", "Pull"]);
  });

  it("rejects an invalid payload", async () => {
    seedActor();
    const res = await createRoutineAction(fd({ routine: "{not json" }));
    expect(res).toEqual({ ok: false, error: "invalid routine" });
  });

  it("edits a routine in place (rename + replace days), children not stranded", async () => {
    const { profile } = seedActor();
    const created = await createRoutineAction(fd({ routine: customPayload() }));
    const rid = created.ok ? created.routineId! : 0;
    const oldDayIds = getRoutineWithDays(profile.id, rid)!.days.map(
      (d) => d.id
    );

    const res = await updateRoutineAction(
      fd({
        routine_id: rid,
        routine: JSON.stringify({
          name: "Renamed",
          days: [
            {
              label: "Full",
              focus: ["Legs"],
              slots: [
                { candidates: ["Back Squat"], sets: 5, repMin: 5, repMax: 5 },
              ],
            },
          ],
        }),
      })
    );
    expect(res.ok).toBe(true);
    const routine = getRoutineWithDays(profile.id, rid)!;
    expect(routine.name).toBe("Renamed");
    expect(routine.days.map((d) => d.label)).toEqual(["Full"]);
    // Old day rows (and their slots) are gone, not orphaned.
    const placeholders = oldDayIds.map(() => "?").join(",");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) c FROM routine_slots WHERE routine_day_id IN (${placeholders})`
        )
        .get(...oldDayIds)
    ).toEqual({ c: 0 });
  });
});

describe("activateRoutineAction — target replacement", () => {
  it("replaces training-scope targets, food_group survives, single active", async () => {
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?,'group','Upper',2),(?,'food_group','fatty_fish',2)`
    ).run(profile.id, profile.id);

    const a = await adoptRoutineTemplateAction(
      fd({ template_id: "full-body-3x" })
    );
    const b = await adoptRoutineTemplateAction(
      fd({ template_id: "upper-lower-4x" })
    );
    const aId = a.ok ? a.routineId! : 0;
    const bId = b.ok ? b.routineId! : 0;

    await activateRoutineAction(fd({ routine_id: aId }));
    const res = await activateRoutineAction(fd({ routine_id: bId }));
    expect(res.ok).toBe(true);

    // Only b is active.
    expect(
      getRoutines(profile.id)
        .filter((r) => r.active === 1)
        .map((r) => r.id)
    ).toEqual([bId]);

    const after = targets(profile.id);
    // food_group untouched.
    expect(after.filter((t) => t.scope_kind === "food_group")).toEqual([
      { scope_kind: "food_group", scope_value: "fatty_fish", per_week: 2 },
    ]);
    // upper-lower's declared group targets present; the old 'Upper' 2 was replaced.
    const tpl = getRoutineTemplate("upper-lower-4x")!;
    const training = after.filter((t) => t.scope_kind !== "food_group");
    expect(training.length).toBe(tpl.frequencyTargets.length);
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("fresh profile activates confirm-free (no targets to replace)", async () => {
    const { profile } = seedActor();
    const a = await adoptRoutineTemplateAction(
      fd({ template_id: "bodyweight-minimal" })
    );
    const rid = a.ok ? a.routineId! : 0;
    expect(targets(profile.id)).toEqual([]);
    const res = await activateRoutineAction(fd({ routine_id: rid }));
    expect(res.ok).toBe(true);
    expect(targets(profile.id).length).toBeGreaterThan(0);
  });
});

describe("deactivate / delete actions", () => {
  it("deactivate keeps targets; delete removes the routine, keeps targets", async () => {
    const { profile } = seedActor();
    const a = await adoptRoutineTemplateAction(
      fd({ template_id: "full-body-3x" })
    );
    const rid = a.ok ? a.routineId! : 0;
    await activateRoutineAction(fd({ routine_id: rid }));
    const withTargets = targets(profile.id);
    expect(withTargets.length).toBeGreaterThan(0);

    await deactivateRoutineAction(fd({ routine_id: rid }));
    expect(getRoutines(profile.id).find((r) => r.id === rid)!.active).toBe(0);
    expect(targets(profile.id)).toEqual(withTargets);

    const del = await deleteRoutineAction(fd({ routine_id: rid }));
    expect(del.ok).toBe(true);
    expect(getRoutineWithDays(profile.id, rid)).toBeNull();
    expect(targets(profile.id)).toEqual(withTargets);
  });

  it("returns not-found for another profile's routine (scoping)", async () => {
    // Admin actor A adopts a routine; a member with a different profile can't touch it.
    const admin = createLogin({ role: "admin" });
    const pA = createProfile("A", admin.id);
    actAs(admin, pA);
    const a = await adoptRoutineTemplateAction(
      fd({ template_id: "full-body-3x" })
    );
    const rid = a.ok ? a.routineId! : 0;

    const member = createLogin({ role: "member" });
    const pB = createProfile("B", member.id);
    actAs(member, pB);
    expect(await activateRoutineAction(fd({ routine_id: rid }))).toEqual({
      ok: false,
      error: "not found",
    });
    expect(await deleteRoutineAction(fd({ routine_id: rid }))).toEqual({
      ok: false,
      error: "not found",
    });
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO", login.id);
    actAs(login, profile, "read");
    await expect(
      adoptRoutineTemplateAction(fd({ template_id: "full-body-3x" }))
    ).rejects.toThrow();
  });
});
