// The glucose trace/observation routing of #3182, in BOTH directions.
//
// The owner's ruling makes an UNSET `specimen_source` default to OBSERVATION, and a
// test that only asserts "unset does not become a trace" is green on a tree where
// NOTHING becomes a trace — one direction, two very different worlds, one green. So
// the four cases are one table and the converse is pinned beside the default: a
// record that MUST route to the trace, records that must NOT, and the per-connection
// override turning all of them into traces.

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
  // switch OFF: only the sensor's own word routes a reading to the trace.
  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }, "trace"],
    ["camelCase spelling", { specimenSource: "interstitialFluid" }, "trace"],
    ["platform constant", { specimen_source: "INTERSTITIAL_FLUID" }, "trace"],
    ["capillary", { specimen_source: "capillary_blood" }, "observation"],
    ["whole blood", { specimen_source: "whole_blood" }, "observation"],
    ["unset", {}, "observation"],
    ["null", { specimen_source: null }, "observation"],
    ["unknown value", { specimen_source: "tears" }, "observation"],
  ])("switch off — %s → %s", (_name, rec, expected) => {
    const got = parse(rec as Record<string, unknown>, false);
    expect(got).toEqual(
      expected === "trace"
        ? { trace: 1, observations: 0 }
        : { trace: 0, observations: 1 }
    );
  });

  // switch ON: the connection overrides the field, including where the field says
  // capillary and where it says nothing at all.
  it.each([
    ["interstitial fluid", { specimen_source: "interstitial_fluid" }],
    ["capillary", { specimen_source: "capillary_blood" }],
    ["unset", {}],
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
