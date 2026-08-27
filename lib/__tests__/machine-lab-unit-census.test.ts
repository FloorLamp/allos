import { describe, expect, it } from "vitest";
import {
  MACHINE_LAB_UNIT_RE,
  machineLabUnitHits,
} from "@/lib/machine-lab-unit-census";

describe("the machine-spelled lab-unit matcher (#3545)", () => {
  it("sees every supported ASCII micro token, including spaced slashes", () => {
    expect(machineLabUnitHits("CoQ10 1.2 ug/mL · Lead 2 ug / dL")).toEqual([
      "ug",
      "ug",
    ]);
    expect(
      machineLabUnitHits("WBC 5.8 10^3/uL · 6 uIU / mL · 2 uU/mL · 9 umol / L")
    ).toEqual(["uL", "uIU", "uU", "umol"]);
  });

  it("stays quiet on display spelling, dose vocabulary, and ordinary words", () => {
    for (const value of [
      "1.2 µg/mL",
      "2 µU/mL",
      "500 mcg",
      "drug/mL",
      "drug / mL",
      "shrug/off",
      "shrug / off",
    ])
      expect(machineLabUnitHits(value)).toEqual([]);
  });

  it("is stateless across calls", () => {
    expect(machineLabUnitHits("45 ug/L")).toEqual(["ug"]);
    expect(machineLabUnitHits("45 ug/L")).toEqual(["ug"]);
    expect(MACHINE_LAB_UNIT_RE.lastIndex).toBe(0);
  });
});
