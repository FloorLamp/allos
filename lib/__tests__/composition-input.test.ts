import { describe, it, expect } from "vitest";
import {
  normalizeCompositionInput,
  validateCompositionInput,
  type CompositionInputRaw,
} from "@/lib/composition-input";

// The three manual body samples #1851 opened. What matters here is the CANONICAL
// value each entry lands on — a lean mass typed in pounds is stored in kilograms or
// lib/protein.ts scales the protein band by a number 2.2× too large — and that the
// plausibility bands are the ingest ones rather than a second opinion.

const blank: CompositionInputRaw = {
  leanMass: null,
  leanMassUnit: null,
  boneMass: null,
  boneMassUnit: null,
  hydration: null,
};

function samples(raw: Partial<CompositionInputRaw>) {
  const res = normalizeCompositionInput({ ...blank, ...raw });
  if ("error" in res) throw new Error(`expected samples, got: ${res.error}`);
  return res.samples;
}

describe("normalizeCompositionInput", () => {
  it.each([
    ["kilograms pass through", { leanMass: "56.4", leanMassUnit: "kg" }, 56.4],
    // 130 lb / 2.2046226218 = 58.9668… → 2dp, the storage precision every kg
    // metric already rounds to (lib/ingest-bounds.ts METRIC_ROUND_DP).
    ["pounds convert to kg", { leanMass: "130", leanMassUnit: "lb" }, 58.97],
    // An absent unit is kilograms, never a guess at the login's preference: the
    // form always posts the toggle, so this is only reachable by a crafted post.
    ["a missing unit is kg", { leanMass: "60" }, 60],
  ])("%s", (_label, raw, expected) => {
    expect(samples(raw)).toEqual([{ metric: "lean_mass_kg", value: expected }]);
  });

  it("carries bone mass and water on the same submission", () => {
    expect(
      samples({
        leanMass: "56.4",
        leanMassUnit: "kg",
        boneMass: "6.6",
        boneMassUnit: "lb",
        hydration: "2.35",
      })
    ).toEqual([
      { metric: "lean_mass_kg", value: 56.4 },
      // 6.6 lb → 2.9937… kg → 2dp
      { metric: "bone_mass_kg", value: 2.99 },
      // Litres are already canonical; 1dp is hydration_l's storage precision.
      { metric: "hydration_l", value: 2.4 },
    ]);
  });

  it.each([
    ["a blank submission", {}, /lean mass, bone mass or water/i],
    ["an unparseable lean mass", { leanMass: "x" }, /valid lean mass/i],
    ["an unparseable water", { hydration: "two litres" }, /valid water/i],
    // The ingest envelopes: lean_mass_kg 1–300, bone_mass_kg 0.05–20,
    // hydration_l 0–40. A value outside them is a hard error, never a silent skip.
    [
      "a 900 kg lean mass",
      { leanMass: "900" },
      /lean mass looks out of range/i,
    ],
    ["a 40 kg bone mass", { boneMass: "40" }, /bone mass looks out of range/i],
    ["a 60 L day", { hydration: "60" }, /water intake looks out of range/i],
  ])("refuses %s", (_label, raw, pattern) => {
    expect(validateCompositionInput({ ...blank, ...raw })).toMatch(pattern);
  });

  it("treats a whitespace field as not measured rather than as an error", () => {
    expect(samples({ leanMass: "  ", hydration: "1.5" })).toEqual([
      { metric: "hydration_l", value: 1.5 },
    ]);
  });
});
