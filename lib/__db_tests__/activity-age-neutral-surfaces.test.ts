// DB INTEGRATION TIER — a minor's own activity data is visible everywhere (#3067).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getDataset } from "@/lib/export";
import { searchAll } from "@/lib/queries";
import { setStoredAge } from "@/lib/settings";
import { getTimelineDates, getTimelineEvents } from "@/lib/timeline";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("activity surfaces are age-neutral (#3067)", () => {
  it("shows a 15-year-old's strength session in timeline, search, and export", () => {
    const profileId = newProfile("fifteen-year-old activity owner");
    setStoredAge(profileId, 15);
    const date = "2026-04-11";
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'AGE15 Bench Press', 45)`
    ).run(profileId, date);

    expect(
      getTimelineEvents(profileId).some(
        (event) => event.title === "AGE15 Bench Press"
      )
    ).toBe(true);
    expect(getTimelineDates(profileId)).toContain(date);
    expect(
      searchAll(profileId, "AGE15 Bench")
        .find((group) => group.domain === "activity")
        ?.hits.some((hit) => hit.title === "AGE15 Bench Press")
    ).toBe(true);
    expect(
      getDataset("activities")!
        .rows(profileId)
        .some((row) => row.title === "AGE15 Bench Press")
    ).toBe(true);
  });
});
