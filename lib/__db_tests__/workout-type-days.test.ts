// DB INTEGRATION TIER — the sessions-by-type day-history gather groups one
// pass over `activities` by (date, type), profile-scoped and window-bounded.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getWorkoutTypeDays } from "@/lib/queries/training/heatmap";

function insertActivity(
  profileId: number,
  date: string,
  type: string,
  durationMin: number | null
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, date, type, `${type} on ${date}`, durationMin);
}

describe("getWorkoutTypeDays", () => {
  it("groups sessions and minutes by day and type inside the window", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Type Days")
        .lastInsertRowid
    );
    insertActivity(profileId, "2026-06-01", "strength", 60);
    insertActivity(profileId, "2026-06-01", "strength", null); // null duration counts as 0 min
    insertActivity(profileId, "2026-06-01", "cardio", 30);
    insertActivity(profileId, "2026-06-03", "sport", 90);
    insertActivity(profileId, "2026-05-31", "cardio", 45); // before window
    insertActivity(profileId, "2026-06-04", "cardio", 45); // after window

    expect(getWorkoutTypeDays(profileId, "2026-06-01", "2026-06-03")).toEqual([
      { date: "2026-06-01", type: "cardio", count: 1, minutes: 30 },
      { date: "2026-06-01", type: "strength", count: 2, minutes: 60 },
      { date: "2026-06-03", type: "sport", count: 1, minutes: 90 },
    ]);
  });

  it("is profile-scoped", () => {
    const a = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Type Days A")
        .lastInsertRowid
    );
    const b = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Type Days B")
        .lastInsertRowid
    );
    insertActivity(a, "2026-06-02", "cardio", 20);
    insertActivity(b, "2026-06-02", "cardio", 40);

    expect(getWorkoutTypeDays(a, "2026-06-01", "2026-06-30")).toEqual([
      { date: "2026-06-02", type: "cardio", count: 1, minutes: 20 },
    ]);
  });
});
