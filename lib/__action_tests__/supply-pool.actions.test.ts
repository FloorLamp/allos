// SERVER-ACTION TIER — the shared supply pool auth gates (#1374). A `shared_supplies`
// row is household-shared and has NO owning profile, so the ordinary active-profile
// requireWriteAccess() would authorize the wrong subject. Two distinct gates ship here
// and only this tier can see them:
//
//   • POOL edits (quantity / threshold / rename / delete) → requirePoolWriteAccess:
//     write access to at least ONE linked profile.
//   • LINK / UNLINK → requireItemWriteAccess: the ITEM's own profile.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createPoolAction,
  updatePoolAction,
  deletePoolAction,
  linkItemAction,
  unlinkItemAction,
} from "@/app/(app)/supplies/actions";
import { createSharedSupply, getSharedSupply } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

let seq = 0;
function tag(): string {
  return `pool${++seq}`;
}

function item(profileId: number, name: string, qty: number | null): number {
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

function supplyIdOf(itemId: number): number | null {
  return (
    db
      .prepare("SELECT supply_id AS s FROM intake_items WHERE id = ?")
      .get(itemId) as { s: number | null }
  ).s;
}
function itemQty(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

function newPool(name: string, qty: number | null): number {
  return createSharedSupply(
    { name, strength: null, form: null, lowSupplyDays: null, notes: null },
    qty
  );
}

const poolFields = (name: string): Record<string, string> => ({ name });

describe("pool edits gate on membership (write to ≥1 linked profile)", () => {
  it("lets a member who writes ONE linked profile edit and delete the pool", async () => {
    const t = tag();
    const member = createLogin({ role: "member", username: `m_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, member.id);
    const theirs = createProfile(`Test Patient ${t}`);
    actAs(member, mine);

    const supplyId = newPool(`Shared ${t}`, 40);
    const a = item(mine.id, `Med ${t} A`, null);
    const b = item(theirs.id, `Med ${t} B`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id IN (?, ?)").run(
      supplyId,
      a,
      b
    );

    const res = await updatePoolAction(
      fd({ id: supplyId, ...poolFields(`Shared ${t} renamed`) })
    );
    expect(res.ok).toBe(true);
    expect(getSharedSupply(supplyId)?.name).toBe(`Shared ${t} renamed`);

    expect((await deletePoolAction(fd({ id: supplyId }))).ok).toBe(true);
    expect(getSharedSupply(supplyId)).toBe(null);
    // The links are carried, not cascade-dropped: two members ⇒ both untracked.
    expect(supplyIdOf(a)).toBe(null);
    expect(supplyIdOf(b)).toBe(null);
    expect(itemQty(a)).toBe(null);
    expect(itemQty(b)).toBe(null);
  });

  it("refuses a member granted NONE of the linked profiles", async () => {
    const t = tag();
    const outsider = createLogin({ role: "member", username: `o_${t}` });
    const own = createProfile(`Ada Lovelace ${t}`, outsider.id);
    const stranger = createProfile(`Test Patient ${t}`);
    actAs(outsider, own);

    const supplyId = newPool(`Foreign ${t}`, 40);
    const foreign = item(stranger.id, `Med ${t}`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      supplyId,
      foreign
    );

    await expect(
      updatePoolAction(fd({ id: supplyId, ...poolFields(`Hijacked ${t}`) }))
    ).rejects.toThrow(/not accessible/);
    await expect(deletePoolAction(fd({ id: supplyId }))).rejects.toThrow(
      /not accessible/
    );
    expect(getSharedSupply(supplyId)?.name).toBe(`Foreign ${t}`);
  });

  it("refuses a member with only READ on the single linked profile", async () => {
    const t = tag();
    const viewer = createLogin({ role: "member", username: `r_${t}` });
    const own = createProfile(`Ada Lovelace ${t}`, viewer.id);
    const readOnly = createProfile(`Test Patient ${t}`, viewer.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(viewer.id, readOnly.id);
    actAs(viewer, own);

    const supplyId = newPool(`ReadOnly ${t}`, 40);
    const theirs = item(readOnly.id, `Med ${t}`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      supplyId,
      theirs
    );

    await expect(
      updatePoolAction(fd({ id: supplyId, ...poolFields(`Nope ${t}`) }))
    ).rejects.toThrow(/read-only on target/);
    expect(getSharedSupply(supplyId)?.name).toBe(`ReadOnly ${t}`);
  });

  it("applies the pool-level #467 CAS through the action", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `a_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const supplyId = newPool(`CAS ${t}`, 30);
    const a = item(p.id, `Med ${t}`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      supplyId,
      a
    );

    // A linked member's confirm moved the pool 30 → 29 while the form was open.
    db.prepare(
      "UPDATE shared_supplies SET quantity_on_hand = 29 WHERE id = ?"
    ).run(supplyId);

    // Saving the UNTOUCHED loaded value must not undo that decrement.
    await updatePoolAction(
      fd({
        id: supplyId,
        name: `CAS ${t}`,
        quantity_on_hand: 30,
        quantity_on_hand_loaded: 30,
      })
    );
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(29);

    // A deliberate change IS honored (the edit form is the refill path).
    await updatePoolAction(
      fd({
        id: supplyId,
        name: `CAS ${t}`,
        quantity_on_hand: 90,
        quantity_on_hand_loaded: 30,
      })
    );
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(90);
  });
});

describe("link / unlink gate on the ITEM's own profile", () => {
  it("creates a pool from an item, migrating its count once", async () => {
    const t = tag();
    const member = createLogin({ role: "member", username: `c_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, member.id);
    actAs(member, mine);
    const a = item(mine.id, `Med ${t}`, 90);

    const res = await createPoolAction(
      fd({ item_id: a, name: `From item ${t}` })
    );
    expect(res.ok).toBe(true);
    const supplyId = supplyIdOf(a);
    expect(supplyId).not.toBe(null);
    // The count moved INTO the pool, one-way — the item keeps no second copy.
    expect(getSharedSupply(supplyId as number)?.quantity_on_hand).toBe(90);
    expect(itemQty(a)).toBe(null);
  });

  it("refuses linking an item on a profile the caller can't write", async () => {
    const t = tag();
    const member = createLogin({ role: "member", username: `l_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, member.id);
    const stranger = createProfile(`Test Patient ${t}`);
    actAs(member, mine);
    const supplyId = newPool(`Target ${t}`, 10);
    const foreign = item(stranger.id, `Med ${t}`, 5);

    await expect(
      linkItemAction(fd({ item_id: foreign, supply_id: supplyId }))
    ).rejects.toThrow(/not accessible/);
    await expect(unlinkItemAction(fd({ item_id: foreign }))).rejects.toThrow(
      /not accessible/
    );
    expect(supplyIdOf(foreign)).toBe(null);
    // …and the stranger's private count is untouched.
    expect(itemQty(foreign)).toBe(5);
  });

  it("refuses a cross-profile create-from-item too", async () => {
    const t = tag();
    const member = createLogin({ role: "member", username: `x_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, member.id);
    const stranger = createProfile(`Test Patient ${t}`);
    actAs(member, mine);
    const foreign = item(stranger.id, `Med ${t}`, 5);
    await expect(
      createPoolAction(fd({ item_id: foreign, name: `Sneaky ${t}` }))
    ).rejects.toThrow(/not accessible/);
    expect(supplyIdOf(foreign)).toBe(null);
  });

  it("reports a missing pool instead of linking to a forged id", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `f_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const a = item(p.id, `Med ${t}`, 5);
    const res = await linkItemAction(fd({ item_id: a, supply_id: 999_999 }));
    expect(res.ok).toBe(false);
    expect(supplyIdOf(a)).toBe(null);
  });

  it("unlinks the caller's own item back to untracked supply", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `u_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const supplyId = newPool(`Unlink ${t}`, 25);
    const a = item(p.id, `Med ${t}`, 7);
    expect(
      (await linkItemAction(fd({ item_id: a, supply_id: supplyId }))).ok
    ).toBe(true);
    expect(itemQty(a)).toBe(null);
    expect((await unlinkItemAction(fd({ item_id: a }))).ok).toBe(true);
    expect(supplyIdOf(a)).toBe(null);
    // The bottle didn't move to the item, so it stays untracked — and the pool keeps
    // its count, now orphaned rather than destroyed.
    expect(itemQty(a)).toBe(null);
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(25);
  });
});
