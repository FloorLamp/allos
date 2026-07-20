import { describe, it, expect } from "vitest";
import {
  buildPillars,
  optimalRangeHitRate,
  optimalShareRows,
  pillarHref,
  PILLAR_ANCHOR,
  type NamedBiomarkerReading,
  type PillarInputs,
  type PillarKey,
} from "@/lib/healthspan-pillars";
import { longevitySections, PROTOCOLS_ANCHOR } from "@/lib/longevity";
import { bioAgeDelta } from "@/lib/bio-age";
import type { CanonicalBiomarker } from "@/lib/types";

// The Longevity page is the EXPANDED formatter over the SAME pillar model the
// dashboard widget compact-renders (#1042 phase 4, the #221 one-model-two-
// formatters precedent). These tests pin that for one fixture model, both
// surfaces carry identical facts: the widget renders buildPillars' output
// directly, and the page's sections are a pure regrouping of the SAME objects —
// nothing re-derived, nothing dropped, nothing invented.

// A full-coverage fixture: every pillar present.
const FULL_INPUTS: PillarInputs = {
  vo2: { percentile: { percentile: 62, clamped: null }, fitnessAge: null },
  strength: { level: "advanced", lift: "Back Squat" },
  sleep: { sri: 84 },
  bioAge: { delta: bioAgeDelta(45, 50) },
  optimal: { optimal: 31, total: 38 },
};

describe("longevitySections is a pure regrouping of the widget's pillar model", () => {
  it("same fixture model in → same facts out on both surfaces", () => {
    const pillars = buildPillars(FULL_INPUTS);
    const sections = longevitySections(pillars);
    const sectionPillars = sections.flatMap((s) => s.pillars);
    // Every pillar the widget renders appears in exactly one page section, as
    // the SAME object (identity, not a lookalike) — value/detail/tone/trend are
    // therefore byte-identical on both surfaces.
    expect(sectionPillars.length).toBe(pillars.length);
    for (const p of pillars) {
      expect(sectionPillars.filter((sp) => sp === p)).toHaveLength(1);
    }
  });

  it("groups each pillar under its PILLAR_ANCHOR section", () => {
    const pillars = buildPillars(FULL_INPUTS);
    for (const s of longevitySections(pillars)) {
      for (const p of s.pillars) {
        expect(PILLAR_ANCHOR[p.key]).toBe(s.anchor);
      }
    }
  });

  it("absent pillars drop their section (no ghost sections)", () => {
    const sections = longevitySections(buildPillars({ sleep: { sri: 70 } }));
    expect(sections.map((s) => s.anchor)).toEqual(["sleep"]);
  });

  it("an empty model yields no sections at all", () => {
    expect(longevitySections(buildPillars({}))).toEqual([]);
  });

  it("keeps the stable section order for a full model", () => {
    const sections = longevitySections(buildPillars(FULL_INPUTS));
    expect(sections.map((s) => s.anchor)).toEqual([
      "bio-age",
      "fitness",
      "sleep",
      "biomarkers",
    ]);
  });
});

describe("widget deep-links land on the page section that expands the pillar", () => {
  it("every pillar href is /longevity#<its section anchor>", () => {
    const pillars = buildPillars(FULL_INPUTS);
    expect(pillars.length).toBeGreaterThan(0);
    for (const p of pillars) {
      expect(p.href).toBe(`/longevity#${PILLAR_ANCHOR[p.key]}`);
      expect(p.href).toBe(pillarHref(p.key));
    }
  });

  it("every anchor a pillar points at is a section longevitySections can emit", () => {
    // Build one model per pillar and confirm its section materializes under the
    // anchor its href targets — a deep-link can never land on a missing id.
    const perPillar: [PillarKey, PillarInputs][] = [
      ["vo2max", { vo2: FULL_INPUTS.vo2 }],
      ["strength", { strength: FULL_INPUTS.strength }],
      ["sleep-regularity", { sleep: FULL_INPUTS.sleep }],
      ["bio-age", { bioAge: FULL_INPUTS.bioAge }],
      ["optimal-biomarkers", { optimal: FULL_INPUTS.optimal }],
    ];
    for (const [key, inputs] of perPillar) {
      const sections = longevitySections(buildPillars(inputs));
      expect(sections.map((s) => s.anchor)).toEqual([PILLAR_ANCHOR[key]]);
    }
  });

  it("the protocols anchor is reserved for the interventions section, never a pillar", () => {
    expect(Object.values(PILLAR_ANCHOR)).not.toContain(PROTOCOLS_ANCHOR);
  });
});

// ── Optimal-share breakdown reconciles with the pillar count ─────────────────

function cb(
  partial: Partial<CanonicalBiomarker> & {
    name: string;
    unit: string;
    direction: CanonicalBiomarker["direction"];
  }
): CanonicalBiomarker {
  return partial as unknown as CanonicalBiomarker;
}

const totalChol = cb({
  name: "Total Cholesterol",
  unit: "mg/dL",
  direction: "lower_better",
  ref_low: 125,
  ref_high: 200,
  optimal_low: null,
  optimal_high: 180,
});

describe("optimalShareRows (the expanded #biomarkers breakdown)", () => {
  const readings: NamedBiomarkerReading[] = [
    {
      name: "Total Cholesterol",
      canonicalName: "Total Cholesterol",
      value_num: 170,
      unit: "mg/dL",
      cb: totalChol,
    }, // optimal
    {
      name: "Cholesterol (repeat)",
      canonicalName: "Total Cholesterol",
      value_num: 195,
      unit: "mg/dL",
      cb: totalChol,
    }, // above optimal (in ref)
    {
      name: "Mystery",
      canonicalName: null,
      value_num: 5,
      unit: "mg/dL",
      cb: null,
    }, // unjudgeable → excluded
  ];

  it("its rows reconcile exactly with optimalRangeHitRate over the same readings", () => {
    const rows = optimalShareRows(readings);
    const rate = optimalRangeHitRate(readings);
    expect(rows).toHaveLength(rate.total);
    expect(rows.filter((r) => r.badge === "optimal")).toHaveLength(
      rate.optimal
    );
  });

  it("sorts non-optimal rows first (the actionable ones)", () => {
    const rows = optimalShareRows(readings);
    expect(rows.map((r) => r.badge)).toEqual(["above-optimal", "optimal"]);
  });
});
