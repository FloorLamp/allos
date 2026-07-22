import { describe, it, expect } from "vitest";
import {
  analyteTrajectoryFindings,
  trajectoryFindings,
  classifyValue,
  MIN_POINTS,
  MIN_SPAN_DAYS,
  PERSIST_SPAN_DAYS,
  CONFIDENT_MIN_POINTS,
  type TrajectoryInput,
} from "../biomarker-trajectory";
import type { DatedPoint } from "../robust-stats";
import { biomarkerFlagDismissalKey } from "../dismissal-keys";

// A YYYY-MM-DD date `offset` days after a fixed base, so spans/slopes are exact.
function d(offset: number): string {
  const base = Date.parse("2020-01-01T00:00:00Z");
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

// Collinear points at the given day offsets with a constant per-day step, so the
// Theil–Sen slope is exactly `step/spacing` per day.
function line(offsets: number[], v0: number, step: number): DatedPoint[] {
  return offsets.map((o, i) => ({ date: d(o), value: v0 + step * i }));
}

function input(over: Partial<TrajectoryInput> = {}): TrajectoryInput {
  return {
    analyte: "Test",
    unit: "mg/dL",
    points: [],
    reference: null,
    optimal: null,
    direction: "in_range",
    retestDays: 365,
    today: d(400),
    ...over,
  };
}

const keys = (fs: { rule: string }[]) => fs.map((f) => f.rule).sort();

describe("classifyValue", () => {
  it("flags out-of-range above/below the reference range first", () => {
    const ref = { low: 60, high: 100 };
    const opt = { low: 70, high: 90 };
    expect(classifyValue(110, ref, opt, "in_range")).toBe("high");
    expect(classifyValue(50, ref, opt, "in_range")).toBe("low");
  });

  it("flags above/below the optimal band while in the reference range", () => {
    const ref = { low: 60, high: 100 };
    const opt = { low: 70, high: 90 };
    expect(classifyValue(95, ref, opt, "in_range")).toBe("above-optimal");
    expect(classifyValue(65, ref, opt, "in_range")).toBe("below-optimal");
    expect(classifyValue(80, ref, opt, "in_range")).toBe("optimal");
  });

  it("honors direction for one-sided optimal bands", () => {
    // higher_better only judges the optimal LOW.
    expect(
      classifyValue(
        95,
        { low: 60, high: null },
        { low: 90, high: null },
        "higher_better"
      )
    ).toBe("optimal");
    expect(
      classifyValue(
        80,
        { low: 60, high: null },
        { low: 90, high: null },
        "higher_better"
      )
    ).toBe("below-optimal");
    // lower_better only judges the optimal HIGH.
    expect(
      classifyValue(
        2,
        { low: null, high: 4 },
        { low: null, high: 1 },
        "lower_better"
      )
    ).toBe("above-optimal");
  });

  it("returns unknown only when there is nothing to judge against", () => {
    expect(classifyValue(5, null, null, "in_range")).toBe("unknown");
    // A reference range with no optimal band → in-range reads as optimal.
    expect(classifyValue(80, { low: 60, high: 100 }, null, "in_range")).toBe(
      "optimal"
    );
  });
});

describe("shared gates", () => {
  it("returns nothing with fewer than MIN_POINTS readings", () => {
    const pts = line([0, 120], 90, -10); // 2 points
    expect(pts.length).toBeLessThan(MIN_POINTS);
    expect(analyteTrajectoryFindings(input({ points: pts }))).toEqual([]);
  });

  it("returns nothing when the span is under MIN_SPAN_DAYS", () => {
    // 3 points but only 40 days total (< 60).
    const pts = line([0, 20, 40], 90, -10);
    expect(analyteTrajectoryFindings(input({ points: pts }))).toEqual([]);
    expect(MIN_SPAN_DAYS).toBe(60);
  });

  it("returns nothing for a perfectly flat series", () => {
    const pts = line([0, 100, 200], 80, 0);
    const findings = analyteTrajectoryFindings(
      input({
        points: pts,
        reference: { low: 60, high: 100 },
        optimal: { low: 70, high: 90 },
        velocityPerYear: 5,
      })
    );
    expect(findings).toEqual([]);
  });
});

describe("rule 1 — approaching boundary", () => {
  // higher_better, declining, still in range, no optimal band (so persistence
  // stays quiet and the approaching rule is isolated).
  const base = input({
    analyte: "eGFR",
    unit: "mL/min/1.73m2",
    reference: { low: 60, high: null },
    optimal: null,
    direction: "higher_better",
    retestDays: 365, // horizon = 730 days
  });

  it("fires when a crossing is projected within the horizon", () => {
    // 69 → 63 over 120 days = -0.05/day; from 63 the 60 floor is 60 days out.
    const pts = line([0, 60, 120], 69, -3);
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(keys(fs)).toEqual(["approaching"]);
    const f = fs[0];
    expect(f.dedupeKey).toBe("trajectory:eGFR:approaching");
    expect(f.tone).toBe("caution");
    expect(f.title).toContain("low");
    expect(f.detail).toMatch(/still in range/i);
    expect(f.detail).toMatch(/clinician/i);
    expect(f.actionHref).toBeUndefined(); // no href supplied
    expect(f.evidenceData.boundary).toBe(60);
    expect(f.evidenceData.boundaryKind).toBe("reference");
    expect(f.tone).toBe("caution");
    expect(f.evidenceData.projectedDays).toBe(60);
  });

  it("does NOT fire when the projected crossing is beyond the horizon", () => {
    // Same slope, but a 10-day retest interval → horizon 20 < projected 60.
    const pts = line([0, 60, 120], 69, -3);
    const fs = analyteTrajectoryFindings({
      ...base,
      points: pts,
      retestDays: 10,
    });
    expect(fs.every((f) => f.rule !== "approaching")).toBe(true);
  });

  it("does NOT fire when already out of range", () => {
    // Latest 57 is below the 60 floor → a crossing already happened.
    const pts = line([0, 60, 120], 63, -3);
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "approaching")).toBe(true);
  });

  it("does NOT fire when the slope moves in the healthy direction", () => {
    // higher_better RISING is good — no warning.
    const pts = line([0, 60, 120], 63, +3);
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "approaching")).toBe(true);
  });

  it("targets the nearest boundary (optimal before reference)", () => {
    // lower_better rising toward the optimal HIGH (1) before the reference (4).
    const pts = line([0, 90, 180], 0.4, 0.1); // 0.4 → 0.6 over 180d
    const fs = analyteTrajectoryFindings(
      input({
        analyte: "PSA",
        unit: "ng/mL",
        points: pts,
        reference: { low: null, high: 4 },
        optimal: { low: null, high: 1 },
        direction: "lower_better",
        retestDays: 3650, // large horizon so the crossing is reachable
      })
    );
    const app = fs.find((f) => f.rule === "approaching");
    expect(app).toBeDefined();
    expect(app!.evidenceData.boundary).toBe(1);
    expect(app!.evidenceData.boundaryKind).toBe("optimal");
    expect(app!.title).toContain("high");
    // An optimal-edge approach is the mildest signal — informational, not caution.
    expect(app!.tone).toBe("info");
  });
});

describe("shared flag+trajectory acknowledgment (issue #564)", () => {
  const base = input({
    analyte: "eGFR",
    unit: "mL/min/1.73m2",
    reference: { low: 60, high: null },
    optimal: null,
    direction: "higher_better",
    retestDays: 365,
  });

  it("carries the analyte's flag family key as `supersedes` so a flag dismiss silences it", () => {
    const pts = line([0, 60, 120], 69, -3);
    const f = analyteTrajectoryFindings({ ...base, points: pts }).find(
      (x) => x.rule === "approaching"
    )!;
    expect(f.supersedes).toBe(biomarkerFlagDismissalKey("eGFR"));
    // Its own per-rule key is unchanged (a pre-#564 dismissal still suppresses).
    expect(f.dedupeKey).toBe("trajectory:eGFR:approaching");
  });

  it("uses the FAMILY flag key for the TOTAL vitamin D so flag/trajectory align", () => {
    const f = analyteTrajectoryFindings({
      ...base,
      analyte: "Vitamin D, 25-Hydroxy",
      points: line([0, 60, 120], 69, -3),
    }).find((x) => x.rule === "approaching")!;
    expect(f.supersedes).toBe("biomarker-flag:family:vitamin-d-25-hydroxy");
    expect(f.supersedes).toBe(biomarkerFlagDismissalKey("Vitamin D, Total"));
  });

  it("uses the FRACTION's OWN flag key for a D2/D3 trajectory — fractions flag independently (#1193)", () => {
    // A D3 fraction's trajectory ack must align with the D3 fraction's OWN flag key,
    // NOT the total's — the fraction flags independently now.
    const f = analyteTrajectoryFindings({
      ...base,
      analyte: "Vitamin D3, 25-Hydroxy",
      points: line([0, 60, 120], 69, -3),
    }).find((x) => x.rule === "approaching")!;
    expect(f.supersedes).toBe(
      biomarkerFlagDismissalKey("Vitamin D3, 25-Hydroxy")
    );
    expect(f.supersedes).not.toBe(
      biomarkerFlagDismissalKey("Vitamin D, Total")
    );
  });
});

describe("rule 1 — measurement-noise floor (issue #563)", () => {
  // A bounded, near-ceiling vital: SpO2 (higher_better), reference/optimal low 95.
  const spo2 = input({
    analyte: "Oxygen Saturation",
    unit: "%",
    reference: { low: 95, high: 100 },
    optimal: { low: 95, high: 100 },
    direction: "higher_better",
    retestDays: 365, // horizon 730 — a projected crossing IS reachable
  });

  it("suppresses a 1-unit wiggle within the noise floor (98→97, no finding)", () => {
    // 98,98,97,97 over 270 days: absent the floor this projects a crossing of the
    // 95 boundary within the horizon (the reported bug). Range 1 and fitted change
    // ~1 both sit under SpO2's ±2 floor, so no trajectory fires.
    const pts = [
      { date: d(0), value: 98 },
      { date: d(90), value: 98 },
      { date: d(180), value: 97 },
      { date: d(270), value: 97 },
    ];
    const fs = analyteTrajectoryFindings({
      ...spo2,
      points: pts,
      noiseFloor: 2,
    });
    expect(fs.every((f) => f.rule !== "approaching")).toBe(true);
  });

  it("still fires on a genuine multi-unit decline that clears the floor", () => {
    // 99→96 over 270 days: range 3 > the ±2 floor, latest 96 still in range → the
    // approaching-boundary finding survives the noise gate.
    const pts = [
      { date: d(0), value: 99 },
      { date: d(90), value: 98 },
      { date: d(180), value: 97 },
      { date: d(270), value: 96 },
    ];
    const fs = analyteTrajectoryFindings({
      ...spo2,
      points: pts,
      noiseFloor: 2,
    });
    expect(fs.some((f) => f.rule === "approaching")).toBe(true);
  });

  it("with no floor supplied, the same 1-unit wiggle DOES project (gate is the floor)", () => {
    // Proves the suppression above is the noise floor, not the horizon/other gates.
    const pts = [
      { date: d(0), value: 98 },
      { date: d(90), value: 98 },
      { date: d(180), value: 97 },
      { date: d(270), value: 97 },
    ];
    const fs = analyteTrajectoryFindings({ ...spo2, points: pts });
    expect(fs.some((f) => f.rule === "approaching")).toBe(true);
  });
});

describe("rule 1 — low-confidence hedge in the copy (issue #563)", () => {
  const base = input({
    analyte: "eGFR",
    unit: "mL/min/1.73m2",
    reference: { low: 60, high: null },
    optimal: null,
    direction: "higher_better",
    retestDays: 365,
  });

  it("hedges the ETA as a rough estimate below CONFIDENT_MIN_POINTS readings", () => {
    const pts = line([0, 60, 120], 69, -3); // 3 points < 5
    expect(pts.length).toBeLessThan(CONFIDENT_MIN_POINTS);
    const f = analyteTrajectoryFindings({ ...base, points: pts }).find(
      (x) => x.rule === "approaching"
    )!;
    expect(f.detail).toMatch(/rough estimate/i);
    expect(f.detail).toMatch(/3 readings/);
    expect(f.detail).not.toMatch(/projected to cross/i);
  });

  it("states a firm ETA at/above CONFIDENT_MIN_POINTS readings", () => {
    // 5 collinear points, still declining toward the 60 floor.
    const pts = line([0, 45, 90, 135, 180], 69, -1.5); // 69→63, 5 points
    expect(pts.length).toBeGreaterThanOrEqual(CONFIDENT_MIN_POINTS);
    const f = analyteTrajectoryFindings({ ...base, points: pts }).find(
      (x) => x.rule === "approaching"
    )!;
    expect(f.detail).toMatch(/projected to cross/i);
    expect(f.detail).not.toMatch(/rough estimate/i);
  });
});

describe("rule 2 — persistent non-optimal", () => {
  const base = input({
    analyte: "LDL Cholesterol",
    unit: "mg/dL",
    reference: { low: null, high: 130 },
    optimal: { low: null, high: 100 },
    direction: "lower_better",
    velocityPerYear: null,
  });

  it("fires when the last 3 readings share a non-optimal status over ≥90 days", () => {
    // All above optimal (100) but under the reference (130): above-optimal ×3.
    const pts = line([0, 60, 120], 110, 3); // 110,113,116
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.some((f) => f.rule === "persistent")).toBe(true);
    const p = fs.find((f) => f.rule === "persistent")!;
    expect(p.dedupeKey).toBe("trajectory:LDL Cholesterol:persistent");
    expect(p.title).toMatch(/above the optimal range/i);
    expect(p.evidenceData.spanDays).toBe(120);
  });

  it("does NOT fire when the 3-reading span is under 90 days", () => {
    // 3 above-optimal readings but only 80 days apart.
    const pts = line([0, 40, 80], 110, 3);
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "persistent")).toBe(true);
    expect(PERSIST_SPAN_DAYS).toBe(90);
  });

  it("does NOT fire when the statuses are not identical", () => {
    // Recovers into the optimal band on the last reading.
    const pts = [
      { date: d(0), value: 116 }, // above-optimal
      { date: d(60), value: 113 }, // above-optimal
      { date: d(120), value: 95 }, // optimal
    ];
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "persistent")).toBe(true);
  });

  it("uses only the 3 MOST RECENT readings", () => {
    // First two optimal, last three above-optimal spanning ≥90 → still fires.
    const pts = [
      { date: d(0), value: 90 },
      { date: d(60), value: 92 },
      { date: d(120), value: 110 },
      { date: d(180), value: 113 },
      { date: d(240), value: 116 },
    ];
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.some((f) => f.rule === "persistent")).toBe(true);
  });
});

describe("rule 3 — velocity", () => {
  // Roughly a year between points so per-year ≈ per-step.
  const offsets = [0, 365, 730];
  const base = input({
    analyte: "eGFR",
    unit: "mL/min/1.73m2",
    reference: { low: 60, high: null },
    optimal: null,
    direction: "higher_better",
    retestDays: 10, // tiny horizon so the approaching rule stays out of the way
    velocityPerYear: 5,
  });

  it("fires when the decline exceeds the curated threshold", () => {
    // ~ -8/yr, well past the 5/yr threshold, but every value stays above 60.
    const pts = line(offsets, 95, -8); // 95, 87, 79
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    const v = fs.find((f) => f.rule === "velocity");
    expect(v).toBeDefined();
    expect(v!.dedupeKey).toBe("trajectory:eGFR:velocity");
    expect(v!.title).toMatch(/falling faster/i);
    expect(v!.detail).toMatch(/within range/i);
    expect(v!.evidenceData.slopePerYear).toBeLessThan(-5);
  });

  it("does NOT fire when the rate is under the threshold", () => {
    const pts = line(offsets, 95, -4); // ~ -4/yr < 5/yr threshold
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "velocity")).toBe(true);
  });

  it("does NOT fire when moving in the healthy direction", () => {
    // higher_better RISING fast is good — velocity ignores it.
    const pts = line(offsets, 79, +8);
    const fs = analyteTrajectoryFindings({ ...base, points: pts });
    expect(fs.every((f) => f.rule !== "velocity")).toBe(true);
  });

  it("does NOT fire without a curated threshold", () => {
    const pts = line(offsets, 95, -8);
    const fs = analyteTrajectoryFindings({
      ...base,
      points: pts,
      velocityPerYear: null,
    });
    expect(fs.every((f) => f.rule !== "velocity")).toBe(true);
  });

  it("fires on a rise for a lower_better marker", () => {
    // PSA rising ~1/yr, past the 0.75/yr threshold, still under the 4 ceiling.
    const pts = line(offsets, 1.5, +1); // 1.5, 2.5, 3.5
    const fs = analyteTrajectoryFindings(
      input({
        analyte: "PSA",
        unit: "ng/mL",
        points: pts,
        reference: { low: null, high: 4 },
        optimal: { low: null, high: 1 },
        direction: "lower_better",
        retestDays: 5,
        velocityPerYear: 0.75,
      })
    );
    expect(fs.some((f) => f.rule === "velocity")).toBe(true);
    const v = fs.find((f) => f.rule === "velocity")!;
    expect(v.title).toMatch(/rising faster/i);
  });
});

describe("trajectoryFindings — batch + dedupeKeys", () => {
  it("flattens across analytes and namespaces every key under trajectory:", () => {
    const egfr = input({
      analyte: "eGFR",
      reference: { low: 60, high: null },
      optimal: { low: 90, high: 120 },
      direction: "higher_better",
      retestDays: 10,
      velocityPerYear: 5,
      points: line([0, 365, 730], 88, -8), // velocity + persistent(below-optimal)
      href: "/biomarkers/view?name=eGFR",
    });
    const fs = trajectoryFindings([egfr]);
    expect(fs.length).toBeGreaterThan(0);
    expect(fs.every((f) => f.dedupeKey.startsWith("trajectory:eGFR:"))).toBe(
      true
    );
    expect(fs.every((f) => f.domain === "trajectory")).toBe(true);
    // href threads through to the action affordance.
    expect(fs[0].actionHref).toBe("/biomarkers/view?name=eGFR");
    expect(fs[0].actionLabel).toBe("Schedule a retest");
  });
});
