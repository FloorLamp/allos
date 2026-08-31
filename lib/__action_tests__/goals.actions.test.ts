// SERVER-ACTION TIER — goals write path.
//
// Covers a freeform goal create (stored shape) and an exercise goal whose weight
// target is converted to canonical kg from the acting login's lb pref, plus the
// numeric-guard rejection.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createGoal,
  setArchived,
  setStatus,
  updateGoal,
} from "@/app/(app)/training/goal-actions";
import {
  getOutcomeGoals,
  dismissFinding,
  getFindingSuppressions,
} from "@/lib/queries";
import { goalPaceSignalKey } from "@/lib/goal-pacing";
import { LB_PER_KG } from "@/lib/units";
import { setStoredAge } from "@/lib/settings";
import {
  createLogin,
  createProfile,
  actAs,
  seedActor as seedActorWithoutAge,
  fd,
} from "./harness";

function seedActor() {
  const actor = seedActorWithoutAge();
  setStoredAge(actor.profile.id, 30);
  return actor;
}

const revalidate = vi.mocked(revalidatePath);

function goalRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, title, category, status, target_value, current_value, exercise, metric, target_weight_kg FROM goals WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as any[];
}

beforeEach(() => revalidate.mockClear());

describe("createGoal", () => {
  it("refuses general goals in early childhood and strength goals in childhood", async () => {
    const login = createLogin();
    const profile = createProfile("minor-goals", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 2);

    expect(
      await createGoal(fd({ kind: "freeform", title: "Run a 5k" }))
    ).toMatchObject({ ok: false });

    setStoredAge(profile.id, 12);
    expect(
      await createGoal(
        fd({
          kind: "exercise",
          exercise: "Deadlift",
          metric: "weight",
          target_weight: 50,
        })
      )
    ).toMatchObject({ ok: false });
    expect(goalRows(profile.id)).toHaveLength(0);
  });

  it("stores a scoped freeform goal with title/category/status", async () => {
    const { login, profile } = seedActor();
    const otherProfile = createProfile("Other goals", login.id);
    await createGoal(
      fd({
        kind: "freeform",
        title: "Run a 10k",
        category: "cardio",
        target_value: 10,
      })
    );

    const rows = goalRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Run a 10k");
    expect(rows[0].category).toBe("cardio");
    expect(rows[0].status).toBe("active");
    expect(rows[0].target_value).toBe(10);
    expect(getOutcomeGoals(otherProfile.id)).toHaveLength(0);
    expect(revalidate).toHaveBeenCalledWith("/training");
  });

  it("stores a canonical exercise target and rejects a non-positive one", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lifter", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 30);

    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Deadlift",
        metric: "weight",
        target_weight: 315,
      })
    );
    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Squat",
        metric: "weight",
        target_weight: 0,
      })
    );

    const rows = goalRows(profile.id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.exercise).toBe("Deadlift");
    expect(row.metric).toBe("weight");
    expect(row.category).toBeNull();
    expect(row.target_weight_kg).toBeCloseTo(315 / LB_PER_KG, 6);
    expect(getOutcomeGoals(profile.id)[0]).toMatchObject({
      kind: "exercise",
      categoryLabel: null,
    });
  });
});

describe("getOutcomeGoals vocabulary (#2480)", () => {
  it("derives kind structurally and reserves categoryLabel for freeform text", () => {
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO goals
         (profile_id, title, category, body_metric, target_value, status)
       VALUES (?, 'Legacy body goal', 'body', 'weight', 80, 'active'),
              (?, 'Sleep routine', 'Wellbeing', NULL, 8, 'active')`
    ).run(profile.id, profile.id);

    const byTitle = new Map(
      getOutcomeGoals(profile.id).map((goal) => [goal.title, goal])
    );
    expect(byTitle.get("Legacy body goal")).toMatchObject({
      kind: "body",
      categoryLabel: null,
    });
    expect(byTitle.get("Sleep routine")).toMatchObject({
      kind: "freeform",
      categoryLabel: "Wellbeing",
    });
  });
});

describe("updateGoal weight round-trip (issue #194)", () => {
  it("preserves an unchanged canonical weight and converts a genuine edit", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("cutter", login.id);
    actAs(login, profile);

    // A body weight goal with a CLEAN canonical kg value (as if entered in kg).
    const storedKg = 142.9;
    const id = Number(
      db
        .prepare(
          "INSERT INTO goals (title, category, target_value, body_metric, profile_id, status) VALUES (?, 'body', ?, 'weight', ?, 'active')"
        )
        .run("Cut", storedKg, profile.id).lastInsertRowid
    );

    // What the edit form pre-fills for an lb user: round(kgTo(stored, lb), 1).
    const displayLb = Math.round(storedKg * LB_PER_KG * 10) / 10;
    await updateGoal(
      fd({ id, kind: "body", body_metric: "weight", body_target: displayLb })
    );

    // The untouched round-trip is a true no-op: the canonical kg is byte-identical,
    // not nudged by the display-rounding quantum.
    const unchangedRow = goalRows(profile.id).find((r) => r.id === id);
    expect(unchangedRow.target_value).toBe(storedKg);

    // User actually lowers the target to 300 lb.
    await updateGoal(
      fd({ id, kind: "body", body_metric: "weight", body_target: 300 })
    );
    const changedRow = goalRows(profile.id).find((r) => r.id === id);
    expect(changedRow.target_value).toBeCloseTo(300 / LB_PER_KG, 6);
  });
});

describe("updateGoal re-target clears the off-pace dismissal (#436)", () => {
  it("drops the goal-pace suppression on a target change; keeps it on a no-op", async () => {
    const { profile } = seedActor();
    const id = Number(
      db
        .prepare(
          "INSERT INTO goals (title, category, target_value, target_date, body_metric, profile_id, status) VALUES ('Cut', 'body', 84, '2026-09-01', 'weight', ?, 'active')"
        )
        .run(profile.id).lastInsertRowid
    );
    const key = goalPaceSignalKey(id);
    dismissFinding(profile.id, key);
    expect(getFindingSuppressions(profile.id).has(key)).toBe(true);

    // A no-op edit (same target value + date) must NOT clear the dismissal.
    await updateGoal(
      fd({
        id,
        kind: "body",
        body_metric: "weight",
        body_target: 84,
        target_date: "2026-09-01",
      })
    );
    expect(getFindingSuppressions(profile.id).has(key)).toBe(true);

    // Re-targeting (new deadline) is a new pacing question → the stale dismissal is
    // dropped so the finding re-assesses against the new date.
    await updateGoal(
      fd({
        id,
        kind: "body",
        body_metric: "weight",
        body_target: 84,
        target_date: "2026-12-01",
      })
    );
    expect(getFindingSuppressions(profile.id).has(key)).toBe(false);
  });
});

describe("setStatus", () => {
  // #2394: `status` says WHETHER, `achieved_at` says WHEN — and without the second
  // one the recap had nothing to window on but the deadline. This is the only writer.
  it("stamps the achievement instant, keeps it on a re-state, and clears it on undo", async () => {
    const { profile } = seedActor();
    await createGoal(fd({ kind: "freeform", title: "Hold a 2 minute plank" }));
    const id = goalRows(profile.id)[0].id;
    const achievedAt = () =>
      (
        db.prepare("SELECT achieved_at FROM goals WHERE id = ?").get(id) as {
          achieved_at: string | null;
        }
      ).achieved_at;

    expect(achievedAt()).toBeNull();

    expect(await setStatus(fd({ id, status: "achieved" }))).toEqual({
      ok: true,
    });
    expect(goalRows(profile.id)[0].status).toBe("achieved");
    const first = achievedAt();
    // The canonical UTC+Z convention (lib/date.ts utcInstant), not SQLite's bare shape:
    // the recap compares this column lexically against canonical bounds.
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // Re-stating the current status stays idempotent success AND keeps the original
    // instant — a second flip must not re-date the goal into a later recap.
    expect((await setStatus(fd({ id, status: "achieved" }))).ok).toBe(true);
    expect(achievedAt()).toBe(first);

    // Un-achieving clears it: the goal has not been achieved, and reaching it again is
    // a new event that earns a new instant.
    await setStatus(fd({ id, status: "active" }));
    expect(achievedAt()).toBeNull();
    await setStatus(fd({ id, status: "achieved" }));
    expect(achievedAt()).not.toBeNull();
  });

  // Changes-checked (#2140): the UPDATE's WHERE (id + profile) is the CAS
  // expectation, so a forged id — or another profile's — refuses instead of the
  // menu toasting "Goal achieved" over a write that matched nothing.
  it("refuses a forged id and another profile's goal with a typed error", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("StatusB", login.id);
    actAs(login, profileB);
    await createGoal(fd({ kind: "freeform", title: "B's goal" }));
    const bId = goalRows(profileB.id)[0].id;

    actAs(login, profileA);
    expect((await setStatus(fd({ id: 999999, status: "achieved" }))).ok).toBe(
      false
    );
    expect((await setStatus(fd({ id: bId, status: "achieved" }))).ok).toBe(
      false
    );
    expect(goalRows(profileB.id)[0].status).toBe("active");
  });
});

describe("setArchived", () => {
  it("archives for the acting profile; refuses a forged id (#2140)", async () => {
    const { profile } = seedActor();
    await createGoal(fd({ kind: "freeform", title: "Archive me" }));
    const id = goalRows(profile.id)[0].id;

    expect(await setArchived(fd({ id, archived: "1" }))).toEqual({ ok: true });
    expect(
      (
        db.prepare("SELECT archived FROM goals WHERE id = ?").get(id) as {
          archived: number;
        }
      ).archived
    ).toBe(1);

    expect((await setArchived(fd({ id: 999999, archived: "1" }))).ok).toBe(
      false
    );
  });
});

// ── Load context on an exercise goal (#1610, migration 120) ──────────────────
// Two registry machines both serialize as the same exact logged exercise name, so
// `goals.exercise` alone can't say which stack an 80 kg target belongs to. The
// action persists the choice, and refuses one that isn't this profile's to make.
describe("createGoal / updateGoal load context", () => {
  function addEquipment(profileId: number, name: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category)
           VALUES (?, ?, 'Machine')`
        )
        .run(profileId, name).lastInsertRowid
    );
  }

  const storedContext = (profileId: number): (number | null)[] =>
    (
      db
        .prepare(
          "SELECT equipment_id FROM goals WHERE profile_id = ? ORDER BY id"
        )
        .all(profileId) as { equipment_id: number | null }[]
    ).map((r) => r.equipment_id);

  it("stores valid load context, normalizes broad scopes, and widens on edit", async () => {
    const { profile } = seedActor();
    const hotel = addEquipment(profile.id, "Hotel chest press");
    const other = createProfile("neighbour");
    const foreign = addEquipment(other.id, "Someone else's machine");

    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Machine Chest Press",
        metric: "weight",
        target_weight: 80,
        equipment_id: hotel,
      })
    );
    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Machine Chest Press",
        metric: "weight",
        target_weight: 80,
      })
    );
    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Machine Chest Press",
        metric: "weight",
        target_weight: 80,
        equipment_id: "any",
      })
    );
    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Machine Chest Press",
        metric: "weight",
        target_weight: 80,
        equipment_id: foreign,
      })
    );

    // NULL is the movement-wide default for an omitted, explicit-any, or foreign
    // context; only the profile's registered machine narrows the goal.
    expect(storedContext(profile.id)).toEqual([hotel, null, null, null]);

    const id = goalRows(profile.id)[0].id;
    await updateGoal(
      fd({
        id,
        kind: "exercise",
        exercise: "Machine Chest Press",
        metric: "weight",
        target_weight: 80,
        equipment_id: "any",
      })
    );
    expect(storedContext(profile.id)).toEqual([null, null, null, null]);
  });
});
