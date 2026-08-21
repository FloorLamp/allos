import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  seriesGapForSeriesKey,
  sparklineShapeForSeriesKey,
} from "@/lib/trend-sparkline";

// THE STANDING COLUMN'S SERIES (#3252), pinned where the dashboard actually declares
// them: in the page's own source.
//
// Two things can go wrong here and neither shows up as a red pixel:
//
//   1. A FAMILY JOINS WITH A BAR-SHAPED SERIES. `components/dashboard/StandingSparkline`
//      draws one mark — the issue's line spec — because every series the column carries
//      today is a level or a total that still reads as a line. `lib/trend-sparkline` is
//      the ONE decision about which series get bars instead, and a `metric:volume`-shaped
//      row added to Standing would be drawn as a line: a slope through rest days that had
//      no training in them. So the registry is consulted here as a GATE rather than
//      duplicated as a second mark spec.
//   2. A SERIES ARRIVES WITH NO DECLARED GAP. The column asks the same registry whether a
//      missing day is a hole the stroke may cross. An unknown key silently falls back to
//      "bridge", which for a per-day TOTAL asserts a step count nobody measured.
//
// The keys are read out of app/(app)/page.tsx rather than restated, so adding a
// `seriesKey:` there brings it under both rules with no second list to update — the same
// read-the-source stance page-width-scan and nav-routes take.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DASHBOARD = "app/(app)/page.tsx";

/** Every `seriesKey:` the dashboard hands to the Standing column. */
export function standingSeriesKeys(): string[] {
  const src = fs.readFileSync(path.join(REPO, DASHBOARD), "utf8");
  return [
    ...new Set([...src.matchAll(/seriesKey:\s*"([^"]+)"/g)].map((m) => m[1])),
  ].sort();
}

describe("the Standing sparkline column's series (#3252)", () => {
  it("names the series the dashboard actually derives, and no others", () => {
    // The column is not a place a new health computation may arrive through: these are
    // the three reads the page already had in hand. A fourth entry here means a fourth
    // query on the dashboard's hot path, which is a decision, not a detail.
    expect(standingSeriesKeys()).toEqual([
      "metric:resting_hr",
      "metric:steps",
      "metric:weight",
    ]);
  });

  it("draws only line-shaped series — a bar series needs the bar mark first", () => {
    for (const key of standingSeriesKeys()) {
      expect(
        sparklineShapeForSeriesKey(key),
        `${key} is bar-shaped, and the Standing column draws one mark (a line). ` +
          `Give StandingSparkline the bar twin before seating this family, or the ` +
          `stroke will slope through days the quantity was genuinely zero.`
      ).toBe("line");
    }
  });

  it("takes its gap policy from the registry, never a default", () => {
    // Weight is a level and bridges its holes; steps is a per-day total that was NOT
    // measured on a missing day, so its stroke breaks. Drawing them the same way is the
    // defect this asserts against.
    expect(seriesGapForSeriesKey("metric:weight")).toBe("bridge");
    expect(seriesGapForSeriesKey("metric:resting_hr")).toBe("bridge");
    expect(seriesGapForSeriesKey("metric:steps")).toBe("slot-null");
  });

  it("reads the keys out of the page rather than a copy of them", () => {
    // The extractor has to be able to SEE a key, or the two rules above are green over
    // an empty list. This is the same shape as the real call sites in page.tsx.
    const src = 'series: {\n  points: rows,\n  seriesKey: "metric:weight",\n}';
    expect(
      [...src.matchAll(/seriesKey:\s*"([^"]+)"/g)].map((m) => m[1])
    ).toEqual(["metric:weight"]);
    expect(standingSeriesKeys().length).toBeGreaterThan(0);
  });
});
