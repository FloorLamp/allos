import { describe, expect, it } from "vitest";
import {
  trainingSignalKey,
  isWorkoutNudgeSuppressed,
} from "@/lib/workout-nudge";
import type { SuppressionRecord } from "@/lib/upcoming-suppress";

const TODAY = "2026-07-08";

function suppressions(
  entries: [string, SuppressionRecord][]
): Map<string, SuppressionRecord> {
  return new Map(entries);
}

const dismissed: SuppressionRecord = {
  dismissed_at: "2026-07-01",
  snooze_until: null,
};

describe("trainingSignalKey (#245 shared signal key)", () => {
  it("is the identical `training:<id>` string the Upcoming finding carries", () => {
    // The Upcoming training item keys itself `training:${p.target.id}` — the push
    // must derive the SAME string so a page dismissal lines up with the nudge.
    expect(trainingSignalKey(7)).toBe("training:7");
  });
});

describe("isWorkoutNudgeSuppressed (#245 bus gating)", () => {
  it("does NOT gate a nudge with no behind targets (habit/rest/on-track)", () => {
    // No `training:<id>` finding to line up with → the bus never touches it.
    expect(isWorkoutNudgeSuppressed([], suppressions([]), TODAY)).toBe(false);
  });

  it("ignores id-less targets (test fixtures) → not suppressed", () => {
    expect(
      isWorkoutNudgeSuppressed([null, null], suppressions([]), TODAY)
    ).toBe(false);
  });

  it("suppresses when the sole behind target's finding is dismissed", () => {
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), dismissed]]),
        TODAY
      )
    ).toBe(true);
  });

  it("still sends when the behind target's finding is not dismissed", () => {
    expect(isWorkoutNudgeSuppressed([7], suppressions([]), TODAY)).toBe(false);
  });

  it("still sends on PARTIAL suppression — one live target keeps the nudge on", () => {
    // 7 dismissed, 9 still live → not suppressed; the nudge fires for 9.
    expect(
      isWorkoutNudgeSuppressed(
        [7, 9],
        suppressions([[trainingSignalKey(7), dismissed]]),
        TODAY
      )
    ).toBe(false);
  });

  it("suppresses only when EVERY behind target is dismissed", () => {
    expect(
      isWorkoutNudgeSuppressed(
        [7, 9],
        suppressions([
          [trainingSignalKey(7), dismissed],
          [trainingSignalKey(9), dismissed],
        ]),
        TODAY
      )
    ).toBe(true);
  });

  it("treats an expired snooze as not suppressing (finding reappears)", () => {
    const snoozedPast: SuppressionRecord = {
      dismissed_at: null,
      snooze_until: "2026-07-05", // before TODAY → expired
    };
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), snoozedPast]]),
        TODAY
      )
    ).toBe(false);
  });

  it("treats an active snooze as suppressing", () => {
    const snoozedFuture: SuppressionRecord = {
      dismissed_at: null,
      snooze_until: "2026-07-20", // after TODAY → still hidden
    };
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), snoozedFuture]]),
        TODAY
      )
    ).toBe(true);
  });
});
