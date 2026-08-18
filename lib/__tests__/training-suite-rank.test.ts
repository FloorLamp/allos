import { describe, expect, it } from "vitest";
import { rankTrainingSuites } from "@/lib/training-suite-rank";

const TODAY = "2026-08-17";

describe("rankTrainingSuites", () => {
  it("orders by recency-decayed observed share", () => {
    const ranked = rankTrainingSuites(
      [
        { date: TODAY, type: "cardio" },
        { date: "2026-08-16", type: "cardio" },
        { date: "2026-06-18", type: "strength" },
        { date: "2026-02-01", type: "sport" },
      ],
      TODAY
    );
    expect(ranked.map((row) => row.suite)).toEqual([
      "endurance",
      "strength",
      "sport",
    ]);
    expect(ranked.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
  });

  it("keeps the stable default order when every domain is low/tied", () => {
    expect(rankTrainingSuites([], TODAY).map((row) => row.suite)).toEqual([
      "strength",
      "endurance",
      "sport",
    ]);
  });

  it("credits each represented component domain once", () => {
    const ranked = rankTrainingSuites(
      [
        {
          date: TODAY,
          type: "strength",
          components: JSON.stringify([
            { name: "Bench Press", type: "strength" },
            { name: "Run", type: "cardio" },
          ]),
        },
      ],
      TODAY
    );
    expect(ranked.find((row) => row.suite === "strength")?.share).toBe(0.5);
    expect(ranked.find((row) => row.suite === "endurance")?.share).toBe(0.5);
  });
});
