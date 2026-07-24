// Shared supply pools — the household medicine cabinet (issue #1374).
//
// `shared_supplies` is a household-shared entity (the `providers` precedent): it has no
// `profile_id`, so nothing here is profile-scoped in the owned-table sense. The LINK
// (`intake_items.supply_id`) lives on a profile-owned row, and every read that filters
// items by profile does so explicitly. The ONE read that deliberately spans profiles is
// `poolMembers` — pool membership is cross-profile BY CONSTRUCTION (a shared bottle's
// takers are different people), so it is allowlisted in the profile-scoping test with
// that justification. It is an ACCOUNTING read (who draws from this bottle), never a
// display read: every surface that NAMES members filters `poolMembers` through the
// caller's ProfileScope before rendering (lib/scope.ts).
//
// AUTH-BLIND (the lib/ write-core convention): nothing here imports lib/auth. The
// Server Actions in app/(app)/supplies/actions.ts own the whole gate.

import { db, writeTx } from "../../db";
import {
  daysOfSupplyForPool,
  resolvePoolUnlinkRestore,
  resolveOnHandWrite,
  DEFAULT_LOW_SUPPLY_DAYS,
  isLowSupply,
  type PoolConsumer,
} from "../../refill";
import { getRefillRates } from "./refill";

// A shared bottle as stored.
export interface SharedSupply {
  id: number;
  name: string;
  strength: string | null;
  form: string | null;
  quantity_on_hand: number | null;
  low_supply_days: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// One intake item drawing from a pool. `profile_id` is what a display caller filters
// through its ProfileScope; `qty_per_dose` is what the pool math consumes.
export interface PoolMember {
  itemId: number;
  profileId: number;
  name: string;
  kind: "supplement" | "medication";
  qtyPerDose: number;
  active: boolean;
}

// A pool plus everything a surface needs: its members, its pooled "≈N days across
// everyone", and whether it is low / orphaned.
export interface PoolView extends SharedSupply {
  members: PoolMember[];
  daysLeft: number | null;
  low: boolean;
  thresholdDays: number;
  // No item links it any more — the last linked item was deleted or unlinked. Surfaced
  // in the cabinet with a "no longer linked" state and a delete offer, NEVER silently
  // cascaded away (the row-ops rule): the bottle may still physically exist.
  orphaned: boolean;
}

const SUPPLY_COLUMNS = `id, name, strength, form, quantity_on_hand, low_supply_days,
                        notes, created_at, updated_at`;

export function getSharedSupply(supplyId: number): SharedSupply | null {
  return (
    (db
      .prepare(`SELECT ${SUPPLY_COLUMNS} FROM shared_supplies WHERE id = ?`)
      .get(supplyId) as SharedSupply | undefined) ?? null
  );
}

export function listSharedSupplies(): SharedSupply[] {
  return db
    .prepare(`SELECT ${SUPPLY_COLUMNS} FROM shared_supplies ORDER BY name, id`)
    .all() as SharedSupply[];
}

// Every intake item linked to `supplyId`, across ALL profiles. Cross-profile by
// construction — see the module header; allowlisted in the profile-scoping test.
export function poolMembers(supplyId: number): PoolMember[] {
  const rows = db
    .prepare(
      `SELECT id, profile_id, name, kind, qty_per_dose, active
         FROM intake_items
        WHERE supply_id = ?
        ORDER BY profile_id, name, id`
    )
    .all(supplyId) as {
    id: number;
    profile_id: number;
    name: string;
    kind: "supplement" | "medication";
    qty_per_dose: number;
    active: number;
  }[];
  return rows.map((r) => ({
    itemId: r.id,
    profileId: r.profile_id,
    name: r.name,
    kind: r.kind,
    qtyPerDose: r.qty_per_dose,
    active: r.active === 1,
  }));
}

// The pooled consumption inputs for one bottle. Rates are composed PER PROFILE — the
// #38 basis logic (actual taken-log vs scheduled estimate) is evaluated in each
// member's own context via getRefillRates(profileId), never in another member's — and
// only then summed. Paused items consume nothing, so they contribute no rate.
export function poolConsumers(members: readonly PoolMember[]): PoolConsumer[] {
  const byProfile = new Map<number, PoolMember[]>();
  for (const m of members) {
    if (!m.active) continue;
    const list = byProfile.get(m.profileId);
    if (list) list.push(m);
    else byProfile.set(m.profileId, [m]);
  }
  const consumers: PoolConsumer[] = [];
  for (const [profileId, list] of byProfile) {
    const rates = getRefillRates(profileId);
    for (const m of list) {
      consumers.push({
        dosesPerDay: rates.get(m.itemId)?.dosesPerDay ?? 0,
        qtyPerDose: m.qtyPerDose,
      });
    }
  }
  return consumers;
}

// One pool resolved for display/alerting: members + the pooled projection.
export function getPoolView(supplyId: number): PoolView | null {
  const supply = getSharedSupply(supplyId);
  if (!supply) return null;
  return buildPoolView(supply);
}

export function listPoolViews(): PoolView[] {
  return listSharedSupplies().map(buildPoolView);
}

function buildPoolView(supply: SharedSupply): PoolView {
  const members = poolMembers(supply.id);
  const daysLeft = daysOfSupplyForPool(
    supply.quantity_on_hand,
    poolConsumers(members)
  );
  const thresholdDays = supply.low_supply_days ?? DEFAULT_LOW_SUPPLY_DAYS;
  return {
    ...supply,
    members,
    daysLeft,
    low: isLowSupply(daysLeft, thresholdDays),
    thresholdDays,
    orphaned: members.length === 0,
  };
}

// The pools any of `profileIds` draws from, for a scoped surface (the chip on a member's
// card, the cabinet list a member sees). Takes the already-resolved accessible ids as
// its first argument and never imports lib/auth — the cross-profile reader convention.
export function poolIdsForProfiles(profileIds: readonly number[]): number[] {
  if (profileIds.length === 0) return [];
  const out = new Set<number>();
  for (const profileId of profileIds) {
    const rows = db
      .prepare(
        `SELECT DISTINCT supply_id FROM intake_items
          WHERE profile_id = ? AND supply_id IS NOT NULL`
      )
      .all(profileId) as { supply_id: number }[];
    for (const r of rows) out.add(r.supply_id);
  }
  return [...out].sort((a, b) => a - b);
}

// The shared-bottle CHIP a linked item's row/card renders in place of the per-item
// "≈N days left" badge — the pooled projection across EVERYONE, which is the whole
// point (this member's own doses are only part of the drain). Keyed by item id so a
// list surface can look up per row, mirroring how getRefillRates is threaded.
export interface PoolChipData {
  supplyId: number;
  name: string;
  daysLeft: number | null;
  memberCount: number;
  low: boolean;
}

export function getPoolChips(profileId: number): Map<number, PoolChipData> {
  const out = new Map<number, PoolChipData>();
  const rows = db
    .prepare(
      `SELECT id, supply_id FROM intake_items
        WHERE profile_id = ? AND supply_id IS NOT NULL`
    )
    .all(profileId) as { id: number; supply_id: number }[];
  const views = new Map<number, PoolView | null>();
  for (const r of rows) {
    if (!views.has(r.supply_id))
      views.set(r.supply_id, getPoolView(r.supply_id));
    const pool = views.get(r.supply_id);
    if (!pool) continue;
    out.set(r.id, {
      supplyId: pool.id,
      name: pool.name,
      daysLeft: pool.daysLeft,
      memberCount: pool.members.length,
      low: pool.low,
    });
  }
  return out;
}

// ── Writes (auth-blind cores) ────────────────────────────────────────────────

export interface SharedSupplyFields {
  name: string;
  strength: string | null;
  form: string | null;
  lowSupplyDays: number | null;
  notes: string | null;
}

// Create a pool. `quantityOnHand` is the count the pool STARTS with — the creating
// item's own on-hand when a pool is created from an item (a one-way, explicit
// migration of that count INTO the pool).
export function createSharedSupply(
  fields: SharedSupplyFields,
  quantityOnHand: number | null
): number {
  const res = db
    .prepare(
      `INSERT INTO shared_supplies
         (name, strength, form, quantity_on_hand, low_supply_days, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.name,
      fields.strength,
      fields.form,
      quantityOnHand,
      fields.lowSupplyDays,
      fields.notes
    );
  return Number(res.lastInsertRowid);
}

// Edit a pool. `quantity_on_hand` goes through the #467 compare-and-set at POOL level —
// the concurrent-writer set is now every linked member's dose confirms (plus the poll
// sidecar), which is exactly the case CAS exists for. The whole read-decide-write runs
// in ONE writeTx so `current` is re-read under the IMMEDIATE write lock.
export function updateSharedSupply(
  supplyId: number,
  fields: SharedSupplyFields,
  submittedQuantity: number | null,
  loadedQuantity: number | null
): boolean {
  return writeTx(() => {
    const row = db
      .prepare("SELECT quantity_on_hand FROM shared_supplies WHERE id = ?")
      .get(supplyId) as { quantity_on_hand: number | null } | undefined;
    if (!row) return false;
    const next = resolveOnHandWrite(
      submittedQuantity,
      loadedQuantity,
      row.quantity_on_hand
    );
    db.prepare(
      `UPDATE shared_supplies
          SET name = ?, strength = ?, form = ?, quantity_on_hand = ?,
              low_supply_days = ?, notes = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(
      fields.name,
      fields.strength,
      fields.form,
      next,
      fields.lowSupplyDays,
      fields.notes,
      supplyId
    );
    return true;
  });
}

// Link ONE item to a pool. The item's PRIVATE count is dropped (set NULL): the pool is
// now the truth for that bottle, and keeping a second count is the phantom-double-supply
// bug. Profile-scoped on the item, so a forged id can't link another profile's row.
export function linkItemToPool(
  profileId: number,
  itemId: number,
  supplyId: number
): void {
  writeTx(() => {
    db.prepare(
      `UPDATE intake_items SET supply_id = ?, quantity_on_hand = NULL
        WHERE id = ? AND profile_id = ?`
    ).run(supplyId, itemId, profileId);
  });
}

// Unlink ONE item. It returns to untracked supply (quantity_on_hand stays NULL) — the
// pool keeps the bottle's count, because the bottle didn't move. The user re-opts into
// per-item tracking by entering a quantity on the item form.
export function unlinkItemFromPool(profileId: number, itemId: number): void {
  db.prepare(
    `UPDATE intake_items SET supply_id = NULL WHERE id = ? AND profile_id = ?`
  ).run(itemId, profileId);
}

// Delete a pool, carrying its side-state (the row-ops rule): every linked item is
// unlinked FIRST (the FK carries no ON DELETE action by design — a cascade must never
// silently untrack a household's supply), and the remaining quantity is restored per
// resolvePoolUnlinkRestore (a sole linked item takes it back; two or more return to
// untracked rather than inventing N copies of one bottle). Returns the ids of the items
// that were unlinked so the caller can sweep their name-keyed markers.
export function deleteSharedSupply(supplyId: number): number[] {
  return writeTx(() => {
    const supply = db
      .prepare("SELECT quantity_on_hand FROM shared_supplies WHERE id = ?")
      .get(supplyId) as { quantity_on_hand: number | null } | undefined;
    if (!supply) return [];
    const members = poolMembers(supplyId);
    const restored = resolvePoolUnlinkRestore(
      supply.quantity_on_hand,
      members.length
    );
    for (const m of members) {
      db.prepare(
        `UPDATE intake_items SET supply_id = NULL, quantity_on_hand = ?
          WHERE id = ? AND profile_id = ?`
      ).run(restored, m.itemId, m.profileId);
    }
    db.prepare("DELETE FROM shared_supplies WHERE id = ?").run(supplyId);
    return members.map((m) => m.itemId);
  });
}
