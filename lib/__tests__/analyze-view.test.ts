import { describe, it, expect } from "vitest";
import {
  benchmarkState,
  buildAnalyzeOptions,
  cardioMetricValue,
  coerceCardioMetric,
  coerceKind,
  coerceRange,
  coerceStrengthMetric,
  defaultMetric,
  bestText,
  e1rmText,
  firstName,
  formatIntensity,
  formatRatio,
  newestFirst,
  rangeFilter,
  strengthMetricValue,
} from "@/lib/analyze-view";
import type { CardioStat, SportStat, ExerciseStat } from "@/lib/queries";

// Minimal fixtures — only the fields the pure helpers actually read.
const cardio = (o: Partial<CardioStat> & { activity: string }): CardioStat =>
  ({ hasDistance: false, ...o }) as CardioStat;
const strengthStat = (exercise: string): ExerciseStat =>
  ({ exercise }) as ExerciseStat;
const sportStat = (sport: string): SportStat => ({ sport }) as SportStat;

describe("coerceKind", () => {
  const all = { strength: true, cardio: true, sport: true };
  it("keeps a valid, available kind", () => {
    expect(coerceKind("cardio", all)).toBe("cardio");
    expect(coerceKind("sport", all)).toBe("sport");
  });
  it("falls back to the first available kind when the requested one is absent", () => {
    expect(
      coerceKind("cardio", { strength: true, cardio: false, sport: true })
    ).toBe("strength");
    expect(
      coerceKind("strength", { strength: false, cardio: true, sport: true })
    ).toBe("cardio");
    expect(
      coerceKind(undefined, { strength: false, cardio: false, sport: true })
    ).toBe("sport");
  });
});

describe("coerceRange", () => {
  it("accepts known ids and defaults unknown ones to 12w", () => {
    expect(coerceRange("6m")).toBe("6m");
    expect(coerceRange("all")).toBe("all");
    expect(coerceRange("nonsense")).toBe("12w");
    expect(coerceRange(undefined)).toBe("12w");
  });
});

describe("coerceStrengthMetric", () => {
  it("accepts known metrics and defaults to volume", () => {
    expect(coerceStrengthMetric("e1rm")).toBe("e1rm");
    expect(coerceStrengthMetric("bogus")).toBe("volume");
    expect(coerceStrengthMetric(undefined)).toBe("volume");
  });
});

describe("coerceCardioMetric", () => {
  it("distance/speed require a distance-bearing stat", () => {
    const withDist = cardio({ activity: "Run", hasDistance: true });
    const noDist = cardio({ activity: "Row", hasDistance: false });
    expect(coerceCardioMetric("distance", withDist)).toBe("distance");
    expect(coerceCardioMetric("speed", withDist)).toBe("speed");
    // No distance → distance/speed collapse to duration.
    expect(coerceCardioMetric("distance", noDist)).toBe("duration");
    expect(coerceCardioMetric("speed", noDist)).toBe("duration");
  });
  it("duration is always valid; the default follows hasDistance", () => {
    expect(
      coerceCardioMetric(
        "duration",
        cardio({ activity: "Run", hasDistance: true })
      )
    ).toBe("duration");
    expect(
      coerceCardioMetric(
        undefined,
        cardio({ activity: "Run", hasDistance: true })
      )
    ).toBe("distance");
    expect(coerceCardioMetric(undefined, cardio({ activity: "Row" }))).toBe(
      "duration"
    );
  });
});

describe("defaultMetric", () => {
  it("routes by kind", () => {
    expect(defaultMetric("sport", "anything")).toBe("duration");
    expect(defaultMetric("strength", "e1rm")).toBe("e1rm");
    expect(
      defaultMetric(
        "cardio",
        "distance",
        cardio({ activity: "Run", hasDistance: true })
      )
    ).toBe("distance");
  });
});

describe("firstName", () => {
  it("returns the first item of the active kind, else null", () => {
    const s = [strengthStat("Squat")];
    const c = [cardio({ activity: "Run" })];
    const sp = [sportStat("Tennis")];
    expect(firstName("strength", s, c, sp)).toBe("Squat");
    expect(firstName("cardio", s, c, sp)).toBe("Run");
    expect(firstName("sport", s, c, sp)).toBe("Tennis");
    expect(firstName("strength", [], c, sp)).toBeNull();
  });
});

describe("buildAnalyzeOptions", () => {
  it("labels duplicate item names across kinds with their kind, unique ones plain", () => {
    const opts = buildAnalyzeOptions({
      strength: [strengthStat("Rowing")],
      cardio: [cardio({ activity: "Rowing", hasDistance: true })],
      sports: [sportStat("Tennis")],
      activeRange: "12w",
    });
    const rowingStrength = opts.find((o) => o.kind === "strength")!;
    const rowingCardio = opts.find((o) => o.kind === "cardio")!;
    const tennis = opts.find((o) => o.kind === "sport")!;
    expect(rowingStrength.label).toBe("Rowing (Strength)");
    expect(rowingCardio.label).toBe("Rowing (Cardio)");
    expect(tennis.label).toBe("Tennis");
  });
  it("encodes href params (kind/item/metric/range)", () => {
    const [opt] = buildAnalyzeOptions({
      strength: [strengthStat("Bench Press")],
      cardio: [],
      sports: [],
      activeRange: "6m",
      metric: "e1rm",
    });
    expect(opt.href).toContain("kind=strength");
    expect(opt.href).toContain("item=Bench+Press");
    expect(opt.href).toContain("metric=e1rm");
    expect(opt.href).toContain("range=6m");
  });
});

describe("rangeFilter", () => {
  const rows = [
    { date: "2026-01-01" },
    { date: "2026-03-01" },
    { date: "2026-06-01" },
  ];
  it("keeps rows on/after fromDate; passes all through when null", () => {
    expect(rangeFilter(rows, "2026-03-01")).toEqual([
      { date: "2026-03-01" },
      { date: "2026-06-01" },
    ]);
    expect(rangeFilter(rows, null)).toEqual(rows);
  });
});

describe("newestFirst", () => {
  it("sorts by date desc, breaking ties by activityId desc", () => {
    const rows = [
      { date: "2026-01-01", activityId: 5 },
      { date: "2026-02-01", activityId: 1 },
      { date: "2026-01-01", activityId: 9 },
    ];
    expect([...rows].sort(newestFirst)).toEqual([
      { date: "2026-02-01", activityId: 1 },
      { date: "2026-01-01", activityId: 9 },
      { date: "2026-01-01", activityId: 5 },
    ]);
  });
});

describe("strengthMetricValue", () => {
  const session = {
    volumeKg: 1000,
    e1rmKg: 100,
    topWeightKg: 80,
    totalReps: 30,
  } as Parameters<typeof strengthMetricValue>[0];
  it("returns display-unit numbers, null for missing weights, reps verbatim", () => {
    expect(strengthMetricValue(session, "volume", "kg")).toBe(1000);
    expect(strengthMetricValue(session, "e1rm", "kg")).toBe(100);
    expect(strengthMetricValue(session, "top", "kg")).toBe(80);
    expect(strengthMetricValue(session, "reps", "kg")).toBe(30);
    expect(
      strengthMetricValue({ ...session, e1rmKg: null }, "e1rm", "kg")
    ).toBeNull();
    expect(
      strengthMetricValue({ ...session, topWeightKg: null }, "top", "kg")
    ).toBeNull();
  });
});

describe("cardioMetricValue", () => {
  const s = { distanceKm: 5, durationMin: 30.4, speedKmh: 10 } as Parameters<
    typeof cardioMetricValue
  >[0];
  it("selects and rounds per metric; null speed stays null", () => {
    expect(cardioMetricValue(s, "distance", "km")).toBe(5);
    expect(cardioMetricValue(s, "duration", "km")).toBe(30); // Math.round
    expect(cardioMetricValue(s, "speed", "km")).toBe(10);
    expect(
      cardioMetricValue({ ...s, speedKmh: null }, "speed", "km")
    ).toBeNull();
  });
});

describe("bestText / e1rmText", () => {
  const base = {
    topWeightKg: 80,
    topReps: 5,
    e1rmKg: 93,
  } as Parameters<typeof bestText>[0];
  it("formats present values and em-dashes missing ones", () => {
    expect(bestText(base, "kg")).toBe("80 kg × 5");
    expect(bestText({ ...base, topWeightKg: null }, "kg")).toBe("—");
    expect(bestText({ ...base, topReps: null }, "kg")).toBe("—");
    expect(e1rmText(base, "kg")).toBe("93 kg");
    expect(e1rmText({ ...base, e1rmKg: null }, "kg")).toBe("—");
  });
});

describe("formatIntensity / formatRatio", () => {
  it("capitalizes intensity, em-dashes empty", () => {
    expect(formatIntensity("hard")).toBe("Hard");
    expect(formatIntensity("  easy  ")).toBe("Easy");
    expect(formatIntensity(null)).toBe("—");
    expect(formatIntensity("   ")).toBe("—");
  });
  it("prints whole ratios plainly, fractions to 2dp", () => {
    expect(formatRatio(2)).toBe("2");
    expect(formatRatio(1.5)).toBe("1.50");
  });
});

describe("benchmarkState (bodyweight-band model)", () => {
  // Bench Press male @80 kg floors = [40, 60, 80, 120, 160] for
  // beginner/novice/intermediate/advanced/elite.
  it("places the lifter and flags the ranked level (interior)", () => {
    const st = benchmarkState("Bench Press", "male", 100, 80)!; // clears 80, not 120
    expect(st).not.toBeNull();
    expect(st.currentLevel.level).toBe("intermediate");
    expect(st.currentLevel.label).toBe("Intermediate");
    expect(st.isUntrained).toBe(false);
    expect(st.rankedLevelLabel).toBe("Intermediate");
    // The five named level floors, sorted by kg descending, no injected current.
    expect(st.rows.map((r) => r.type)).toEqual([
      "level",
      "level",
      "level",
      "level",
      "level",
    ]);
    expect(st.rows[0].valueKg).toBeGreaterThan(st.rows[4].valueKg);
  });

  it("injects a Current row (and no ranked label) when untrained", () => {
    const st = benchmarkState("Bench Press", "male", 30, 80)!; // below the 40 floor
    expect(st.isUntrained).toBe(true);
    expect(st.rankedLevelLabel).toBeNull();
    expect(st.rows.some((r) => r.type === "current")).toBe(true);
  });

  it("hides (null) without a bodyweight, sex, or for an uncovered lift", () => {
    expect(benchmarkState("Bench Press", "male", 180, null)).toBeNull();
    expect(benchmarkState("Bench Press", null, 180, 80)).toBeNull();
    expect(benchmarkState("Dumbbell Curl", "male", 180, 80)).toBeNull();
  });
});
