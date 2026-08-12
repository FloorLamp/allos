import { describe, it, expect } from "vitest";
import {
  buildMacroFiberSeries,
  mergeProteinSources,
  aggregateFoodAdherenceByWeek,
  orderNutritionSections,
  NUTRITION_SECTION_LAYOUT,
} from "../nutrition-trends";
import type { HabitWeekCell } from "../food-habit-trend";

describe("orderNutritionSections (#2399)", () => {
  it("returns the declared reading order when every section has data", () => {
    expect(orderNutritionSections(NUTRITION_SECTION_LAYOUT)).toEqual([
      ...NUTRITION_SECTION_LAYOUT,
    ]);
  });

  it("sinks the setup prompts below the sections that carry content", () => {
    // The reported shape: the two empty cards sat ABOVE the only populated section.
    expect(orderNutritionSections(["intake-history"])).toEqual([
      "intake-history",
      "dose-history",
      "macros",
      "adherence",
    ]);
    expect(orderNutritionSections(["macros"])).toEqual([
      "macros",
      "intake-history",
      "dose-history",
      "adherence",
    ]);
  });

  it("keeps the declared order inside each group", () => {
    expect(orderNutritionSections(["adherence", "dose-history"])).toEqual([
      "dose-history",
      "adherence",
      "intake-history",
      "macros",
    ]);
  });

  it("falls back to the declared order for a profile with nothing at all", () => {
    expect(orderNutritionSections([])).toEqual([...NUTRITION_SECTION_LAYOUT]);
  });
});

describe("mergeProteinSources (#2414)", () => {
  it("lets a tracked reading override the same day's hand-logged grams", () => {
    const out = mergeProteinSources(
      [{ date: "2026-01-02", value: 140 }],
      [{ date: "2026-01-02", value: 30 }]
    );
    // Never 170: a day carrying both sources would double-count the same meals.
    expect(out).toEqual([{ date: "2026-01-02", value: 140 }]);
  });

  it("fills the days no tracked reading covers with the logged grams", () => {
    const out = mergeProteinSources(
      [{ date: "2026-01-02", value: 140 }],
      [
        { date: "2026-01-01", value: 30 },
        { date: "2026-01-02", value: 30 },
        { date: "2026-01-03", value: 55 },
      ]
    );
    expect(out).toEqual([
      { date: "2026-01-01", value: 30 },
      { date: "2026-01-02", value: 140 },
      { date: "2026-01-03", value: 55 },
    ]);
  });

  it("passes a tracked-only profile through unchanged, oldest first", () => {
    const out = mergeProteinSources(
      [
        { date: "2026-01-02", value: 140 },
        { date: "2026-01-01", value: 120 },
      ],
      []
    );
    expect(out).toEqual([
      { date: "2026-01-01", value: 120 },
      { date: "2026-01-02", value: 140 },
    ]);
  });

  it("omits a day neither source has, rather than charting a zero", () => {
    // The gap-fill (#2258) decides how an unlogged day draws; the merge must not
    // pre-empt it with a zero-gram row asserting a fast nobody recorded.
    expect(mergeProteinSources([], [])).toEqual([]);
    expect(mergeProteinSources([{ date: "2026-01-01", value: 0 }], [])).toEqual(
      []
    );
  });
});

describe("buildMacroFiberSeries (#1166 Part 1)", () => {
  it("merges the four tracked series into one dated, ascending row set", () => {
    const out = buildMacroFiberSeries({
      protein: [
        { date: "2026-01-02", value: 90 },
        { date: "2026-01-01", value: 80 },
      ],
      carbs: [{ date: "2026-01-01", value: 200 }],
      fat: [{ date: "2026-01-02", value: 70 }],
      fiber: [{ date: "2026-01-03", value: 28 }],
    });
    expect(out.map((r) => r.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
    // A day with only some series present zero-fills the rest.
    expect(out[0]).toEqual({
      date: "2026-01-01",
      protein: 80,
      carbs: 200,
      fat: 0,
      fiber: 0,
    });
    expect(out[2]).toEqual({
      date: "2026-01-03",
      protein: 0,
      carbs: 0,
      fat: 0,
      fiber: 28,
    });
  });

  it("rounds every gram value to a whole number", () => {
    const out = buildMacroFiberSeries({
      protein: [{ date: "2026-01-01", value: 90.4 }],
      carbs: [],
      fat: [],
      fiber: [{ date: "2026-01-01", value: 27.6 }],
    });
    expect(out[0].protein).toBe(90);
    expect(out[0].fiber).toBe(28);
  });

  it("is empty when no series has data", () => {
    expect(
      buildMacroFiberSeries({ protein: [], carbs: [], fat: [], fiber: [] })
    ).toEqual([]);
  });
});

// Build a cell for one target/week with the shared "range · N of M" label shape.
function cell(
  start: string,
  end: string,
  verdict: HabitWeekCell["verdict"],
  count = 0,
  target = 2
): HabitWeekCell {
  return {
    start,
    end,
    count,
    target,
    verdict,
    label: `${start} – ${end} · ${count} of ${target}`,
  };
}

describe("aggregateFoodAdherenceByWeek (#1166 Part 2)", () => {
  it("computes an overall met/applicable hit-rate per week, oldest first", () => {
    // Two targets across two weeks. Week 1: one met, one short → 1/2. Week 2: both met → 2/2.
    const trends = new Map<number, HabitWeekCell[]>([
      [
        1,
        [
          cell("2026-01-05", "2026-01-11", "met", 2),
          cell("2026-01-12", "2026-01-18", "met", 3),
        ],
      ],
      [
        2,
        [
          cell("2026-01-05", "2026-01-11", "short", 1),
          cell("2026-01-12", "2026-01-18", "met", 2),
        ],
      ],
    ]);
    const out = aggregateFoodAdherenceByWeek(trends);
    expect(out.map((w) => w.weekStart)).toEqual(["2026-01-05", "2026-01-12"]);
    expect(out[0]).toMatchObject({ met: 1, applicable: 2, rate: 0.5 });
    expect(out[1]).toMatchObject({ met: 2, applicable: 2, rate: 1 });
    // The label is the date-range portion of the cell label (no " · N of M" tail).
    expect(out[0].label).toBe("2026-01-05 – 2026-01-11");
  });

  it("excludes not-applicable and in-progress weeks from the applicable count", () => {
    const trends = new Map<number, HabitWeekCell[]>([
      [
        1,
        [
          cell("2025-12-29", "2026-01-04", "na"),
          cell("2026-01-05", "2026-01-11", "empty", 0),
          cell("2026-01-12", "2026-01-18", "current", 1),
        ],
      ],
    ]);
    const out = aggregateFoodAdherenceByWeek(trends);
    // na week: no applicable target → rate null. empty week: applicable but 0 met.
    // current week (not yet met): excluded, so no applicable → rate null.
    const byStart = new Map(out.map((w) => [w.weekStart, w]));
    expect(byStart.get("2025-12-29")).toBeUndefined();
    expect(byStart.get("2026-01-05")).toMatchObject({
      met: 0,
      applicable: 1,
      rate: 0,
    });
    expect(byStart.get("2026-01-12")).toBeUndefined();
  });

  it("counts a current week only once the goal is already met", () => {
    const trends = new Map<number, HabitWeekCell[]>([
      [1, [cell("2026-01-12", "2026-01-18", "met", 2)]],
    ]);
    const out = aggregateFoodAdherenceByWeek(trends);
    expect(out[0]).toMatchObject({ met: 1, applicable: 1, rate: 1 });
  });

  it("is empty for a profile tracking no food habits", () => {
    expect(aggregateFoodAdherenceByWeek(new Map())).toEqual([]);
  });
});
