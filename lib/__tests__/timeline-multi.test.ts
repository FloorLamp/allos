import { describe, expect, it } from "vitest";
import {
  relativeDay,
  dayMarksFor,
  mergeMemberTimelines,
  byPersonTimelines,
  type MemberTimeline,
  type ProfiledTimelineEvent,
} from "../timeline-multi";
import type { TimelineEvent } from "../timeline-format";

// A tiny builder for a profiled timeline event on a given (member-local) date.
function ev(
  profileId: number,
  date: string,
  id: string,
  extra: Partial<TimelineEvent> = {}
): ProfiledTimelineEvent {
  return {
    profileId,
    id,
    date,
    category: "activity",
    title: id,
    ...extra,
  };
}

// The scenario the issue names: a member in UTC+13 (Kiritimati-ish) whose local date
// has already rolled to 2026-07-14, and a member in UTC-8 (Pacific) still on
// 2026-07-13 — the same instant, two different local "todays".
const MIA_UTC_PLUS_13: MemberTimeline = {
  profileId: 1,
  today: "2026-07-14",
  events: [
    ev(1, "2026-07-14", "a:mia-today"),
    ev(1, "2026-07-13", "a:mia-yesterday"),
    ev(1, "2026-06-01", "a:mia-old"),
  ],
};
const SAM_UTC_MINUS_8: MemberTimeline = {
  profileId: 2,
  today: "2026-07-13",
  events: [
    ev(2, "2026-07-13", "a:sam-today"),
    ev(2, "2026-06-01", "a:sam-old"),
  ],
};

describe("relativeDay", () => {
  it("labels today / yesterday / tomorrow relative to the member's own today", () => {
    expect(relativeDay("2026-07-14", "2026-07-14")).toBe("today");
    expect(relativeDay("2026-07-13", "2026-07-14")).toBe("yesterday");
    expect(relativeDay("2026-07-15", "2026-07-14")).toBe("tomorrow");
  });
  it("returns null for a date more than a day from the member's today", () => {
    expect(relativeDay("2026-07-12", "2026-07-14")).toBeNull();
    expect(relativeDay("2026-06-01", "2026-07-14")).toBeNull();
  });
});

describe("dayMarksFor — divergent-day honesty", () => {
  const members = [MIA_UTC_PLUS_13, SAM_UTC_MINUS_8];

  it("marks 2026-07-14 as Mia's today and Sam's tomorrow (divergent)", () => {
    // The crossing-midnight day: the SAME calendar date is 'today' for Mia (+13) and
    // 'tomorrow' for Sam (−8). The header must carry BOTH honestly.
    const marks = dayMarksFor("2026-07-14", members);
    expect(marks).toEqual([
      { profileId: 1, relative: "today" },
      { profileId: 2, relative: "tomorrow" },
    ]);
  });

  it("marks 2026-07-13 as Sam's today and Mia's yesterday (divergent)", () => {
    const marks = dayMarksFor("2026-07-13", members);
    expect(marks).toEqual([
      { profileId: 1, relative: "yesterday" },
      { profileId: 2, relative: "today" },
    ]);
  });

  it("emits NO marks for a far-past day both members share (not divergent)", () => {
    expect(dayMarksFor("2026-06-01", members)).toEqual([]);
  });

  it("emits NO marks in single view (one member can never diverge)", () => {
    expect(dayMarksFor("2026-07-14", [MIA_UTC_PLUS_13])).toEqual([]);
    expect(dayMarksFor("2026-07-13", [MIA_UTC_PLUS_13])).toEqual([]);
  });

  it("emits NO marks when two members share the same timezone/today", () => {
    const a: MemberTimeline = { profileId: 1, today: "2026-07-14", events: [] };
    const b: MemberTimeline = { profileId: 2, today: "2026-07-14", events: [] };
    // Same today → the date means the SAME thing to both → no divergence chrome.
    expect(dayMarksFor("2026-07-14", [a, b])).toEqual([]);
    expect(dayMarksFor("2026-07-13", [a, b])).toEqual([]);
  });

  it("marks a two-day gap with only the near member (honest, not invented)", () => {
    // A 2-day divergence (e.g. UTC+14 vs UTC−12): 2026-07-14 is Mia's today but far
    // from Sam's 2026-07-12 today → only Mia's mark, never a fabricated Sam label.
    const far: MemberTimeline = {
      profileId: 2,
      today: "2026-07-12",
      events: [],
    };
    expect(dayMarksFor("2026-07-14", [MIA_UTC_PLUS_13, far])).toEqual([
      { profileId: 1, relative: "today" },
    ]);
  });
});

describe("mergeMemberTimelines", () => {
  it("buckets each member's items into their OWN local day, newest-first", () => {
    const days = mergeMemberTimelines([MIA_UTC_PLUS_13, SAM_UTC_MINUS_8]);
    expect(days.map((d) => d.date)).toEqual([
      "2026-07-14",
      "2026-07-13",
      "2026-06-01",
    ]);
    // Mia's today-bucket holds only Mia's today item; it is divergent (Sam's tomorrow).
    const d14 = days.find((d) => d.date === "2026-07-14")!;
    expect(d14.events.map((e) => e.id)).toEqual(["a:mia-today"]);
    expect(d14.marks).toEqual([
      { profileId: 1, relative: "today" },
      { profileId: 2, relative: "tomorrow" },
    ]);
    // The shared 2026-07-13 bucket interleaves BOTH members' items (Mia's yesterday +
    // Sam's today), ordered deterministically by profileId then id.
    const d13 = days.find((d) => d.date === "2026-07-13")!;
    expect(d13.events.map((e) => e.profileId)).toEqual([1, 2]);
    expect(d13.marks).toEqual([
      { profileId: 1, relative: "yesterday" },
      { profileId: 2, relative: "today" },
    ]);
    // Far-past bucket: both members, no divergence marks.
    const dOld = days.find((d) => d.date === "2026-06-01")!;
    expect(dOld.events.length).toBe(2);
    expect(dOld.marks).toEqual([]);
  });

  it("single-view merge is byte-equivalent grouping with no marks", () => {
    const days = mergeMemberTimelines([MIA_UTC_PLUS_13]);
    expect(days.map((d) => d.date)).toEqual([
      "2026-07-14",
      "2026-07-13",
      "2026-06-01",
    ]);
    for (const d of days) expect(d.marks).toEqual([]);
  });

  it("orders same-day events by sortTime desc, then profileId, then id", () => {
    const members: MemberTimeline[] = [
      {
        profileId: 2,
        today: "2026-07-14",
        events: [ev(2, "2026-07-14", "z", { sortTime: "08:00" })],
      },
      {
        profileId: 1,
        today: "2026-07-14",
        events: [
          ev(1, "2026-07-14", "a", { sortTime: "09:00" }),
          ev(1, "2026-07-14", "b", { sortTime: "08:00" }),
        ],
      },
    ];
    const [day] = mergeMemberTimelines(members);
    // 09:00 first (desc), then the 08:00 pair ordered by profileId (1 before 2).
    expect(day.events.map((e) => `${e.profileId}:${e.id}`)).toEqual([
      "1:a",
      "1:b",
      "2:z",
    ]);
  });
});

describe("byPersonTimelines", () => {
  it("returns one section per member with their own day grouping and empty flag", () => {
    const empty: MemberTimeline = {
      profileId: 3,
      today: "2026-07-14",
      events: [],
    };
    const sections = byPersonTimelines([
      MIA_UTC_PLUS_13,
      SAM_UTC_MINUS_8,
      empty,
    ]);
    expect(sections.map((s) => s.profileId)).toEqual([1, 2, 3]);
    expect(sections[0].days.map((d) => d.date)).toEqual([
      "2026-07-14",
      "2026-07-13",
      "2026-06-01",
    ]);
    // A single member's per-member sections never carry divergence marks.
    for (const s of sections)
      for (const d of s.days) expect(d.marks).toEqual([]);
    expect(sections[0].empty).toBe(false);
    expect(sections[2].empty).toBe(true);
  });
});
