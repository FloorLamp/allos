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
import {
  MUSCLE_IDS,
  REGION_SCOPES,
  liftInfo,
  type Equipment,
  type LiftDef,
  type MovementPattern,
} from "@/lib/lifts";

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

// The LEGAL VALUE SETS the pins below check against, derived from the code that owns
// each union wherever a runtime witness exists, so a pin cannot drift from its type:
//
//   MuscleId     → MUSCLE_IDS, exported by lib/lifts.ts.
//   MuscleRegion → REGION_SCOPES, exported and typed `MuscleRegion[]`, so every element
//                  is compile-checked to be one. If it ever stopped being the WHOLE
//                  union the pins would get too STRICT (a false failure), never too
//                  permissive — the safe direction, and why no literal is needed here.
//
// MovementPattern and Equipment have no runtime witness to derive from, so each is a
// `satisfies`-checked record: `satisfies` fails on a MISSING member and the
// excess-property check fails on an INVENTED one, which pins the literal to the union
// in both directions at compile time — the nearest thing to a witness the union has.
const PATTERNS = {
  push: true,
  pull: true,
  legs: true,
  core: true,
} satisfies Record<MovementPattern, true>;

const EQUIPMENT = {
  Barbell: true,
  Dumbbell: true,
  Cable: true,
  Machine: true,
  Kettlebell: true,
  "Trap Bar": true,
  Smith: true,
} satisfies Record<Equipment, true>;

const MUSCLE_SET = new Set<string>(MUSCLE_IDS);
const REGION_SET = new Set<string>(REGION_SCOPES);
const PATTERN_SET = new Set<string>(Object.keys(PATTERNS));
const EQUIPMENT_SET = new Set<string>(Object.keys(EQUIPMENT));

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
      // Membership, not truthiness: a corrupted "Bak" is truthy and would sail
      // through a presence check while silently un-regioning every chest lift.
      expect(REGION_SET.has(MUSCLE_REGION[m]), `${m}: region`).toBe(true);
      expect(MUSCLE_LABEL[m]?.trim(), `${m}: label`).toBeTruthy();
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
  // ── Value domains ─────────────────────────────────────────────────────────
  // The guarantee the relocation traded away. The in-code literals were fully
  // typechecked, so `pattern: "pushh"` or `region: "Bak"` was a COMPILE error. A JSON
  // entry gets its `LiftDef` typing from `loadDataset<LiftDef, …>`'s type PARAMETER,
  // which is erased: loadDataset validates the envelope and the identity keys, and the
  // framework harness checks citations, identity, refusal and key collisions — none of
  // them asks whether a value belongs to its union. These are that check, at the
  // boundary, so a bad value fails HERE naming the lift rather than downstream.
  //
  // The deeper tagging invariant — that a lift's primary muscles ROLL UP into its
  // declared region — is muscle-id.test.ts's, over the derived defs. This file pins the
  // dataset's own fields; that file pins what they must add up to. Don't add a third.

  it("gives every entry a real region and pattern, and only real muscle ids", () => {
    for (const d of PLAIN_DEFS) {
      expect(REGION_SET.has(d.region), `${d.name}: region "${d.region}"`).toBe(
        true
      );
      expect(
        PATTERN_SET.has(d.pattern),
        `${d.name}: pattern "${d.pattern}"`
      ).toBe(true);
      // `muscle` is a free-text DISPLAY label and deliberately NOT an identity key
      // (LiftDef says so): "Posterior chain", "Chest & triceps" and "Full body" are
      // real catalog values and none of them is a MuscleId. The ids are the two arrays
      // below, so all this field can honestly be pinned to is that it says something.
      expect(d.muscle.trim(), `${d.name}: empty muscle label`).not.toBe("");
      for (const m of [...d.primaryMuscles, ...d.secondaryMuscles]) {
        expect(MUSCLE_SET.has(m), `${d.name}: unknown muscle id "${m}"`).toBe(
          true
        );
      }
    }
  });

  it("gives every variant group a real region, pattern, muscle ids and equipment", () => {
    for (const g of VARIANT_GROUPS) {
      expect(REGION_SET.has(g.region), `${g.name}: region "${g.region}"`).toBe(
        true
      );
      expect(
        PATTERN_SET.has(g.pattern),
        `${g.name}: pattern "${g.pattern}"`
      ).toBe(true);
      expect(g.muscle.trim(), `${g.name}: empty muscle label`).not.toBe("");
      for (const m of [...g.primaryMuscles, ...g.secondaryMuscles]) {
        expect(MUSCLE_SET.has(m), `${g.name}: unknown muscle id "${m}"`).toBe(
          true
        );
      }
      expect(g.equipment.length, `${g.name}: no equipment`).toBeGreaterThan(0);
      for (const eq of g.equipment) {
        expect(EQUIPMENT_SET.has(eq), `${g.name}: equipment "${eq}"`).toBe(
          true
        );
      }
      for (const eq of g.unilateralEquipment ?? []) {
        expect(
          EQUIPMENT_SET.has(eq),
          `${g.name}: unilateralEquipment "${eq}"`
        ).toBe(true);
        // A per-side flag for an implement the group cannot be loaded with composes
        // no lift, so it would silently do nothing.
        expect(
          g.equipment,
          `${g.name}: unilateralEquipment "${eq}" is not in equipment`
        ).toContain(eq);
      }
    }
  });
});
