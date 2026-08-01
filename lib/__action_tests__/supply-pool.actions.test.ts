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
  listSharedSupplyOptions,
} from "@/app/(app)/supplies/actions";
import { addSupplement } from "@/app/(app)/nutrition/supplement-actions";
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
    expect(res.supply).toEqual({
      id: supplyId,
      name: `From item ${t}`,
      strength: null,
      form: null,
    });
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
    const linked = await linkItemAction(
      fd({ item_id: a, supply_id: supplyId })
    );
    expect(linked.ok).toBe(true);
    expect(linked.supply).toEqual({
      id: supplyId,
      name: `Unlink ${t}`,
      strength: null,
      form: null,
    });
    expect(itemQty(a)).toBe(null);
    const unlinked = await unlinkItemAction(fd({ item_id: a }));
    expect(unlinked.ok).toBe(true);
    expect(unlinked.supply).toBe(null);
    expect(supplyIdOf(a)).toBe(null);
    // The bottle didn't move to the item, so it stays untracked — and the pool keeps
    // its count, now orphaned rather than destroyed.
    expect(itemQty(a)).toBe(null);
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(25);
  });
});

// ── The product-fact exchange between a bottle and an item (#1705) ──────────────
//
// Direction 1 seeds the bottle from the item; direction 2 creates the item FROM the
// bottle. Only this tier sees both gates: the seeding reads the item under its own
// profile scope, and the create-from-bottle write runs the TARGET profile's gate.

function dose(itemId: number, amount: string, sort = 0): void {
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
     VALUES (?, ?, '08:00', 'any', ?, 0)`
  ).run(itemId, amount, sort);
}

describe("a pool created from an item inherits its product identity", () => {
  it("seeds name and strength from the item, alongside the count", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `seed_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const a = item(p.id, `Cholecalciferol ${t}`, 60);
    dose(a, "5000 IU");
    dose(a, "1000 IU", 1);

    // The picker posts nothing but the item id: everything else is inherited.
    const res = await createPoolAction(fd({ item_id: a }));
    expect(res.ok).toBe(true);
    const supplyId = supplyIdOf(a) as number;
    const pool = getSharedSupply(supplyId);
    expect(pool?.name).toBe(`Cholecalciferol ${t}`);
    // The FIRST active dose amount is where a strength is actually typed.
    expect(pool?.strength).toBe("5000 IU");
    expect(pool?.quantity_on_hand).toBe(60);
    expect(itemQty(a)).toBe(null);
  });

  it("lets a posted field win over the inherited one", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `over_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const a = item(p.id, `Cholecalciferol ${t}`, 60);
    dose(a, "5000 IU");

    const res = await createPoolAction(
      fd({
        item_id: a,
        name: `Household D3 ${t}`,
        strength: "2000 IU",
        form: "softgel",
      })
    );
    expect(res.ok).toBe(true);
    const pool = getSharedSupply(supplyIdOf(a) as number);
    expect(pool?.name).toBe(`Household D3 ${t}`);
    expect(pool?.strength).toBe("2000 IU");
    expect(pool?.form).toBe("softgel");
  });

  it("does not read product facts across a profile boundary", async () => {
    const t = tag();
    const member = createLogin({ role: "member", username: `bnd_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, member.id);
    const stranger = createProfile(`Test Patient ${t}`);
    actAs(member, mine);
    const foreign = item(stranger.id, `Med ${t}`, 5);
    dose(foreign, "500 mg");
    await expect(createPoolAction(fd({ item_id: foreign }))).rejects.toThrow(
      /not accessible/
    );
  });
});

describe("an item created from a bottle links on save", () => {
  it("links the new item and drops its private count", async () => {
    const t = tag();
    const admin = createLogin({ role: "admin", username: `mk_${t}` });
    const p = createProfile(`Ada Lovelace ${t}`);
    actAs(admin, p);
    const supplyId = newPool(`Household ${t}`, 120);

    const res = await addSupplement(
      fd({
        name: `Cholecalciferol ${t}`,
        kind: "supplement",
        supply_id: supplyId,
        // What the form would post for an untracked private count.
        quantity_on_hand: "",
        doses: JSON.stringify([{ amount: "5000 IU", time_of_day: "08:00" }]),
      })
    );
    expect(res.ok).toBe(true);
    const created = db
      .prepare(
        "SELECT id, supply_id AS s, quantity_on_hand AS q FROM intake_items WHERE profile_id = ? AND name = ?"
      )
      .get(p.id, `Cholecalciferol ${t}`) as {
      id: number;
      s: number | null;
      q: number | null;
    };
    expect(created.s).toBe(supplyId);
    // A pooled item keeps NO private count — the phantom-double-supply invariant.
    expect(created.q).toBe(null);
    // The bottle's own count is untouched by the link.
    expect(getSharedSupply(supplyId)?.quantity_on_hand).toBe(120);
  });

  it("refuses a bottle outside the caller's reach instead of linking it", async () => {
    const t = tag();
    // The bottle belongs to a household branch this member was never granted.
    const owner = createLogin({ role: "member", username: `own_${t}` });
    const theirs = createProfile(`Test Patient ${t}`, owner.id);
    const supplyId = newPool(`Foreign ${t}`, 30);
    const theirItem = item(theirs.id, `Med ${t}`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      supplyId,
      theirItem
    );

    const outsider = createLogin({ role: "member", username: `out_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, outsider.id);
    actAs(outsider, mine);

    const res = await addSupplement(
      fd({
        name: `Sneaky ${t}`,
        kind: "supplement",
        supply_id: supplyId,
        doses: JSON.stringify([{ amount: "1 tab" }]),
      })
    );
    expect(res.ok).toBe(false);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE name = ?")
        .get(`Sneaky ${t}`)
    ).toEqual({ n: 0 });
  });

  it("offers only the bottles the caller's own people draw from, plus orphans", async () => {
    const t = tag();
    const owner = createLogin({ role: "member", username: `lo_${t}` });
    const theirs = createProfile(`Test Patient ${t}`, owner.id);
    const hidden = newPool(`Hidden ${t}`, 10);
    const theirItem = item(theirs.id, `Med ${t}`, null);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      hidden,
      theirItem
    );
    const orphan = newPool(`Orphan ${t}`, 10);

    const outsider = createLogin({ role: "member", username: `lx_${t}` });
    const mine = createProfile(`Ada Lovelace ${t}`, outsider.id);
    actAs(outsider, mine);
    const mineItem = item(mine.id, `Mine ${t}`, null);
    const ownPool = newPool(`Mine ${t}`, 10);
    db.prepare("UPDATE intake_items SET supply_id = ? WHERE id = ?").run(
      ownPool,
      mineItem
    );

    const ids = (await listSharedSupplyOptions()).map((o) => o.id);
    expect(ids).toContain(ownPool);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(hidden);
  });
});
