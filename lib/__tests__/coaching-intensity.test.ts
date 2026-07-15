import { describe, it, expect } from "vitest";
import {
  intensityRecommendation,
  recommendCoaching,
  type CoachingInput,
} from "../coaching";
import {
  isLoadingDay,
  loadingDates,
  DAY_LOADING_DURATION_FLOOR_MIN,
  type PolarizedSplit,
} from "../training-zones";

function split(easyMin: number, hardMin: number): PolarizedSplit {
  const total = easyMin + hardMin;
  return {
    easyMin,
    hardMin,
    totalMin: total,
    easyPct: total ? Math.round((easyMin / total) * 100) : 0,
    hardPct: total ? Math.round((hardMin / total) * 100) : 0,
  };
}

describe("intensityRecommendation", () => {
  it("fires a caution nudge when the split is hard-heavy", () => {
    const rec = intensityRecommendation(split(55, 45)); // 45% hard, 100 min
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe("intensity");
    expect(rec!.tone).toBe("caution");
    expect(rec!.detail).toContain("45%");
  });

  it("stays silent when balanced", () => {
    expect(intensityRecommendation(split(80, 20))).toBeNull();
  });

  it("stays silent below the minimum volume", () => {
    expect(intensityRecommendation(split(0, 40))).toBeNull();
  });

  it("stays silent with no signal", () => {
    expect(intensityRecommendation(null)).toBeNull();
    expect(intensityRecommendation(undefined)).toBeNull();
  });
});

describe("recommendCoaching threads the intensity nudge in as context", () => {
  const base: CoachingInput = {
    today: "2026-07-10",
    routine: [],
    strength: [],
    cardio: [{ activity: "Running", lastDate: "2026-07-09" }],
    trainingDates: ["2026-07-09"],
    sleep: null,
    restingHr: null,
  };

  it("appends the hard-heavy nudge after the training recommendations", () => {
    const recs = recommendCoaching({ ...base, intensity: split(55, 45) });
    expect(recs.some((r) => r.kind === "intensity")).toBe(true);
    // It's trailing context, never the top-line "one clear thing".
    expect(recs[0].kind).not.toBe("intensity");
  });

  it("omits it when balanced", () => {
    const recs = recommendCoaching({ ...base, intensity: split(85, 15) });
    expect(recs.some((r) => r.kind === "intensity")).toBe(false);
  });
});

// Issue #754: the pure loading-vs-easy day classifier the gather feeds the
// overtraining/load rest triggers.
describe("isLoadingDay", () => {
  const d = "2026-07-10";

  it("counts an HR-hard day as loading", () => {
    // 60 min, 40% hard — well above the aerobic threshold.
    expect(isLoadingDay({ date: d, split: split(60, 40) })).toBe(true);
  });

  it("counts an almost-entirely-easy HR day as NOT loading", () => {
    // 60 min, ~8% hard — a recovery Zone 2 day.
    expect(isLoadingDay({ date: d, split: split(55, 5) })).toBe(false);
  });

  it("ignores a too-thin HR split and falls back to duration", () => {
    // Only 6 HR minutes — below the trust floor — so the duration floor decides.
    const thin = split(2, 4); // hard-heavy but only 6 min total
    expect(isLoadingDay({ date: d, split: thin, durationMin: 15 })).toBe(false); // short session → easy
    expect(
      isLoadingDay({
        date: d,
        split: thin,
        durationMin: DAY_LOADING_DURATION_FLOOR_MIN,
      })
    ).toBe(true); // long session, unknown intensity → loading
  });

  it("uses the duration floor when no HR data exists", () => {
    expect(isLoadingDay({ date: d, durationMin: 20 })).toBe(false);
    expect(isLoadingDay({ date: d, durationMin: 45 })).toBe(true);
  });

  it("defaults to loading when intensity is genuinely unknown", () => {
    expect(isLoadingDay({ date: d })).toBe(true);
    expect(isLoadingDay({ date: d, split: null, durationMin: null })).toBe(
      true
    );
  });

  it("lets declared planned intent win over observed signals", () => {
    // A planned easy/deload day is non-loading even with a hard-looking HR split…
    expect(
      isLoadingDay({ date: d, split: split(10, 90), plannedIntent: "easy" })
    ).toBe(false);
    // …and a planned hard day is loading even with an easy split.
    expect(
      isLoadingDay({ date: d, split: split(90, 10), plannedIntent: "hard" })
    ).toBe(true);
  });
});

describe("loadingDates", () => {
  it("keeps only the loading days, in order", () => {
    expect(
      loadingDates([
        { date: "2026-07-08", split: split(40, 40) }, // hard → loading
        { date: "2026-07-09", split: split(58, 2) }, // easy → dropped
        { date: "2026-07-10", durationMin: 60 }, // long, no HR → loading
        { date: "2026-07-11", durationMin: 10 }, // short → dropped
      ])
    ).toEqual(["2026-07-08", "2026-07-10"]);
  });
});
