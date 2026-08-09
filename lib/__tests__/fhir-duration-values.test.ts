import { describe, expect, it } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";

// The FHIR half of the duration door (#2322). Bundles ship a stress test's
// `Exercise Duration` as a Quantity whose unit is `min:sec` — and, because FHIR has no
// legal shape for a colon-formatted number, whose `value` is the string "10:30". Read
// it at the source's grain and store ONE number in ONE unit; refuse a value the
// declared unit can't explain, and say so in the report. Fixtures SYNTHETIC.

function bundle(resources: object[]): string {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
  });
}

function durationObs(value: unknown): object {
  return {
    resourceType: "Observation",
    status: "final",
    code: { text: "Exercise Duration" },
    effectiveDateTime: "2024-03-01",
    valueQuantity: { value, unit: "min:sec" },
  };
}

describe("FHIR duration door (#2322)", () => {
  it("normalizes a string-valued min:sec quantity to whole seconds", () => {
    const r = parseFhirBundle(bundle([durationObs("10:30")]));
    expect(r.records.find((x) => x.name === "Exercise Duration")).toMatchObject(
      {
        value: "630",
        value_num: 630,
        unit: "s",
      }
    );
  });

  it("reads a colon-less number at the unit's leading field grain", () => {
    const r = parseFhirBundle(bundle([durationObs(9)]));
    expect(
      r.records.find((x) => x.name === "Exercise Duration")?.value_num
    ).toBe(540);
  });

  it("DROPS an unparsable duration and reports it as unparsable_value", () => {
    const r = parseFhirBundle(bundle([durationObs("not recorded")]));
    expect(r.records.some((x) => x.name === "Exercise Duration")).toBe(false);
    const drop = r.report?.drops.find((d) => d.label === "Exercise Duration");
    expect(drop?.reason).toBe("unparsable_value");
  });

  it("leaves an ordinary quantity untouched", () => {
    const r = parseFhirBundle(
      bundle([
        {
          resourceType: "Observation",
          status: "final",
          code: { text: "Glucose" },
          effectiveDateTime: "2024-03-01",
          valueQuantity: { value: 99, unit: "mg/dL" },
        },
      ])
    );
    expect(r.records.find((x) => x.name === "Glucose")).toMatchObject({
      value_num: 99,
      unit: "mg/dL",
    });
  });
});
