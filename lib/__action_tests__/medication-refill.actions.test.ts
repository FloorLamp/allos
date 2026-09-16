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
import {
  createSharedSupply,
  decrementSupply,
  getSharedSupply,
  linkItemToPool,
} from "@/lib/queries";
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
    kind?: "medication" | "supplement";
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, condition, obligation, kind, active, quantity_on_hand, qty_per_dose, last_fill_size)
         VALUES (?, 'Metformin', 'daily', 'should', ?, 1, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.kind ?? "medication",
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

// A household bottle with a starting count, and one of the actor's items drawing from
// it. `linkItemToPool` nulls the item's private count, which is the state every pooled
// assertion below starts from.
function seedBottle(
  profileId: number,
  itemId: number,
  quantityOnHand: number
): number {
  const supplyId = createSharedSupply(
    {
      name: "Household Jar",
      strength: null,
      form: null,
      lowSupplyDays: null,
      notes: null,
    },
    quantityOnHand
  );
  linkItemToPool(profileId, itemId, supplyId);
  return supplyId;
}

function bottle(supplyId: number): {
  quantity_on_hand: number | null;
  last_fill_size: number | null;
} {
  const row = getSharedSupply(supplyId)!;
  return {
    quantity_on_hand: row.quantity_on_hand,
    last_fill_size: row.last_fill_size,
  };
}

describe("refillMedication (#852 item 3)", () => {
  it.each(["medication", "supplement"] as const)(
    "first use records the submitted fill size for %s",
    async (kind) => {
      const { profile } = seedActor();
      const id = seedMed(profile.id, {
        quantityOnHand: 3,
        lastFill: null,
        kind,
      });
      const res = await refillMedication(fd({ id, fill_size: 30 }));
      expect(res.ok).toBe(true);
      expect(onHand(id)).toEqual({ quantity_on_hand: 33, last_fill_size: 30 });
      expect(revalidate).toHaveBeenCalledWith("/medications");
    }
  );

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
    expect(res).toMatchObject({ ok: false, kind: "needs-size" });
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

  // #1893: the success arm carries the core's OWN numbers back, so the affordance can
  // say "Refilled just now (+90)" for a short window (the #798 informational treatment
  // for an accidental double-tap). The one-tap path is the case the client cannot
  // compute for itself — the size came from `last_fill_size`, not from the form.
  it("returns the fill size and resulting quantity on the one-tap path (#1893)", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 2, lastFill: 90 });
    const res = await refillMedication(fd({ id }));
    expect(res).toEqual({ ok: true, fillSize: 90, newQuantity: 92 });
  });

  // The second tap of a double-tap is a real, ADDITIVE write — it is never blocked, and
  // it reports its own fill honestly. The recency line tells; it does not gate (#798).
  it("a second tap adds a second fill and reports it (#1893)", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 2, lastFill: 90 });
    await refillMedication(fd({ id }));
    const second = await refillMedication(fd({ id }));
    expect(second).toEqual({ ok: true, fillSize: 90, newQuantity: 182 });
    expect(onHand(id).quantity_on_hand).toBe(182);
  });
});

// ── A SHARED BOTTLE'S OWN USUAL REFILL (#5121 owner ruling 2026-09-16, #5911) ────────
//
// The same action, the same gate, the same CAS core — asked about a POOLED target. What
// changes is only which container's remembered fill answers a tap with no size in it.
describe("refillMedication on a pooled target", () => {
  it("asks once for the bottle's fill size, then one-taps it", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 8, lastFill: null });
    const supplyId = seedBottle(profile.id, id, 20);

    const first = await refillMedication(fd({ id }));
    expect(first).toMatchObject({ ok: false, kind: "needs-size" });
    expect(bottle(supplyId)).toEqual({
      quantity_on_hand: 20,
      last_fill_size: null,
    });

    expect(await refillMedication(fd({ id, fill_size: 500 }))).toEqual({
      ok: true,
      fillSize: 500,
      newQuantity: 520,
    });
    // THE ONE-TAP: no size in the form, and the BOTTLE's own 500 is what lands.
    expect(await refillMedication(fd({ id }))).toEqual({
      ok: true,
      fillSize: 500,
      newQuantity: 1020,
    });
    expect(bottle(supplyId)).toEqual({
      quantity_on_hand: 1020,
      last_fill_size: 500,
    });
  });

  it("never one-taps a member's PRIVATE remembered fill into the bottle (#5911)", async () => {
    // THE BUG, THROUGH THE REAL ACTION. The item was refilled at 30 while private and
    // linked afterwards; `linkItemToPool` drops the private count and keeps the 30. On
    // main the no-size tap added that 30 to the 500-count jar with no input shown. The
    // member's size is no longer an input to a pooled answer, so the action asks — and
    // the member's own memory is left exactly as it was.
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 10, lastFill: 30 });
    const supplyId = seedBottle(profile.id, id, 500);
    expect(onHand(id)).toEqual({ quantity_on_hand: null, last_fill_size: 30 });

    expect(await refillMedication(fd({ id }))).toMatchObject({
      ok: false,
      kind: "needs-size",
    });
    expect(bottle(supplyId)).toEqual({
      quantity_on_hand: 500,
      last_fill_size: null,
    });
    expect(onHand(id)).toEqual({ quantity_on_hand: null, last_fill_size: 30 });
  });

  it("remembers the pooled fill on the bottle only, leaving the member's alone", async () => {
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 10, lastFill: 60 });
    const supplyId = seedBottle(profile.id, id, 5);

    expect(await refillMedication(fd({ id, fill_size: 500 }))).toEqual({
      ok: true,
      fillSize: 500,
      newQuantity: 505,
    });
    expect(bottle(supplyId).last_fill_size).toBe(500);
    expect(onHand(id).last_fill_size).toBe(60);
  });

  it("preserves a concurrent dose decrement on the pooled one-tap (CAS)", async () => {
    // The relative-refill arithmetic is unchanged by any of this: the fill still lands
    // on the value re-read under the write lock, not on the loaded one.
    const { profile } = seedActor();
    const id = seedMed(profile.id, {
      quantityOnHand: null,
      qtyPerDose: 1,
      lastFill: null,
    });
    const supplyId = seedBottle(profile.id, id, 10);
    await refillMedication(fd({ id, fill_size: 100 })); // bottle: 110, remembers 100
    decrementSupply(profile.id, id); // concurrent dose: 110 → 109
    expect(await refillMedication(fd({ id }))).toEqual({
      ok: true,
      fillSize: 100,
      newQuantity: 209,
    });
    expect(bottle(supplyId).quantity_on_hand).toBe(209);
  });

  it("refuses a tap aimed at a stale target, writing nothing", async () => {
    // The posted `supply_id` is the target the surface BELIEVED it was refilling. An
    // item relinked (or unlinked) since that render must not have its tap silently
    // land on whatever container it points at now — unchanged by this work, asserted
    // here because the remembered fill is now read from that same target.
    const { profile } = seedActor();
    const id = seedMed(profile.id, { quantityOnHand: 4, lastFill: null });
    const supplyId = seedBottle(profile.id, id, 40);
    await refillMedication(fd({ id, supply_id: supplyId, fill_size: 90 }));
    expect(bottle(supplyId)).toEqual({
      quantity_on_hand: 130,
      last_fill_size: 90,
    });

    const stale = await refillMedication(fd({ id, supply_id: "" }));
    expect(stale.ok).toBe(false);
    expect(bottle(supplyId)).toEqual({
      quantity_on_hand: 130,
      last_fill_size: 90,
    });
  });
});
