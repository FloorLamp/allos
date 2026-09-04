// The glucose trace/observation routing of #3182, in BOTH directions.
//
// A test that only asserts "an undeclared connection does not produce traces" is
// green on a tree where NOTHING becomes a trace — one direction, two very different
// worlds, one green. So the converse is pinned beside it: the declared connection
// routes every record to the trace, and the undeclared one routes every record to an
// observation WHATEVER the record carries.
//
// The `specimenSource` clause the 2026-09-02 ruling named is gone (owner ruling
// 2026-09-03, recorded on #3182): the exporter never writes the field, so the clause
// could not fire and read as a discriminator that was really just the default. What
// survives from those cases is the shape below — a record's own contents never route
// it, which is now a POSITIVE claim rather than a side effect of an unset default.

import { describe, it, expect } from "vitest";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";

const TIME = "2026-06-15T08:00:00Z";

function parse(
  rec: Record<string, unknown>,
  cgmConnection: boolean
): { trace: number; observations: number } {
  const out = parseHealthConnectPayload(
    { blood_glucose: [{ time: TIME, mmol_per_liter: 5.5, ...rec }] },
    "UTC",
    { cgmConnection }
  );
  return {
    trace: out.glucoseTrace.length,
    observations: out.vitals.filter((v) => v.canonical === "Glucose").length,
  };
}

describe("glucose routing (#3182)", () => {
  // SWITCH OFF, AND NOTHING IN THE RECORD CHANGES THAT. The interstitial spellings
  // stay in this table deliberately: they are what the removed clause used to route,
  // so they are the cases that would go wrong first if anyone re-introduced a
  // content-sniffing branch, and a record shaped like a sensor's must still land as
  // an observation while the connection is undeclared.
  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }],
    ["camelCase spelling", { specimenSource: "interstitialFluid" }],
    ["platform constant", { specimen_source: "INTERSTITIAL_FLUID" }],
    ["capillary", { specimen_source: "capillary_blood" }],
    ["whole blood", { specimen_source: "whole_blood" }],
    ["unset", {}],
    ["null", { specimen_source: null }],
    ["unknown value", { specimen_source: "tears" }],
  ])("switch off — %s → observation", (_name, rec) => {
    expect(parse(rec as Record<string, unknown>, false)).toEqual({
      trace: 0,
      observations: 1,
    });
  });

  // SWITCH ON, AND NOTHING IN THE RECORD CHANGES THAT EITHER. Same eight shapes, so
  // the pair of tables says the routing reads the connection and only the connection.
  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }],
    ["camelCase spelling", { specimenSource: "interstitialFluid" }],
    ["platform constant", { specimen_source: "INTERSTITIAL_FLUID" }],
    ["capillary", { specimen_source: "capillary_blood" }],
    ["whole blood", { specimen_source: "whole_blood" }],
    ["unset", {}],
    ["null", { specimen_source: null }],
    ["unknown value", { specimen_source: "tears" }],
  ])("switch on — %s → trace", (_name, rec) => {
    expect(parse(rec as Record<string, unknown>, true)).toEqual({
      trace: 1,
      observations: 0,
    });
  });

  it("omitting the option is the same answer as the switch being off", () => {
    const out = parseHealthConnectPayload(
      { blood_glucose: [{ time: TIME, mmol_per_liter: 5.5 }] },
      "UTC"
    );
    expect(out.glucoseTrace).toHaveLength(0);
    expect(out.vitals.map((v) => v.canonical)).toEqual(["Glucose"]);
  });

  it("carries the writing app per point and converts to mg/dL", () => {
    const out = parseHealthConnectPayload(
      {
        blood_glucose: [
          {
            time: TIME,
            mmol_per_liter: 5.5,
            metadata: { data_origin: "com.example.sensor" },
          },
          { time: "2026-06-15T08:05:00Z", mmol_per_liter: 6 },
        ],
      },
      "UTC",
      { cgmConnection: true }
    );
    expect(out.glucoseTrace).toEqual([
      { ts: "2026-06-15T08:00:00Z", mgdl: 99.1, origin: "com.example.sensor" },
      { ts: "2026-06-15T08:05:00Z", mgdl: 108.1, origin: null },
    ]);
  });

  // A routed reading is still bounds-checked (#132) and still ACCOUNTED (#419) — the
  // routing decides the store, never whether an impossible value is allowed through
  // or whether a dropped record is visible in Review.
  it("skips an implausible trace value and counts it", () => {
    const out = parseHealthConnectPayload(
      {
        blood_glucose: [
          { time: TIME, mmol_per_liter: 500 },
          { time: "2026-06-15T08:05:00Z", mmol_per_liter: 5.5 },
        ],
      },
      "UTC",
      { cgmConnection: true }
    );
    expect(out.glucoseTrace).toHaveLength(1);
    expect(out.skipped).toBe(1);
  });
});
