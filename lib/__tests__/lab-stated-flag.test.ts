import { describe, expect, it } from "vitest";
import {
  isLabStated,
  labStatedFlag,
  reconciledFlag,
} from "@/lib/reference-range";
import {
  frameUnstatedNames,
  isFrameUnstated,
} from "@/lib/patient-state-qualifiers";
import canonicalSeed from "@/lib/canonical-result-definitions.json";

// A VALUE OUTSIDE THE LAB'S OWN PRINTED RANGE (issue #2799).
//
// `Microalbumin/Creatinine Ratio, Urine` is band-less on purpose (KDIGO staging needs
// repeat samples over months). A real report prints `<30` beside the value anyway, so a
// rising 31 → 44 mg/g rendered with NO marker anywhere while a fasting glucose beside it
// flagged red. The composition — catalog entry exists + bands deliberately null ⇒ the
// lab's own printed range is never used to judge — reads worst exactly where the catalog
// was being careful, across the ~95 band-less analytes.
//
// The flag is DISTINCTLY SOURCED. `reported-high` / `reported-low` are never an allos
// band: lib/__tests__/flag-classification.test.ts pins that they stay out of
// isOutOfRange, tone amber not red, and label "Above/Below reported range".
//
// SYNTHETIC ONLY: invented subjects and values. No PHI.

interface EntryOpts {
  ref_low?: number | null;
  ref_high?: number | null;
  optimal_low?: number | null;
  optimal_high?: number | null;
  direction?: "in_range" | "lower_better" | "higher_better";
  unit?: string;
}

function entry(name: string, o: EntryOpts = {}) {
  return {
    name,
    unit: o.unit ?? "mg/g",
    direction: o.direction ?? ("in_range" as const),
    ref_low: o.ref_low ?? null,
    ref_high: o.ref_high ?? null,
    ref_low_male: null,
    ref_high_male: null,
    ref_low_female: null,
    ref_high_female: null,
    optimal_low: o.optimal_low ?? null,
    optimal_high: o.optimal_high ?? null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
  };
}

// The band-less entry the issue is written about.
const uacr = entry("Microalbumin/Creatinine Ratio, Urine");
// The band-less entry #2337 ruled must stay silent.
const glucose = entry("Glucose", { unit: "mg/dL" });

const FRAME_UNSTATED = { frameUnstated: true };

describe("labStatedFlag — the pure decision", () => {
  it("judges the value against the printed range, as printed", () => {
    expect(labStatedFlag("<30", 44, "in_range")).toBe("reported-high");
    expect(labStatedFlag("<30", 29, "in_range")).toBeNull();
    expect(labStatedFlag("<30", 30, "in_range")).toBeNull(); // the bound is inside
    expect(labStatedFlag("0.5-13.8 ng/mL", 0.2, "in_range")).toBe(
      "reported-low"
    );
    expect(labStatedFlag("0.5-13.8 ng/mL", 14, "in_range")).toBe(
      "reported-high"
    );
    expect(labStatedFlag(">40", 12, "in_range")).toBe("reported-low");
  });

  it("says nothing when there is nothing to say", () => {
    expect(labStatedFlag(null, 44, "in_range")).toBeNull();
    expect(labStatedFlag("", 44, "in_range")).toBeNull();
    expect(labStatedFlag("NEGATIVE", 44, "in_range")).toBeNull(); // unparseable
    expect(labStatedFlag("<30", null, "in_range")).toBeNull();
    expect(labStatedFlag("<30", Number.NaN, "in_range")).toBeNull();
  });

  // A PRINTED RANGE READ THROUGH THE ANALYTE'S DIRECTION. The predicted range on a
  // pulmonary-function or fitness report is a floor to clear, not a box to sit in, and
  // a healthy person beats it routinely. Flagging that is #544's "good result reads as
  // needs-attention" through a new door — and all six of these are `category: vitals`,
  // so each would reach the recent-changes digest.
  it("never flags a higher-better analyte for beating its printed range", () => {
    expect(labStatedFlag("3.1-4.2", 4.6, "higher_better")).toBeNull(); // FEV1 L
    expect(labStatedFlag("4.0-5.4", 5.9, "higher_better")).toBeNull(); // FVC L
    expect(labStatedFlag("480-620", 680, "higher_better")).toBeNull(); // Peak flow
    expect(labStatedFlag("35-50", 58, "higher_better")).toBeNull(); // Grip kg
    expect(labStatedFlag("14-19", 24, "higher_better")).toBeNull(); // Chair stand
    expect(labStatedFlag("35-45", 58, "higher_better")).toBeNull(); // VO2 Max
    // …while the direction that IS the concern still speaks.
    expect(labStatedFlag("3.1-4.2", 2.0, "higher_better")).toBe("reported-low");
    expect(labStatedFlag(">40", 12, "higher_better")).toBe("reported-low");
  });

  it("never flags a lower-better analyte for coming in under its printed range", () => {
    expect(labStatedFlag("10-40", 4, "lower_better")).toBeNull();
    expect(labStatedFlag("10-40", 55, "lower_better")).toBe("reported-high");
    expect(labStatedFlag("<30", 44, "lower_better")).toBe("reported-high");
  });

  it("treats an absent direction as in_range, like optimalStatus does", () => {
    expect(labStatedFlag("10-40", 55, null)).toBe("reported-high");
    expect(labStatedFlag("10-40", 4, undefined)).toBe("reported-low");
  });

  it("is silent for a frame-unstated analyte (#2337)", () => {
    expect(labStatedFlag("65-99", 120, "in_range", FRAME_UNSTATED)).toBeNull();
    // …without the guard the very same row WOULD flag.
    expect(labStatedFlag("65-99", 120, "in_range")).toBe("reported-high");
  });
});

describe("reconciledFlag emits the lab-stated flag in the unknown branch", () => {
  it("flags a microalbumin 44 mg/g beside the lab's printed <30", () => {
    expect(reconciledFlag(null, 44, "mg/g", uacr, null, 55, null, "<30")).toBe(
      "reported-high"
    );
    // …and leaves the earlier, in-range draw alone.
    expect(
      reconciledFlag(null, 22, "mg/g", uacr, null, 55, null, "<30")
    ).toBeUndefined();
  });

  it("does not restate a flag the row already carries", () => {
    expect(
      reconciledFlag("reported-high", 44, "mg/g", uacr, null, 55, null, "<30")
    ).toBeUndefined();
  });

  it("RETIRES a lab-stated flag once nothing states it", () => {
    // A corrected value, or a re-import whose printed range moved. This pass is the
    // only thing that writes these flags, so it is the only thing that can clear one —
    // the "frozen forever per row" failure #2687 needed a version bump to undo.
    expect(
      reconciledFlag("reported-high", 22, "mg/g", uacr, null, 55, null, "<30")
    ).toBeNull();
    expect(
      reconciledFlag("reported-low", 44, "mg/g", uacr, null, 55, null, null)
    ).toBeNull();
  });

  it("changes nothing where the catalog DOES publish a band", () => {
    // The lab's printed range is the last resort, not a competing verdict: a curated
    // reference band still decides, even when the printed one disagrees.
    const banded = entry("Banded", { ref_low: 10, ref_high: 100, unit: "u" });
    expect(
      reconciledFlag(null, 50, "u", banded, null, 40, null, "<30")
    ).toBeUndefined();
    expect(reconciledFlag(null, 120, "u", banded, null, 40, null, "<300")).toBe(
      "high"
    );
  });

  it("does not flag a band-less higher-better vital that beats its printed range", () => {
    // The end-to-end shape of the direction rule: a PFT's predicted range on an entry
    // the catalog publishes no band for. Reported through reconciledFlag rather than
    // labStatedFlag alone, because the digest reads the STORED flag.
    const fev1 = entry("FEV1", { direction: "higher_better", unit: "L" });
    expect(
      reconciledFlag(null, 4.6, "L", fev1, null, 40, null, "3.1-4.2")
    ).toBeUndefined();
    // Below predicted is the direction that means something, and still speaks.
    expect(
      reconciledFlag(null, 2.0, "L", fev1, null, 40, null, "3.1-4.2")
    ).toBe("reported-low");
  });

  it("yields to our own optimal band when the entry has one", () => {
    // An entry with no reference band but a curated OPTIMAL one: ours is the band on
    // screen, so ours is the verdict.
    const optimalOnly = entry("OptimalOnly", {
      optimal_high: 10,
      direction: "lower_better",
      unit: "u",
    });
    expect(
      reconciledFlag(null, 20, "u", optimalOnly, null, 40, null, "<30")
    ).toBe("non-optimal-high");
  });

  it("still declines to override a lab's own clinical high/low", () => {
    expect(
      reconciledFlag("high", 44, "mg/g", uacr, null, 55, null, "<30")
    ).toBeUndefined();
    expect(
      reconciledFlag("low", 2, "mg/g", uacr, null, 55, null, "<30")
    ).toBeUndefined();
  });

  it("never touches a qualitative 'abnormal'", () => {
    expect(
      reconciledFlag("abnormal", 44, "mg/g", uacr, null, 55, null, "<30")
    ).toBeUndefined();
  });

  it("stays silent for an unqualified glucose — the #2337 guard (via reconciledFlag)", () => {
    // 120 mg/dL an hour after lunch, beside the CMP's printed fasting interval. This is
    // the exact reading migration 176 unflagged; the printed range must not put it back.
    expect(
      reconciledFlag(
        null,
        120,
        "mg/dL",
        glucose,
        null,
        40,
        null,
        "65-99",
        null,
        FRAME_UNSTATED
      )
    ).toBeUndefined();
    // …in both directions, and for every flavor of range a CMP prints.
    expect(
      reconciledFlag(
        null,
        60,
        "mg/dL",
        glucose,
        null,
        40,
        null,
        "70-99 mg/dL",
        null,
        FRAME_UNSTATED
      )
    ).toBeUndefined();
    // Without the guard the very same row WOULD flag — which is what makes the guard
    // load-bearing rather than incidental.
    expect(
      reconciledFlag(null, 120, "mg/dL", glucose, null, 40, null, "65-99")
    ).toBe("reported-high");
  });

  it("also clears a lab-stated flag that a frame-unstated row somehow carries", () => {
    expect(
      reconciledFlag(
        "reported-high",
        120,
        "mg/dL",
        glucose,
        null,
        40,
        null,
        "65-99",
        null,
        FRAME_UNSTATED
      )
    ).toBeNull();
  });
});

describe("frameUnstatedNames — derived from the real catalog", () => {
  const names = (
    canonicalSeed as { definitions: { name: string }[] }
  ).definitions.map((d) => d.name);
  const set = frameUnstatedNames(names);

  it("is exactly the three bare entries whose qualified sibling the catalog carries", () => {
    const matched = names.filter((n) => isFrameUnstated(set, n)).sort();
    expect(matched).toEqual(["Cortisol", "Glucose", "Insulin"]);
  });

  it("does not catch the qualified siblings themselves", () => {
    for (const n of [
      "Glucose, Fasting",
      "Insulin, Fasting",
      "Cortisol, Morning",
    ])
      expect(isFrameUnstated(set, n)).toBe(false);
  });

  it("does not catch the band-less analyte this issue is about", () => {
    expect(isFrameUnstated(set, "Microalbumin/Creatinine Ratio, Urine")).toBe(
      false
    );
  });

  it("every entry it catches is band-less — the guard only ever suppresses silence", () => {
    // If a frame-unstated entry ever acquired a curated band, it would stop reaching the
    // unknown branch at all and this guard would be dead code on it. Catch that here
    // rather than letting the suppression drift out of contact with the catalog.
    const byName = new Map(
      (
        canonicalSeed as {
          definitions: {
            name: string;
            ref_low: number | null;
            ref_high: number | null;
          }[];
        }
      ).definitions.map((d) => [d.name, d])
    );
    for (const n of names.filter((x) => isFrameUnstated(set, x))) {
      const d = byName.get(n);
      expect(d?.ref_low ?? null).toBeNull();
      expect(d?.ref_high ?? null).toBeNull();
    }
  });

  it("needs no per-entry curation — a new frame pair is picked up from the names alone", () => {
    const invented = frameUnstatedNames([
      "Gastrin",
      "Gastrin, Fasting",
      "Ferritin",
    ]);
    expect(isFrameUnstated(invented, "Gastrin")).toBe(true);
    expect(isFrameUnstated(invented, "Ferritin")).toBe(false);
  });

  it("is empty when the catalog carries no qualified sibling", () => {
    expect(frameUnstatedNames(["Glucose", "Ferritin"]).size).toBe(0);
  });

  it("isFrameUnstated is null-safe and normalizes the name it is handed", () => {
    expect(isFrameUnstated(set, null)).toBe(false);
    expect(isFrameUnstated(null, "Glucose")).toBe(false);
    expect(isFrameUnstated(set, "glucose")).toBe(true);
  });
});

describe("isLabStated", () => {
  it("recognizes exactly the two lab-stated tokens", () => {
    expect(isLabStated("reported-high")).toBe(true);
    expect(isLabStated("reported-low")).toBe(true);
    expect(isLabStated("high")).toBe(false);
    expect(isLabStated(null)).toBe(false);
    expect(isLabStated(undefined)).toBe(false);
  });
});
