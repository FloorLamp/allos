// DB INTEGRATION TIER — the #1893 gated-table write registry, validated against the REAL
// migrated schema.
//
// The pure scan (lib/__tests__/stateful-writes.test.ts) proves the rule fires and that no
// module reaches past a registered core. What it CANNOT see is whether the registry names
// a table and column that actually exist: a typo ("cycle" for "cycles",
// "quantity_on_hand" renamed by a later migration) would leave the entry matching nothing
// and the guard silently open, while every text-level assertion kept passing. That is the
// registry's quietest failure mode, so it is pinned here against sqlite_master and
// PRAGMA table_info after the migration runner has done its work.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { STATEFUL_WRITE_TABLES } from "@/lib/stateful-writes";
import { refillSupply } from "@/lib/queries";

function tableExists(name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) != null
  );
}

function columnsOf(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

describe("STATEFUL_WRITE_TABLES against the migrated schema (#1893)", () => {
  it("registers at least the issue's first entries", () => {
    const tables = STATEFUL_WRITE_TABLES.map((e) => e.table).sort();
    expect(tables).toEqual([
      "cycles",
      // #2138: the retire flag that gates pickers/availability/suggestions —
      // equipment's state-named CAS core.
      "equipment",
      "illness_episodes",
      // The dose SCHEDULE's retired flag, added by #2131 — the parent whose gating the
      // ledger below had and it lacked.
      "intake_item_doses",
      // The dose LEDGER, added by #2039 — the row that drives the supply counter two
      // entries down, and the table whose second core this registry now forbids.
      "intake_item_logs",
      // #2133 (sibling): the side-effect resolved flag's state-named CAS.
      "intake_item_side_effects",
      "intake_items",
      // #2132: the open-course ⇔ active invariant's single write core.
      "medication_courses",
      // #2140: the single-active training routine — activation's sibling-deactivate
      // and the derived-target replacement live in one core.
      "routines",
      "shared_supplies",
      // #2140: the active-situation set rewrite + illness-episode sync machine.
      "situations",
    ]);
  });

  it("every registered table exists in the schema", () => {
    for (const e of STATEFUL_WRITE_TABLES) {
      expect(tableExists(e.table), `${e.table} is not a table`).toBe(true);
    }
  });

  it("every column-narrowed entry names a real column on its table", () => {
    for (const e of STATEFUL_WRITE_TABLES) {
      if (!e.columns) continue;
      const cols = columnsOf(e.table);
      for (const c of e.columns) {
        expect(cols.has(c), `${e.table}.${c} is not a column`).toBe(true);
      }
    }
  });

  it("the cycle lifecycle table carries the open-period column the gate reasons about", () => {
    // `cycleControlState` — the offerState this entry names — is a function of
    // period_end being NULL. If that column moved, the registry's offer-state claim
    // would be describing a shape the schema no longer has.
    expect(columnsOf("cycles").has("period_end")).toBe(true);
  });
});

// The write core's typed outcomes are UNCHANGED by this issue (the recency treatment is
// informational and lives on the affordance). Pinned here beside the registry so the
// "route every write through a core that can refuse" claim is backed by a core that
// demonstrably refuses.
describe("refillSupply typed outcomes unchanged (#1893)", () => {
  function seedProfile(name: string): number {
    return Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
  }

  function seedItem(
    profileId: number,
    quantityOnHand: number | null,
    lastFill: number | null
  ): number {
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, condition, obligation, kind, active,
              quantity_on_hand, qty_per_dose, last_fill_size)
           VALUES (?, 'Vitamin D', 'daily', 'should', 'supplement', 1, ?, 1, ?)`
        )
        .run(profileId, quantityOnHand, lastFill).lastInsertRowid
    );
  }

  it("refuses an item this profile does not own", () => {
    const owner = seedProfile("Registry Owner");
    const other = seedProfile("Registry Other");
    const id = seedItem(owner, 5, 30);
    expect(refillSupply(other, id, 30)).toEqual({ kind: "stale-item" });
  });

  it("refuses an untracked item", () => {
    const p = seedProfile("Registry Untracked");
    const id = seedItem(p, null, 30);
    expect(refillSupply(p, id, 30)).toEqual({ kind: "untracked" });
  });

  it("asks for a size when none is remembered", () => {
    const p = seedProfile("Registry NeedsSize");
    const id = seedItem(p, 5, null);
    expect(refillSupply(p, id, null)).toEqual({ kind: "needs-size" });
  });

  it("reports the fill and the resulting quantity on success", () => {
    const p = seedProfile("Registry Refilled");
    const id = seedItem(p, 5, 90);
    expect(refillSupply(p, id, null)).toEqual({
      kind: "refilled",
      newQuantity: 95,
      fillSize: 90,
    });
  });
});
