// SERVER-ACTION TIER — session-level duration persists independently of clock
// times and remains authoritative over component sums for mixed activities.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

const mixedComponents = JSON.stringify([
  {
    name: "Barbell Bench Press",
    type: "strength",
    distance: null,
    duration_min: null,
  },
  {
    name: "Running",
    type: "cardio",
    distance: 3,
    duration_min: 20,
  },
]);

function duration(id: number): number | null {
  return (
    db.prepare("SELECT duration_min FROM activities WHERE id = ?").get(id) as {
      duration_min: number | null;
    }
  ).duration_min;
}

describe("saveActivity session duration", () => {
  it("stores a top-level mixed-session duration without clock times", async () => {
    const login = createLogin();
    const profile = createProfile("mixed-duration", login.id);
    actAs(login, profile);

    const result = await saveActivity(
      fd({
        type: "strength",
        title: "Lifting and running",
        date: "2026-07-01",
        components: mixedComponents,
        sets: "[]",
        duration_min: "75",
      })
    );
    if (!result.ok) throw new Error(`save failed: ${result.reason}`);
    expect(duration(result.id)).toBe(75);
  });

  it("prefers a complete clock range and rejects a total shorter than its legs", async () => {
    const login = createLogin();
    const profile = createProfile("clock-duration", login.id);
    actAs(login, profile);

    const clock = await saveActivity(
      fd({
        type: "strength",
        title: "Clocked mixed session",
        date: "2026-07-02",
        components: mixedComponents,
        sets: "[]",
        duration_min: "75",
        start_time: "09:00",
        end_time: "10:00",
      })
    );
    if (!clock.ok) throw new Error(`save failed: ${clock.reason}`);
    expect(duration(clock.id)).toBe(60);

    const invalid = await saveActivity(
      fd({
        type: "strength",
        title: "Too short",
        date: "2026-07-03",
        components: mixedComponents,
        sets: "[]",
        duration_min: "10",
      })
    );
    expect(invalid).toEqual({ ok: false, reason: "invalid" });
  });
});
