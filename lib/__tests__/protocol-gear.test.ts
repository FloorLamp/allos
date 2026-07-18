import { describe, it, expect } from "vitest";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import type { Equipment } from "@/lib/types";

// The protocol "Recovery gear" option filter (issue #592).

function eq(
  id: number,
  name: string,
  category: string | null,
  retired = 0
): Equipment {
  return { id, name, weight_kg: null, category, retired, created_at: "" };
}

const bar = eq(1, "Trap Bar", "Barbell"); // strength
const bike = eq(2, "Road Bike", "Bike"); // cardio
const shoes = eq(3, "Trail Shoes", "Shoes"); // cardio
const sauna = eq(4, "Sauna", "Sauna"); // recovery
const plunge = eq(5, "Cold Plunge", "Cold plunge"); // recovery
const racket = eq(6, "Racket", "Other"); // other
const mystery = eq(7, "Mystery", null); // null → other
const retiredSauna = eq(8, "Old Sauna", "Sauna", 1); // recovery, retired

const inventory = [bar, bike, shoes, sauna, plunge, racket, mystery];

describe("recoveryGearOptions", () => {
  it("keeps recovery gear plus uncategorized/Other, dropping strength & cardio", () => {
    expect(recoveryGearOptions(inventory)).toEqual([
      sauna,
      plunge,
      racket,
      mystery,
    ]);
  });

  it("excludes strength and cardio implements", () => {
    const ids = recoveryGearOptions(inventory).map((e) => e.id);
    expect(ids).not.toContain(bar.id);
    expect(ids).not.toContain(bike.id);
    expect(ids).not.toContain(shoes.id);
  });

  it("returns an empty list when the profile owns only strength/cardio gear", () => {
    expect(recoveryGearOptions([bar, bike, shoes])).toEqual([]);
  });

  it("appends a linked non-recovery item so the edit never drops it", () => {
    // A protocol linked to a barbell (a mis-link, or category changed later) stays
    // selectable — appended last, like the picker's selectedMissing fallback.
    const opts = recoveryGearOptions(inventory, bar);
    expect(opts).toEqual([sauna, plunge, racket, mystery, bar]);
  });

  it("drops a retired recovery row from the fresh list (issue #662)", () => {
    // Even if a caller hands in a retired row (e.g. includeRetired:true), the
    // filter must not offer it as a fresh pick — like every training surface.
    const opts = recoveryGearOptions([sauna, retiredSauna, plunge]);
    expect(opts).toEqual([sauna, plunge]);
    expect(opts.map((e) => e.id)).not.toContain(retiredSauna.id);
  });

  it("appends a linked retired recovery item (excluded from the fresh list)", () => {
    // getEquipment drops retired rows, so a linked-but-retired sauna arrives only
    // via `selected` (resolved by getEquipmentById, which ignores retired).
    const active = [bar, bike, sauna];
    const opts = recoveryGearOptions(active, retiredSauna);
    expect(opts).toEqual([sauna, retiredSauna]);
  });

  it("does not duplicate a linked item already in the filtered list", () => {
    const opts = recoveryGearOptions(inventory, sauna);
    expect(opts).toEqual([sauna, plunge, racket, mystery]);
    expect(opts.filter((e) => e.id === sauna.id)).toHaveLength(1);
  });

  it("ignores a null selection", () => {
    expect(recoveryGearOptions(inventory, null)).toEqual(
      recoveryGearOptions(inventory)
    );
  });
});
