// SERVER-ACTION TIER — goals write path.
//
// Covers a freeform goal create (stored shape) and an exercise goal whose weight
// target is converted to canonical kg from the acting login's lb pref, plus the
// numeric-guard rejection.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { createGoal, setStatus } from "@/app/(app)/goals/actions";
import { getGoals } from "@/lib/queries";
import { LB_PER_KG } from "@/lib/units";
import { createLogin, createProfile, actAs, seedActor, fd } from "./harness";

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
  it("stores a freeform goal with title/category/status", async () => {
    const { profile } = seedActor();
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
    expect(revalidate).toHaveBeenCalledWith("/training");
  });

  it("converts an exercise goal's weight target to kg from a lb login", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("lifter", login.id);
    actAs(login, profile);

    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Deadlift",
        metric: "weight",
        target_weight: 315,
      })
    );

    const row = goalRows(profile.id)[0];
    expect(row.exercise).toBe("Deadlift");
    expect(row.metric).toBe("weight");
    expect(row.target_weight_kg).toBeCloseTo(315 / LB_PER_KG, 6);
  });

  it("rejects an exercise goal with a non-positive primary target", async () => {
    const { profile } = seedActor();
    await createGoal(
      fd({
        kind: "exercise",
        exercise: "Squat",
        metric: "weight",
        target_weight: 0,
      })
    );
    expect(goalRows(profile.id)).toHaveLength(0);
  });
});

describe("setStatus", () => {
  it("marks a goal achieved for the acting profile", async () => {
    const { profile } = seedActor();
    await createGoal(fd({ kind: "freeform", title: "Do 10 pullups" }));
    const id = goalRows(profile.id)[0].id;

    await setStatus(fd({ id, status: "achieved" }));
    expect(goalRows(profile.id)[0].status).toBe("achieved");
  });
});

describe("scoping", () => {
  it("createGoal writes only to the acting profile", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("GoalB", login.id);

    actAs(login, profileA);
    await createGoal(fd({ kind: "freeform", title: "A-only goal" }));

    expect(getGoals(profileB.id)).toHaveLength(0);
    expect(getGoals(profileA.id).map((g) => g.title)).toContain("A-only goal");
  });
});
