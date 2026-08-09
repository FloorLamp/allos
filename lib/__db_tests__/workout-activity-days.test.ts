// DB INTEGRATION TIER — the workout day-history gather groups sessions by day
// and NAMED activity (activityHistoryKey over the normalized title), so a PPL
// routine's time-of-day title variants land on one row.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getWorkoutActivityDays } from "@/lib/queries/training/heatmap";

function insertActivity(
  profileId: number,
  date: string,
  title: string,
  durationMin: number | null
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'strength', ?, ?)`
  ).run(profileId, date, title, durationMin);
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("getWorkoutActivityDays", () => {
  it("merges time-of-day title variants onto one activity key across days", () => {
    const profileId = newProfile("Activity Days");
    insertActivity(profileId, "2026-06-01", "Push day", 60);
    insertActivity(profileId, "2026-06-01", "Afternoon Push Day", null);
    insertActivity(profileId, "2026-06-03", "Morning Push Day", 45);
    insertActivity(profileId, "2026-06-03", "Pull day", 50);

    const rows = getWorkoutActivityDays(profileId, "2026-06-01", "2026-06-30");
    const push = rows.filter((r) => r.key === "push day");
    expect(push).toHaveLength(2);
    expect(push.find((r) => r.date === "2026-06-01")).toMatchObject({
      count: 2,
      minutes: 60, // the null-duration session adds 0
    });
    expect(push.find((r) => r.date === "2026-06-03")).toMatchObject({
      count: 1,
      minutes: 45,
    });
    // The label is the first-seen normalized form, shared across the window.
    expect(new Set(push.map((r) => r.label))).toEqual(new Set(["Push day"]));
    expect(rows.find((r) => r.key === "pull day")).toMatchObject({
      date: "2026-06-03",
      count: 1,
    });
  });

  it("strips the duration infix and Session suffix from imported titles", () => {
    const profileId = newProfile("Activity Days Import");
    insertActivity(
      profileId,
      "2026-06-02",
      "Afternoon 59 Min Stationary Bike Session",
      59
    );
    const rows = getWorkoutActivityDays(profileId, "2026-06-01", "2026-06-30");
    expect(rows).toEqual([
      {
        date: "2026-06-02",
        key: "stationary bike",
        label: "Stationary Bike",
        count: 1,
        minutes: 59,
      },
    ]);
  });

  it("is window-bounded and profile-scoped", () => {
    const a = newProfile("Activity Days A");
    const b = newProfile("Activity Days B");
    insertActivity(a, "2026-05-31", "Legs day", 40); // before window
    insertActivity(a, "2026-06-02", "Legs day", 40);
    insertActivity(a, "2026-06-04", "Legs day", 40); // after window
    insertActivity(b, "2026-06-02", "Legs day", 99);

    expect(getWorkoutActivityDays(a, "2026-06-01", "2026-06-03")).toEqual([
      {
        date: "2026-06-02",
        key: "legs day",
        label: "Legs day",
        count: 1,
        minutes: 40,
      },
    ]);
  });
});
