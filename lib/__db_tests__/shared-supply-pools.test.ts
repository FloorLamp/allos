// DB INTEGRATION TIER — shared medication/supplement supply pools (#1374). These need
// the real schema: migration 112's `shared_supplies` table + `intake_items.supply_id`,
// the pool-aware decrement inside the ONE supply write core, the cross-profile pooled
// projection, the pool-level #467 compare-and-set, and the delete's side-state restore.
// None of it is visible to the pure tier, which only sees pre-gathered arrays.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  createSharedSupply,
  updateSharedSupply,
  deleteSharedSupply,
  linkItemToPool,
  unlinkItemFromPool,
  getSharedSupply,
  getPoolView,
  getPoolChips,
  poolMembers,
  poolIdsForProfiles,
  listVisiblePoolViews,
  countVisiblePools,
  listLinkableSupplies,
  findLinkableSupply,
  isLinkableSupply,
  getItemProductFacts,
  markDoseTaken,
  refillSupply,
} from "@/lib/queries";
import { collectUpcoming } from "@/lib/queries/upcoming";
import { poolRefillSignalKey } from "@/lib/refill-nudge";
import { seedProfile, type SeededProfile } from "./fixtures";

let alice: SeededProfile;
let bruno: SeededProfile;

// Statement counting (the #885 shape, as tick-scoped-gathers.test.ts uses it): the query
// layer prepares its SQL inline on every call, so counting prepares of a signature counts
// evaluations of the read that owns it. One spy for every signature — vi.spyOn returns
// the SAME spy for an already-spied method, so two independent spies would leave the
// second calling through to itself.
function countPrepareSet(...signatures: RegExp[]): { calls: () => number }[] {
  const counts = signatures.map(() => 0);
  const real = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    signatures.forEach((s, i) => {
      if (s.test(sql)) counts[i]++;
    });
    return real(sql);
  }) as typeof db.prepare);
  return signatures.map((_, i) => ({ calls: () => counts[i] }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

function poolQty(supplyId: number): number | null {
  return getSharedSupply(supplyId)?.quantity_on_hand ?? null;
}

function itemQty(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

// One profile-owned scheduled item with a dose, so a confirm can be driven end to end.
function addItem(
  profileId: number,
  name: string,
  qtyPerDose: number,
  quantityOnHand: number | null
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'should', ?, ?)`
      )
      .run(profileId, name, quantityOnHand, qtyPerDose).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tablet', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

beforeAll(() => {
  alice = seedProfile("POOLA");
  bruno = seedProfile("POOLB");
});

describe("migration 112 applies to a fresh DB and an existing one", () => {
  it("creates shared_supplies with the pool columns and the intake_items link", () => {
    const cols = new Set(
      (
        db.prepare("PRAGMA table_info(shared_supplies)").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    );
    for (const c of [
      "id",
      "name",
      "strength",
      "form",
      "quantity_on_hand",
      "low_supply_days",
      "notes",
      "created_at",
      "updated_at",
    ])
      expect(cols.has(c)).toBe(true);
    // Deliberately NO qty_per_dose on the pool: units-per-dose is the TAKER's property.
    expect(cols.has("qty_per_dose")).toBe(false);
    // Not profile-owned (the providers precedent).
    expect(cols.has("profile_id")).toBe(false);

    const itemCols = new Set(
      (
        db.prepare("PRAGMA table_info(intake_items)").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    );
    expect(itemCols.has("supply_id")).toBe(true);

    // Existing rows are untouched: every pre-migration item links nothing.
    const linked = db
      .prepare(
        "SELECT COUNT(*) AS n FROM intake_items WHERE supply_id IS NOT NULL"
      )
      .get() as { n: number };
    expect(linked.n).toBeGreaterThanOrEqual(0);
  });

  it("declares an enforced FK from intake_items.supply_id to shared_supplies", () => {
    const fks = db.prepare("PRAGMA foreign_key_list(intake_items)").all() as {
      table: string;
      from: string;
    }[];
    expect(
      fks.some((f) => f.from === "supply_id" && f.table === "shared_supplies")
    ).toBe(true);
  });
});

describe("pooled decrement — every taker draws from ONE count", () => {
  it("lands both members' dose confirms on the pool, by each item's own qty_per_dose", () => {
    const supplyId = createSharedSupply(
      {
        name: "Household Ibuprofen",
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      100
    );
    // Alice takes 2 tablets a dose; Bruno (a child) takes 1.
    const a = addItem(alice.profileId, "POOLA Ibuprofen", 2, 30);
    const b = addItem(bruno.profileId, "POOLB Ibuprofen", 1, 12);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    linkItemToPool(bruno.profileId, b.itemId, supplyId);

    // Linking drops each item's private count — the pool is the single truth.
    expect(itemQty(a.itemId)).toBe(null);
    expect(itemQty(b.itemId)).toBe(null);

    // The SAME write core every dose-log path routes through.
    expect(
      markDoseTaken(alice.profileId, a.doseId, null, today(alice.profileId))
    ).toBe("logged");
    expect(poolQty(supplyId)).toBe(98);
    expect(
      markDoseTaken(bruno.profileId, b.doseId, null, today(bruno.profileId))
    ).toBe("logged");
    expect(poolQty(supplyId)).toBe(97);

    // Neither item's private counter moved — there IS no second accounting.
    expect(itemQty(a.itemId)).toBe(null);
    expect(itemQty(b.itemId)).toBe(null);

    // Membership spans profiles; each member's own scoped read finds the pool.
    expect(
      poolMembers(supplyId)
        .map((m) => m.profileId)
        .sort()
    ).toEqual([alice.profileId, bruno.profileId].sort());
    expect(
      poolMembers(supplyId).find((m) => m.itemId === a.itemId)?.doseAmounts
    ).toEqual(["1 tablet"]);
    expect(poolIdsForProfiles([alice.profileId])).toContain(supplyId);
    expect(poolIdsForProfiles([bruno.profileId])).toContain(supplyId);
  });

  it("refills the POOL from a linked item's one-tap refill, not the item", () => {
    const supplyId = createSharedSupply(
      {
        name: "Household Paracetamol",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      10
    );
    const a = addItem(alice.profileId, "POOLA Paracetamol", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    const out = refillSupply(alice.profileId, a.itemId, 50);
    expect(out).toEqual({ kind: "refilled", newQuantity: 60, fillSize: 50 });
    expect(poolQty(supplyId)).toBe(60);
    expect(itemQty(a.itemId)).toBe(null);
  });

  it("leaves an UNLINKED item on its own private counter (nothing changes by default)", () => {
    const solo = addItem(alice.profileId, "POOLA Solo Med", 1, 9);
    expect(
      markDoseTaken(alice.profileId, solo.doseId, null, today(alice.profileId))
    ).toBe("logged");
    expect(itemQty(solo.itemId)).toBe(8);
  });
});

describe("pooled projection sums every linked member's rate", () => {
  it("reads lower than either member's private projection, and flags low once", () => {
    const supplyId = createSharedSupply(
      {
        name: "Household Vitamin D",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      // Two daily consumers at 2 + 1 units/day = 3/day → 8 days left (below the
      // 10-day default threshold), while either alone would read 12 or 24.
      25
    );
    const a = addItem(alice.profileId, "POOLA Vit D Pool", 2, null);
    const b = addItem(bruno.profileId, "POOLB Vit D Pool", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    linkItemToPool(bruno.profileId, b.itemId, supplyId);

    const pool = getPoolView(supplyId);
    expect(pool?.daysLeft).toBe(8);
    expect(pool?.low).toBe(true);
    expect(pool?.members).toHaveLength(2);
    expect(pool?.orphaned).toBe(false);

    // The chip each member's row renders carries the POOLED number, not their share.
    expect(getPoolChips(alice.profileId).get(a.itemId)?.daysLeft).toBe(8);
    expect(getPoolChips(bruno.profileId).get(b.itemId)?.daysLeft).toBe(8);
    expect(getPoolChips(bruno.profileId).get(b.itemId)?.memberCount).toBe(2);

    // ONE finding per bottle, keyed on the pool, on EACH linked member's Upcoming.
    const key = poolRefillSignalKey(supplyId);
    for (const p of [alice, bruno]) {
      const keys = collectUpcoming(p.profileId, today(p.profileId)).map(
        (i) => i.key
      );
      expect(keys.filter((k) => k === key)).toHaveLength(1);
    }

    // A per-pool threshold overrides the shared default.
    updateSharedSupply(
      supplyId,
      {
        name: "Household Vitamin D",
        strength: null,
        form: null,
        lowSupplyDays: 3,
        notes: null,
      },
      25,
      25
    );
    expect(getPoolView(supplyId)?.low).toBe(false);
  });

  it("ignores a PAUSED member's rate (a paused item consumes nothing)", () => {
    const supplyId = createSharedSupply(
      {
        name: "Household Magnesium",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const a = addItem(alice.profileId, "POOLA Mag Pool", 1, null);
    const b = addItem(bruno.profileId, "POOLB Mag Pool", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    linkItemToPool(bruno.profileId, b.itemId, supplyId);
    expect(getPoolView(supplyId)?.daysLeft).toBe(15); // 2 units/day
    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(b.itemId);
    expect(getPoolView(supplyId)?.daysLeft).toBe(30); // 1 unit/day
  });
});

describe("pool-level compare-and-set (#467)", () => {
  it("keeps a concurrent decrement when the editor didn't touch the quantity field", () => {
    const supplyId = createSharedSupply(
      {
        name: "CAS Bottle",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const a = addItem(alice.profileId, "POOLA CAS Med", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);

    // A caregiver opens the cabinet form; it loads 30.
    const loaded = 30;
    // Meanwhile, another member's confirm decrements the pool to 29.
    markDoseTaken(alice.profileId, a.doseId, null, today(alice.profileId));
    expect(poolQty(supplyId)).toBe(29);

    // Saving an unrelated tweak submits the untouched 30 — which must NOT be written.
    updateSharedSupply(
      supplyId,
      {
        name: "CAS Bottle (renamed)",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30,
      loaded
    );
    expect(poolQty(supplyId)).toBe(29);
    expect(getSharedSupply(supplyId)?.name).toBe("CAS Bottle (renamed)");

    // A DELIBERATE change (submitted ≠ loaded) is honored — that IS the refill path.
    updateSharedSupply(
      supplyId,
      {
        name: "CAS Bottle (renamed)",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      90,
      loaded
    );
    expect(poolQty(supplyId)).toBe(90);
  });
});

describe("row-ops side-state on unlink and delete", () => {
  it("restores the whole count to a SOLE linked item, and untracks two or more", () => {
    // Sole member: unambiguous, so the count comes back.
    const soloPool = createSharedSupply(
      {
        name: "Solo Bottle",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      44
    );
    const s = addItem(alice.profileId, "POOLA Solo Pool Med", 1, null);
    linkItemToPool(alice.profileId, s.itemId, soloPool);
    expect(deleteSharedSupply(soloPool)).toEqual([s.itemId]);
    expect(getSharedSupply(soloPool)).toBe(null);
    expect(itemQty(s.itemId)).toBe(44);

    // Two members: copying 44 onto both would invent a second bottle, so both go
    // back to untracked and the confirm surfaces the number for manual re-entry.
    const sharedPool = createSharedSupply(
      {
        name: "Two Member Bottle",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      44
    );
    const a = addItem(alice.profileId, "POOLA Two Member", 1, null);
    const b = addItem(bruno.profileId, "POOLB Two Member", 1, null);
    linkItemToPool(alice.profileId, a.itemId, sharedPool);
    linkItemToPool(bruno.profileId, b.itemId, sharedPool);
    expect(deleteSharedSupply(sharedPool).sort()).toEqual(
      [a.itemId, b.itemId].sort()
    );
    expect(itemQty(a.itemId)).toBe(null);
    expect(itemQty(b.itemId)).toBe(null);
    // The links are nulled, not cascade-dropped — both items still exist.
    for (const id of [a.itemId, b.itemId]) {
      const row = db
        .prepare("SELECT supply_id FROM intake_items WHERE id = ?")
        .get(id) as { supply_id: number | null } | undefined;
      expect(row).toBeTruthy();
      expect(row?.supply_id).toBe(null);
    }
  });

  it("orphans (never destroys) a pool whose last member unlinks", () => {
    const supplyId = createSharedSupply(
      {
        name: "Orphan Bottle",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      12
    );
    const a = addItem(alice.profileId, "POOLA Orphan Med", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    unlinkItemFromPool(alice.profileId, a.itemId);
    const pool = getPoolView(supplyId);
    expect(pool).toBeTruthy();
    expect(pool?.orphaned).toBe(true);
    expect(pool?.quantity_on_hand).toBe(12); // the bottle's count is kept
    // Unlinking leaves the item untracked — the bottle did not move to it.
    expect(itemQty(a.itemId)).toBe(null);
  });

  it("survives a linked profile losing its item without touching the other member", () => {
    const supplyId = createSharedSupply(
      {
        name: "Survivor Bottle",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      20
    );
    const a = addItem(alice.profileId, "POOLA Survivor", 1, null);
    const b = addItem(bruno.profileId, "POOLB Survivor", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    linkItemToPool(bruno.profileId, b.itemId, supplyId);
    db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(b.itemId);
    db.prepare("DELETE FROM intake_items WHERE id = ?").run(b.itemId);
    const pool = getPoolView(supplyId);
    expect(pool?.orphaned).toBe(false);
    expect(pool?.members.map((m) => m.profileId)).toEqual([alice.profileId]);
    expect(pool?.quantity_on_hand).toBe(20);
  });
});

// The cabinet's reach (#1522). Removing the /supplies nav row put the surface behind
// "N shared bottles" doors on Medications / Supplements / Household, so the COUNT on
// those doors and the LIST on the page have to be the same question — a door that
// promises a bottle the page won't show is worse than no door.
describe("what the cabinet shows a caller (#1522)", () => {
  it("lists a pool for a member who draws from it, and hides one they don't", () => {
    const mine = createSharedSupply(
      {
        name: "Cabinet Mine",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const theirs = createSharedSupply(
      {
        name: "Cabinet Theirs",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      30
    );
    const a = addItem(alice.profileId, "POOLA Cabinet", 1, null);
    const b = addItem(bruno.profileId, "POOLB Cabinet", 1, null);
    linkItemToPool(alice.profileId, a.itemId, mine);
    linkItemToPool(bruno.profileId, b.itemId, theirs);

    const aliceSees = listVisiblePoolViews([alice.profileId]).map((p) => p.id);
    expect(aliceSees).toContain(mine);
    expect(aliceSees).not.toContain(theirs);
    // A caregiver granted BOTH profiles sees both bottles.
    const bothSees = listVisiblePoolViews([
      alice.profileId,
      bruno.profileId,
    ]).map((p) => p.id);
    expect(bothSees).toContain(mine);
    expect(bothSees).toContain(theirs);
  });

  it("shows an ORPHANED bottle to everyone — nobody is named, and someone must clear it", () => {
    const orphan = createSharedSupply(
      {
        name: "Cabinet Orphan",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      5
    );
    expect(poolMembers(orphan)).toEqual([]);
    expect(listVisiblePoolViews([alice.profileId]).map((p) => p.id)).toContain(
      orphan
    );
    // …including a caller with no accessible profiles at all.
    expect(listVisiblePoolViews([]).map((p) => p.id)).toContain(orphan);
  });

  it("counts exactly what it would list — the door can't outrun the page", () => {
    for (const ids of [
      [alice.profileId],
      [bruno.profileId],
      [alice.profileId, bruno.profileId],
      [] as number[],
    ]) {
      expect(countVisiblePools(ids)).toBe(listVisiblePoolViews(ids).length);
    }
  });

  // #2116: the door used to run one poolMembers query per shared bottle, and it renders
  // on /household, /medications and the supplements tab. The rule is unchanged (still
  // the pure isPoolVisibleTo over the raw membership); only the number of reads is.
  it("asks once for the whole cabinet, not once per bottle", () => {
    // Several bottles, so a per-supply loop could not accidentally pass.
    expect(
      listVisiblePoolViews([alice.profileId, bruno.profileId]).length
    ).toBeGreaterThan(1);
    const [perSupplyMembers, cabinetMembership] = countPrepareSet(
      /FROM intake_items i\s+LEFT JOIN intake_item_doses d/,
      /FROM shared_supplies s\s+LEFT JOIN intake_items i/
    );
    countVisiblePools([alice.profileId, bruno.profileId]);
    expect(perSupplyMembers.calls()).toBe(0);
    expect(cabinetMembership.calls()).toBe(1);
  });

  // #2116: poolIdsForProfiles looped a SELECT DISTINCT per profile where one bound
  // `profile_id IN (…)` answers — the repo's own cross-profile convention, registered
  // in CROSS_PROFILE_SQL_MODULES in the same change.
  it("resolves the pools of a whole accessible set in one read", () => {
    const both = [alice.profileId, bruno.profileId];
    const union = [
      ...new Set([
        ...poolIdsForProfiles([alice.profileId]),
        ...poolIdsForProfiles([bruno.profileId]),
      ]),
    ].sort((a, b) => a - b);
    expect(poolIdsForProfiles(both)).toEqual(union);
    expect(union.length).toBeGreaterThan(1);
    // An empty accessible set still short-circuits to nothing, with no read at all.
    const [distinctSupply] = countPrepareSet(
      /SELECT DISTINCT supply_id FROM intake_items/
    );
    expect(poolIdsForProfiles([])).toEqual([]);
    poolIdsForProfiles(both);
    expect(distinctSupply.calls()).toBe(1);
  });
});

// ── The product-fact exchange (#1705) ───────────────────────────────────────────
//
// The bottle is authoritative for what the product IS, and a linked item DERIVES
// those facts at render time rather than storing a copy that can drift. Only this
// tier can prove "no write to the item row" and the scoped reader boundaries.
describe("a linked item derives the bottle's product facts", () => {
  it("follows a pool edit with no write to any item row", () => {
    const supplyId = createSharedSupply(
      {
        name: "Household D3",
        strength: "5000 IU",
        form: "capsule",
        lowSupplyDays: null,
        notes: null,
      },
      100
    );
    const a = addItem(alice.profileId, "Alice D3", 1, null);
    linkItemToPool(alice.profileId, a.itemId, supplyId);
    const before = db
      .prepare("SELECT * FROM intake_items WHERE id = ?")
      .get(a.itemId);

    expect(getPoolChips(alice.profileId).get(a.itemId)).toMatchObject({
      strength: "5000 IU",
      form: "capsule",
    });

    updateSharedSupply(
      supplyId,
      {
        name: "Household D3",
        strength: "1000 IU",
        form: "softgel",
        lowSupplyDays: null,
        notes: null,
      },
      100,
      100
    );

    // The chip follows the bottle…
    expect(getPoolChips(alice.profileId).get(a.itemId)).toMatchObject({
      strength: "1000 IU",
      form: "softgel",
    });
    // …and the member's own row — dose amounts, obligation, schedule — is untouched.
    expect(
      db.prepare("SELECT * FROM intake_items WHERE id = ?").get(a.itemId)
    ).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT amount FROM intake_item_doses WHERE item_id = ? AND retired = 0"
        )
        .get(a.itemId)
    ).toEqual({ amount: "1 tablet" });
  });
});

describe("the item → bottle seeding reads one profile-scoped row", () => {
  it("returns the item's name, active dose amounts and on-hand count", () => {
    const b = addItem(bruno.profileId, "Bruno Ibuprofen", 1, 24);
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '400 mg', 'evening', 'any', 1)`
    ).run(b.itemId);
    // A RETIRED dose is not part of the item's current product identity.
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, retired)
       VALUES (?, '999 mg', 'night', 'any', 2, 1)`
    ).run(b.itemId);

    expect(getItemProductFacts(bruno.profileId, b.itemId)).toEqual({
      name: "Bruno Ibuprofen",
      doseAmounts: ["1 tablet", "400 mg"],
      quantityOnHand: 24,
    });
    // Another profile cannot read it, so a forged id can't seed a bottle from it.
    expect(getItemProductFacts(alice.profileId, b.itemId)).toBe(null);
  });
});

describe("the offerable-bottle rule matches the cabinet's own list", () => {
  it("offers a drawn-from bottle and an orphan, and hides another branch's", () => {
    const mine = createSharedSupply(
      {
        name: "Mine 1705",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      10
    );
    const theirs = createSharedSupply(
      {
        name: "Theirs 1705",
        strength: null,
        form: null,
        lowSupplyDays: null,
        notes: null,
      },
      10
    );
    const orphan = createSharedSupply(
      {
        name: "Orphan 1705",
        strength: "200 mg",
        form: "tablet",
        lowSupplyDays: null,
        notes: null,
      },
      10
    );
    const a = addItem(alice.profileId, "Alice 1705", 1, null);
    const b = addItem(bruno.profileId, "Bruno 1705", 1, null);
    linkItemToPool(alice.profileId, a.itemId, mine);
    linkItemToPool(bruno.profileId, b.itemId, theirs);

    const offered = listLinkableSupplies([alice.profileId]).map((s) => s.id);
    expect(offered).toContain(mine);
    expect(offered).toContain(orphan);
    expect(offered).not.toContain(theirs);

    // The single-id question agrees with the list, and carries the product facts a
    // seeded item form prefills from.
    expect(findLinkableSupply([alice.profileId], orphan)).toEqual({
      id: orphan,
      name: "Orphan 1705",
      strength: "200 mg",
      form: "tablet",
    });
    expect(findLinkableSupply([alice.profileId], theirs)).toBe(null);
    expect(isLinkableSupply([alice.profileId], theirs)).toBe(false);

    // Exactly the set the cabinet page itself lists.
    expect(offered.sort()).toEqual(
      listVisiblePoolViews([alice.profileId])
        .map((p) => p.id)
        .sort()
    );
  });
});
