import { describe, expect, it } from "vitest";
import {
  DASHBOARD_READING_PROMOTIONS,
  clinicalResultBecameNotable,
  outcomeGoalProgressChanged,
  outcomeGoalStateChanged,
  sleepArrivedInWakeWindow,
  weeklyTargetStateChanged,
} from "../dashboard-reading-promotions";
import {
  careCandidates,
  progressCandidates,
  sleepCandidates,
} from "../dashboard-candidates";
import type { OutcomeGoal } from "../types";

const subject = { scope: "profile" as const, profileId: 7 };
const ctx = { subject, sourceOrder: 0 };

describe("closed dashboard reading promotions", () => {
  it("contains exactly the six owner-ratified semantic transitions", () => {
    expect(DASHBOARD_READING_PROMOTIONS).toEqual([
      "clinical-non-notable-to-notable",
      "weekly-target-transition",
      "outcome-goal-transition",
      "training-best",
      "sleep-arrived",
      "nap-ended",
    ]);
  });

  it("promotes only a comparable clinical move into notability", () => {
    expect(clinicalResultBecameNotable("high", "normal")).toBe(true);
    expect(clinicalResultBecameNotable("non-optimal", null)).toBe(true);
    expect(clinicalResultBecameNotable("high", undefined)).toBe(false);
    expect(clinicalResultBecameNotable("high", "low")).toBe(false);
    expect(clinicalResultBecameNotable("normal", "high")).toBe(false);
    expect(clinicalResultBecameNotable("immune", "normal")).toBe(false);
  });

  it("compares weekly target semantic states without reading a numeric delta", () => {
    expect(
      weeklyTargetStateChanged(
        { pace: "behind", met: false, count: 1 },
        { pace: "on-pace", met: false }
      )
    ).toBe(true);
    expect(
      weeklyTargetStateChanged(
        { pace: "met", met: true, count: 3 },
        { pace: "on-pace", met: false }
      )
    ).toBe(true);
    expect(
      weeklyTargetStateChanged(
        { pace: "on-pace", met: false, count: 1 },
        { pace: "on-pace", met: false }
      )
    ).toBe(false);
    expect(
      weeklyTargetStateChanged({ pace: "behind", met: false, count: 1 }, null)
    ).toBe(false);
    expect(
      weeklyTargetStateChanged(
        { pace: "behind", met: false, count: 0 },
        { pace: "on-pace", met: false }
      )
    ).toBe(true);
    expect(
      weeklyTargetStateChanged(
        { pace: "on-pace", met: false, count: 0 },
        { pace: "on-pace", met: false }
      )
    ).toBe(false);
  });

  it("compares outcome-goal pace and completion states", () => {
    expect(
      outcomeGoalStateChanged(
        { pace: "behind", complete: false },
        { pace: "on-pace", complete: false }
      )
    ).toBe(true);
    expect(
      outcomeGoalStateChanged(
        { pace: "met", complete: true },
        { pace: "on-pace", complete: false }
      )
    ).toBe(true);
    expect(
      outcomeGoalStateChanged(
        { pace: "on-pace", complete: false },
        { pace: "on-pace", complete: false }
      )
    ).toBe(false);
    expect(
      outcomeGoalStateChanged({ pace: "behind", complete: false }, null)
    ).toBe(false);
  });

  it("ends an outcome transition when the goal period closes", () => {
    const goal = {
      target_date: "2026-06-16",
      created_at: "2026-05-01",
    } as OutcomeGoal;
    expect(
      outcomeGoalProgressChanged(
        goal,
        {
          current: 10,
          target: 10,
          pct: 100,
          done: true,
          previous: { pct: 90, done: false },
        },
        "2026-06-17"
      )
    ).toBe(false);
  });

  it("routes every registered transition through its existing domain candidate", () => {
    const candidates = [
      careCandidates.lab(ctx, "LDL Cholesterol", { changed: true }),
      progressCandidates.targetProgress(ctx, 1, true, true),
      progressCandidates.goal(ctx, 2, true),
      progressCandidates.trainingResult(ctx, "bench", "2026-06-17", 0),
      sleepCandidates.reading(
        ctx,
        "last-night",
        "2026-06-17",
        "external",
        {
          kind: "local-time",
          opensAt: 360,
          closesAt: 540,
          wrapsMidnight: false,
        },
        true
      ),
      sleepCandidates.nap(ctx, "2026-06-17", 780, "manual", 30),
    ];

    expect(candidates.map(({ readingPromotion }) => readingPromotion)).toEqual(
      DASHBOARD_READING_PROMOTIONS
    );
    expect(candidates.every(({ rankReasons }) => rankReasons.changed)).toBe(
      true
    );
  });

  it("leaves sibling last-night facts as ordinary readings", () => {
    const bedtime = sleepCandidates.reading(
      ctx,
      "bedtime",
      "2026-06-17",
      "external",
      {
        kind: "local-time",
        opensAt: 360,
        closesAt: 540,
        wrapsMidnight: false,
      }
    );

    expect(bedtime.readingPromotion).toBeUndefined();
    expect(bedtime.rankReasons.changed).toBe(false);
  });

  it("requires the canonical last-night label and never repromotes recent sleep", () => {
    expect(sleepArrivedInWakeWindow("last-night", 0, 1380, 1379)).toBe(false);
    expect(sleepArrivedInWakeWindow("last-night", 0, 1380, 1380)).toBe(true);
    expect(sleepArrivedInWakeWindow("recent", 1, 1380, 120)).toBe(false);
    expect(sleepArrivedInWakeWindow("recent", 1, 1380, 121)).toBe(false);
    expect(sleepArrivedInWakeWindow("recent", 2, 1380, 60)).toBe(false);
  });

  // #4299: the arrival that WOULD promote, withheld because the night's synced
  // session disagrees with the heart rate recorded across it. The pair is the
  // proof — the same inputs promote when the session is not contradicted.
  it("withholds the arrival on a clock-skew-contradicted night", () => {
    expect(sleepArrivedInWakeWindow("last-night", 0, 1380, 1380, false)).toBe(
      true
    );
    expect(sleepArrivedInWakeWindow("last-night", 0, 1380, 1380, true)).toBe(
      false
    );
  });
});
