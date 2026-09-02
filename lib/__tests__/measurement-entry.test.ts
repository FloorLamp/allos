import { describe, expect, it } from "vitest";
import { isMeasurementEntryAllowed } from "@/lib/measurement-entry";

const CHILD = {
  showCompositionEntry: false,
  showGrowth: true,
  showHeadCirc: true,
};
const ADULT = {
  showCompositionEntry: true,
  showGrowth: false,
  showHeadCirc: false,
};

describe("isMeasurementEntryAllowed", () => {
  // THE COMPOSITION CLASS TRAVELS TOGETHER (#4147). Lean and bone mass were ungated
  // on the waist-tape precedent, so a child's form offered two of the three numbers
  // on one DEXA report while the third was deliberately absent. The direct metric URL
  // is the same door as the combined form and must give the same answer.
  it.each([
    { metric: "body-fat", child: false, adult: true },
    { metric: "lean-mass", child: false, adult: true },
    { metric: "bone-mass", child: false, adult: true },
    { metric: "hrv", child: false, adult: true },
    { metric: "head-circ", child: true, adult: false },
    // Ungated at every life stage: a tape measure, a counted breathing rate and a
    // day's water are not composition, and #2322/#1851 said so on purpose.
    { metric: "waist-circ", child: true, adult: true },
    { metric: "respiratory-rate", child: true, adult: true },
    { metric: "hydration", child: true, adult: true },
    { metric: "weight", child: true, adult: true },
    { metric: "resting-hr", child: true, adult: true },
    { metric: "blood-pressure", child: true, adult: true },
    { metric: "spo2", child: true, adult: true },
    { metric: "temperature", child: true, adult: true },
    { metric: "height", child: true, adult: true },
  ] as const)(
    "$metric — child $child, adult $adult",
    ({ metric, child, adult }) => {
      expect(isMeasurementEntryAllowed(metric, CHILD)).toBe(child);
      expect(isMeasurementEntryAllowed(metric, ADULT)).toBe(adult);
    }
  );
});
