// SERVER-ACTION TIER — saveActivity stores the estimated-calories field (issue
// #151) for MANUAL activities and never lets it shadow an imported (device) row.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function estCalories(activityId: number): number | null {
  return (
    db
      .prepare("SELECT est_calories FROM activities WHERE id = ?")
      .get(activityId) as { est_calories: number | null }
  ).est_calories;
}

const cardioComponents = JSON.stringify([
  { name: "Running", type: "cardio", distance: null, duration_min: 60 },
]);

describe("saveActivity estimated calories (issue #151)", () => {
  it("stores the est_calories field on a manual create", async () => {
    const login = createLogin();
    const profile = createProfile("runner", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Morning run",
        date: "2026-07-01",
        components: cardioComponents,
        sets: "[]",
        est_calories: "784",
      })
    );
    if (!res.ok) throw new Error(`expected save to succeed, got ${res.reason}`);
    const id = res.id;
    expect(estCalories(id)).toBe(784);
  });

  it("updates est_calories on a manual edit, and clears it when the field is blank", async () => {
    const login = createLogin();
    const profile = createProfile("runner2", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Run",
        date: "2026-07-02",
        components: cardioComponents,
        sets: "[]",
        est_calories: "500",
      })
    );
    if (!res.ok) throw new Error(`expected save to succeed, got ${res.reason}`);
    const id = res.id;
    expect(estCalories(id)).toBe(500);

    // Re-save with an override.
    await saveActivity(
      fd({
        id,
        type: "cardio",
        title: "Run",
        date: "2026-07-02",
        components: cardioComponents,
        sets: "[]",
        est_calories: "650",
      })
    );
    expect(estCalories(id)).toBe(650);

    // Re-save with the field cleared → the stored estimate is cleared.
    await saveActivity(
      fd({
        id,
        type: "cardio",
        title: "Run",
        date: "2026-07-02",
        components: cardioComponents,
        sets: "[]",
      })
    );
    expect(estCalories(id)).toBeNull();
  });

  it("never writes est_calories onto an imported (device) activity", async () => {
    const login = createLogin();
    const profile = createProfile("importer", login.id);
    actAs(login, profile);

    // An imported row (source + external_id set) with no estimate.
    const id = Number(
      db
        .prepare(
          `INSERT INTO activities (date, type, title, source, external_id, profile_id)
           VALUES ('2026-07-03', 'cardio', 'Imported ride', 'strava', 'strava:1', ?)`
        )
        .run(profile.id).lastInsertRowid
    );

    // Editing it through the form (which would submit est_calories) must NOT set it —
    // the device energy stays the source of truth, unshadowed by an estimate.
    await saveActivity(
      fd({
        id,
        type: "cardio",
        title: "Imported ride",
        date: "2026-07-03",
        components: JSON.stringify([
          { name: "Cycling", type: "cardio", distance: null, duration_min: 60 },
        ]),
        sets: "[]",
        est_calories: "900",
      })
    );
    expect(estCalories(id)).toBeNull();
  });
});
