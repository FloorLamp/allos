// DB INTEGRATION TIER — the multi-view Timeline cross-profile gather (issue #1329).
//
// getMultiProfileTimeline loops the EXISTING per-profile getTimelinePage over the
// view-set, each member bucketed in that member's OWN timezone. This tier proves the
// three things the pure merge test structurally can't see (it takes pre-gathered
// arrays):
//   (a) each member's events are tagged with its profileId and a NOT-in-view profile
//       is excluded;
//   (b) each member's per-table cap applies PER MEMBER (a chatty member can't evict a
//       quiet member's rows — #304), and hasMore reflects ANY member overflowing;
//   (c) member.today is resolved in the member's OWN timezone (the per-profile-context
//       trap) — two far-apart zones yield different "today" strings; and a per-day
//       deep-link carries the member's own subject id.
// Synthetic fixtures only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getMultiProfileTimeline } from "@/lib/timeline";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string, timezone?: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  if (timezone) {
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)"
    ).run(id, timezone);
  }
  return id;
}
function addActivity(profileId: number, date: string, title: string): void {
  db.prepare(
    "INSERT INTO activities (profile_id, date, type, title) VALUES (?, ?, 'cardio', ?)"
  ).run(profileId, date, title);
}
function addSymptom(profileId: number, date: string): void {
  db.prepare(
    "INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?, ?, 'cough', 2)"
  ).run(profileId, date);
}

describe("getMultiProfileTimeline over a multi-profile view-set (#1329)", () => {
  it("tags each member's events with its profileId and excludes a not-in-view profile", () => {
    const dad = newProfile("MV Dad");
    const mia = newProfile("MV Mia");
    const notInView = newProfile("MV Uncle");
    addActivity(dad, "2024-03-10", "Dad run");
    addActivity(mia, "2024-03-11", "Mia swim");
    addActivity(notInView, "2024-03-12", "Should not appear");

    const { members } = getMultiProfileTimeline([dad, mia]);
    expect(members.map((m) => m.profileId)).toEqual([dad, mia]);
    const dadEvents = members[0].events;
    const miaEvents = members[1].events;
    expect(dadEvents.every((e) => e.profileId === dad)).toBe(true);
    expect(miaEvents.every((e) => e.profileId === mia)).toBe(true);
    expect(dadEvents.some((e) => e.title === "Dad run")).toBe(true);
    expect(miaEvents.some((e) => e.title === "Mia swim")).toBe(true);
    // Not-in-view profile never contributes.
    const allTitles = [...dadEvents, ...miaEvents].map((e) => e.title);
    expect(allTitles).not.toContain("Should not appear");
  });

  it("applies the per-table cap PER MEMBER — a chatty member doesn't evict a quiet one", () => {
    const chatty = newProfile("MV Chatty");
    const quiet = newProfile("MV Quiet");
    // 30 chatty rows > the clamped minimum page window (25); 2 quiet rows.
    for (let i = 0; i < 30; i++)
      addActivity(chatty, shiftDateStr("2024-04-01", i), `chatty ${i}`);
    addActivity(quiet, "2024-04-01", "quiet a");
    addActivity(quiet, "2024-04-02", "quiet b");

    // A small requested page (clamped to the 25 floor): the chatty member is capped at
    // 25 of its 30, the quiet member keeps BOTH its rows (its window is independent),
    // and hasMore is true (chatty overflowed).
    const { members, hasMore } = getMultiProfileTimeline([chatty, quiet], {
      limit: 1,
    });
    const chattyCount = members[0].events.filter((e) =>
      e.title.startsWith("chatty")
    ).length;
    const quietCount = members[1].events.filter((e) =>
      e.title.startsWith("quiet")
    ).length;
    expect(chattyCount).toBe(25);
    expect(quietCount).toBe(2);
    expect(hasMore).toBe(true);
  });

  it("resolves each member's today in its OWN timezone (the per-profile-context trap)", () => {
    // ~25h apart (UTC+13 vs UTC−12) → the two local calendar dates ALWAYS differ,
    // regardless of the wall-clock instant the test runs at.
    const east = newProfile("MV East", "Etc/GMT-13");
    const west = newProfile("MV West", "Etc/GMT+12");
    const { members } = getMultiProfileTimeline([east, west]);
    const eastToday = members.find((m) => m.profileId === east)!.today;
    const westToday = members.find((m) => m.profileId === west)!.today;
    expect(eastToday).not.toBe(westToday);
    // East is ahead of West.
    expect(eastToday > westToday).toBe(true);
  });

  it("threads each member's own subject id into per-day deep-links (whose day it is)", () => {
    const a = newProfile("MV SymA");
    const b = newProfile("MV SymB");
    addSymptom(a, "2024-05-01");
    addSymptom(b, "2024-05-02");
    const { members } = getMultiProfileTimeline([a, b]);
    const aSym = members[0].events.find((e) => e.id.startsWith("symptom:"))!;
    const bSym = members[1].events.find((e) => e.id.startsWith("symptom:"))!;
    expect(aSym.href).toContain(`subject=${a}`);
    expect(bSym.href).toContain(`subject=${b}`);
    // And the merge buckets them on their own dates with both members present.
    const days = mergeMemberTimelines(members);
    expect(days.some((d) => d.date === "2024-05-01")).toBe(true);
    expect(days.some((d) => d.date === "2024-05-02")).toBe(true);
  });
});
