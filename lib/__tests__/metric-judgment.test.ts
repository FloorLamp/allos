// PURE TIER — the one judgement lookup (#1996).
//
// The load-bearing case is the pediatric one: a three-year-old's resting heart
// rate must be judged against the curated 1–3 band (80–150), not the adult 50–100,
// and the lookup must reach that band from the reading's #482 IDENTITY — which is
// what makes it work for a reading that streams into `body_metrics` and never
// visits the store the bands are filed beside.
//
// The completeness test is the other half: every registered metric declares which
// knowledge system answers for it, or says `none` WITH a reason. That is what turns
// "audit whether another metric has this shape" into a build failure.
//
// All fixtures SYNTHETIC.

import { describe, it, expect } from "vitest";
import {
  JUDGED_METRIC_SLUGS,
  METRIC_KNOWLEDGE,
  metricIdentity,
  metricJudgment,
  metricJudgmentForSlug,
  metricObservationFoldIdentity,
} from "@/lib/metric-judgment";
import { readingIdentity } from "@/lib/reading-model";
import { canonicalBiomarkerForName } from "@/lib/datasets/canonical-biomarkers";
import { BODY_METRIC_SLUGS } from "@/lib/trends-body-metrics";

const RHR = readingIdentity("Resting Heart Rate");

describe("metricJudgment resolves knowledge from the identity", () => {
  it("judges an ADULT resting heart rate against the adult range", () => {
    const j = metricJudgment(RHR, { age: 40, value: 58 });
    expect(j).not.toBeNull();
    expect(j).toMatchObject({
      identity: RHR,
      canonical: "Resting Heart Rate",
      unit: "bpm",
      low: 50,
      high: 100,
      optimalLow: 50,
      optimalHigh: 65,
      bandLabel: null,
      direction: "lower_better",
      badge: "optimal",
    });
  });

  it("judges an INFANT against the 0–1 band (90–160), not the adult one", () => {
    const j = metricJudgment(RHR, { age: 0, value: 120 });
    expect(j?.low).toBe(90);
    expect(j?.high).toBe(160);
    expect(j?.bandLabel).toBe("age <1");
    // 120 bpm is normal for an infant and would read "Above range" against 50–100.
    expect(j?.badge).not.toBe("high");
  });

  it("judges a TODDLER against the 1–3 band (80–150)", () => {
    // The reported harm: a young child's daily 120 bpm trend, judged against
    // nothing. Bands are half-open [min, max), so age 2 sits in 1–3.
    const j = metricJudgment(RHR, { age: 2, value: 120 });
    expect(j?.low).toBe(80);
    expect(j?.high).toBe(150);
    expect(j?.bandLabel).toBe("age 1–3");
    expect(j?.badge).not.toBe("high");
    // The next band up for a three-year-old…
    expect(metricJudgment(RHR, { age: 3, value: 120 })).toMatchObject({
      low: 70,
      high: 140,
      bandLabel: "age 3–6",
    });
    // …while the SAME value in an adult is out of range.
    expect(metricJudgment(RHR, { age: 40, value: 120 })?.badge).toBe("high");
  });

  it("returns the bands with no verdict when no reading is supplied", () => {
    const j = metricJudgment(RHR, { age: 40 });
    expect(j?.low).toBe(50);
    expect(j?.badge).toBe("unknown");
  });

  it("refuses an identity the vocabulary does not know", () => {
    expect(metricJudgment("Unicorn Horn Length", { age: 40 })).toBeNull();
    expect(metricJudgment("", {})).toBeNull();
  });

  it("refuses an entry that states no band at all", () => {
    expect(
      metricJudgment("Nothing Curated", { age: 40, value: 1 }, [
        { name: "Nothing Curated" },
      ])
    ).toBeNull();
  });

  it("prefers the caller's vocabulary over the bundled dataset", () => {
    // The runtime path passes the seeded `canonical_biomarkers` row, so a re-seed
    // or an operator edit wins — one judgement, one vocabulary per call.
    const j = metricJudgment(RHR, { age: 40, value: 58 }, [
      { name: "Resting Heart Rate", unit: "bpm", ref_low: 40, ref_high: 70 },
    ]);
    expect(j?.low).toBe(40);
    expect(j?.high).toBe(70);
  });
});

describe("the slug → knowledge registry", () => {
  it("has an entry for EVERY registered metric", () => {
    for (const slug of BODY_METRIC_SLUGS) {
      expect(
        METRIC_KNOWLEDGE[slug],
        `no knowledge entry for ${slug}`
      ).toBeDefined();
    }
    expect(Object.keys(METRIC_KNOWLEDGE).sort()).toEqual(
      [...BODY_METRIC_SLUGS].sort()
    );
  });

  it("names a REAL canonical entry wherever it claims one", () => {
    for (const slug of JUDGED_METRIC_SLUGS) {
      const knowledge = METRIC_KNOWLEDGE[slug];
      if (knowledge.source !== "canonical") continue;
      expect(
        canonicalBiomarkerForName(knowledge.canonical),
        `${slug} names "${knowledge.canonical}", which is not in the canonical vocabulary`
      ).not.toBeNull();
      // …and it actually resolves to a judgement, so no slug claims knowledge it
      // cannot produce.
      expect(metricJudgmentForSlug(slug, { age: 40 })).not.toBeNull();
    }
  });

  it("gives every unjudged metric an explicit reason", () => {
    for (const slug of BODY_METRIC_SLUGS) {
      const knowledge = METRIC_KNOWLEDGE[slug];
      if (knowledge.source === "none") {
        expect(
          knowledge.reason.length,
          `${slug} has an empty reason`
        ).toBeGreaterThan(20);
        expect(metricIdentity(slug)).toBeNull();
        expect(metricJudgmentForSlug(slug, { age: 40 })).toBeNull();
      }
      if (knowledge.source === "growth-percentile") {
        // Knowledge EXISTS, it is simply not a band — the surface that owns it is
        // named rather than the metric being filed as unjudgeable.
        expect(knowledge.renderedBy.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers the metrics #1996 audited: resting HR, body fat, and the vitals", () => {
    expect(JUDGED_METRIC_SLUGS).toEqual(
      expect.arrayContaining([
        "resting-hr",
        "body-fat",
        "spo2",
        "temperature",
        "systolic",
        "diastolic",
        "respiratory-rate",
      ])
    );
  });

  it("keeps daily-average HR OUT of the resting bands", () => {
    // A different quantity: the #482 exclusion discipline, not an oversight.
    expect(METRIC_KNOWLEDGE.hr.source).toBe("none");
    expect(metricIdentity("hr")).toBeNull();
  });
});

describe("which metric surfaces fold observations in", () => {
  it("folds for a metric whose readings STREAM", () => {
    expect(metricObservationFoldIdentity("resting-hr")).toBe(RHR);
    expect(metricObservationFoldIdentity("body-fat")).toBe(
      readingIdentity("Body Fat Percentage")
    );
  });

  it("does NOT fold for a metric whose readings already ARE observations", () => {
    // SpO2, temperature, respiratory rate and blood pressure store as
    // `medical_records` rows; folding would list every reading twice.
    for (const slug of [
      "spo2",
      "temperature",
      "respiratory-rate",
      "systolic",
      "diastolic",
    ] as const) {
      expect(metricObservationFoldIdentity(slug)).toBeNull();
    }
  });

  it("does NOT fold for a metric with no canonical identity", () => {
    expect(metricObservationFoldIdentity("weight")).toBeNull();
    expect(metricObservationFoldIdentity("steps")).toBeNull();
  });
});
