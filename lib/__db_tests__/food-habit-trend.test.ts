// DB INTEGRATION TIER (issue #954): the food-habit N-week consistency trend.
//
// Seeds a food_group frequency target created mid-window plus multi-week food_log
// servings (met / short / empty / pre-target weeks) and asserts getFoodHabitTrends
// classifies each trailing week correctly, with weeks before the target existed
// rendered not-applicable (honest cold start), not misses. The #221 pin: the trend's
// current-week cell count equals getFrequencyTargetProgress's this-week count for the
// SAME fixture — one weekly rollup, the two surfaces can never disagree.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getFoodHabitTrends, getFrequencyTargetProgress } from "@/lib/queries";
import { getWeekMode, getWeekStart } from "@/lib/settings";
import { trailingWeeks } from "@/lib/week-window";

function makeProfile(name: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return profileId;
}

function logServings(
  profileId: number,
  group: string,
  date: string,
  servings: number
) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(profileId, date, group, servings);
}

describe("getFoodHabitTrends (#954)", () => {
  it("classifies met/short/empty/pre-target across the trailing weeks", () => {
    const profileId = makeProfile("habit-trend");
    const weeks = trailingWeeks(
      today(profileId),
      getWeekMode(profileId),
      getWeekStart(profileId),
      8
    );
    // weeks: index 0 oldest … 7 current (in-progress).
    // Seed servings into specific week windows (place on each week's start day).
    logServings(profileId, "fatty_fish", weeks[4].start, 0); // empty (no-op, but explicit)
    logServings(profileId, "fatty_fish", weeks[5].start, 1); // short
    logServings(profileId, "fatty_fish", weeks[6].start, 2); // met
    logServings(profileId, "fatty_fish", today(profileId), 1); // current (in-progress)

    // Target created at the start of week 4, so weeks 0–3 are entirely before it → na.
    const created = `${weeks[4].start}T00:00:00Z`;
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, created_at)
           VALUES (?, 'food_group', 'fatty_fish', 2, ?)`
        )
        .run(profileId, created).lastInsertRowid
    );

    const cells = getFoodHabitTrends(profileId).get(targetId)!;
    expect(cells).toHaveLength(8);
    expect(cells.map((c) => c.verdict)).toEqual([
      "na", // 0
      "na", // 1
      "na", // 2
      "na", // 3
      "empty", // 4 (applicable, zero)
      "short", // 5
      "met", // 6
      "current", // 7 (in-progress, 1 of 2)
    ]);
    // Cold-start honesty: only the applicable weeks carry a real verdict.
    expect(cells.filter((c) => c.verdict !== "na")).toHaveLength(4);
  });

  it("the current-week cell count equals the this-week progress (#221 pin)", () => {
    const profileId = makeProfile("habit-trend-pin");
    logServings(profileId, "leafy_greens", today(profileId), 3);
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week, created_at)
           VALUES (?, 'food_group', 'leafy_greens', 5, '2026-01-01T00:00:00Z')`
        )
        .run(profileId).lastInsertRowid
    );

    const cells = getFoodHabitTrends(profileId).get(targetId)!;
    const current = cells[cells.length - 1];
    const progress = getFrequencyTargetProgress(profileId).find(
      (p) => p.target.id === targetId
    )!;
    // Same weekly rollup: the trend's current cell and the this-week progress agree.
    expect(current.count).toBe(progress.count);
    expect(current.count).toBe(3);
  });

  it("returns an empty map when the profile tracks no food habits", () => {
    const profileId = makeProfile("habit-trend-none");
    expect(getFoodHabitTrends(profileId).size).toBe(0);
  });
});
