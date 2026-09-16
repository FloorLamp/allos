import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  createSharedSupply,
  linkItemToPool,
  refillSupply,
  getSharedSupply,
} from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let alice: SeededProfile;
beforeAll(() => {
  alice = seedProfile("R5911");
});

function addItem(profileId: number, name: string, qty: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'should', ?, 1)`
      )
      .run(profileId, name, qty).lastInsertRowid
  );
}

describe("#5911 repro on main", () => {
  it("one-taps a private 30 into a shared 500 jar", () => {
    const itemId = addItem(alice.profileId, "R5911 Med", 10);
    // Step 1: private refill at 30 → last_fill_size = 30
    expect(refillSupply(alice.profileId, itemId, 30)).toEqual({
      kind: "refilled",
      newQuantity: 40,
      fillSize: 30,
    });
    const supplyId = createSharedSupply(
      { name: "R5911 Jar", strength: null, form: null, lowSupplyDays: null, notes: null },
      500
    );
    // Step 2: link — private count nulled, last_fill_size kept
    linkItemToPool(alice.profileId, itemId, supplyId);
    const after = db
      .prepare("SELECT quantity_on_hand, last_fill_size FROM intake_items WHERE id = ?")
      .get(itemId);
    console.log("ITEM AFTER LINK:", after);
    // Step 3/4: one-tap with NO size → the member's 30 lands on the jar
    const out = refillSupply(alice.profileId, itemId, null);
    console.log("REFILL OUTCOME:", out, "POOL:", getSharedSupply(supplyId));
    expect(out).toEqual({ kind: "refilled", newQuantity: 530, fillSize: 30 });
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(530);
  });
});
