"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { deleteSetting } from "@/lib/settings";
import { poolRefillMarkerKey, poolRefillSignalKey } from "@/lib/refill-nudge";
import { restoreFinding } from "@/lib/queries/upcoming";
import {
  createSharedSupply,
  updateSharedSupply,
  deleteSharedSupply,
  linkItemToPool,
  unlinkItemFromPool,
  poolMembers,
  listLinkableSupplies,
  getItemProductFacts,
  getSharedSupply,
  supplyOption,
  type SharedSupplyFields,
} from "@/lib/queries/intake";
import { parseQuantityOnHand } from "@/lib/refill";
import { poolSeedFromItem, type SupplyOption } from "@/lib/supply-product";
import { requirePoolWriteAccess } from "./access";

export interface SupplyResult {
  ok: boolean;
  error?: string;
  supply?: SupplyOption | null;
}

const ok = (supply?: SupplyResult["supply"]): SupplyResult =>
  supply === undefined ? { ok: true } : { ok: true, supply };
const fail = (error: string): SupplyResult => ({ ok: false, error });

function revalidateSupplies(): void {
  revalidateRoute("/supplies");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
}

// The item's OWN write access always governs its side of linking/unlinking.
async function requireItemWriteAccess(itemId: number): Promise<number> {
  const row = db
    .prepare("SELECT profile_id FROM intake_items WHERE id = ?")
    .get(itemId) as { profile_id: number } | undefined;
  if (!row) {
    // No such item: gate on the acting profile so an unauthenticated/ungranted caller
    // still can't probe ids, then let the caller report "not found".
    await requireWriteAccess();
    return 0;
  }
  await requireProfileWriteAccess(row.profile_id);
  return row.profile_id;
}

// `seed` carries the product facts inherited from the item a pool is being created FROM
// (#1705). A field the form POSTS always wins — including one the user deliberately
// cleared — and the seed fills only what the form OMITS, which is exactly the rule the
// on-hand count already follows.
function fields(
  formData: FormData,
  seed?: { name: string; strength: string | null } | null
): SharedSupplyFields | null {
  const name = String(formData.get("name") ?? "").trim() || (seed?.name ?? "");
  if (!name) return null;
  const text = (k: string): string | null => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const rawDays = String(formData.get("low_supply_days") ?? "").trim();
  const days = rawDays === "" ? null : Number(rawDays);
  return {
    name,
    strength: formData.has("strength")
      ? text("strength")
      : (seed?.strength ?? null),
    form: text("form"),
    lowSupplyDays:
      days != null && Number.isFinite(days) && days > 0
        ? Math.floor(days)
        : null,
    notes: text("notes"),
  };
}

// Read-only: the pools the caller may link an item to. Scoped through the caller's
// accessible profiles (requireScope) — a member sees the bottles their OWN people
// already draw from — plus ORPHANED pools, which name nobody and so leak nothing.
// `form` rides along since #1705: the picker no longer only LINKS an existing item, it
// also seeds a NEW one, and the bottle's form is part of what it seeds.
export async function listSharedSupplyOptions(): Promise<SupplyOption[]> {
  const scope = await requireScope();
  // Each option carries its own members so the intake form can label the row with the
  // bottle's count and read the kind its siblings lend (#3216).
  return listLinkableSupplies(scope.ids).map((supply) =>
    supplyOption(supply, poolMembers(supply.id))
  );
}

// Create a shared bottle. Creating an EMPTY cabinet entry touches nobody's data, so the
// ordinary active-profile write gate is the right one; when `item_id` is posted the
// creating item is linked in the same step and its own gate applies too — that is the
// "create a pool from the item" flow.
//
// It INHERITS the item's product identity (#1705), not just its count: name and strength
// (the item's first active dose amount — where a strength is actually typed) seed the
// bottle so it is recognisably the same substance as the item drawing on it, instead of
// a retyped near-miss. Anything the form posts still wins. The count seeding is unchanged
// — a one-way, explicit migration of the item's on-hand INTO the pool — and from here on
// the pool is the authority for both.
export async function createPoolAction(
  formData: FormData
): Promise<SupplyResult> {
  await requireWriteAccess();
  const itemId = Number(formData.get("item_id") ?? 0);
  let quantity = parseQuantityOnHand(formData.get("quantity_on_hand"));
  let itemProfileId = 0;
  let productSeed: { name: string; strength: string | null } | null = null;
  if (itemId) {
    itemProfileId = await requireItemWriteAccess(itemId);
    if (!itemProfileId) return fail("Couldn't find that item.");
    const facts = getItemProductFacts(itemProfileId, itemId);
    if (!facts) return fail("Couldn't find that item.");
    productSeed = poolSeedFromItem(facts);
    if (!formData.has("quantity_on_hand")) quantity = facts.quantityOnHand;
  }
  const f = fields(formData, productSeed);
  if (!f) return fail("Enter a name for the shared bottle.");
  const supplyId = createSharedSupply(f, quantity);
  if (itemId && itemProfileId) linkItemToPool(itemProfileId, itemId, supplyId);
  revalidateSupplies();
  return ok({
    id: supplyId,
    name: f.name,
    strength: f.strength,
    form: f.form,
  });
}

// Edit a shared bottle: name/strength/form/threshold/notes plus the counter, which goes
// through the #467 compare-and-set at POOL level (updateSharedSupply re-reads under the
// write lock). The form posts the value it LOADED with so a linked member's dose confirm
// mid-edit is preserved, not clobbered.
export async function updatePoolAction(
  formData: FormData
): Promise<SupplyResult> {
  const supplyId = Number(formData.get("id"));
  if (!supplyId) return fail("Couldn't find that shared bottle.");
  await requirePoolWriteAccess(supplyId);
  const f = fields(formData);
  if (!f) return fail("Enter a name for the shared bottle.");
  const done = updateSharedSupply(
    supplyId,
    f,
    parseQuantityOnHand(formData.get("quantity_on_hand")),
    parseQuantityOnHand(formData.get("quantity_on_hand_loaded"))
  );
  if (!done) return fail("Couldn't find that shared bottle.");
  revalidateSupplies();
  return ok();
}

// Delete a shared bottle, carrying its side-state (#203 / the row-ops rule): the links
// are nulled and per-item accounting is restored by deleteSharedSupply, and the id-keyed
// state this pool owned is swept here — its low-supply episode marker and every linked
// member's suppression row for `pool-refill:<id>`. Ids never recycle, so a leftover
// would be a dead row rather than wrong suppression; sweeping it anyway keeps the
// suppressed-items centre free of orphan rows.
export async function deletePoolAction(
  formData: FormData
): Promise<SupplyResult> {
  const supplyId = Number(formData.get("id"));
  if (!supplyId) return fail("Couldn't find that shared bottle.");
  await requirePoolWriteAccess(supplyId);
  const pool = getSharedSupply(supplyId);
  if (!pool) return fail("Couldn't find that shared bottle.");
  const memberProfileIds = [
    ...new Set(poolMembers(supplyId).map((m) => m.profileId)),
  ];
  deleteSharedSupply(supplyId);
  deleteSetting(poolRefillMarkerKey(supplyId));
  for (const profileId of memberProfileIds)
    restoreFinding(profileId, poolRefillSignalKey(supplyId));
  revalidateSupplies();
  return ok();
}

// Link ONE item to an existing pool. The item's private count is dropped — the pool is
// now the truth for that bottle (keeping a second count IS the phantom-double-supply
// bug). Both sides of the membership change are authorized before the core runs.
export async function linkItemAction(
  formData: FormData
): Promise<SupplyResult> {
  const itemId = Number(formData.get("item_id"));
  const supplyId = Number(formData.get("supply_id"));
  if (!itemId || !supplyId) return fail("Couldn't find that item.");
  const profileId = await requireItemWriteAccess(itemId);
  if (!profileId) return fail("Couldn't find that item.");
  const supply = getSharedSupply(supplyId);
  if (!supply) return fail("Couldn't find that shared bottle.");
  await requirePoolWriteAccess(supplyId);
  linkItemToPool(profileId, itemId, supplyId);
  revalidateSupplies();
  // Members read AFTER the link, so the option returned describes the bottle as it
  // now is rather than as it was a line ago.
  return ok(supplyOption(supply, poolMembers(supplyId)));
}

export async function unlinkItemAction(
  formData: FormData
): Promise<SupplyResult> {
  const itemId = Number(formData.get("item_id"));
  if (!itemId) return fail("Couldn't find that item.");
  const profileId = await requireItemWriteAccess(itemId);
  if (!profileId) return fail("Couldn't find that item.");
  unlinkItemFromPool(profileId, itemId);
  revalidateSupplies();
  return ok(null);
}
