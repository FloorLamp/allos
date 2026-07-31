import { describe, expect, it } from "vitest";
import {
  buildPracticeHeatmap,
  WELLNESS_PRACTICE_HEATMAP_WEEKS,
} from "@/lib/practice-heatmap";

describe("buildPracticeHeatmap", () => {
  it("uses the same trailing calendar window for populated and empty practices", () => {
    const populated = buildPracticeHeatmap(
      [
        { date: "2026-07-27", count: 2 },
        { date: "2026-07-28", count: 1 },
        { date: "2026-04-01", count: 4 },
      ],
      "2026-07-29",
      0
    );
    const empty = buildPracticeHeatmap([], "2026-07-29", 0);

    expect(populated.columns).toHaveLength(WELLNESS_PRACTICE_HEATMAP_WEEKS);
    expect(empty.columns).toHaveLength(WELLNESS_PRACTICE_HEATMAP_WEEKS);
    expect(populated.start).toBe(empty.start);
    expect(populated.end).toBe(empty.end);
    expect(populated).toMatchObject({
      totalSessions: 3,
      activeDays: 2,
      truncated: false,
    });
    expect(
      populated.columns.flat().find((cell) => cell.date === "2026-07-27")
    ).toMatchObject({ count: 2, level: 2, outside: false });
  });
});
