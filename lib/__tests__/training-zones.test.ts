import { describe, it, expect } from "vitest";
import {
  activityWindow,
  activityWindows,
  buildZoneModel,
  classifyPolarization,
  estimateMaxHr,
  polarizedSplit,
  resolveMaxHr,
  scopeBucketsToWindows,
  weeklyZoneMinutes,
  zone2Adherence,
  zone2Minutes,
  zoneForBpm,
  zoneMinuteTotals,
  type HrBucket,
  type ZoneModel,
} from "../training-zones";

describe("estimateMaxHr (Tanaka)", () => {
  it("is 208 − 0.7 × age, rounded", () => {
    expect(estimateMaxHr(40)).toBe(180); // 208 - 28 = 180
    expect(estimateMaxHr(30)).toBe(187); // 208 - 21 = 187
    expect(estimateMaxHr(25)).toBe(191); // 208 - 17.5 = 190.5 → 191
  });
});

describe("resolveMaxHr (override vs estimate)", () => {
  it("prefers a valid override over the age estimate", () => {
    expect(resolveMaxHr({ override: 190, age: 40 })).toEqual({
      maxHr: 190,
      source: "override",
    });
  });

  it("falls back to the age estimate when no override", () => {
    expect(resolveMaxHr({ override: null, age: 40 })).toEqual({
      maxHr: 180,
      source: "estimated",
    });
  });

  it("ignores a non-positive override", () => {
    expect(resolveMaxHr({ override: 0, age: 40 })?.source).toBe("estimated");
  });

  it("returns null when neither override nor age is known", () => {
    expect(resolveMaxHr({ override: null, age: null })).toBeNull();
  });
});

describe("buildZoneModel", () => {
  it("uses Karvonen (heart-rate reserve) when a resting HR is present", () => {
    // max 180, resting 60 → HRR 120. Z1..Z5 lower = 60 + f×120.
    const m = buildZoneModel({ age: 40, restingHr: 60 })!;
    expect(m.method).toBe("karvonen");
    expect(m.maxHr).toBe(180);
    expect(m.restingHr).toBe(60);
    // 0.5→120, 0.6→132, 0.7→144, 0.8→156, 0.9→168
    expect(m.lowerBounds).toEqual([120, 132, 144, 156, 168]);
    expect(m.formula).toContain("Karvonen");
  });

  it("falls back to %-of-max when no resting HR", () => {
    const m = buildZoneModel({ age: 40, restingHr: null })!;
    expect(m.method).toBe("percent-max");
    // 0.5..0.9 × 180
    expect(m.lowerBounds).toEqual([90, 108, 126, 144, 162]);
    expect(m.formula).toContain("% of max HR");
  });

  it("honors a manual max-HR override", () => {
    const m = buildZoneModel({ age: 40, restingHr: null, maxHrOverride: 200 })!;
    expect(m.maxHr).toBe(200);
    expect(m.maxHrSource).toBe("override");
    expect(m.lowerBounds).toEqual([100, 120, 140, 160, 180]);
  });

  it("ignores an implausible resting HR (>= max) and uses %-max", () => {
    const m = buildZoneModel({ age: 40, restingHr: 200 })!;
    expect(m.method).toBe("percent-max");
  });

  it("returns null with no age and no override", () => {
    expect(buildZoneModel({ age: null, restingHr: 60 })).toBeNull();
  });
});

describe("zoneForBpm", () => {
  const model = buildZoneModel({ age: 40, restingHr: 60 })!; // bounds 120/132/144/156/168
  it("classifies each band and clamps the extremes", () => {
    expect(zoneForBpm(80, model)).toBe(1); // below Z2 floor → clamped Z1
    expect(zoneForBpm(120, model)).toBe(1);
    expect(zoneForBpm(135, model)).toBe(2);
    expect(zoneForBpm(150, model)).toBe(3);
    expect(zoneForBpm(160, model)).toBe(4);
    expect(zoneForBpm(170, model)).toBe(5);
    expect(zoneForBpm(250, model)).toBe(5); // above Z5 floor → clamped Z5
  });
});

describe("activityWindow", () => {
  it("bounds from explicit start/end times", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: "08:00",
        end_time: "08:45",
        duration_min: null,
      })
    ).toEqual({ start: "2026-07-01T08:00", end: "2026-07-01T08:45" });
  });

  it("derives the end from duration when no end_time", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: "08:00",
        end_time: null,
        duration_min: 90,
      })
    ).toEqual({ start: "2026-07-01T08:00", end: "2026-07-01T09:30" });
  });

  it("rolls the end across midnight when duration overflows the day", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: "23:30",
        end_time: null,
        duration_min: 60,
      })
    ).toEqual({ start: "2026-07-01T23:30", end: "2026-07-02T00:30" });
  });

  it("treats an end_time before start_time as a next-day rollover", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: "23:00",
        end_time: "00:30",
        duration_min: null,
      })
    ).toEqual({ start: "2026-07-01T23:00", end: "2026-07-02T00:30" });
  });

  it("returns null with no start time (can't be windowed)", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: null,
        end_time: "09:00",
        duration_min: 60,
      })
    ).toBeNull();
  });

  it("returns null when no end is derivable", () => {
    expect(
      activityWindow({
        date: "2026-07-01",
        start_time: "08:00",
        end_time: null,
        duration_min: null,
      })
    ).toBeNull();
  });
});

describe("scopeBucketsToWindows (activity-window scoping)", () => {
  it("keeps only buckets inside a window — all-day wear is excluded", () => {
    const windows = activityWindows([
      {
        date: "2026-07-01",
        start_time: "08:00",
        end_time: "08:30",
        duration_min: null,
      },
    ]);
    const buckets: HrBucket[] = [
      { ts: "2026-07-01T07:59", bpm: 100 }, // before window
      { ts: "2026-07-01T08:00", bpm: 100 }, // inclusive start
      { ts: "2026-07-01T08:15", bpm: 100 }, // inside
      { ts: "2026-07-01T08:30", bpm: 100 }, // exclusive end → excluded
      { ts: "2026-07-01T12:00", bpm: 100 }, // midday resting → excluded
    ];
    const scoped = scopeBucketsToWindows(buckets, windows);
    expect(scoped.map((b) => b.ts)).toEqual([
      "2026-07-01T08:00",
      "2026-07-01T08:15",
    ]);
  });

  it("returns nothing when there are no windows", () => {
    expect(
      scopeBucketsToWindows([{ ts: "2026-07-01T08:00", bpm: 120 }], [])
    ).toEqual([]);
  });
});

describe("weeklyZoneMinutes (week boundaries)", () => {
  const model = buildZoneModel({ age: 40, restingHr: 60 })!; // 120/132/144/156/168
  it("groups minutes by the profile week-start", () => {
    // 2026-07-01 is a Wednesday; 2026-06-30 a Tuesday.
    const scoped: HrBucket[] = [
      { ts: "2026-06-30T08:00", bpm: 135 }, // Z2
      { ts: "2026-06-30T08:01", bpm: 150 }, // Z3
      { ts: "2026-07-01T08:00", bpm: 135 }, // Z2, same Sun-start week as 06-30
    ];
    // weekStart = 0 (Sunday): week of 2026-06-28 holds all three.
    const sun = weeklyZoneMinutes(scoped, model, 0);
    expect(sun).toHaveLength(1);
    expect(sun[0].week).toBe("2026-06-28");
    expect(sun[0].minutes).toEqual([0, 2, 1, 0, 0]);
    expect(sun[0].total).toBe(3);
  });

  it("splits across weeks when the week-start differs", () => {
    const scoped: HrBucket[] = [
      { ts: "2026-06-28T08:00", bpm: 135 }, // Sunday
      { ts: "2026-06-29T08:00", bpm: 135 }, // Monday
    ];
    // weekStart = 1 (Monday): Sunday 06-28 is the tail of week 06-22; Monday
    // 06-29 opens week 06-29. Two distinct weeks.
    const mon = weeklyZoneMinutes(scoped, model, 1);
    expect(mon.map((w) => w.week)).toEqual(["2026-06-22", "2026-06-29"]);
  });
});

describe("zone2 target math", () => {
  it("reports met/pct against the target", () => {
    expect(zone2Adherence(150, 150)).toEqual({
      minutes: 150,
      target: 150,
      met: true,
      pct: 100,
    });
    expect(zone2Adherence(90, 150)).toMatchObject({ met: false, pct: 60 });
  });

  it("treats a zero/absent target as no target", () => {
    expect(zone2Adherence(90, 0)).toMatchObject({
      target: 0,
      met: false,
      pct: 0,
    });
  });

  it("zone2Minutes reads the Zone 2 slot of a week row", () => {
    expect(
      zone2Minutes({ week: "2026-06-28", minutes: [1, 40, 3, 0, 0], total: 44 })
    ).toBe(40);
    expect(zone2Minutes(undefined)).toBe(0);
  });

  it("zoneMinuteTotals sums per zone across all buckets", () => {
    const model = buildZoneModel({ age: 40, restingHr: 60 })!;
    const scoped: HrBucket[] = [
      { ts: "2026-07-01T08:00", bpm: 135 }, // Z2
      { ts: "2026-07-01T08:01", bpm: 135 }, // Z2
      { ts: "2026-07-01T08:02", bpm: 150 }, // Z3
    ];
    expect(zoneMinuteTotals(scoped, model)).toEqual([0, 2, 1, 0, 0]);
  });
});

describe("polarizedSplit + classifyPolarization", () => {
  const model = buildZoneModel({ age: 40, restingHr: 60 })!; // 120/132/144/156/168
  function buckets(easy: number, hard: number): HrBucket[] {
    const out: HrBucket[] = [];
    for (let i = 0; i < easy; i++) out.push({ ts: `t${i}`, bpm: 135 }); // Z2 easy
    for (let i = 0; i < hard; i++) out.push({ ts: `h${i}`, bpm: 160 }); // Z4 hard
    return out;
  }

  it("splits easy (Z1–Z2) from hard (Z3–Z5)", () => {
    const s = polarizedSplit(buckets(80, 20), model);
    expect(s).toMatchObject({
      easyMin: 80,
      hardMin: 20,
      totalMin: 100,
      easyPct: 80,
      hardPct: 20,
    });
  });

  it("flags hard-heavy when the hard share exceeds the limit with enough volume", () => {
    // 100 min total, 45 hard → 45% > 35% limit.
    expect(classifyPolarization(polarizedSplit(buckets(55, 45), model))).toBe(
      "hard-heavy"
    );
  });

  it("is balanced when hard stays within the limit", () => {
    expect(classifyPolarization(polarizedSplit(buckets(80, 20), model))).toBe(
      "balanced"
    );
  });

  it("is insufficient-data below the minimum volume", () => {
    // 40 min total (< 90), even if all hard.
    expect(classifyPolarization(polarizedSplit(buckets(0, 40), model))).toBe(
      "insufficient-data"
    );
  });

  it("reports zero percentages for an empty set", () => {
    const empty = polarizedSplit([], model as ZoneModel);
    expect(empty).toMatchObject({ totalMin: 0, easyPct: 0, hardPct: 0 });
  });
});
