"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess, requireProfileWriteAccess } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { db } from "@/lib/db";
import { deleteSetting } from "@/lib/settings";
import { poolRefillMarkerKey, poolRefillSignalKey } from "@/lib/refill-nudge";
import { restoreFinding } from "@/lib/queries/upcoming";
import {
  copyPoolMemberPlan,
  declineAlsoForOffer,
} from "@/lib/queries/intake/also-for";
import { intakeHref, medicationHref } from "@/lib/hrefs";
import {
  alsoForRefusalMessage,
  alsoForRefusalRefreshes,
  type AlsoForResult,
} from "@/lib/intake-also-for";
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
  isLinkableSupply,
  supplyOption,
  type SharedSupplyFields,
} from "@/lib/queries/intake";
import { parseQuantityOnHand } from "@/lib/refill";
import { poolSeedFromItem, type SupplyOption } from "@/lib/supply-product";
import { cabinetViewer, requirePoolWriteAccess } from "./access";

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
// cabinet viewer (requireScope) — a member sees the bottles their OWN people already
// draw from, and a MEMBER-LESS bottle reaches an admin only (#5122). `form` rides along
// since #1705: the picker no longer only LINKS an existing item, it also seeds a NEW
// one, and the bottle's form is part of what it seeds.
export async function listSharedSupplyOptions(): Promise<SupplyOption[]> {
  const scope = await requireScope();
  // Each option carries its own members so the intake form can label the row with the
  // bottle's count and read the kind its siblings lend (#3216).
  return listLinkableSupplies(cabinetViewer(scope.ids, scope.role)).map(
    (supply) => supplyOption(supply, poolMembers(supply.id))
  );
}

// Create a shared bottle FROM an item — the only way there is. The gate here is the
// ordinary active-profile write gate, and the creating item's own gate applies too,
// since the item is linked in the same step.
//
// A bottle with no member cannot be created by anyone (#5122, owner ruling 2026-09-09),
// so `item_id` is required and the refusal points the person at linking from an item
// instead. That gives every bottle a member from birth; the other half of the same rule
// — a bottle that has LOST its members is admin-only — lives on the pool gates.
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
  if (!itemId)
    return fail(
      "Start a shared bottle from an item — open the item and create it under Shared supply."
    );
  const itemProfileId = await requireItemWriteAccess(itemId);
  if (!itemProfileId) return fail("Couldn't find that item.");
  const facts = getItemProductFacts(itemProfileId, itemId);
  if (!facts) return fail("Couldn't find that item.");
  const quantity = formData.has("quantity_on_hand")
    ? parseQuantityOnHand(formData.get("quantity_on_hand"))
    : facts.quantityOnHand;
  const f = fields(formData, poolSeedFromItem(facts));
  if (!f) return fail("Enter a name for the shared bottle.");
  const supplyId = createSharedSupply(f, quantity);
  linkItemToPool(itemProfileId, itemId, supplyId);
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

// "Also for" (#5230): copy ONE bottle member's plan onto another person, in one tap,
// without the caller ever becoming that person.
//
// THE GATE IS THE SUBJECT'S, PLUS THE BOTTLE'S. `requireProfileWriteAccess(targetId)` is
// the same re-gate linkItemAction applies to an item's own profile (#4693: the subject
// on every path, re-checked server-side) — the ACTING profile's requireWriteAccess()
// would authorize the wrong person. On top of it sits the bottle's membership-management
// gate (#5560, requirePoolWriteAccess), because this write also changes who draws from a
// household-shared bottle. The SOURCE must be a member the caller may actually read, so
// its profile is checked against the caller's own scope: a member they cannot see is
// never a plan they can copy.
//
// Everything the offer was derived from is re-read inside the atomic write, which is
// where a stale intent is refused (lib/queries/intake/also-for.ts).
//
// A REFUSAL THAT A FRESH RENDER FIXES ALSO REFRESHES THE CARD. The recipient's midnight
// is the case that matters: the offer's basis carries the day it was computed in, so an
// offer rendered at 23:59 and tapped at 00:01 refuses — and it must not refuse forever,
// which is what "reload the cabinet and try again" did to a state that was deterministic
// rather than stale. Revalidating here re-renders /supplies as part of this action's own
// response, so the card the person is looking at is already carrying the new day's basis
// by the time they read the message, and the next tap works. `alsoForRefusalRefreshes`
// names exactly which reasons that is true of.
export async function alsoForAction(
  formData: FormData
): Promise<AlsoForResult> {
  const supplyId = Number(formData.get("supply_id") ?? 0);
  const sourceItemId = Number(formData.get("source_item_id") ?? 0);
  const sourceProfileId = Number(formData.get("source_profile_id") ?? 0);
  const targetProfileId = Number(formData.get("profile_id") ?? 0);
  const basis = String(formData.get("basis") ?? "");
  if (!supplyId || !sourceItemId || !sourceProfileId || !targetProfileId) {
    return {
      ok: false,
      reason: "no-bottle",
      error: alsoForRefusalMessage("no-bottle", "them"),
    };
  }
  await requireProfileWriteAccess(targetProfileId);
  const scope = await requireScope();
  if (
    !isLinkableSupply(cabinetViewer(scope.ids, scope.role), supplyId) ||
    !scope.ids.includes(sourceProfileId)
  ) {
    return {
      ok: false,
      reason: "no-bottle",
      error: alsoForRefusalMessage("no-bottle", "them"),
    };
  }
  await requirePoolWriteAccess(supplyId);
  const target = scope.profiles.find((p) => p.id === targetProfileId);
  const targetName = target?.name ?? "them";
  const result = copyPoolMemberPlan({
    supplyId,
    sourceProfileId,
    sourceItemId,
    targetProfileId,
    targetName,
    basis,
  });
  if (!result.ok) {
    if (alsoForRefusalRefreshes(result.reason)) revalidateSupplies();
    return {
      ok: false,
      reason: result.reason,
      // The named refusals carry their own sentence; `age-gated` and `create-failed`
      // carry the OWNER MODEL's own words instead — the label's life-stage reason and
      // the create core's error — because those are more specific than anything this
      // action could say about them.
      error: result.detail ?? alsoForRefusalMessage(result.reason, targetName),
    };
  }
  revalidateSupplies();
  return {
    ok: true,
    receipt: result.receipt,
    href:
      result.kind === "medication"
        ? medicationHref(result.itemId)
        : intakeHref(result.kind),
  };
}

// "Not for them" (#5230): decline the bottle's offer for ONE person, without recurrence.
//
// Same gate as the tap, because the same two subjects are involved — the recipient's own
// write access and the bottle's membership-management gate — even though the write is
// only a suppression row under the recipient's profile. It touches no health data, no
// membership and no notification setting; Restore in that profile's "Snoozed &
// dismissed" puts the chip back.
export async function declineAlsoForAction(
  formData: FormData
): Promise<AlsoForResult> {
  const supplyId = Number(formData.get("supply_id") ?? 0);
  const targetProfileId = Number(formData.get("profile_id") ?? 0);
  if (!supplyId || !targetProfileId) {
    return {
      ok: false,
      reason: "no-bottle",
      error: alsoForRefusalMessage("no-bottle", "them"),
    };
  }
  await requireProfileWriteAccess(targetProfileId);
  const scope = await requireScope();
  if (!isLinkableSupply(cabinetViewer(scope.ids, scope.role), supplyId)) {
    return {
      ok: false,
      reason: "no-bottle",
      error: alsoForRefusalMessage("no-bottle", "them"),
    };
  }
  await requirePoolWriteAccess(supplyId);
  declineAlsoForOffer(supplyId, targetProfileId);
  revalidateSupplies();
  return { ok: true };
}
