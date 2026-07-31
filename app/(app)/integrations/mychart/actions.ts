"use server";
// MyChart acquirer setup actions (#1739) — the portal registry and the
// patient-label → profile bindings.
//
// AUTH TIER. A binding decides WHERE a person's records land, so it is
// access-control-adjacent and gates on requireProfileWriteAccess(TARGET) — the
// cross-profile write gate. requireWriteAccess() would be the wrong gate: it checks the
// session's ACTIVE profile, while a binding names an arbitrary target, and binding
// grandma's portal patient to grandma's profile from your own session is the normal case.
// That guard resolves the session, refuses in demo mode, asserts the caller can REACH the
// target, and asserts WRITE on it — in that order, because accessForProfile assumes
// reachability.
//
// Portal registry writes are instance-scoped (a household shares one "Ochsner MyChart",
// like the shared `providers` registry), so they gate on requireAdmin().
//
// The lib/portals.ts cores are auth-blind by house rule; every gate lives here.

import { revalidatePath } from "next/cache";
import { requireAdmin, requireProfileWriteAccess } from "@/lib/auth";
import {
  bindPortalIdentity,
  createPortal,
  deletePortal,
  unbindPortalIdentity,
} from "@/lib/portals";

export type PortalActionResult = { ok: true } | { ok: false; error: string };

export async function addPortalAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const slug = String(formData.get("slug") ?? "");
  const name = String(formData.get("name") ?? "");
  // createPortal owns the validation, including the refusal of URL-shaped input — the
  // schema has no address column, and this is the one free-text field where one could
  // otherwise enter the record.
  const r = createPortal(slug, name);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/integrations/mychart");
  return { ok: true };
}

export async function removePortalAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const id = Number(formData.get("portal_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown portal." };
  }
  if (!deletePortal(id))
    return { ok: false, error: "That portal is already gone." };
  revalidatePath("/integrations/mychart");
  return { ok: true };
}

export async function bindIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  const portalId = Number(formData.get("portal_id"));
  const profileId = Number(formData.get("profile_id"));
  const label = String(formData.get("patient_label") ?? "");
  if (!Number.isInteger(portalId) || portalId <= 0) {
    return { ok: false, error: "Choose a portal." };
  }
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return { ok: false, error: "Choose a profile." };
  }
  // The gate is on the TARGET profile: you may only route a portal patient onto a
  // profile you could write to yourself. Throws (redirect) if not — so a forged post
  // aborts before the binding is written.
  await requireProfileWriteAccess(profileId);

  const r = bindPortalIdentity(portalId, label, profileId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/integrations/mychart");
  return { ok: true };
}

export async function unbindIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  const id = Number(formData.get("identity_id"));
  const profileId = Number(formData.get("profile_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown mapping." };
  }
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return { ok: false, error: "Unknown mapping." };
  }
  // Removing a binding is the same class of decision as creating one — it changes where
  // this patient's future records go (namely: nowhere, refused) — so it takes the same
  // gate on the profile the binding currently points at.
  await requireProfileWriteAccess(profileId);

  if (!unbindPortalIdentity(id)) {
    return { ok: false, error: "That mapping is already gone." };
  }
  revalidatePath("/integrations/mychart");
  return { ok: true };
}
