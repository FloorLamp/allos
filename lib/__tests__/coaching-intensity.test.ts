import { describe, it, expect } from "vitest";
import {
  intensityRecommendation,
  recommendCoaching,
  type CoachingInput,
} from "../coaching";
import type { PolarizedSplit } from "../training-zones";

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
