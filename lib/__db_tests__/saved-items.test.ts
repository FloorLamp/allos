// DB INTEGRATION TIER — the semantics the unified save store (#1456) CARRIES OVER
// from the two stores it folded, plus the contracts the fold promoted:
//
//   1. #482 family identity — a save on any family member lights the family, and
//      un-saving clears every member (the toggle can't get stuck).
//   2. The #203 name-keyed lifecycle — a canonical RENAME re-keys the save (and never
//      touches a `trend-metric` save that happens to share the name), a delete
//      de-orphans it, and the orphan sweep is kind-scoped.
//   3. THE SAVE→PASSPORT CONTRACT — a saved biomarker enters the profile summary's
//      vitals. This was an undocumented side effect of `starred_biomarkers`; the fold
//      promoted it to a stated contract (lib/profile-summary-load.ts), so it is pinned
//      here.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. All values are
// SYNTHETIC (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getSavedBiomarkers,
  isBiomarkerSaved,
  saveBiomarker,
  unsaveBiomarkerFamily,
  toggleBiomarkerSaved,
  cleanupOrphanSavedBiomarkers,
  migrateRenamedBiomarker,
  getSavedItems,
  moveSavedItem,
  toggleItemSaved,
} from "@/lib/queries";
import { getProfileSummary } from "@/lib/profile-summary-load";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addReading(
  profileId: number,
  canonical: string,
  opts: { date?: string; value?: string; valueNum?: number; unit?: string } = {}
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, 'manual')`
  ).run(
    profileId,
    opts.date ?? "2026-04-01",
    canonical,
    opts.value ?? "100",
    opts.valueNum ?? 100,
    opts.unit ?? "mg/dL",
    canonical
  );
}

function savedKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT key FROM saved_items
          WHERE profile_id = ? AND kind = 'biomarker' ORDER BY key`
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
}

describe("biomarker saves are #482 family-keyed", () => {
  it("a save on one member reads as saved for every member", () => {
    const p = newProfile("Family Save");
    addReading(p, "Vitamin D, 25-Hydroxy", { unit: "ng/mL" });
    saveBiomarker(p, "Vitamin D, 25-Hydroxy");

    expect(isBiomarkerSaved(p, "Vitamin D, 25-Hydroxy")).toBe(true);
    // A sibling spelling of the SAME analyte family lights the same star.
    expect(isBiomarkerSaved(p, "Vitamin D, Total")).toBe(true);
    // An unrelated analyte does not.
    expect(isBiomarkerSaved(p, "ApoB")).toBe(false);
  });

  it("respects the family EXCLUSION discipline (a D3 fraction is its own analyte)", () => {
    // #1193 deliberately keeps the D2/D3 fractions OUT of the 25-OH total's family,
    // so a save must not collapse them — an over-collapse grants a wrong all-clear.
    const p = newProfile("Family Exclusion");
    saveBiomarker(p, "Vitamin D, Total");
    expect(isBiomarkerSaved(p, "Vitamin D3")).toBe(false);
  });

  it("un-saving clears the whole family, so the toggle can't stick", () => {
    const p = newProfile("Family Unsave");
    saveBiomarker(p, "Vitamin D, Total");
    saveBiomarker(p, "25-OH Vitamin D");
    expect(savedKeys(p).length).toBe(2);

    unsaveBiomarkerFamily(p, "Vitamin D, 25-Hydroxy");

    expect(savedKeys(p)).toEqual([]);
    expect(isBiomarkerSaved(p, "25-OH Vitamin D")).toBe(false);
  });

  it("toggleBiomarkerSaved round-trips through the family", () => {
    const p = newProfile("Family Toggle");
    expect(toggleBiomarkerSaved(p, "Vitamin D, Total")).toBe(true);
    // Toggling a SIBLING off clears the family (it read as saved).
    expect(toggleBiomarkerSaved(p, "25-OH Vitamin D")).toBe(false);
    expect(savedKeys(p)).toEqual([]);
  });

  it("stores the name the user starred, not the family key", () => {
    // The row stays a real, human-readable analyte name that a rename can re-key.
    const p = newProfile("Family Storage");
    saveBiomarker(p, "25-OH Vitamin D");
    expect(savedKeys(p)).toEqual(["25-OH Vitamin D"]);
  });
});

describe("name-keyed lifecycle (#203)", () => {
  it("a canonical rename re-keys the save", () => {
    const p = newProfile("Rename Save");
    saveBiomarker(p, "RDW");

    migrateRenamedBiomarker(p, "RDW", "Red Cell Distribution Width (RDW)");

    expect(savedKeys(p)).toEqual(["Red Cell Distribution Width (RDW)"]);
  });

  it("a rename that COLLIDES with an existing save collapses to one row", () => {
    const p = newProfile("Rename Collision");
    saveBiomarker(p, "RDW");
    saveBiomarker(p, "Red Cell Distribution Width (RDW)");

    migrateRenamedBiomarker(p, "RDW", "Red Cell Distribution Width (RDW)");

    // Never two saves on one analyte after a rename.
    expect(savedKeys(p)).toEqual(["Red Cell Distribution Width (RDW)"]);
  });

  it("a rename never touches a trend-metric save sharing the name", () => {
    // The generic store's hazard: `kind` is what keeps the two key spaces apart.
    const p = newProfile("Rename Kind Scope");
    saveBiomarker(p, "weight");
    toggleItemSaved(p, "trend-metric", "weight");

    migrateRenamedBiomarker(p, "weight", "Body Weight (lab)");

    expect(savedKeys(p)).toEqual(["Body Weight (lab)"]);
    expect(getSavedItems(p, "trend-metric").map((r) => r.key)).toEqual([
      "weight",
    ]);
  });

  it("the orphan sweep drops a save whose family lost every reading", () => {
    const p = newProfile("Orphan Sweep");
    addReading(p, "ApoB");
    saveBiomarker(p, "ApoB");
    saveBiomarker(p, "Ferritin"); // never had a reading

    cleanupOrphanSavedBiomarkers(p);

    expect(savedKeys(p)).toEqual(["ApoB"]);
  });

  it("the orphan sweep keeps a save backed by ANY family member's reading", () => {
    const p = newProfile("Orphan Family");
    addReading(p, "25-OH Vitamin D", { unit: "ng/mL" });
    saveBiomarker(p, "Vitamin D, 25-Hydroxy");

    cleanupOrphanSavedBiomarkers(p);

    expect(savedKeys(p)).toEqual(["Vitamin D, 25-Hydroxy"]);
  });

  it("the orphan sweep never removes a trend-metric save", () => {
    // A metric id is not a biomarker name; a records-driven sweep must not see it.
    const p = newProfile("Orphan Kind Scope");
    toggleItemSaved(p, "trend-metric", "weight");

    cleanupOrphanSavedBiomarkers(p);

    expect(getSavedItems(p, "trend-metric").map((r) => r.key)).toEqual([
      "weight",
    ]);
  });
});

describe("saved order", () => {
  it("reads positioned rows first, then newest saves", () => {
    const p = newProfile("Saved Order");
    saveBiomarker(p, "ApoB");
    saveBiomarker(p, "Ferritin");
    toggleItemSaved(p, "trend-metric", "weight");
    // Nothing positioned yet — a plain star leaves position NULL.
    expect(getSavedItems(p).every((r) => r.position == null)).toBe(true);

    // One reorder normalizes EVERY row to a dense position.
    const first = getSavedItems(p);
    moveSavedItem(p, { kind: first[2].kind, key: first[2].key }, "up");
    const after = getSavedItems(p);
    expect(after.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(after.map((r) => r.key)).toEqual([
      first[0].key,
      first[2].key,
      first[1].key,
    ]);
  });

  it("a move at either end is a no-op", () => {
    const p = newProfile("Saved Order Ends");
    saveBiomarker(p, "ApoB");
    saveBiomarker(p, "Ferritin");
    const before = getSavedItems(p).map((r) => r.key);

    moveSavedItem(p, { kind: "biomarker", key: before[0] }, "up");
    expect(getSavedItems(p).map((r) => r.key)).toEqual(before);

    moveSavedItem(p, { kind: "biomarker", key: before[1] }, "down");
    expect(getSavedItems(p).map((r) => r.key)).toEqual(before);
  });

  it("getSavedBiomarkers honours that same order", () => {
    const p = newProfile("Saved Biomarker Order");
    addReading(p, "ApoB");
    addReading(p, "Ferritin", { unit: "ng/mL" });
    saveBiomarker(p, "ApoB");
    saveBiomarker(p, "Ferritin");
    db.prepare(
      `UPDATE saved_items SET position = 0 WHERE profile_id = ? AND key = 'Ferritin'`
    ).run(p);

    expect(getSavedBiomarkers(p).map((s) => s.canonical_name)).toEqual([
      "Ferritin",
      "ApoB",
    ]);
  });
});

describe("the save→passport contract (#1456)", () => {
  it("a saved biomarker enters the profile summary's vitals", () => {
    const p = newProfile("Passport Contract");
    // An UNFLAGGED, in-range reading: it reaches the passport ONLY because it is
    // saved (the flagged list would never carry it).
    addReading(p, "Ferritin", {
      date: "2026-04-01",
      value: "120",
      valueNum: 120,
      unit: "ng/mL",
    });

    const before = getProfileSummary(p, "Passport Contract");
    expect(before.vitals.some((v) => v.name === "Ferritin")).toBe(false);

    saveBiomarker(p, "Ferritin");

    const after = getProfileSummary(p, "Passport Contract");
    const vital = after.vitals.find((v) => v.name === "Ferritin");
    expect(vital).toBeDefined();
    expect(vital?.starred).toBe(true);
    expect(vital?.value).toBe("120");
    expect(vital?.date).toBe("2026-04-01");

    // …and un-starring removes it again: membership IS the contract.
    unsaveBiomarkerFamily(p, "Ferritin");
    expect(
      getProfileSummary(p, "Passport Contract").vitals.some(
        (v) => v.name === "Ferritin"
      )
    ).toBe(false);
  });

  it("a saved TREND-METRIC never leaks into the passport vitals", () => {
    // Kind-specific meaning: a metric save is Trends promotion, nothing else.
    const p = newProfile("Passport Kind Scope");
    toggleItemSaved(p, "trend-metric", "weight");
    expect(
      getProfileSummary(p, "Passport Kind Scope").vitals.map((v) => v.name)
    ).not.toContain("weight");
  });
});
