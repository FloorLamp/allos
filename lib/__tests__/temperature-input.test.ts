// PURE TIER — manual body-temperature entry (issue #800). Covers the boundary
// conversion + range guard shared by the vitals form, the illness symptom-card quick
// entry, and the write core, and proves the SHIPPED canonical "Body Temperature" range
// flags a fever "high" through the same reconciledFlag path every lab uses.

import { describe, expect, it } from "vitest";
import {
  detectTemperatureUnit,
  resolveTemperatureUnit,
  toCanonicalTempF,
  temperatureRangeError,
  celsiusToF,
  TEMP_MIN_F,
  TEMP_MAX_F,
  VITAL_CANONICAL,
} from "@/lib/vitals-input";
import { reconciledFlag } from "@/lib/reference-range";
import type { CanonicalBiomarker } from "@/lib/types";
import canonical from "@/lib/canonical-biomarkers.json";

const rows = (canonical as { biomarkers: unknown[] })
  .biomarkers as CanonicalBiomarker[];
const bodyTemp = rows.find((b) => b.name === "Body Temperature");

describe("toCanonicalTempF — °C/°F boundary conversion", () => {
  it("converts °C to °F via the exact Health Connect factor", () => {
    // 39.5 °C is the issue's fever example.
    expect(toCanonicalTempF(39.5, "C")).toBe(103.1);
    expect(toCanonicalTempF(37, "C")).toBe(98.6);
    expect(toCanonicalTempF(39.5, "C")).toBe(celsiusToF(39.5));
  });

  it("passes °F through unchanged (already canonical)", () => {
    expect(toCanonicalTempF(100.4, "F")).toBe(100.4);
    // A missing/garbage unit defaults to °F (the canonical unit).
    expect(toCanonicalTempF(100.4, null)).toBe(100.4);
    expect(toCanonicalTempF(100.4, "")).toBe(100.4);
  });
});

describe("temperature unit detection", () => {
  it("detects plausible body-temperature scales from the reading", () => {
    expect(detectTemperatureUnit(37)).toBe("C");
    expect(detectTemperatureUnit(39.5)).toBe("C");
    expect(detectTemperatureUnit(98.6)).toBe("F");
    expect(detectTemperatureUnit(104)).toBe("F");
  });

  it("keeps the selected unit while typing or outside both plausible ranges", () => {
    expect(detectTemperatureUnit(3)).toBeNull();
    expect(detectTemperatureUnit(60)).toBeNull();
    expect(resolveTemperatureUnit(60, "C")).toBe("C");
    expect(resolveTemperatureUnit(60, "F")).toBe("F");
  });

  it("uses detection when the selected unit does not match the reading", () => {
    expect(resolveTemperatureUnit(37, "F")).toBe("C");
    expect(resolveTemperatureUnit(98.6, "C")).toBe("F");
  });
});

describe("temperatureRangeError — canonical °F bounds", () => {
  it("accepts plausible readings and rejects the physiologically impossible", () => {
    expect(temperatureRangeError(98.6)).toBeNull();
    expect(temperatureRangeError(103.1)).toBeNull(); // a real fever is in range
    expect(temperatureRangeError(TEMP_MIN_F)).toBeNull();
    expect(temperatureRangeError(TEMP_MAX_F)).toBeNull();
    expect(temperatureRangeError(TEMP_MIN_F - 0.1)).toBe(
      "Body temperature is out of range."
    );
    expect(temperatureRangeError(TEMP_MAX_F + 0.1)).toBe(
      "Body temperature is out of range."
    );
  });
});

describe("canonical Body Temperature range + reconciledFlag", () => {
  it("ships a canonical vitals entry in °F matching the manual/HC identity", () => {
    expect(bodyTemp).toBeTruthy();
    expect(bodyTemp!.category).toBe("vitals");
    expect(bodyTemp!.unit).toBe("degF");
    // The manual write core writes this exact canonical shape (one-series #482).
    expect(VITAL_CANONICAL.temperature).toMatchObject({
      canonical: "Body Temperature",
      category: "vitals",
      unit: "degF",
    });
  });

  it("derives 'high' on a fever reading and no flag on a normal one", () => {
    const cb = bodyTemp!;
    // 39.5 °C → 103.1 °F flags high like any out-of-range lab.
    expect(reconciledFlag(null, toCanonicalTempF(39.5, "C"), "degF", cb)).toBe(
      "high"
    );
    // A normal 37 °C → 98.6 °F carries no derived out-of-range flag.
    expect(
      reconciledFlag(null, toCanonicalTempF(37, "C"), "degF", cb)
    ).toBeUndefined();
    // A °F reading entered directly flags the same way.
    expect(reconciledFlag(null, 100.4, "degF", cb)).toBe("high");
  });
});
