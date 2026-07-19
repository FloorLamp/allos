import { describe, expect, it } from "vitest";
import {
  recognizedTempUnit,
  normalizeImportedTemperature,
  storedTempToF,
} from "@/lib/vitals-input";

// Pure tests for the imported/stored temperature unit gate (#1018). The
// CCDA/FHIR-mapper application is covered in cda.test.ts / fhir-resources.test.ts;
// the DB end-to-end (import → series → flag → fever curve) in the DB tier.

describe("recognizedTempUnit", () => {
  it("recognizes the Celsius spellings documents ship", () => {
    for (const u of [
      "C",
      "c",
      "Cel",
      "cel",
      "°C",
      "[degC]",
      "degC",
      "celsius",
      "deg C",
    ]) {
      expect(recognizedTempUnit(u), u).toBe("C");
    }
  });

  it("recognizes the Fahrenheit spellings documents ship", () => {
    for (const u of ["F", "f", "°F", "[degF]", "degF", "fahrenheit", "deg F"]) {
      expect(recognizedTempUnit(u), u).toBe("F");
    }
  });

  it("never guesses an unrecognized or missing unit", () => {
    for (const u of [null, undefined, "", "K", "kelvin", "mmHg", "%", "degR"]) {
      expect(recognizedTempUnit(u), String(u)).toBeNull();
    }
  });
});

describe("normalizeImportedTemperature", () => {
  it("converts a recognized Celsius reading to the canonical °F trio", () => {
    expect(normalizeImportedTemperature(38.5, "Cel")).toEqual({
      value: "101.3",
      value_num: 101.3,
      unit: "degF",
    });
    expect(normalizeImportedTemperature(40, "°C")?.value_num).toBe(104);
  });

  it("normalizes a UCUM-spelled Fahrenheit reading onto the canonical unit", () => {
    expect(normalizeImportedTemperature(101.3, "[degF]")).toEqual({
      value: "101.3",
      value_num: 101.3,
      unit: "degF",
    });
  });

  it("declines an unrecognized unit (stored verbatim, never guessed)", () => {
    expect(normalizeImportedTemperature(38.5, "K")).toBeNull();
    expect(normalizeImportedTemperature(38.5, null)).toBeNull();
  });

  it("declines an implausible converted value (junk must not enter the series)", () => {
    // 900 °C is a sensor/export fault, not a body temperature (ingest band 77–113 °F).
    expect(normalizeImportedTemperature(900, "Cel")).toBeNull();
    expect(normalizeImportedTemperature(3, "C")).toBeNull();
    expect(normalizeImportedTemperature(500, "[degF]")).toBeNull();
    expect(normalizeImportedTemperature(Number.NaN, "C")).toBeNull();
  });
});

describe("storedTempToF (the episode fever-curve read gate)", () => {
  it("trusts a NULL/blank unit as canonical °F (every app writer stores degF)", () => {
    expect(storedTempToF(101.3, null)).toBe(101.3);
    expect(storedTempToF(101.3, "")).toBe(101.3);
  });

  it("passes a recognized °F spelling through unchanged", () => {
    expect(storedTempToF(101.3, "degF")).toBe(101.3);
    expect(storedTempToF(101.3, "[degF]")).toBe(101.3);
    expect(storedTempToF(101.3, "°F")).toBe(101.3);
  });

  it("converts a recognized Celsius row (legacy pre-conversion import)", () => {
    expect(storedTempToF(38.5, "Cel")).toBe(101.3);
    expect(storedTempToF(40, "°C")).toBe(104);
  });

  it("excludes an unrecognized unit instead of plotting it as °F", () => {
    expect(storedTempToF(38.5, "K")).toBeNull();
    expect(storedTempToF(38.5, "mmHg")).toBeNull();
  });
});
