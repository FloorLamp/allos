import { describe, it, expect } from "vitest";
import { parseQuickLog } from "@/lib/palette-quick-log";

describe("parseQuickLog", () => {
  it("returns null for non-commands (falls through to search)", () => {
    expect(parseQuickLog("", "kg")).toBeNull();
    expect(parseQuickLog("bench press", "kg")).toBeNull();
    expect(parseQuickLog("running 5k", "kg")).toBeNull();
    // A bare keyword with no value is not a command yet.
    expect(parseQuickLog("weight", "kg")).toBeNull();
    expect(parseQuickLog("w", "kg")).toBeNull();
  });

  it("parses a plain weight in the login's unit", () => {
    const r = parseQuickLog("weight 82.5", "kg");
    expect(r).toMatchObject({
      type: "weight",
      value: 82.5,
      unit: "kg",
      error: null,
    });
    expect(r?.label).toBe("Log weight · 82.5 kg");
  });

  it("uses the login's preferred unit when none is given", () => {
    expect(parseQuickLog("weight 180", "lb")).toMatchObject({
      value: 180,
      unit: "lb",
      error: null,
    });
  });

  it("accepts short aliases and integer values", () => {
    expect(parseQuickLog("wt 90", "kg")).toMatchObject({
      value: 90,
      unit: "kg",
    });
    expect(parseQuickLog("bw 200", "lb")).toMatchObject({
      value: 200,
      unit: "lb",
    });
    expect(parseQuickLog("w 75", "kg")).toMatchObject({
      value: 75,
      unit: "kg",
    });
  });

  it("honors an explicit trailing unit over the preference", () => {
    expect(parseQuickLog("weight 180 lb", "kg")).toMatchObject({
      value: 180,
      unit: "lb",
    });
    expect(parseQuickLog("weight 82kg", "lb")).toMatchObject({
      value: 82,
      unit: "kg",
    });
    expect(parseQuickLog("weight 180lbs", "kg")).toMatchObject({
      value: 180,
      unit: "lb",
    });
  });

  it("is case-insensitive on the keyword and unit", () => {
    expect(parseQuickLog("Weight 82.5", "kg")).toMatchObject({ value: 82.5 });
    expect(parseQuickLog("WEIGHT 82.5 KG", "lb")).toMatchObject({
      value: 82.5,
      unit: "kg",
    });
  });

  it("recognizes the command but flags a non-numeric value", () => {
    const r = parseQuickLog("weight abc", "kg");
    expect(r?.type).toBe("weight");
    expect(r?.error).toBeTruthy();
  });

  it("reuses the body-metric range guard to reject impossible values", () => {
    // 0 and negative are rejected by validateBodyMetricInput.
    expect(parseQuickLog("weight 0", "kg")?.error).toBeTruthy();
  });
});
