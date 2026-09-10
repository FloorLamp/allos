import { describe, expect, it } from "vitest";
import {
  DEFS,
  LIFT_OPTIONS,
  PLAIN_DEFS,
  VARIANT_GROUPS,
  MUSCLE_LABEL,
  MUSCLE_REGION,
  DEFAULT_EQUIPMENT_LIFTS,
  composeVariant,
  liftsDataset,
} from "@/lib/datasets/lifts";
import { MUSCLE_IDS, liftInfo, type LiftDef } from "@/lib/lifts";

// Anti-drift pins for the curated lift catalog after it moved out of lib/lifts.ts into
// lib/datasets/data/lifts.json (#5175). The relocation's correctness was proved by a
// before/after byte-identity diff of DEFS / LIFT_OPTIONS against the pre-change module;
// what remains to pin permanently is the SHAPE that diff can no longer watch:
//
//   - the dataset entries reach DEFS untouched, in order, with the variant PRODUCT
//     appended after them (liftInfo's loose contains-fallback resolves ties by DEFS
//     order, so a reshuffle silently changes which lift a free-typed name resolves to);
//   - the MuscleId rollup and its labels stay TOTAL over the union (the guarantee the
//     in-code `Record<MuscleId, …>` literals gave at compile time);
//   - every default-implement name is a REAL catalog lift — a drift a hard-coded set of
//     name strings could not catch, and the reason those lists now sit beside the
//     catalog they name.
//
// Pure — no DB, no network.

describe("lifts.json dataset", () => {
  it("is the registered `lifts` envelope, identified by lift name", () => {
    expect(liftsDataset.id).toBe("lifts");
    expect(liftsDataset.identity.keys).toEqual(["name"]);
    expect(liftsDataset.citation.length).toBeGreaterThan(0);
  });

  it("hands its entries through as PLAIN_DEFS untouched (same objects, same order)", () => {
    expect(PLAIN_DEFS).toBe(liftsDataset.entries);
    expect(PLAIN_DEFS.length).toBeGreaterThan(0);
    expect(DEFS.slice(0, PLAIN_DEFS.length)).toEqual(PLAIN_DEFS);
    for (let i = 0; i < PLAIN_DEFS.length; i++) {
      expect(DEFS[i]).toBe(PLAIN_DEFS[i]);
    }
  });

  it("appends the variant product after the plain defs, base then one per equipment", () => {
    const expected: LiftDef[] = VARIANT_GROUPS.flatMap((g) => [
      { name: g.name, unilateral: undefined },
      ...g.equipment.map((eq) => ({
        name: composeVariant(g, eq),
        unilateral: g.unilateralEquipment?.includes(eq) || undefined,
      })),
    ]) as unknown as LiftDef[];
    const product = DEFS.slice(PLAIN_DEFS.length).map((d) => ({
      name: d.name,
      unilateral: d.unilateral,
    }));
    expect(product).toEqual(
      expected.map((e) => ({ name: e.name, unilateral: e.unilateral }))
    );
  });

  it("keeps the assisted entries LAST among the plain defs (the DEFS-order tie-break)", () => {
    const assisted = PLAIN_DEFS.map((d, i) =>
      d.loadKind === "assisted" ? i : -1
    ).filter((i) => i >= 0);
    expect(assisted.length).toBeGreaterThan(0);
    const tail = PLAIN_DEFS.length - assisted.length;
    expect(assisted).toEqual(assisted.map((_, k) => tail + k));
  });

  it("offers every plain lift plus each variant BASE in LIFT_OPTIONS, and no composed variant", () => {
    expect(LIFT_OPTIONS).toEqual([
      ...PLAIN_DEFS.map((d) => d.name),
      ...VARIANT_GROUPS.map((g) => g.name),
    ]);
    for (const g of VARIANT_GROUPS) {
      for (const eq of g.equipment) {
        expect(LIFT_OPTIONS).not.toContain(composeVariant(g, eq));
      }
    }
  });

  it("rolls up and labels EVERY MuscleId (totality over the union)", () => {
    for (const m of MUSCLE_IDS) {
      expect(MUSCLE_REGION[m], `${m}: no region`).toBeTruthy();
      expect(MUSCLE_LABEL[m], `${m}: no label`).toBeTruthy();
    }
    expect(Object.keys(MUSCLE_REGION).sort()).toEqual([...MUSCLE_IDS].sort());
    expect(Object.keys(MUSCLE_LABEL).sort()).toEqual([...MUSCLE_IDS].sort());
  });

  it("names only REAL catalog lifts in every default-implement list", () => {
    for (const [implement, names] of Object.entries(DEFAULT_EQUIPMENT_LIFTS)) {
      for (const key of names) {
        const info = liftInfo(key);
        expect(info?.name.toLowerCase(), `${implement}: "${key}"`).toBe(key);
      }
    }
  });
});
