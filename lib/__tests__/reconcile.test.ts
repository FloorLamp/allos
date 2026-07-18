import { describe, it, expect, afterEach } from "vitest";
import {
  reconcileResults,
  reconcileAgainstSource,
  isOcrReconcileEnabled,
} from "@/lib/medical-extract/reconcile";

// A stand-in for a report's extracted text layer — the "NAME  value  ref  unit"
// line shape a lab PDF produces, including the two things that fooled a naive
// matcher: a name that appears in a panel TITLE and again in its result row, and a
// second "GLUCOSE" from a different specimen.
const TEXT = `
IRON, TIBC AND FERRITIN PANEL   Collected 06/03
FERRITIN                245     38-380 ng/mL
COMPREHENSIVE METABOLIC PANEL
GLUCOSE                 85      65-99 mg/dL     Fasting reference interval
CBC
NEUTROPHILS             59.3    %
ABSOLUTE NEUTROPHILS    2846    1500-7800 cells/uL
URINALYSIS, COMPLETE
GLUCOSE                 NEGATIVE   NEGATIVE
PROTEIN                 NEGATIVE   NEGATIVE
RBC                     4.80    4.20-5.80 Million/uL
`;

const row = (name: string, value: string | null, value_num: number | null) => ({
  name,
  value,
  value_num,
});

describe("reconcileResults", () => {
  it("confirms a name+value that appear together in the source", () => {
    const r = reconcileResults(TEXT, [row("FERRITIN", "245", 245)]);
    expect(r.items[0].verdict).toBe("confirmed");
    expect(r.confirmedRate).toBe(1);
  });

  it("flags a value the source does not support (transcription/hallucination)", () => {
    const r = reconcileResults(TEXT, [row("FERRITIN", "999", 999)]);
    expect(r.items[0].verdict).toBe("value_mismatch");
  });

  it("flags a name that never appears in the source", () => {
    const r = reconcileResults(TEXT, [row("Unobtainium", "42", 42)]);
    expect(r.items[0].verdict).toBe("name_not_found");
  });

  it("anchors on the RIGHT occurrence when the name repeats (title vs row)", () => {
    // "Ferritin" appears in the panel title first; the value is only by the result
    // row — a first-hit-only matcher would wrongly report a mismatch.
    expect(
      reconcileResults(TEXT, [row("FERRITIN", "245", 245)]).confirmed
    ).toBe(1);
  });

  it("distinguishes two specimens sharing a name by their values", () => {
    // Serum glucose 85 and urine glucose NEGATIVE — each confirms against its own row.
    expect(reconcileResults(TEXT, [row("GLUCOSE", "85", 85)]).confirmed).toBe(
      1
    );
    expect(
      reconcileResults(TEXT, [row("GLUCOSE", "NEGATIVE", null)]).confirmed
    ).toBe(1);
  });

  it("treats a trailing '%' in the name as the unit column, not the name", () => {
    // The model emits "NEUTROPHILS %"; the report prints "NEUTROPHILS" with % in the
    // unit column. It should still match the differential's %-row.
    expect(
      reconcileResults(TEXT, [row("NEUTROPHILS %", "59.3", 59.3)]).confirmed
    ).toBe(1);
  });

  it("matches a number as a whole token (not inside a longer number)", () => {
    // "8" must NOT confirm against "2846" / "38-380" — only a standalone 8 would.
    expect(
      reconcileResults(TEXT, [row("ABSOLUTE NEUTROPHILS", "8", 8)]).items[0]
        .verdict
    ).toBe("value_mismatch");
    expect(
      reconcileResults(TEXT, [row("ABSOLUTE NEUTROPHILS", "2846", 2846)])
        .items[0].verdict
    ).toBe("confirmed");
  });

  it("reports every row as name_not_found for an empty text layer (scanned image)", () => {
    const r = reconcileResults("", [
      row("FERRITIN", "245", 245),
      row("GLUCOSE", "85", 85),
    ]);
    expect(r.nameNotFound).toBe(2);
    expect(r.confirmed).toBe(0);
  });

  it("aggregates counts and the confirmed rate", () => {
    const r = reconcileResults(TEXT, [
      row("FERRITIN", "245", 245), // confirmed
      row("GLUCOSE", "999", 999), // value_mismatch
      row("Unobtainium", "1", 1), // name_not_found
    ]);
    expect(r).toMatchObject({
      total: 3,
      confirmed: 1,
      valueMismatch: 1,
      nameNotFound: 1,
    });
    expect(r.confirmedRate).toBeCloseTo(1 / 3);
  });
});

describe("reconcileAgainstSource", () => {
  it("returns null for a non-PDF source (nothing to reconcile against)", async () => {
    expect(
      await reconcileAgainstSource(Buffer.from("x"), "text/plain", [
        { name: "Sodium", value: "140", value_num: 140 },
      ])
    ).toBeNull();
  });
});

describe("isOcrReconcileEnabled — OCR fallback is opt-in, off by default", () => {
  afterEach(() => {
    delete process.env.RECONCILE_OCR;
  });
  it("is off when the env var is unset or anything but 1/true", () => {
    delete process.env.RECONCILE_OCR;
    expect(isOcrReconcileEnabled()).toBe(false);
    process.env.RECONCILE_OCR = "0";
    expect(isOcrReconcileEnabled()).toBe(false);
    process.env.RECONCILE_OCR = "yes";
    expect(isOcrReconcileEnabled()).toBe(false);
  });
  it("is on for 1 or true", () => {
    process.env.RECONCILE_OCR = "1";
    expect(isOcrReconcileEnabled()).toBe(true);
    process.env.RECONCILE_OCR = "true";
    expect(isOcrReconcileEnabled()).toBe(true);
  });
});
