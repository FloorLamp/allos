// SERVER-ACTION TIER — ordinary activity logging/history is age-neutral (#3067),
// while new strength-specific content starts in adolescence.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  saveActivity,
  startWorkout,
} from "@/app/(app)/training/activity-actions";
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

describe("saveActivity life-stage strength gate (#3067)", () => {
  it.each([
    ["adolescent", 13],
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

  it.each([
    ["child", 4],
    ["unknown age", null],
  ])("refuses new strength content for a %s profile", async (_label, age) => {
    const login = createLogin();
    const profile = createProfile(`strength-blocked-${age}`, login.id);
    actAs(login, profile);
    if (age != null) setStoredAge(profile.id, age);

    const result = await saveActivity(
      fd({
        type: "strength",
        title: "Squat",
        date: "2026-07-06",
        components: "[]",
        sets: JSON.stringify([{ exercise: "Squat", weight: 80, reps: 5 }]),
      })
    );

    expect(result).toEqual({ ok: false, reason: "strength-unavailable" });
    expect(activityCount(profile.id)).toBe(0);
  });

  it("keeps ordinary movement logging available to a child", async () => {
    const login = createLogin();
    const profile = createProfile("child-walk", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 4);

    const result = await saveActivity(
      fd({
        type: "cardio",
        title: "Walk to the park",
        date: "2026-07-06",
        components: JSON.stringify([
          {
            name: "Walking",
            type: "cardio",
            distance: 1,
            duration_min: 20,
          },
        ]),
        sets: "[]",
      })
    );

    expect(result.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });

  it("does not bypass the gate by relabeling a catalog lift", async () => {
    const login = createLogin();
    const profile = createProfile("child-relabeled-lift", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 4);

    const result = await saveActivity(
      fd({
        type: "sport",
        title: "Back Squat",
        date: "2026-07-06",
        components: JSON.stringify([
          {
            name: "Back Squat",
            type: "sport",
            distance: null,
            duration_min: 10,
          },
        ]),
        sets: "[]",
      })
    );

    expect(result).toEqual({ ok: false, reason: "strength-unavailable" });
    expect(activityCount(profile.id)).toBe(0);
  });

  it("allows a child profile to correct an existing strength record", async () => {
    const login = createLogin();
    const profile = createProfile("child-history", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 4);
    const inserted = db
      .prepare(
        "INSERT INTO activities (profile_id, date, type, title) VALUES (?, ?, 'strength', ?)"
      )
      .run(profile.id, "2026-07-01", "Imported strength session");
    const id = Number(inserted.lastInsertRowid);

    const result = await saveActivity(
      fd({
        id,
        type: "strength",
        title: "Corrected imported session",
        date: "2026-07-01",
        components: "[]",
        sets: "[]",
      })
    );

    expect(result).toEqual({ ok: true, id });
    expect(
      db.prepare("SELECT title FROM activities WHERE id = ?").get(id)
    ).toEqual({ title: "Corrected imported session" });
  });
});

describe("startWorkout life-stage gate", () => {
  it("refuses a new live strength session for a child", async () => {
    const login = createLogin();
    const profile = createProfile("child-live", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 4);

    expect(await startWorkout(fd({ type: "strength", title: "" }))).toEqual({
      ok: false,
    });
    expect(activityCount(profile.id)).toBe(0);
  });

  it("allows a new live strength session from adolescence", async () => {
    const login = createLogin();
    const profile = createProfile("teen-live", login.id);
    actAs(login, profile);
    setStoredAge(profile.id, 13);

    const result = await startWorkout(fd({ type: "strength", title: "" }));
    expect(result.ok).toBe(true);
    expect(activityCount(profile.id)).toBe(1);
  });
});
