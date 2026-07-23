// SERVER-ACTION TIER — the one-tap "Refilled" action (issue #852 item 3).
//
// refillMedication adds a remembered fill size back to a med's on-hand supply through
// the CAS write core (refillSupply → resolveRefillWrite), which re-reads the on-hand
// value under the IMMEDIATE write lock and adds RELATIVE to it — so a dose confirm that
// decremented supply between page-load and the refill tap is preserved, not clobbered
// (#467).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { decrementSupply } from "@/lib/queries";
import { refillMedication } from "@/app/(app)/medications/actions";
import { seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function seedMed(
  profileId: number,
  opts: {
    quantityOnHand: number | null;
    qtyPerDose?: number;
    lastFill?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, priority, kind, active, as_needed,
            quantity_on_hand, qty_per_dose, last_fill_size)
         VALUES (?, 'Metformin', 'daily', 'low', 'medication', 1, 0, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.quantityOnHand,
        opts.qtyPerDose ?? 1,
        opts.lastFill ?? null
      ).lastInsertRowid
  );
}

function onHand(id: number): {
  quantity_on_hand: number | null;
  last_fill_size: number | null;
} {
  return db
    .prepare(
      "SELECT quantity_on_hand, last_fill_size FROM intake_items WHERE id = ?"
    )
    .get(id) as {
    quantity_on_hand: number | null;
    last_fill_size: number | null;
  };
}

describe("refillMedication (#852 item 3)", () => {
  it("first use records the submitted fill size and adds it to supply", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 3, lastFill: null });
    const res = await refillMedication(fd({ id, fill_size: 30 }));
    expect(res.ok).toBe(true);
    expect(onHand(id)).toEqual({ quantity_on_hand: 33, last_fill_size: 30 });
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("one-tap reuses the remembered fill size when none is submitted", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 2, lastFill: 90 });
    const res = await refillMedication(fd({ id }));
    expect(res.ok).toBe(true);
    expect(onHand(id).quantity_on_hand).toBe(92);
  });

  it("preserves a concurrent dose decrement (CAS): refill lands on the CURRENT value", async () => {
    const { profile } = seedActor();
    // Loaded at 5 with a remembered fill of 30. A dose confirm decrements it to 4
    // AFTER the row was loaded but BEFORE the refill tap.
    const id = seedMed(profile.id, {
      quantityOnHand: 5,
      qtyPerDose: 1,
      lastFill: 30,
    });
    decrementSupply(profile.id, id); // concurrent: 5 → 4
    const res = await refillMedication(fd({ id })); // one-tap, remembered 30
    expect(res.ok).toBe(true);
    // 4 + 30 = 34 — NOT 5 + 30 = 35. The decrement survived the refill.
    expect(onHand(id).quantity_on_hand).toBe(34);
  });

  it("asks for a size on first use when none is remembered", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 3, lastFill: null });
    const res = await refillMedication(fd({ id }));
    expect(res.ok).toBe(false);
    // Nothing written.
    expect(onHand(id)).toEqual({ quantity_on_hand: 3, last_fill_size: null });
  });

  it("refuses an untracked item (no on-hand counter to add to)", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: null, lastFill: 30 });
    const res = await refillMedication(fd({ id, fill_size: 30 }));
    expect(res.ok).toBe(false);
    expect(onHand(id).quantity_on_hand).toBeNull();
  });

  it("rejects a non-positive submitted fill size", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 3, lastFill: null });
    const res = await refillMedication(fd({ id, fill_size: 0 }));
    expect(res.ok).toBe(false);
    expect(onHand(id).quantity_on_hand).toBe(3);
  });
});
