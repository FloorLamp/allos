import { describe, it, expect } from "vitest";
import {
  validateVitalsInput,
  normalizeVitalsInput,
  celsiusToF,
  mmolToMgdl,
  type VitalsRawInput,
} from "@/lib/vitals-input";

const empty: VitalsRawInput = {};

describe("celsiusToF / mmolToMgdl (match the Health Connect parser)", () => {
  it("converts body temperature °C → °F", () => {
    expect(celsiusToF(37)).toBe(98.6);
    expect(celsiusToF(0)).toBe(32);
    expect(celsiusToF(38.5)).toBe(101.3);
  });

  it("converts glucose mmol/L → mg/dL with the 18.0156 factor", () => {
    expect(mmolToMgdl(5)).toBe(90.1);
    expect(mmolToMgdl(10)).toBe(180.2);
  });
});

describe("validateVitalsInput", () => {
  it("requires at least one vital", () => {
    expect(validateVitalsInput(empty)).toMatch(/at least one/i);
  });

  it("accepts a lone valid measure", () => {
    expect(validateVitalsInput({ spo2: "98" })).toBeNull();
    expect(validateVitalsInput({ sleepHours: "7.5" })).toBeNull();
    expect(validateVitalsInput({ hrv: "55" })).toBeNull();
  });

  it("treats blank/whitespace fields as absent", () => {
    expect(
      validateVitalsInput({ spo2: "97", glucose: "  ", hrv: "" })
    ).toBeNull();
  });

  it("requires both sides of a blood pressure pair", () => {
    expect(validateVitalsInput({ systolic: "120" })).toMatch(/both/i);
    expect(validateVitalsInput({ diastolic: "80" })).toMatch(/both/i);
    expect(
      validateVitalsInput({ systolic: "120", diastolic: "80" })
    ).toBeNull();
  });

  it("rejects an out-of-range or inverted blood pressure", () => {
    expect(validateVitalsInput({ systolic: "500", diastolic: "80" })).toMatch(
      /systolic/i
    );
    expect(validateVitalsInput({ systolic: "120", diastolic: "5" })).toMatch(
      /diastolic/i
    );
    expect(validateVitalsInput({ systolic: "80", diastolic: "120" })).toMatch(
      /greater than diastolic/i
    );
  });

  it("validates glucose against the canonical mg/dL bound after unit conversion", () => {
    // 40 mmol/L → ~721 mg/dL is in range; 60 mmol/L → ~1081 is not.
    expect(
      validateVitalsInput({ glucose: "40", glucoseUnit: "mmol/L" })
    ).toBeNull();
    expect(
      validateVitalsInput({ glucose: "60", glucoseUnit: "mmol/L" })
    ).toMatch(/glucose/i);
    expect(validateVitalsInput({ glucose: "5000" })).toMatch(/glucose/i);
    expect(validateVitalsInput({ glucose: "-1" })).toMatch(/glucose/i);
  });

  it("rejects oxygen saturation outside 50-100", () => {
    expect(validateVitalsInput({ spo2: "40" })).toMatch(/oxygen/i);
    expect(validateVitalsInput({ spo2: "101" })).toMatch(/oxygen/i);
    expect(validateVitalsInput({ spo2: "100" })).toBeNull();
  });

  it("validates temperature against the canonical °F bound after unit conversion", () => {
    expect(
      validateVitalsInput({ temperature: "37", tempUnit: "C" })
    ).toBeNull();
    expect(
      validateVitalsInput({ temperature: "98.6", tempUnit: "F" })
    ).toBeNull();
    // The reading wins when the selected unit is stale or still at its default.
    expect(
      validateVitalsInput({ temperature: "37", tempUnit: "F" })
    ).toBeNull();
    expect(
      validateVitalsInput({ temperature: "98.6", tempUnit: "C" })
    ).toBeNull();
    // 50 °C → 122 °F is out of range.
    expect(validateVitalsInput({ temperature: "50", tempUnit: "C" })).toMatch(
      /temperature/i
    );
  });

  it("rejects sleep and HRV out of range", () => {
    expect(validateVitalsInput({ sleepHours: "0" })).toMatch(/sleep/i);
    expect(validateVitalsInput({ sleepHours: "25" })).toMatch(/sleep/i);
    expect(validateVitalsInput({ hrv: "0" })).toMatch(/hrv/i);
    expect(validateVitalsInput({ hrv: "600" })).toMatch(/hrv/i);
  });
});

describe("normalizeVitalsInput", () => {
  it("propagates a validation error", () => {
    const out = normalizeVitalsInput(empty);
    expect("error" in out).toBe(true);
  });

  it("maps blood pressure to the two canonical medical rows (mmHg)", () => {
    const out = normalizeVitalsInput({ systolic: "118", diastolic: "76" });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.medical).toEqual([
      {
        canonical: "Blood Pressure Systolic",
        category: "vitals",
        unit: "mmHg",
        value_num: 118,
      },
      {
        canonical: "Blood Pressure Diastolic",
        category: "vitals",
        unit: "mmHg",
        value_num: 76,
      },
    ]);
    expect(out.samples).toEqual([]);
  });

  it("converts glucose mmol/L and temperature °C to canonical units", () => {
    const out = normalizeVitalsInput({
      glucose: "5",
      glucoseUnit: "mmol/L",
      temperature: "37",
      tempUnit: "C",
    });
    if ("error" in out) throw new Error(out.error);
    const glucose = out.medical.find((m) => m.canonical === "Glucose");
    const temp = out.medical.find((m) => m.canonical === "Body Temperature");
    expect(glucose).toEqual({
      canonical: "Glucose",
      // #1076: Glucose is a lab, not a vital sign.
      category: "lab",
      unit: "mg/dL",
      value_num: 90.1,
    });
    expect(temp).toEqual({
      canonical: "Body Temperature",
      category: "vitals",
      unit: "degF",
      value_num: 98.6,
    });
  });

  it("keeps mg/dL glucose and °F temperature as entered", () => {
    const out = normalizeVitalsInput({
      glucose: "92",
      glucoseUnit: "mg/dL",
      temperature: "98.6",
      tempUnit: "F",
    });
    if ("error" in out) throw new Error(out.error);
    expect(out.medical.find((m) => m.canonical === "Glucose")?.value_num).toBe(
      92
    );
    expect(
      out.medical.find((m) => m.canonical === "Body Temperature")?.value_num
    ).toBe(98.6);
  });

  it("auto-detects temperature units during canonical normalization", () => {
    const celsius = normalizeVitalsInput({
      temperature: "37",
      tempUnit: "F",
    });
    const fahrenheit = normalizeVitalsInput({
      temperature: "98.6",
      tempUnit: "C",
    });
    if ("error" in celsius) throw new Error(celsius.error);
    if ("error" in fahrenheit) throw new Error(fahrenheit.error);
    expect(celsius.medical[0].value_num).toBe(98.6);
    expect(fahrenheit.medical[0].value_num).toBe(98.6);
  });

  it("routes sleep (hours→minutes) and HRV to metric samples", () => {
    const out = normalizeVitalsInput({ sleepHours: "7.5", hrv: "48" });
    if ("error" in out) throw new Error(out.error);
    expect(out.samples).toEqual([
      { metric: "sleep_min", value: 450 },
      { metric: "hrv_ms", value: 48 },
    ]);
    expect(out.medical).toEqual([]);
  });

  it("maps SpO2 to Oxygen Saturation", () => {
    const out = normalizeVitalsInput({ spo2: "97" });
    if ("error" in out) throw new Error(out.error);
    expect(out.medical).toEqual([
      {
        canonical: "Oxygen Saturation",
        category: "vitals",
        unit: "%",
        value_num: 97,
      },
    ]);
  });

  it("maps the functional fitness markers to their canonical medical rows (#158)", () => {
    const out = normalizeVitalsInput({
      gripStrength: "48",
      chairStand: "16",
      balance: "42",
    });
    if ("error" in out) throw new Error(out.error);
    expect(out.medical).toEqual([
      {
        canonical: "Grip Strength",
        category: "vitals",
        unit: "kg",
        value_num: 48,
      },
      {
        canonical: "30-Second Chair Stand",
        category: "vitals",
        unit: "reps",
        value_num: 16,
      },
      {
        canonical: "Single-Leg Balance",
        category: "vitals",
        unit: "seconds",
        value_num: 42,
      },
    ]);
    expect(out.samples).toEqual([]);
  });

  it("rejects out-of-range or non-integer functional markers (#158)", () => {
    expect(validateVitalsInput({ gripStrength: "0" })).toMatch(/Grip strength/);
    expect(validateVitalsInput({ gripStrength: "200" })).toMatch(
      /Grip strength/
    );
    expect(validateVitalsInput({ chairStand: "16.5" })).toMatch(/whole number/);
    expect(validateVitalsInput({ balance: "-1" })).toMatch(/Balance/);
    // A lone valid functional marker satisfies the "at least one vital" gate.
    expect(validateVitalsInput({ chairStand: "14" })).toBeNull();
  });
});
