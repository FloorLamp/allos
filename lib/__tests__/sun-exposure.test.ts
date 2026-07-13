import { describe, it, expect } from "vitest";
import {
  decideSunExposure,
  sunExposureSignalKey,
  SUN_EXPOSURE_PREFIX,
  LOW_WEEKLY_DAYLIGHT_MIN,
  type SunExposureInput,
} from "../sun-exposure";
import { dedupeKeyHasKnownPrefix } from "../rule-finding-prefixes";

const base: SunExposureInput = {
  hasHomeLocation: true,
  avgWeeklyDaylightMin: 20,
  vitaminDStatus: "below",
  vitaminDValue: 22,
  vitaminDUnit: "ng/mL",
  vitaminDDate: "2024-06-01",
};

describe("decideSunExposure", () => {
  it("emits when home set, vitamin D below optimal, and daylight is scarce", () => {
    const obs = decideSunExposure(base);
    expect(obs).not.toBeNull();
    expect(obs!.dedupeKey).toBe(sunExposureSignalKey("2024-06-01"));
    // Observational: names both facts, prescribes nothing (no "get more sun/UV").
    expect(obs!.detail).toMatch(/vitamin D/i);
    expect(obs!.detail).not.toMatch(/\bmore sun\b|\bUV\b|should|must/i);
  });

  it("is null without a home location", () => {
    expect(decideSunExposure({ ...base, hasHomeLocation: false })).toBeNull();
  });

  it("is null when vitamin D is not below optimal", () => {
    expect(
      decideSunExposure({ ...base, vitaminDStatus: "optimal" })
    ).toBeNull();
    expect(
      decideSunExposure({ ...base, vitaminDStatus: "unknown" })
    ).toBeNull();
  });

  it("is null when daylight exposure is already at/above the threshold", () => {
    expect(
      decideSunExposure({
        ...base,
        avgWeeklyDaylightMin: LOW_WEEKLY_DAYLIGHT_MIN,
      })
    ).toBeNull();
    expect(
      decideSunExposure({ ...base, avgWeeklyDaylightMin: 200 })
    ).toBeNull();
  });

  it("is null without a vitamin D date (no episode to key on)", () => {
    expect(decideSunExposure({ ...base, vitaminDDate: null })).toBeNull();
  });
});

describe("dedupeKey namespace", () => {
  it("is registered so page dismiss guards match it", () => {
    expect(
      sunExposureSignalKey("2024-06-01").startsWith(SUN_EXPOSURE_PREFIX)
    ).toBe(true);
    expect(dedupeKeyHasKnownPrefix(sunExposureSignalKey("2024-06-01"))).toBe(
      true
    );
  });
});
