// PURE TIER — the cadence routing decision (#1932): which detail surface a dated
// clinical reading belongs on.
//
// The audit is the test. `category = 'vitals'` is not the continuous set — it holds
// six streaming vital signs AND twenty-five domain vitals (audiogram thresholds,
// intraocular pressure, visual acuity, periodontal measures, the functional-fitness
// markers) that arrive at the LAB cadence and are read the LAB way. VITALS_AUDIT
// below is that classification written out in full, and it is pinned in BOTH
// directions against the canonical dataset, so a newly added vital is a red test
// here rather than a silently mis-rendered page — the failure mode #1932 was.
//
// The other half of the pin ("the surface we route to can actually render it") needs
// a database and lives in lib/__db_tests__/vitals-reading-surface.test.ts.

import { describe, it, expect } from "vitest";
import canonicalData from "@/lib/canonical-biomarkers.json";
import {
  CATEGORY_CADENCE,
  CONTINUOUS_READING_METRIC,
  continuousReadingSlug,
  readingCadence,
  type ReadingCadence,
} from "@/lib/reading-cadence";
import type { MedicalCategory } from "@/lib/types";

const entries = (
  canonicalData as { biomarkers: { name: string; category: string }[] }
).biomarkers;

// Every `category = 'vitals'` canonical entry and the cadence it arrives at. The
// continuous six stream from a wearable or a cuff and are read as a trend; every
// other one is an episodic clinical measurement read against a band or an age/sex
// percentile, so it keeps the reference-range renderer.
const VITALS_AUDIT: Record<string, ReadingCadence> = {
  // Physiologic vital signs — continuous.
  "Blood Pressure Systolic": "continuous",
  "Blood Pressure Diastolic": "continuous",
  "Oxygen Saturation": "continuous",
  "Respiratory Rate": "continuous",
  "Body Temperature": "continuous",
  // Streams too, but its metric-detail kind reads `body_metrics.resting_hr`, not the
  // `medical_records` row an imported observation lands in — routing it there would
  // show an empty page, so it stays on the surface that does chart it.
  "Resting Heart Rate": "episodic",
  // Functional-fitness markers (#158) — an annual-at-best physical test, read by an
  // age/sex percentile card the reading detail page renders.
  "VO2 Max": "episodic",
  "Grip Strength": "episodic",
  "30-Second Chair Stand": "episodic",
  "Single-Leg Balance": "episodic",
  // Vision (#697) — a tonometry reading or a Snellen fraction per eye exam. Visual
  // acuity is qualitative and has no numeric axis at all.
  "Intraocular Pressure": "episodic",
  "Intraocular Pressure, Right Eye": "episodic",
  "Intraocular Pressure, Left Eye": "episodic",
  "Visual Acuity": "episodic",
  "Visual Acuity, Right Eye": "episodic",
  "Visual Acuity, Left Eye": "episodic",
  // Dental (#705) — measured at a cleaning, against a millimetre/percentage band.
  "Periodontal Probing Depth": "episodic",
  "Bleeding on Probing": "episodic",
  "Clinical Attachment Loss": "episodic",
  // Audiogram thresholds (#713) — one per ear per frequency, per hearing test.
  "Hearing Threshold, Right Ear 250 Hz": "episodic",
  "Hearing Threshold, Right Ear 500 Hz": "episodic",
  "Hearing Threshold, Right Ear 1 kHz": "episodic",
  "Hearing Threshold, Right Ear 2 kHz": "episodic",
  "Hearing Threshold, Right Ear 4 kHz": "episodic",
  "Hearing Threshold, Right Ear 8 kHz": "episodic",
  "Hearing Threshold, Left Ear 250 Hz": "episodic",
  "Hearing Threshold, Left Ear 500 Hz": "episodic",
  "Hearing Threshold, Left Ear 1 kHz": "episodic",
  "Hearing Threshold, Left Ear 2 kHz": "episodic",
  "Hearing Threshold, Left Ear 4 kHz": "episodic",
  "Hearing Threshold, Left Ear 8 kHz": "episodic",
};

describe("reading cadence — the vitals audit", () => {
  const vitals = entries.filter((e) => e.category === "vitals");

  it("classifies every canonical vitals entry, and classifies nothing else", () => {
    // Both directions: a NEW vital in the dataset fails here until it is classified,
    // and a renamed/removed one fails until this table follows it.
    expect(vitals.map((e) => e.name).sort()).toEqual(
      Object.keys(VITALS_AUDIT).sort()
    );
  });

  it.each(Object.entries(VITALS_AUDIT))("%s is %s", (name, expected) => {
    expect(readingCadence(name)).toBe(expected);
  });

  it("declares a metric kind for exactly the continuous five", () => {
    // Named out loud so the one deliberate omission (Resting Heart Rate, whose
    // metric kind reads a different store) can't be quietly filled in without a
    // matching change to that store.
    expect(Object.keys(CONTINUOUS_READING_METRIC).sort()).toEqual([
      "Blood Pressure Diastolic",
      "Blood Pressure Systolic",
      "Body Temperature",
      "Oxygen Saturation",
      "Respiratory Rate",
    ]);
  });
});

describe("reading cadence — categories", () => {
  it("classifies every category the canonical dataset uses", () => {
    const used = [...new Set(entries.map((e) => e.category))].sort();
    for (const category of used) {
      expect(CATEGORY_CADENCE[category as MedicalCategory]).toBeDefined();
    }
  });

  it("keeps every wholly-episodic category off the metric surface", () => {
    // One surface per category, except the one category declared mixed: a `lab`,
    // `scan`, `derived`, `reference` or `instrument` entry can never claim a
    // metric-detail kind, whatever its name.
    for (const e of entries) {
      const cadence = CATEGORY_CADENCE[e.category as MedicalCategory];
      if (cadence === "episodic") {
        expect(continuousReadingSlug(e.name)).toBeNull();
      }
    }
  });

  it("has exactly one mixed category", () => {
    expect(
      Object.entries(CATEGORY_CADENCE)
        .filter(([, cadence]) => cadence === "mixed")
        .map(([category]) => category)
    ).toEqual(["vitals"]);
  });
});

describe("continuousReadingSlug", () => {
  it("resolves a continuous vital to its metric kind", () => {
    expect(continuousReadingSlug("Oxygen Saturation")).toBe("spo2");
    expect(continuousReadingSlug("Blood Pressure Systolic")).toBe("systolic");
    expect(continuousReadingSlug("Body Temperature")).toBe("temperature");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(continuousReadingSlug("  oxygen saturation ")).toBe("spo2");
  });

  it("is null for a lab, an unknown name, and an absent one", () => {
    expect(continuousReadingSlug("LDL Cholesterol")).toBeNull();
    expect(continuousReadingSlug("Grip Strength")).toBeNull();
    expect(continuousReadingSlug("Not A Real Analyte")).toBeNull();
    expect(continuousReadingSlug(null)).toBeNull();
    expect(continuousReadingSlug(undefined)).toBeNull();
    expect(continuousReadingSlug("   ")).toBeNull();
  });
});
