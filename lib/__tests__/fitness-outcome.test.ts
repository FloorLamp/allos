// PURE TIER — the per-test outcome moment + battery-completion finale (issue #1307).
// The outcome panel is a FORMATTER over the tile VM (never a second computation, #221),
// so this pins that its marker/value/delta equal the tile's; the completion decision +
// summary read the model the header already renders.

import { describe, it, expect } from "vitest";
import { buildFitnessTile } from "@/lib/fitness-tile";
import {
  buildFitnessOutcome,
  batteryCompletion,
  batteryCompletionSummary,
} from "@/lib/fitness-outcome";
import type {
  FitnessTestResult,
  FitnessCheckModel,
  FitnessProvenance,
} from "@/lib/fitness-check-model";

function prov(stale = false): FitnessProvenance {
  return {
    kind: "check",
    label: "from your check",
    sourceName: "your check",
    date: "2026-03-01",
    ageDays: 1,
    stale,
  };
}

function res(p: Partial<FitnessTestResult>): FitnessTestResult {
  return {
    key: "bodyfat",
    label: "Body fat",
    tier: "body",
    domain: "body",
    unit: "%",
    measured: true,
    value: 18,
    lowerIsBetter: true,
    percentile: null,
    fitnessAge: null,
    standing: null,
    standingLift: null,
    selfNorm: null,
    favorability: 100,
    provenance: prov(),
    delta: -2,
    improved: true,
    ...p,
  };
}

describe("buildFitnessOutcome (#1307) — a formatter over the tile VM", () => {
  it("marker/value/delta equal the tile's (pinned equal, #221)", () => {
    const tile = buildFitnessTile(res({}));
    const outcome = buildFitnessOutcome(tile);
    expect(outcome.marker).toBe(tile.overlay);
    expect(outcome.deltaArrow).toBe(tile.deltaArrow);
    expect(outcome.valueText).toBe("18 %");
    // Body fat drops 2 with lowerIsBetter → an improvement (up arrow), signed delta.
    expect(outcome.deltaText).toBe("-2 vs your last check");
    expect(outcome.deltaArrow).toBe("up");
    expect(outcome.announcement).toContain("Body fat 18 %");
    expect(outcome.announcement).toContain(tile.overlay);
  });

  it("omits the delta clause with no prior check", () => {
    const tile = buildFitnessTile(res({ delta: null, improved: null }));
    const outcome = buildFitnessOutcome(tile);
    expect(outcome.deltaText).toBeNull();
    expect(outcome.deltaArrow).toBeNull();
  });
});

describe("batteryCompletion (#1307)", () => {
  it("is complete only when every non-excluded test carries a FRESH value", () => {
    const results = [
      res({ key: "a", provenance: prov(false) }),
      res({ key: "b", provenance: prov(false) }),
    ];
    expect(batteryCompletion(results, new Set()).complete).toBe(true);
    // A stale value doesn't count as today's fitness.
    const withStale = [
      res({ key: "a", provenance: prov(false) }),
      res({ key: "b", provenance: prov(true) }),
    ];
    expect(batteryCompletion(withStale, new Set()).complete).toBe(false);
  });

  it("holds equipment-missing tests OUT of the denominator", () => {
    const results = [
      res({ key: "a", provenance: prov(false) }),
      res({ key: "deadhang", measured: false, provenance: null }),
    ];
    // deadhang is unmeasured but excluded → the rest is complete.
    expect(batteryCompletion(results, new Set(["deadhang"]))).toEqual({
      measured: 1,
      total: 1,
      complete: true,
    });
  });

  it("an empty in-scope denominator is never complete", () => {
    expect(batteryCompletion([], new Set()).complete).toBe(false);
  });
});

describe("batteryCompletionSummary (#1307)", () => {
  function model(results: FitnessTestResult[]): FitnessCheckModel {
    return {
      latestDate: "2026-03-01",
      priorDate: "2025-12-01",
      measuredCount: results.filter((r) => r.measured).length,
      totalCount: results.length,
      results,
      domains: [],
      headlineFitnessAge: { fitnessAge: 34, clamped: null },
      priorHeadlineFitnessAge: { fitnessAge: 36, clamped: null },
    };
  }

  it("counts improved / declined / new from the per-test deltas + carries fitness age", () => {
    const results = [
      res({ key: "a", improved: true, delta: 2 }),
      res({ key: "b", improved: false, delta: -1 }),
      res({ key: "c", improved: null, delta: null }), // measured, no prior → new
    ];
    expect(batteryCompletionSummary(model(results), new Set())).toEqual({
      fitnessAge: 34,
      priorFitnessAge: 36,
      improved: 1,
      declined: 1,
      fresh: 1,
    });
  });

  it("excludes equipment-missing tests from the counts", () => {
    const results = [
      res({ key: "a", improved: true, delta: 2 }),
      res({ key: "deadhang", improved: false, delta: -3 }),
    ];
    const s = batteryCompletionSummary(model(results), new Set(["deadhang"]));
    expect(s.improved).toBe(1);
    expect(s.declined).toBe(0);
  });
});
