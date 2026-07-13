import { describe, expect, it } from "vitest";
import { IMPORT_SIDE_EFFECTS } from "@/lib/import-footprint";

// Pins the import side-effect inventory (#453 item 2) — the typed list of non-row
// effects an import writes ALONGSIDE its IMPORT_FOOTPRINT_TABLES rows. The footprint
// list is mechanically bound (a table added to persistDocumentImport but not the list
// fails the single-entry scan); a side EFFECT is a decision, so this list can't be
// derived mechanically. This test is its teeth: adding a new followup without giving
// it an inventory slot — and answering its delete/reassign/count questions — fails
// here, which is the "obvious slot, obvious question" the inventory exists to force.

describe("import side-effect inventory", () => {
  it("declares exactly the known side effects (a new one forces a conscious slot)", () => {
    const keys = IMPORT_SIDE_EFFECTS.map((e) => e.key).sort();
    expect(keys).toEqual(
      [
        "canonical-name-registration",
        "demographics-adoption",
        "flag-reconciliation",
        "immunization-dismissal-sweep",
        "orphan-biomarker-keyed-state-sweep",
        "smoking-status-adoption",
      ].sort()
    );
  });

  it("has unique keys", () => {
    const keys = IMPORT_SIDE_EFFECTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry answers its delete + reassign + count questions", () => {
    for (const e of IMPORT_SIDE_EFFECTS) {
      expect(e.what.length, e.key).toBeGreaterThan(0);
      expect(e.where.length, e.key).toBeGreaterThan(0);
      expect(["one-way", "recompute", "sweep", "global"], e.key).toContain(
        e.onDelete
      );
      expect(["one-way", "recompute", "sweep", "global"], e.key).toContain(
        e.onReassign
      );
      // A side EFFECT is by definition not a footprint ROW, so it never feeds the
      // extracted_count tally (that number counts rows off IMPORT_FOOTPRINT_TABLES).
      expect(e.countsTowardFootprint, e.key).toBe(false);
    }
  });

  it("declares profile adoption one-way on both delete and reassign (#452 item 2)", () => {
    for (const key of ["smoking-status-adoption", "demographics-adoption"]) {
      const e = IMPORT_SIDE_EFFECTS.find((x) => x.key === key);
      expect(e, key).toBeTruthy();
      expect(e!.onDelete, key).toBe("one-way");
      expect(e!.onReassign, key).toBe("one-way");
    }
  });
});
