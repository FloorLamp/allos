import { describe, expect, it } from "vitest";
import {
  intensityToTier,
  metsForActivity,
  estimateKcal,
  nearestBodyweightKg,
  estimateActivityKcal,
  activityEstimateKcal,
  totalEstimatedKcal,
  isEstimable,
  formatEstimatedKcal,
  type EstimableActivity,
} from "@/lib/calorie-estimate";

// Pure estimator for manual-activity calorie estimates (issue #151):
// kcal = METs × weight(kg) × hours, using the nearest-in-time bodyweight, with a
// tested missing-bodyweight fallback and a tested estimate-vs-measured distinction.

describe("intensityToTier", () => {
  it("maps the form's intensity labels to tiers", () => {
    expect(intensityToTier("easy")).toBe("easy");
    expect(intensityToTier("moderate")).toBe("moderate");
    expect(intensityToTier("hard")).toBe("hard");
  });
  it("defaults null / unknown to moderate", () => {
    expect(intensityToTier(null)).toBe("moderate");
    expect(intensityToTier("")).toBe("moderate");
    expect(intensityToTier("blistering")).toBe("moderate");
  });
});

describe("metsForActivity", () => {
  it("resolves a catalog name (case-insensitive) at the right tier", () => {
    const easy = metsForActivity("Running", "cardio", "easy");
    const hard = metsForActivity("running", "cardio", "hard");
    expect(easy).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(easy!);
  });
  it("falls back to the per-type default for an unknown name", () => {
    const unknown = metsForActivity(
      "Underwater Basket Weaving",
      "cardio",
      null
    );
    const def = metsForActivity(
      "Definitely Not A Catalog Name",
      "cardio",
      null
    );
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBe(def); // both hit the cardio default
  });
  it("scores strength lifts via the strength type default (never enumerated)", () => {
    const mets = metsForActivity("Barbell Bench Press", "strength", "moderate");
    expect(mets).toBe(5.0); // TYPE_DEFAULTS.strength.moderate
  });
});

describe("estimateKcal", () => {
  it("computes METs × weight × hours, rounded", () => {
    // 8 METs, 80 kg, 60 min → 8 * 80 * 1 = 640
    expect(estimateKcal(8, 80, 60)).toBe(640);
    // 10 METs, 70 kg, 30 min → 10 * 70 * 0.5 = 350
    expect(estimateKcal(10, 70, 30)).toBe(350);
  });
  it("returns null when the bodyweight is missing (the missing-bodyweight fallback)", () => {
    expect(estimateKcal(8, null, 60)).toBeNull();
    expect(estimateKcal(8, 0, 60)).toBeNull();
    expect(estimateKcal(8, -5, 60)).toBeNull();
  });
  it("returns null for a missing/zero MET or duration", () => {
    expect(estimateKcal(null, 80, 60)).toBeNull();
    expect(estimateKcal(0, 80, 60)).toBeNull();
    expect(estimateKcal(8, 80, null)).toBeNull();
    expect(estimateKcal(8, 80, 0)).toBeNull();
  });
});

describe("nearestBodyweightKg", () => {
  const series = [
    { date: "2026-01-01", weightKg: 80 },
    { date: "2026-02-01", weightKg: 82 },
    { date: "2026-03-01", weightKg: 84 },
  ];
  it("picks the weigh-in nearest the activity date (either side)", () => {
    expect(nearestBodyweightKg(series, "2026-01-05")).toBe(80);
    expect(nearestBodyweightKg(series, "2026-02-20")).toBe(84); // closer to Mar 1
    expect(nearestBodyweightKg(series, "2026-03-15")).toBe(84);
  });
  it("breaks ties toward the more recent reading", () => {
    // Exactly between Jan 1 and Mar 1 (Feb 1 is also present and wins outright),
    // but test a clean two-sided tie with only the endpoints.
    const ends = [
      { date: "2026-01-01", weightKg: 80 },
      { date: "2026-01-03", weightKg: 90 },
    ];
    expect(nearestBodyweightKg(ends, "2026-01-02")).toBe(90);
  });
  it("returns null with no usable weights (missing-bodyweight)", () => {
    expect(nearestBodyweightKg([], "2026-01-01")).toBeNull();
    expect(
      nearestBodyweightKg([{ date: "2026-01-01", weightKg: 0 }], "2026-01-01")
    ).toBeNull();
  });
});

const cardioActivity = (
  over: Partial<EstimableActivity> = {}
): EstimableActivity => ({
  type: "cardio",
  title: "Running",
  intensity: "moderate",
  duration_min: 60,
  components: JSON.stringify([
    { name: "Running", type: "cardio", distance_km: null, duration_min: 60 },
  ]),
  source: null,
  ...over,
});

describe("estimateActivityKcal", () => {
  it("estimates a single-component cardio activity from its own duration", () => {
    const kcal = estimateActivityKcal(cardioActivity(), 80);
    // Running moderate MET (9.8) × 80 kg × 1 h = 784
    expect(kcal).toBe(784);
  });
  it("sums multi-part components each on its own MET and duration", () => {
    const brick = cardioActivity({
      title: "Brick",
      duration_min: null,
      components: JSON.stringify([
        {
          name: "Cycling",
          type: "cardio",
          distance_km: null,
          duration_min: 30,
        },
        {
          name: "Running",
          type: "cardio",
          distance_km: null,
          duration_min: 30,
        },
      ]),
    });
    const cyc = estimateKcal(
      metsForActivity("Cycling", "cardio", "moderate"),
      80,
      30
    )!;
    const run = estimateKcal(
      metsForActivity("Running", "cardio", "moderate"),
      80,
      30
    )!;
    expect(estimateActivityKcal(brick, 80)).toBe(cyc + run);
  });
  it("uses the overall duration with the primary MET when components carry none", () => {
    const strength = cardioActivity({
      type: "strength",
      title: "Push day",
      duration_min: 45,
      components: JSON.stringify([
        {
          name: "Barbell Bench Press",
          type: "strength",
          distance_km: null,
          duration_min: null,
        },
      ]),
    });
    // strength moderate default 5.0 × 80 × 0.75 = 300
    expect(estimateActivityKcal(strength, 80)).toBe(300);
  });
  it("returns null with no bodyweight (missing-bodyweight fallback)", () => {
    expect(estimateActivityKcal(cardioActivity(), null)).toBeNull();
  });
  it("returns null when there is no usable duration anywhere", () => {
    const noDur = cardioActivity({
      duration_min: null,
      components: JSON.stringify([
        {
          name: "Running",
          type: "cardio",
          distance_km: null,
          duration_min: null,
        },
      ]),
    });
    expect(estimateActivityKcal(noDur, 80)).toBeNull();
  });
});

describe("isEstimable + estimate/measured distinction", () => {
  it("estimates ONLY manual activities — never an imported (device) row", () => {
    expect(isEstimable({ source: null })).toBe(true);
    expect(isEstimable({ source: "strava" })).toBe(false);
    // An imported row yields no estimate even with a stored value + bodyweight, so
    // an estimate can never shadow a device-measured value.
    expect(
      activityEstimateKcal(
        { ...cardioActivity(), source: "strava", est_calories: 500 },
        80
      )
    ).toBeNull();
  });
  it("prefers the stored override/snapshot over a fresh computation", () => {
    const withOverride = { ...cardioActivity(), est_calories: 999 };
    expect(activityEstimateKcal(withOverride, 80)).toBe(999);
    // With no stored value it computes from the dataset instead.
    expect(activityEstimateKcal(cardioActivity(), 80)).toBe(784);
  });
});

describe("totalEstimatedKcal", () => {
  it("sums estimates across dated activities, each on its nearest bodyweight, skipping non-manual", () => {
    const weights = [{ date: "2026-01-01", weightKg: 80 }];
    const acts = [
      { ...cardioActivity(), date: "2026-01-01" }, // manual: 784
      { ...cardioActivity(), date: "2026-01-02", source: "strava" }, // imported: 0
      {
        ...cardioActivity(),
        date: "2026-01-03",
        est_calories: 100,
      }, // manual override: 100
    ];
    expect(totalEstimatedKcal(acts, weights)).toBe(884);
  });
  it("contributes nothing when there is no bodyweight to score against", () => {
    const acts = [{ ...cardioActivity(), date: "2026-01-01" }];
    expect(totalEstimatedKcal(acts, [])).toBe(0);
  });
});

describe("formatEstimatedKcal", () => {
  it("marks the value as an estimate with ≈ and thousands separators", () => {
    expect(formatEstimatedKcal(1234)).toBe("≈ 1,234 kcal");
  });
  it("returns null for a null/zero value (no chip)", () => {
    expect(formatEstimatedKcal(null)).toBeNull();
    expect(formatEstimatedKcal(0)).toBeNull();
  });
});
