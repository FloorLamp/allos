// DB INTEGRATION TIER — the server-side Journal paging query (issue #451).
//
// getJournalPage windows the feed by WHOLE DAYS via keyset ("seek") pagination on
// `date`, so the Training → Log surface no longer ships the profile's entire activity
// history to the client on every visit. This pins the three properties the paging UI
// relies on:
//   • BOUNDED — a page returns at most `dayLimit` distinct days (never the full set).
//   • STABLE ORDERING — activities come back date DESC, id DESC, deterministically.
//   • LOSSLESS — walking pages with the returned cursor visits every activity exactly
//     once, in the SAME order as the unbounded getActivities(profileId).
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { getJournalPage, getActivities } from "@/lib/queries";
import type { Activity } from "@/lib/types";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";

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

const TODAY = "2026-07-12";
let profileId: number;
let otherProfile: number;

beforeAll(() => {
  profileId = newProfile("journal-page");
  otherProfile = newProfile("journal-page-other");

  // 30 distinct days, each with a single activity — plus two extra activities on the
  // NEWEST day so day-paging (not row-paging) is exercised: one page boundary must
  // never split a day's cards.
  for (let d = 0; d < 30; d++) {
    addActivity(profileId, shiftDateStr(TODAY, -d), `day ${d}`);
  }
  addActivity(profileId, TODAY, "today extra 1");
  addActivity(profileId, TODAY, "today extra 2");

  // Another profile's history must never leak into the page.
  addActivity(otherProfile, TODAY, "not mine");
});

describe("getJournalPage — bounded, day-keyed windows (#451)", () => {
  it("returns at most dayLimit DISTINCT days and every activity on them", () => {
    const page = getJournalPage(profileId, null, 14);
    expect(page.days).toHaveLength(14);
    expect(new Set(page.days).size).toBe(14); // distinct
    // The newest day carries 3 activities (1 + 2 extras); the rest 1 each → 16 rows.
    expect(page.activities).toHaveLength(14 + 2);
    // Every returned activity's date is one of the page's days (no stragglers).
    const dayset = new Set(page.days);
    expect(page.activities.every((a) => dayset.has(a.date))).toBe(true);
    // Profile-scoped: the other profile's row never appears.
    expect(page.activities.every((a) => a.title !== "not mine")).toBe(true);
  });

  it("orders activities date DESC, id DESC (stable within a day)", () => {
    const page = getJournalPage(profileId, null, 14);
    const rows = page.activities;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const cur = rows[i];
      const ordered =
        prev.date > cur.date || (prev.date === cur.date && prev.id > cur.id);
      expect(ordered).toBe(true);
    }
    // The newest day's three cards lead, newest id first.
    expect(rows[0].date).toBe(TODAY);
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
  });

  it("nextBefore is the oldest loaded date while days remain, else null", () => {
    const first = getJournalPage(profileId, null, 14);
    expect(first.nextBefore).toBe(first.days[first.days.length - 1]);

    // A dayLimit larger than the whole history exhausts it → no cursor.
    const all = getJournalPage(profileId, null, 100);
    expect(all.days).toHaveLength(30);
    expect(all.nextBefore).toBeNull();
  });

  it("walking pages with the cursor equals the full unbounded feed, once each", () => {
    const full = getActivities(profileId); // date DESC, id DESC — the source of truth
    const walked: Activity[] = [];
    let before: string | null = null;
    let guard = 0;
    for (;;) {
      const page = getJournalPage(profileId, before, 7);
      walked.push(...page.activities);
      if (page.nextBefore == null) break;
      before = page.nextBefore;
      if (++guard > 100) throw new Error("paging did not terminate");
    }
    // Same rows, same order — no gap, no overlap, no reordering across boundaries.
    expect(walked.map((a) => a.id)).toEqual(full.map((a) => a.id));
    // And exactly once each.
    expect(new Set(walked.map((a) => a.id)).size).toBe(walked.length);
  });

  it("returns an empty page (no cursor) for a profile with no activities", () => {
    const empty = newProfile("journal-page-empty");
    const page = getJournalPage(empty, null, 14);
    expect(page).toEqual({ activities: [], days: [], nextBefore: null });
  });
});
