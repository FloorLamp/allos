// DB INTEGRATION TIER — the multi-view Journal per-member gather (issue #1330).
//
// buildMultiViewJournalGroups loop-composes the per-profile buildJournalFeedPage over
// the whole view-set and merges the day-grouped cards into ONE feed, stamping each
// card with its subject profile (activity.subjectProfileId). This pins the properties
// the merged card feed relies on:
//   • BOTH members' activities appear, each card carrying its OWN subjectProfileId.
//   • Merged by DATE, newest day first; a shared day interleaves both members' cards
//     in VIEW order (never split into two day sections).
//   • Cross-profile scoping: view order [owner, shared] never leaks one member's row
//     under the other's subject stamp.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { buildMultiViewJournalGroups } from "@/lib/journal-feed";
import type { UnitPrefs } from "@/lib/settings";
import { db } from "@/lib/db";

const UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "F",
};

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addActivity(profileId: number, date: string, title: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'cardio', ?, 30)`
      )
      .run(profileId, date, title).lastInsertRowid
  );
}

let owner: number;
let shared: number;

beforeAll(() => {
  owner = newProfile("mv-journal-owner");
  shared = newProfile("mv-journal-shared");

  // Owner: two days, one card each.
  addActivity(owner, "2026-06-10", "owner-older");
  addActivity(owner, "2026-06-15", "owner-shared-day"); // same day as a shared card
  // Shared: a distinct newer day + a card on the shared day.
  addActivity(shared, "2026-06-20", "shared-newest");
  addActivity(shared, "2026-06-15", "shared-shared-day");
});

function titlesByDate(pid: number) {
  return buildMultiViewJournalGroups([owner, shared], pid, UNITS);
}

describe("buildMultiViewJournalGroups (#1330)", () => {
  it("merges both members' cards by date, newest first, each stamped by subject", () => {
    const groups = titlesByDate(owner);
    expect(groups.map((g) => g.date)).toEqual([
      "2026-06-20",
      "2026-06-15",
      "2026-06-10",
    ]);
    // Newest day is the shared member's alone.
    expect(groups[0].cards.map((c) => c.activity.title)).toEqual([
      "shared-newest",
    ]);
    expect(groups[0].cards[0].activity.subjectProfileId).toBe(shared);
    // Oldest day is the owner's alone.
    expect(groups[2].cards[0].activity.subjectProfileId).toBe(owner);
  });

  it("interleaves a shared day in VIEW order (owner then shared), one day section", () => {
    const groups = titlesByDate(owner);
    const sharedDay = groups.find((g) => g.date === "2026-06-15")!;
    expect(sharedDay.cards).toHaveLength(2);
    // View order [owner, shared]: owner's card first, then the shared member's.
    expect(sharedDay.cards.map((c) => c.activity.title)).toEqual([
      "owner-shared-day",
      "shared-shared-day",
    ]);
    expect(sharedDay.cards.map((c) => c.activity.subjectProfileId)).toEqual([
      owner,
      shared,
    ]);
  });

  it("never leaks a member's row under the other's subject stamp", () => {
    const groups = titlesByDate(owner);
    for (const g of groups) {
      for (const c of g.cards) {
        const belongsToOwner = c.activity.title.startsWith("owner-");
        expect(c.activity.subjectProfileId).toBe(
          belongsToOwner ? owner : shared
        );
      }
    }
  });
});
