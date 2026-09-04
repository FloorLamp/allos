// PURE TIER — the physiology the morning digest states (#4775 §2 and §4).
//
// Two lines, both of which must be ABSENT more often than present:
//   • the Yesterday activity line's recovery clause, which rides the send that already
//     carries the session rather than a delayed post-workout message of its own;
//   • the Sleep section's overnight-HR line, which renders only when the stream covered
//     the sleep session.
// Every fixture number is invented.

import { describe, expect, it } from "vitest";
import { plainBody, type MessageBody } from "@/lib/notifications/rich-text";
import {
  buildDigest,
  type DigestInput,
  type DigestSleep,
} from "@/lib/notifications/digest";

const plain = (lines: readonly MessageBody[] | undefined): string[] =>
  (lines ?? []).map(plainBody);

const empty: DigestInput = {
  profileName: "Mom",
  doseCount: 0,
  todayGroups: [],
  activities: [],
  adherence: null,
  weightKg: null,
  newFlaggedBiomarkers: [],
  newDocuments: [],
};

const session = {
  title: "Push day",
  type: "strength" as const,
  durationMin: 45,
  distanceKm: null,
};

function yesterdayLines(activities: DigestInput["activities"]): string[] {
  const model = buildDigest({ ...empty, activities });
  return plain(model?.sections.find((s) => s.heading === "Yesterday")?.lines);
}

describe("the Yesterday recovery clause", () => {
  it("states the recovery beside the profile's own usual", () => {
    expect(
      yesterdayLines([{ ...session, recoveryMin: 28, usualRecoveryMin: 35 }])[0]
    ).toContain("back to resting in 28 min (usual 35)");
  });

  it("states the fact alone below the prior-events floor", () => {
    const line = yesterdayLines([
      { ...session, recoveryMin: 28, usualRecoveryMin: null },
    ])[0];
    expect(line).toContain("back to resting in 28 min");
    expect(line).not.toContain("usual");
  });

  // Uncovered window, a wear gap, and "still elevated two hours later" all arrive here
  // as the same null, and none of them is a number the reader should be shown.
  it("says nothing at all when the stream could not answer", () => {
    const line = yesterdayLines([{ ...session, recoveryMin: null }])[0];
    expect(line).not.toContain("resting");
    // …and the line the digest always carried is untouched.
    expect(line).toContain("Push day");
    expect(line).toContain("45 min");
  });

  it("is absent on a digest whose caller supplied no physiology at all", () => {
    expect(yesterdayLines([session])[0]).not.toContain("resting");
  });

  it("rounds both figures rather than printing a mean's decimals", () => {
    expect(
      yesterdayLines([
        { ...session, recoveryMin: 27.6, usualRecoveryMin: 34.4 },
      ])[0]
    ).toContain("back to resting in 28 min (usual 34)");
  });
});

const NIGHT = { lastNightMin: 420, baselineMin: 430 };

function sleepLines(overnightHr: DigestSleep["overnightHr"]): string[] {
  const model = buildDigest({
    ...empty,
    sleep: { ...NIGHT, overnightHr },
  });
  return plain(model?.sections.find((s) => s.heading === "Sleep")?.lines);
}

describe("the Sleep section's overnight-HR line", () => {
  it("states the night's floor, its average and the device's resting figure", () => {
    expect(
      sleepLines({
        lowBpm: 49,
        avgBpm: 56,
        restingBpm: 55,
        usualRestingBpm: 53,
        elevated: false,
      }).at(-1)
    ).toBe("📈 Overnight HR — low 49 · avg 56 · resting 55 (usual 53)");
  });

  // The verdict is a CLAUSE on the facts, and it qualifies the night (#992).
  it("appends the elevated clause on a rest-rhr-threshold night", () => {
    expect(
      sleepLines({
        lowBpm: 58,
        avgBpm: 64,
        restingBpm: 61,
        usualRestingBpm: 53,
        elevated: true,
      }).at(-1)
    ).toContain("elevated");
  });

  it("says nothing at all when the stream did not cover the sleep session", () => {
    const lines = sleepLines(null);
    expect(lines.join(" ")).not.toContain("Overnight HR");
    // …and the duration line the digest always carried is untouched.
    expect(lines[0]).toContain("Last night:");
  });

  it("states the two stream facts alone when the profile has no resting history", () => {
    const line = sleepLines({
      lowBpm: 49,
      avgBpm: 56,
      restingBpm: null,
      usualRestingBpm: null,
      elevated: false,
    }).at(-1);
    expect(line).toBe("📈 Overnight HR — low 49 · avg 56");
    expect(line).not.toContain("resting");
  });

  it("rounds rather than printing a mean's decimals", () => {
    expect(
      sleepLines({
        lowBpm: 48.6,
        avgBpm: 55.4,
        restingBpm: 54.7,
        usualRestingBpm: 52.5,
        elevated: false,
      }).at(-1)
    ).toBe("📈 Overnight HR — low 49 · avg 55 · resting 55 (usual 53)");
  });
});
