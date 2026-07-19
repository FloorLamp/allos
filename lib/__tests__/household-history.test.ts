import { describe, expect, it } from "vitest";
import {
  mergeHouseholdHistory,
  historyItemSortDate,
  isRecentlySickOn,
  computeHouseholdEpisodeContext,
  HOUSEHOLD_RECENTLY_SICK_DAYS,
  EPISODE_ADJACENCY_DAYS,
  type HouseholdHistoryItem,
  type HouseholdEpisodeItem,
} from "../household-history";

function visit(
  encounterId: number,
  profileId: number,
  date: string
): HouseholdHistoryItem {
  return {
    kind: "visit",
    profileId,
    encounterId,
    date,
    endDate: null,
    type: "Office visit",
    reason: null,
    providerName: null,
    locationName: null,
  };
}

function episode(
  episodeId: number,
  profileId: number,
  firstDay: string | null,
  lastActiveDay: string | null,
  opts: Partial<HouseholdEpisodeItem> = {}
): HouseholdEpisodeItem {
  return {
    kind: "episode",
    profileId,
    episodeId,
    situation: "Illness",
    start: firstDay,
    end: lastActiveDay,
    firstDay,
    lastActiveDay,
    ongoing: false,
    dayCount: null,
    maxTempF: null,
    symptomLabels: [],
    ...opts,
  };
}

describe("historyItemSortDate", () => {
  it("uses the visit date for a visit", () => {
    expect(historyItemSortDate(visit(1, 1, "2026-03-01"))).toBe("2026-03-01");
  });

  it("uses firstDay for an episode, falling back to start then lastActiveDay", () => {
    expect(historyItemSortDate(episode(1, 1, "2026-02-10", "2026-02-14"))).toBe(
      "2026-02-10"
    );
    // Unknown firstDay → falls back to start.
    expect(
      historyItemSortDate(
        episode(2, 1, null, "2026-02-14", { start: "2026-02-09" })
      )
    ).toBe("2026-02-09");
    // Neither → lastActiveDay.
    expect(
      historyItemSortDate(episode(3, 1, null, "2026-02-14", { start: null }))
    ).toBe("2026-02-14");
  });
});

describe("mergeHouseholdHistory", () => {
  it("orders the merged stream most-recent first across kinds and profiles", () => {
    const merged = mergeHouseholdHistory([
      visit(10, 1, "2026-01-05"),
      episode(20, 2, "2026-03-01", "2026-03-04"),
      visit(11, 2, "2026-02-15"),
      episode(21, 1, "2026-01-20", "2026-01-25"),
    ]);
    expect(merged.map(historyItemSortDate)).toEqual([
      "2026-03-01",
      "2026-02-15",
      "2026-01-20",
      "2026-01-05",
    ]);
  });

  it("tags every row with its owning profile (person-tagged)", () => {
    const merged = mergeHouseholdHistory([
      visit(10, 7, "2026-01-05"),
      episode(20, 9, "2026-03-01", "2026-03-04"),
    ]);
    expect(merged.map((i) => i.profileId)).toEqual([9, 7]);
  });

  it("breaks same-day ties deterministically (visit before episode, newer id first)", () => {
    const merged = mergeHouseholdHistory([
      episode(20, 1, "2026-02-01", "2026-02-03"),
      visit(11, 1, "2026-02-01"),
      visit(12, 2, "2026-02-01"),
    ]);
    // Both visits (same day) precede the episode; the newer visit id (12) leads.
    expect(
      merged.map((i) =>
        i.kind === "visit" ? `v${i.encounterId}` : `e${i.episodeId}`
      )
    ).toEqual(["v12", "v11", "e20"]);
  });

  it("does not mutate its input", () => {
    const input = [visit(1, 1, "2026-01-01"), visit(2, 1, "2026-02-01")];
    const before = [...input];
    mergeHouseholdHistory(input);
    expect(input).toEqual(before);
  });
});

describe("isRecentlySickOn", () => {
  const today = "2026-03-20";

  it("is true when currently sick (an episode covers today)", () => {
    expect(isRecentlySickOn(true, null, today)).toBe(true);
  });

  it("is true when the most recent episode closed within the window", () => {
    // Closed 10 days ago, window 14 → recently sick.
    expect(isRecentlySickOn(false, "2026-03-10", today)).toBe(true);
  });

  it("is false when the most recent episode closed before the window", () => {
    // Closed 20 days ago, window 14 → not recently sick.
    expect(isRecentlySickOn(false, "2026-02-28", today)).toBe(false);
  });

  it("is false with no open episode and no closed episode", () => {
    expect(isRecentlySickOn(false, null, today)).toBe(false);
  });

  it("respects the default window constant at the boundary", () => {
    const end = "2026-03-06"; // exactly 14 days before today
    expect(
      isRecentlySickOn(false, end, today, HOUSEHOLD_RECENTLY_SICK_DAYS)
    ).toBe(true);
    expect(
      isRecentlySickOn(false, end, today, HOUSEHOLD_RECENTLY_SICK_DAYS - 1)
    ).toBe(false);
  });
});

describe("computeHouseholdEpisodeContext", () => {
  const focal = { firstDay: "2026-01-10", lastActiveDay: "2026-01-16" };

  it("detects an overlap and reports the overlap-day count", () => {
    // Other sick 2026-01-13 – 2026-01-20: overlap is 13,14,15,16 = 4 days.
    const [ctx] = computeHouseholdEpisodeContext(focal, [
      episode(50, 2, "2026-01-13", "2026-01-20"),
    ]);
    expect(ctx.relation).toBe("overlap");
    expect(ctx.days).toBe(4);
    expect(ctx.profileId).toBe(2);
  });

  it("reports a closely-preceding episode as 'before' with the gap", () => {
    // Other ended 2026-01-07, focal starts 2026-01-10 → gap of 2 days (8th, 9th).
    const [ctx] = computeHouseholdEpisodeContext(focal, [
      episode(51, 3, "2026-01-02", "2026-01-07"),
    ]);
    expect(ctx.relation).toBe("before");
    expect(ctx.days).toBe(2);
  });

  it("reports a closely-following episode as 'after' with the gap", () => {
    // Other starts 2026-01-19, focal ends 2026-01-16 → gap of 2 days (17th, 18th).
    const [ctx] = computeHouseholdEpisodeContext(focal, [
      episode(52, 4, "2026-01-19", "2026-01-24"),
    ]);
    expect(ctx.relation).toBe("after");
    expect(ctx.days).toBe(2);
  });

  it("drops episodes beyond the adjacency window", () => {
    // Ends 30 days before focal starts → far outside EPISODE_ADJACENCY_DAYS.
    expect(
      computeHouseholdEpisodeContext(focal, [
        episode(53, 5, "2025-12-01", "2025-12-05"),
      ])
    ).toEqual([]);
  });

  it("returns nothing when the focal window is unknown", () => {
    expect(
      computeHouseholdEpisodeContext({ firstDay: null, lastActiveDay: null }, [
        episode(54, 6, "2026-01-13", "2026-01-20"),
      ])
    ).toEqual([]);
  });

  it("orders overlaps (longest first) ahead of adjacent episodes (smallest gap first)", () => {
    const ordered = computeHouseholdEpisodeContext(focal, [
      episode(60, 2, "2026-01-18", "2026-01-22"), // after, gap 1
      episode(61, 3, "2026-01-15", "2026-01-30"), // overlap 2 (15,16)
      episode(62, 4, "2026-01-11", "2026-01-25"), // overlap 6 (11..16)
      episode(63, 5, "2026-01-01", "2026-01-05"), // before, gap 4
    ]);
    expect(ordered.map((c) => `${c.relation}:${c.days}`)).toEqual([
      "overlap:6",
      "overlap:2",
      "after:1",
      "before:4",
    ]);
  });

  it("respects a custom adjacency window", () => {
    const near = episode(70, 2, "2026-01-19", "2026-01-24"); // gap 2 after focal
    expect(computeHouseholdEpisodeContext(focal, [near], 1)).toEqual([]);
    expect(
      computeHouseholdEpisodeContext(focal, [near], EPISODE_ADJACENCY_DAYS)
    ).toHaveLength(1);
  });
});
