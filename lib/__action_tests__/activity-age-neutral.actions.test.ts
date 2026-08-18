// SERVER-ACTION TIER — activity logging is age-neutral (#3067).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/training/activity-actions";
import { setStoredAge } from "@/lib/settings";
import { actAs, createLogin, createProfile, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

function activityCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

describe("saveActivity age neutrality (#3067)", () => {
  it.each([
    ["minor", 15],
    ["adult", 30],
  ])("lets a %s profile log strength", async (_label, age) => {
    const login = createLogin();
    const profile = createProfile(`strength-${age}`, login.id);
    actAs(login, profile);
    setStoredAge(profile.id, age);

    const result = await saveActivity(
      fd({
        type: "strength",
        title: "Bench press",
        date: "2026-07-05",
        components: JSON.stringify([
          {
            name: "Bench press",
            type: "strength",
            distance: null,
            duration_min: null,
          },
        ]),
        sets: JSON.stringify([
          { exercise: "Bench press", weight: 60, reps: 5 },
        ]),
      })
    );

    expect(result.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
    expect(revalidate).toHaveBeenCalled();
  });

  it("lets an unknown-age profile log strength", async () => {
    const login = createLogin();
    const profile = createProfile("strength-unknown", login.id);
    actAs(login, profile);

    const result = await saveActivity(
      fd({
        type: "strength",
        title: "Squat",
        date: "2026-07-06",
        components: "[]",
        sets: JSON.stringify([{ exercise: "Squat", weight: 80, reps: 5 }]),
      })
    );

    expect(result.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });
});
