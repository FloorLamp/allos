import { describe, it, expect } from "vitest";
import {
  mergeTrainingLogDayGroups,
  trainingLogDrillInsVisible,
  type MemberTrainingLogGroups,
} from "@/lib/training-log-multi-view";
import type { DayGroup, TrainingLogCardData } from "@/lib/training-log-card";

// Minimal card carrying just the identity the merge touches (id + a title so a test
// can read it back). The merge spreads activity and stamps subjectProfileId.
function card(id: number, title = `A${id}`): TrainingLogCardData {
  return {
    activity: { id, title },
  } as unknown as TrainingLogCardData;
}

function group(date: string, ...cards: TrainingLogCardData[]): DayGroup {
  return { date, label: `raw-${date}`, cards };
}

// A relabel that marks the merged label so tests can prove it is RE-DERIVED (from the
// viewer's clock) rather than inherited from any member's per-profile "raw-" label.
const relabel = (date: string): string =>
  date === "2026-07-24" ? "Today" : date;

describe("mergeTrainingLogDayGroups", () => {
  it("merges by date, newest day first, with cards stamped by subject profile", () => {
    const members: MemberTrainingLogGroups[] = [
      {
        profileId: 10,
        groups: [group("2026-07-24", card(1)), group("2026-07-20", card(2))],
      },
      { profileId: 20, groups: [group("2026-07-22", card(3))] },
    ];
    const out = mergeTrainingLogDayGroups(members, relabel);
    // Newest day first.
    expect(out.map((g) => g.date)).toEqual([
      "2026-07-24",
      "2026-07-22",
      "2026-07-20",
    ]);
    // Each card carries its owner's subjectProfileId.
    expect(out[0].cards[0].activity.subjectProfileId).toBe(10);
    expect(out[1].cards[0].activity.subjectProfileId).toBe(20);
    expect(out[2].cards[0].activity.subjectProfileId).toBe(10);
  });

  it("re-derives the group label from the viewer's clock, not any member's label", () => {
    const members: MemberTrainingLogGroups[] = [
      { profileId: 10, groups: [group("2026-07-24", card(1))] },
    ];
    const out = mergeTrainingLogDayGroups(members, relabel);
    // NOT "raw-2026-07-24" — the merged feed labels by the acting clock (a member in
    // another timezone can't make one date read two ways).
    expect(out[0].label).toBe("Today");
  });

  it("interleaves same-day cards in VIEW order, each keeping its within-day order", () => {
    const members: MemberTrainingLogGroups[] = [
      // View order: owner (10) first, then shared (20).
      {
        profileId: 10,
        groups: [group("2026-07-24", card(1, "owner-a"), card(2, "owner-b"))],
      },
      { profileId: 20, groups: [group("2026-07-24", card(3, "shared-a"))] },
    ];
    const out = mergeTrainingLogDayGroups(members, relabel);
    expect(out).toHaveLength(1);
    // Owner's two cards (in order) then the shared member's card.
    expect(out[0].cards.map((c) => c.activity.subjectProfileId)).toEqual([
      10, 10, 20,
    ]);
    expect(out[0].cards.map((c) => c.activity.title)).toEqual([
      "owner-a",
      "owner-b",
      "shared-a",
    ]);
  });

  it("does not mutate the source member groups", () => {
    const src = group("2026-07-24", card(1));
    const members: MemberTrainingLogGroups[] = [
      { profileId: 10, groups: [src] },
    ];
    mergeTrainingLogDayGroups(members, relabel);
    // The original card was never stamped (clone, not mutate).
    expect(src.cards[0].activity.subjectProfileId).toBeUndefined();
  });

  it("is empty over no members / no groups", () => {
    expect(mergeTrainingLogDayGroups([], relabel)).toEqual([]);
    expect(
      mergeTrainingLogDayGroups([{ profileId: 10, groups: [] }], relabel)
    ).toEqual([]);
  });
});

describe("trainingLogDrillInsVisible (#1330/#3067)", () => {
  it("shows drill-ins only for the acting profile", () => {
    expect(trainingLogDrillInsVisible(true)).toBe(true);
    expect(trainingLogDrillInsVisible(false)).toBe(false);
  });
});
