import { describe, expect, it } from "vitest";
import { pullLogFields } from "@/lib/integrations/pull-log-fields";

describe("pullLogFields", () => {
  it("keeps the diagnostics pull runners intentionally expose", () => {
    expect(
      pullLogFields({
        activities: 2,
        workouts: 3,
        bodyMetrics: 4,
        vitals: 5,
        samples: 6,
        skipped: 7,
        truncated: true,
        hours: 8,
        days: 9,
        inserted: 10,
        updated: 11,
        unchanged: 12,
        partial: "air-quality timeout",
        error: "provider refused token=synthetic-secret",
      })
    ).toEqual({
      activities: 2,
      workouts: 3,
      bodyMetrics: 4,
      vitals: 5,
      samples: 6,
      skipped: 7,
      truncated: true,
      hours: 8,
      days: 9,
      inserted: 10,
      updated: 11,
      unchanged: 12,
      partial: "air-quality timeout",
      error: "provider refused token=***",
    });
  });

  it("does not admit unexpected result fields or wrong-shaped values", () => {
    expect(
      pullLogFields({
        activities: "two",
        partial: { coordinates: "40,-70" },
        homeLocation: "40,-70",
        responseBody: "clinical detail",
        accessToken: "synthetic-secret",
      })
    ).toEqual({});
  });
});
