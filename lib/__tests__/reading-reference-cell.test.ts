import { describe, it, expect } from "vitest";
import { referenceCell } from "@/lib/reading-reference-cell";
import { metricJudgment } from "@/lib/metric-judgment";
import { readingIdentity } from "@/lib/reading-model";

// The Reference cell is a JUDGMENT cell (#2315).
//
// It used to print `reference_range` — the free-text string the lab document
// stated — beside a flag that was never derived from it. These cases are the
// issue's own table, resolved through `metricJudgment` over the committed canonical
// vocabulary, so the cell text and the numbers that actually flagged the row are
// asserted together.

// The cell for a reading of the canonical analyte `name`, judged for `subject`,
// whose document printed `printed`. The lookup is keyed by #482 IDENTITY, so the
// name is resolved through `readingIdentity` exactly as the runtime gather does —
// Hemoglobin A1c belongs to a family and does not answer to its bare name. `unit`
// defaults to the analyte's own canonical unit — the ordinary case, where the value
// cell beside this one already carries it.
function cellFor(
  name: string,
  printed: string | null,
  subject: Parameters<typeof metricJudgment>[1] = {},
  unit: string | null = null
) {
  const judgment = metricJudgment(readingIdentity(name), subject);
  return referenceCell({
    judgment,
    printed,
    unit: unit ?? judgment?.unit ?? null,
  });
}

describe("a canonical entry answers — the cell states the bands that judged the row", () => {
  it("shows the reference band alone when no optimal band resolves", () => {
    // Uric Acid 8.0 printed 3.4-8.5 and was flagged HIGH (red) against the
    // canonical 3.5–7.2. The reader had no way to learn that 7.2, not 8.5, was
    // the ceiling. Its optimal band is curated per SEX only, so an unknown-sex
    // subject resolves none — and none is invented.
    const cell = cellFor("Uric Acid", "3.4-8.5");
    expect(cell.judged).toBe(true);
    expect(cell.label).toBe("Reference");
    expect(cell.text).toBe("ref 3.5–7.2");
  });

  it("resolves the bands for the SUBJECT, not a generic reader", () => {
    // The same analyte for a male subject picks up the sex-specific optimal band —
    // a second thing the lab's printed string could never have said.
    expect(cellFor("Uric Acid", "3.4-8.5", { sex: "male" }).text).toBe(
      "ref 3.5–7.2 · optimal 4–5.5"
    );
  });

  it("shows BOTH bands when both exist", () => {
    // ApoB 77 printed <90 and was flagged "Above optimal" against optimal ≤60.
    // Showing only the optimal band would lose the fact that the reader is inside
    // the reference range — which is exactly what the amber/red split means.
    const cell = cellFor("Apolipoprotein B (ApoB)", "<90");
    expect(cell.text).toBe("ref ≤ 90 · optimal ≤ 60");
  });

  it("states the canonical band for a value its printed range calls low", () => {
    // A1c 4.9 printed 5.0-5.6 and carries NO flag: the canonical model declines to
    // invent a finding for a low A1c (≤5.7, no floor). The row used to show a
    // number below its own stated floor with nothing beside it, which reads as a
    // missed flag. Now it shows the band that actually decided.
    const cell = cellFor("Hemoglobin A1c", "5.0-5.6");
    expect(cell.text).toBe("ref ≤ 5.7 · optimal ≤ 5.3");
  });

  it("keeps the lab's own string as hover provenance", () => {
    const cell = cellFor("Uric Acid", "3.4-8.5");
    expect(cell.title).toBe("Lab reference: 3.4-8.5");
  });

  it("claims no provenance when the document printed none", () => {
    expect(cellFor("Uric Acid", null).title).toBeNull();
    expect(cellFor("Uric Acid", "   ").title).toBeNull();
  });
});

describe("the age band is named — the #150 safety half", () => {
  it("appends the band that ACTUALLY applied", () => {
    // A pediatric profile's row printed the LAB's adult range while the app flagged
    // against the pediatric band, and the row could not show that it happened.
    const cell = cellFor("Resting Heart Rate", "60-100", { age: 2 });
    // The pediatric band REPLACES the adult fields wholesale, optimal included —
    // so there is no optimal band for a two-year-old, and none is invented.
    expect(cell.text).toBe("ref 80–150 · age 1–3");
  });

  it("claims no band when the adult fields applied", () => {
    const cell = cellFor("Resting Heart Rate", "60-100", { age: 40 });
    expect(cell.text).toBe("ref 50–100 · optimal 50–65");
    expect(cell.text).not.toContain("age ");
  });
});

describe("no canonical entry — the printed string IS the deciding range", () => {
  it("shows the printed digits, relabelled and prefixed (#2344)", () => {
    const cell = referenceCell({
      judgment: null,
      printed: "0.5-2.0",
      unit: "units/L",
    });
    expect(cell.judged).toBe(false);
    expect(cell.label).toBe("Lab reference");
    expect(cell.text).toBe("lab 0.5-2.0");
    // Nothing to hover: the content already IS the lab's string.
    expect(cell.title).toBeNull();
  });

  it("makes the cell self-describing, so the desktop table needs no second channel", () => {
    // `label` is the CARD-mode label; on the wide table the column header is one
    // `<th>` shared by every row and says "Reference" whatever the row is. So the
    // distinction #2315 asked for has to be in the cell's own content, by the same
    // prefix mechanism the judged case already uses — never by the reader noticing
    // that a prefix is missing.
    const judged = cellFor("Apolipoprotein B (ApoB)", "<90");
    const unjudged = referenceCell({
      judgment: null,
      printed: "3.4-8.5",
      unit: null,
    });
    expect(judged.text?.startsWith("ref ")).toBe(true);
    expect(unjudged.text?.startsWith("lab ")).toBe(true);
  });

  it("shows nothing when the document printed nothing either", () => {
    // No digits, no prefix: a bare "lab" would name a range that does not exist.
    const cell = referenceCell({ judgment: null, printed: null, unit: null });
    expect(cell.text).toBeNull();
    expect(cell.label).toBe("Lab reference");
  });

  it("falls back for an identity the vocabulary does not carry", () => {
    expect(cellFor("Not A Real Analyte 12", "1-2").judged).toBe(false);
  });
});

describe("the unit rides along only when the row's own unit disagrees", () => {
  it("stays bare when the reading is already in the canonical unit", () => {
    expect(cellFor("Uric Acid", null, {}, "mg/dL").text).toBe("ref 3.5–7.2");
  });

  it("stays bare when the reading states no unit at all", () => {
    // Nothing is claimed when nothing was stated.
    expect(cellFor("Uric Acid", null, {}, null).text).toBe("ref 3.5–7.2");
  });

  it("names the canonical unit when the reading is stated in another", () => {
    // A bare number pair beside a value in a different unit would be a second
    // silent mismatch of exactly the kind this issue exists to end.
    expect(cellFor("Uric Acid", null, {}, "µmol/L").text).toBe(
      "ref 3.5–7.2 mg/dL"
    );
  });
});
