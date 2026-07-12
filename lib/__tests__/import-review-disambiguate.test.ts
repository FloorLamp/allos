import { describe, it, expect } from "vitest";
import { disambiguationLabels } from "@/lib/import-review/disambiguate";

describe("disambiguationLabels (issue #531)", () => {
  it("keeps the distinct source labels when they differ", () => {
    const d = disambiguationLabels("Strava", "Manual entry");
    expect(d).toEqual({ a: "Strava", b: "Manual entry", usedFallback: false });
  });

  it("falls back to A/B (with a badge) when the labels collide", () => {
    // Two Strava rows, or two manual weigh-ins ("Manual entry") — the case the
    // detector surfaces precisely because both share the dimension.
    expect(disambiguationLabels("Strava", "Strava")).toEqual({
      a: "A",
      b: "B",
      usedFallback: true,
    });
    expect(disambiguationLabels("Manual entry", "Manual entry")).toEqual({
      a: "A",
      b: "B",
      usedFallback: true,
    });
  });
});
