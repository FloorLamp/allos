import { describe, it, expect } from "vitest";
import {
  mergeAttentionPageGroups,
  groupAttentionByPerson,
  emptyMemberIds,
  type MemberAttention,
  type ProfiledUpcomingItem,
} from "@/lib/attention";

// Pure-tier coverage for the multi-profile page-group MERGE (lib/attention.ts, issue
// #1096) — and specifically the PER-PROFILE-CONTEXT TRAP: each member's items must be
// banded against THAT member's own `today`, never a shared clock. The DB assembly
// (collectMultiProfileAttention) is exercised in the DB tier; this pins the pure merge.

function item(
  profileId: number,
  key: string,
  dueDate: string | null,
  extra: Partial<ProfiledUpcomingItem> = {}
): ProfiledUpcomingItem {
  return {
    profileId,
    key,
    domain: "dose",
    title: key,
    href: "/upcoming",
    dueDate,
    ...extra,
  };
}

describe("mergeAttentionPageGroups", () => {
  it("bands EACH member's items in that member's own today (the trap)", () => {
    // Same due date (2026-07-23), two members in different timezones/days:
    //   • member 7's today IS 2026-07-23 → the item is due TODAY
    //   • member 9's today is already 2026-07-24 → the SAME date is now OVERDUE
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "dose:7", "2026-07-23")],
      },
      {
        profileId: 9,
        today: "2026-07-24",
        items: [item(9, "dose:9", "2026-07-23")],
      },
    ];
    const groups = mergeAttentionPageGroups(members);
    const overdue = groups.find((g) => g.kind === "overdue");
    const todayGroup = groups.find((g) => g.kind === "today");
    // Member 9's item bands overdue (its own clock rolled over); member 7's bands
    // today. A shared-clock merge would put BOTH in the same band — the bug.
    expect(overdue?.items.map((i) => i.key)).toEqual(["dose:9"]);
    expect(todayGroup?.items.map((i) => i.key)).toEqual(["dose:7"]);
  });

  it("concatenates same-band items across members, soonest due first", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-26")],
      },
      {
        profileId: 9,
        today: "2026-07-23",
        items: [item(9, "b", "2026-07-24"), item(9, "c", "2026-07-25")],
      },
    ];
    const week = mergeAttentionPageGroups(members).find(
      (g) => g.kind === "week"
    );
    // All three fall in "this week" for their (shared here) today; ordered by due
    // date ascending regardless of which member they came from.
    expect(week?.items.map((i) => i.key)).toEqual(["b", "c", "a"]);
  });

  it("orders a same-date tie by priority desc, then profileId, then key (context-free)", () => {
    const members: MemberAttention[] = [
      {
        profileId: 9,
        today: "2026-07-23",
        items: [item(9, "z", "2026-07-23", { priority: 0 })],
      },
      {
        profileId: 7,
        today: "2026-07-23",
        items: [
          item(7, "y", "2026-07-23", { priority: 1 }),
          item(7, "x", "2026-07-23", { priority: 0 }),
        ],
      },
    ];
    const todayGroup = mergeAttentionPageGroups(members).find(
      (g) => g.kind === "today"
    );
    // y (priority 1) leads; then the two priority-0 items ordered by profileId (7
    // before 9): x (profile 7) then z (profile 9).
    expect(todayGroup?.items.map((i) => i.key)).toEqual(["y", "x", "z"]);
  });

  it("is the single-member identity: one member merges to that member's own grouping", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23"), item(7, "b", "2026-07-30")],
      },
    ];
    const groups = mergeAttentionPageGroups(members);
    expect(
      groups.find((g) => g.kind === "today")?.items.map((i) => i.key)
    ).toEqual(["a"]);
    expect(
      groups.find((g) => g.kind === "week")?.items.map((i) => i.key)
    ).toEqual(["b"]);
  });

  it("preserves each item's profileId through the merge (for subject stamping)", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23")],
      },
      {
        profileId: 9,
        today: "2026-07-23",
        items: [item(9, "b", "2026-07-23")],
      },
    ];
    const todayGroup = mergeAttentionPageGroups(members).find(
      (g) => g.kind === "today"
    );
    const byKey = new Map(
      (todayGroup?.items as ProfiledUpcomingItem[]).map((i) => [
        i.key,
        i.profileId,
      ])
    );
    expect(byKey.get("a")).toBe(7);
    expect(byKey.get("b")).toBe(9);
  });
});

// The BY-PERSON mode (issue #1327 fix 2) + the per-member empty state (fix 3). The
// alternate presentation over the SAME per-member models — one section per member, each
// banded in that member's own today, INCLUDING empty members (so a quiet member is
// acknowledged, never silently absent).
describe("groupAttentionByPerson", () => {
  it("returns one section per member IN VIEW ORDER, each banded in its own today", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23"), item(7, "b", "2026-07-30")],
      },
      {
        // Member 9's clock already rolled over → the SAME 07-23 date bands overdue in
        // ITS own section (the trap holds per-member here too).
        profileId: 9,
        today: "2026-07-24",
        items: [item(9, "c", "2026-07-23")],
      },
    ];
    const sections = groupAttentionByPerson(members);
    expect(sections.map((s) => s.profileId)).toEqual([7, 9]);
    // Member 7: 'a' today, 'b' this week.
    expect(
      sections[0].groups
        .find((g) => g.kind === "today")
        ?.items.map((i) => i.key)
    ).toEqual(["a"]);
    expect(
      sections[0].groups.find((g) => g.kind === "week")?.items.map((i) => i.key)
    ).toEqual(["b"]);
    expect(sections[0].empty).toBe(false);
    // Member 9: 'c' overdue in its own context.
    expect(
      sections[1].groups
        .find((g) => g.kind === "overdue")
        ?.items.map((i) => i.key)
    ).toEqual(["c"]);
  });

  it("marks a member with nothing due as empty (its own 'All caught up' section)", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23")],
      },
      { profileId: 9, today: "2026-07-23", items: [] },
    ];
    const sections = groupAttentionByPerson(members);
    expect(sections[1].profileId).toBe(9);
    expect(sections[1].empty).toBe(true);
    expect(sections[1].groups).toEqual([]);
    // The empty member is NOT dropped — it renders its header + "All caught up".
    expect(sections).toHaveLength(2);
  });
});

describe("emptyMemberIds (issue #1327 fix 3 — interleaved-mode acknowledgement)", () => {
  it("lists the in-view members with nothing due, in view order", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23")],
      },
      { profileId: 9, today: "2026-07-23", items: [] },
      { profileId: 4, today: "2026-07-23", items: [] },
    ];
    expect(emptyMemberIds(members)).toEqual([9, 4]);
  });

  it("is empty when every member has something due", () => {
    const members: MemberAttention[] = [
      {
        profileId: 7,
        today: "2026-07-23",
        items: [item(7, "a", "2026-07-23")],
      },
    ];
    expect(emptyMemberIds(members)).toEqual([]);
  });
});
