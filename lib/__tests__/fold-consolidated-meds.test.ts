// PURE TIER (#1280) — the reprocess-preview medication fold decision.
//
// foldConsolidatedMeds folds a derived med that a profile ALREADY tracks into the
// persisted snapshot so it compares "unchanged" (the #1204 phantom-diff fix). The
// #1280 bug: the original fold matched on the bare drug NAME, so it hid a
// genuinely-new medication that the commit path (classifyReprescription) would
// actually create as a SEPARATE item — the #1027 concurrent open-course +
// provably-different-strength case. These pure tests pin that the fold now mirrors
// classifyReprescription: fold a renewal, but leave a "separate" derived med to
// preview as an addition. (The DB-tier end-to-end fixture lives in
// lib/__db_tests__/reprocess-diff.test.ts.)

import { describe, expect, it } from "vitest";
import {
  foldConsolidatedMeds,
  type MedFoldMatch,
} from "@/lib/medication-renewal";
import { emptySnapshot, medicationRow } from "@/lib/import-diff";
import type { ImportSnapshot } from "@/lib/import-diff";

// A snapshot whose ONLY tracked-in-this-document med is Cetirizine (Ibuprofen is
// consolidated onto another document's item, so it is absent here — exactly the
// state the fold exists to reconcile).
function snapWithCetirizine(): ImportSnapshot {
  const snap = emptySnapshot();
  snap.medications = [medicationRow("Cetirizine 10 mg")];
  return snap;
}

// The profile tracks Ibuprofen 200 mg with an OPEN course — the #1027 precondition.
const ibuprofen200Open: MedFoldMatch = {
  name: "Ibuprofen 200 mg",
  brand: null,
  hasOpenCourse: true,
  strengths: ["200 mg"],
};

describe("foldConsolidatedMeds (#1280)", () => {
  it("does NOT fold a derived med that #1027 would split into a separate item (open course + provably different strength)", () => {
    // Ibuprofen 200 mg tracked with an open course; the reprocessed document derives
    // Ibuprofen 800 mg. Commit-time classifyReprescription → "separate" (a real new
    // med), so the preview must show it as an ADDITION, not hide it as "unchanged".
    const snap = snapWithCetirizine();
    const derived = [
      medicationRow("Ibuprofen 800 mg"),
      medicationRow("Cetirizine 10 mg"),
    ];
    const strengths = new Map<string, string | null>([
      [medicationRow("Ibuprofen 800 mg").key, "800 mg"],
      [medicationRow("Cetirizine 10 mg").key, "10 mg"],
    ]);

    foldConsolidatedMeds([ibuprofen200Open], snap, derived, strengths);

    // Ibuprofen was NOT folded in — the preview still sees it as a new derived med.
    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
    ]);
  });

  it("DOES fold a same-strength renewal into unchanged (the #1204 phantom-diff fix stays)", () => {
    // Same tracked med, but the reprocessed document re-derives Ibuprofen 200 mg —
    // a renewal (no strength change). Committing adds nothing, so the fold hides it.
    const snap = snapWithCetirizine();
    const derived = [
      medicationRow("Ibuprofen 200 mg"),
      medicationRow("Cetirizine 10 mg"),
    ];
    const strengths = new Map<string, string | null>([
      [medicationRow("Ibuprofen 200 mg").key, "200 mg"],
      [medicationRow("Cetirizine 10 mg").key, "10 mg"],
    ]);

    foldConsolidatedMeds([ibuprofen200Open], snap, derived, strengths);

    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);
  });

  it("folds an unknown-strength derived med (conservative renewal, never spawns a duplicate)", () => {
    // No strength recovered for the derived Ibuprofen — an unknown strength can't
    // prove a concurrent second product, so it renews and folds (per #1204).
    const snap = snapWithCetirizine();
    const derived = [
      medicationRow("Ibuprofen"),
      medicationRow("Cetirizine 10 mg"),
    ];
    const strengths = new Map<string, string | null>([
      [medicationRow("Ibuprofen").key, null],
      [medicationRow("Cetirizine 10 mg").key, "10 mg"],
    ]);

    foldConsolidatedMeds([ibuprofen200Open], snap, derived, strengths);

    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);
  });

  it("folds a different strength when the prior course is CLOSED (a dose-change renewal, not concurrent)", () => {
    // Existing Ibuprofen 200 mg but NO open course; deriving 800 mg is a renewal /
    // dose change, not a concurrent second product → folds.
    const snap = snapWithCetirizine();
    const closed: MedFoldMatch = { ...ibuprofen200Open, hasOpenCourse: false };
    const derived = [medicationRow("Ibuprofen 800 mg")];
    const strengths = new Map<string, string | null>([
      [medicationRow("Ibuprofen 800 mg").key, "800 mg"],
    ]);

    foldConsolidatedMeds([closed], snap, derived, strengths);

    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);
  });

  it("never folds a derived med the profile does not track", () => {
    const snap = snapWithCetirizine();
    const derived = [medicationRow("Amoxicillin 400 mg")];
    const strengths = new Map<string, string | null>([
      [medicationRow("Amoxicillin 400 mg").key, "400 mg"],
    ]);

    foldConsolidatedMeds([ibuprofen200Open], snap, derived, strengths);

    expect(snap.medications.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
    ]);
  });
});
