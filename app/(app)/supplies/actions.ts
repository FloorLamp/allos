"use server";

import { revalidatePath } from "next/cache";
import {
  requireSession,
  requireWriteAccess,
  requireProfileWriteAccess,
  accessForProfile,
  canAccessProfile,
} from "@/lib/auth";
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

export interface SupplyResult {
  ok: boolean;
  error?: string;
  supply?: SupplyOption | null;
}

const ok = (supply?: SupplyResult["supply"]): SupplyResult =>
  supply === undefined ? { ok: true } : { ok: true, supply };
const fail = (error: string): SupplyResult => ({ ok: false, error });

function revalidateSupplies(): void {
  revalidatePath("/supplies");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  revalidatePath("/upcoming");
  revalidatePath("/");
}

// THE POOL GATE (#1374). A shared bottle has no owning profile, so "who may edit it"
// is defined by its MEMBERSHIP: any login with WRITE access to at least ONE linked
// profile — the same shape cross-profile dose confirms already gate on
// (requireProfileWriteAccess), applied to the union rather than to one target. An
// ORPHANED pool (nothing links it) has no membership to derive from, so it falls back to
// the ordinary active-profile write gate: it holds no one's data, and leaving it
// uneditable would strand a row in the cabinet forever.
//
// Deliberately NOT admin-only and NOT "write to ALL linked profiles": the product
// decision in #1374 is that a caregiver who manages one member of the household may
// correct the count on the bottle that member drinks from.
async function requirePoolWriteAccess(supplyId: number): Promise<void> {
  const session = await requireSession();
  const members = poolMembers(supplyId);
  if (members.length === 0) {
    await requireWriteAccess();
    return;
  }
  // REACHABILITY FIRST, then access — the requireProfileWriteAccess order, and it
  // matters: accessForProfile returns "write" for a profile a member was never
  // granted at all (it only distinguishes read from write WITHIN the accessible set),
  // so consulting it alone would hand every member every household bottle.
  const writable = members.some(
    (m) =>
      canAccessProfile(session, m.profileId) &&
      accessForProfile(session.login.id, session.login.role, m.profileId) ===
        "write"
  );
  // Reuse the canonical per-profile gate for the refusal path so the redirect
  // behaviour (and its demo/read-only handling) is identical to every other write.
  if (!writable) await requireProfileWriteAccess(members[0].profileId);
}

// The item's OWN write access governs linking/unlinking (the issue's rule): putting
// YOUR bottle into the cabinet is a write to YOUR item.
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
  return listLinkableSupplies(scope.ids).map(supplyOption);
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
// bug). Gated on the ITEM's profile.
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
  linkItemToPool(profileId, itemId, supplyId);
  revalidateSupplies();
  return ok(supplyOption(supply));
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
