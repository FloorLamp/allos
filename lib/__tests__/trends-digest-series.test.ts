import { describe, expect, it } from "vitest";
import {
  buildLoggingCadenceDigestSeries,
  buildNutritionDigestSeries,
  LOGGING_CADENCE_DIGEST_MIN_CHANGE,
  NUTRITION_PROTEIN_DIGEST_MIN_CHANGE,
  NUTRITION_SERVINGS_DIGEST_MIN_CHANGE,
} from "../trends-digest-series";
import { summarizeTrends } from "../trends-digest";
import type { CadenceWindow } from "../queries/cadence-ledger";
import { shiftDateStr } from "../date";
import { TREND_METRIC_SLUGS } from "../trend-metrics";

const day = (offset: number) => shiftDateStr("2026-01-01", offset);

function stepValues(first: number, last: number) {
  return Array.from({ length: 8 }, (_, index) => ({
    date: day(index),
    value: index < 4 ? first : last,
  }));
}

function windows(): CadenceWindow[] {
  return Array.from({ length: 8 }, (_, index) => {
    const start = day(index * 7);
    return {
      start,
      end: shiftDateStr(start, 6),
      isCurrent: false,
      elapsedDays: 7,
    };
  });
}

function datesPerWeek(counts: readonly number[]): string[] {
  return counts.flatMap((count, week) =>
    Array.from({ length: count }, (_, within) => day(week * 7 + within))
  );
}

describe("nutrition digest series (#3397)", () => {
  it("stays outside the trend-metric vocabulary", () => {
    expect(TREND_METRIC_SLUGS as readonly string[]).not.toContain("protein");
    expect(TREND_METRIC_SLUGS.some((slug) => slug.startsWith("food"))).toBe(
      false
    );
    expect(TREND_METRIC_SLUGS.some((slug) => slug.startsWith("logging"))).toBe(
      false
    );
  });

  it("admits a protein collapse and a food-group serving shift", () => {
    const foodServings = Array.from({ length: 8 }, (_, index) => ({
      date: day(index),
      group: "poultry",
      servings: index < 4 ? 2 : 1,
    }));
    const series = buildNutritionDigestSeries({
      proteinDays: stepValues(100, 50),
      foodServings,
    });
    expect(
      series.find((item) => item.key === "nutrition:protein")
    ).toMatchObject({ minPctChange: NUTRITION_PROTEIN_DIGEST_MIN_CHANGE });
    expect(
      series.find((item) => item.key === "nutrition:food-group:poultry")
    ).toMatchObject({ minPctChange: NUTRITION_SERVINGS_DIGEST_MIN_CHANGE });
    expect(summarizeTrends(series).map((item) => item.key)).toEqual([
      "nutrition:food-group:poultry",
      "nutrition:protein",
    ]);
  });

  it("keeps steady protein and servings silent", () => {
    const series = buildNutritionDigestSeries({
      proteinDays: stepValues(80, 80),
      foodServings: Array.from({ length: 8 }, (_, index) => ({
        date: day(index),
        group: "legumes",
        servings: 1,
      })),
    });
    expect(summarizeTrends(series)).toEqual([]);
  });

  it("treats an absent group on a food-logged day as the matrix's zero", () => {
    const foodServings = Array.from({ length: 8 }, (_, index) => [
      {
        date: day(index),
        group: "leafy_greens",
        servings: 1,
      },
      ...(index < 4
        ? [{ date: day(index), group: "poultry", servings: 2 }]
        : []),
    ]).flat();
    const poultry = buildNutritionDigestSeries({
      proteinDays: [],
      foodServings,
    }).find((series) => series.key === "nutrition:food-group:poultry");
    expect(poultry?.points.map((point) => point.value)).toEqual([
      2, 2, 2, 2, 0, 0, 0, 0,
    ]);
  });
});

describe("logging-cadence digest series (#3397)", () => {
  it("offers material food, dose and weighing changes as neutral facts", () => {
    const series = buildLoggingCadenceDigestSeries({
      windows: windows(),
      foodDates: datesPerWeek([6, 6, 6, 6, 3, 3, 3, 3]),
      doseDates: datesPerWeek([2, 2, 2, 2, 5, 5, 5, 5]),
      weighingDates: datesPerWeek([4, 4, 4, 4, 1, 1, 1, 1]),
    });
    expect(
      series.every(
        (candidate) =>
          candidate.minPctChange === LOGGING_CADENCE_DIGEST_MIN_CHANGE &&
          candidate.range == null
      )
    ).toBe(true);
    const items = summarizeTrends(series);
    expect(items.map((item) => item.key).sort()).toEqual([
      "logging:dose",
      "logging:food",
      "logging:weighing",
    ]);
    for (const item of items) {
      expect(item.rangeShift).toBeNull();
      expect(item.text).not.toMatch(
        /\b(should|must|need to|try to|better|worse|good|bad)\b/i
      );
    }
  });

  it("keeps steady loggers and windows shorter than four weeks silent", () => {
    const steady = buildLoggingCadenceDigestSeries({
      windows: windows(),
      foodDates: datesPerWeek([3, 3, 3, 3, 3, 3, 3, 3]),
      doseDates: datesPerWeek([2, 2, 2, 2, 2, 2, 2, 2]),
      weighingDates: datesPerWeek([1, 1, 1, 1, 1, 1, 1, 1]),
    });
    expect(summarizeTrends(steady)).toEqual([]);
    expect(
      buildLoggingCadenceDigestSeries({
        windows: windows().slice(0, 3),
        foodDates: datesPerWeek([6, 6, 1]),
        doseDates: [],
        weighingDates: [],
      })
    ).toEqual([]);
  });
});
