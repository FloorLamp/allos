import { describe, expect, it } from "vitest";
import {
  decideUvOverexposure,
  uvOverexposureSignalKey,
  UV_EXPOSURE_PREFIX,
} from "../uv-overexposure";
import type { UvDoseResult } from "../uv-dose";

function dose(over: Partial<UvDoseResult> = {}): UvDoseResult {
  return {
    uvSource: "live",
    outdoorMinutes: 90,
    uvMinutes: 540,
    sed: 8.1,
    meaningfulUvMinutes: 90,
    vitaminDSed: 8.1,
    sufficient: true,
    peakUvIndex: 6,
    minutesToBurn: 28,
    overexposed: true,
    ...over,
  };
}

describe("decideUvOverexposure — care-tier burn warning (#1172)", () => {
  it("fires when the dose crossed the skin-type MED (overexposed)", () => {
    const obs = decideUvOverexposure("2026-07-20", dose());
    expect(obs).not.toBeNull();
    expect(obs!.dedupeKey).toBe(uvOverexposureSignalKey("2026-07-20"));
    expect(obs!.detail).toContain("90 min");
    expect(obs!.detail).toContain("28 min");
  });

  it("stays silent without a skin type (overexposed null)", () => {
    expect(
      decideUvOverexposure("2026-07-20", dose({ overexposed: null }))
    ).toBeNull();
  });

  it("stays silent below the threshold (overexposed false)", () => {
    expect(
      decideUvOverexposure("2026-07-20", dose({ overexposed: false }))
    ).toBeNull();
  });

  it("stays silent with no UV signal (minutes-only)", () => {
    expect(
      decideUvOverexposure(
        "2026-07-20",
        dose({ uvSource: "none", overexposed: null })
      )
    ).toBeNull();
  });

  it("keys the dedupeKey under the registered prefix", () => {
    expect(
      uvOverexposureSignalKey("2026-07-20").startsWith(UV_EXPOSURE_PREFIX)
    ).toBe(true);
  });
});
