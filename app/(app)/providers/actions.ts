"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import {
  getProvider,
  updateProviderIdentity,
  mergeProviders,
  getProviderMergeImpact,
  setProviderArchived,
  linkAffiliation,
  declineAffiliation,
  unlinkAffiliation,
  resolveProviderIdByName,
} from "@/lib/queries";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { formatProviderMergeAudit } from "@/lib/provider-merge";
import { createLogger } from "@/lib/log";
import type { ProviderType } from "@/lib/types";

const log = createLogger("providers");

// Server actions for the provider registry (issue #275). BOTH mutations are on the
// GLOBAL providers row (shared across every profile), so both gate on
// requireAdmin() — the same posture as the other global/instance settings writes.
// Members never reach them (the buttons are hidden AND this guard redirects a
// direct POST). Errors are returned as a { error } object the client renders
// inline, matching the family-actions pattern.

function normType(v: FormDataEntryValue | null): ProviderType {
  return v === "individual" ? "individual" : "organization";
}

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

// Edit the shared identity card (name / type / NPI / identifier / phone / address).
export async function updateProviderAction(
  formData: FormData
): Promise<{ error?: string }> {
  const admin = await requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { error: "Missing provider." };
  const name = str(formData.get("name"));
  if (!name) return { error: "A provider needs a name." };
  try {
    updateProviderIdentity(id, {
      name,
      type: normType(formData.get("type")),
      npi: str(formData.get("npi")) || null,
      identifier: str(formData.get("identifier")) || null,
      phone: str(formData.get("phone")) || null,
      address: str(formData.get("address")) || null,
      specialtyCode: str(formData.get("specialty_code")) || null,
      specialty: str(formData.get("specialty")) || null,
    });
  } catch (err) {
    // updateProviderIdentity throws a FRIENDLY domain error the user needs to see
    // (an identity clash → "…merge the duplicates instead."), so surface it; the
    // fallback string just drops the banned "Could not" verb (#945).
    return { error: err instanceof Error ? err.message : "Couldn't save." };
  }
  // Audit the GLOBAL identity edit (issue #655): who edited which shared provider.
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.providerUpdate,
    target: String(id),
    detail: name,
  });
  revalidatePath(`/providers/${id}`);
  revalidatePath("/records");
  return {};
}

// Absorb `duplicateId` into `survivorId`: re-point every provider link, delete the
// duplicate. Global, transactional (lib/providers-db). On success the duplicate no
// longer exists, so we redirect to the survivor's page.
export async function mergeProviderAction(
  formData: FormData
): Promise<{ error?: string }> {
  const admin = await requireAdmin();
  const survivorId = Number(formData.get("survivorId"));
  const duplicateId = Number(formData.get("duplicateId"));
  if (!survivorId || !duplicateId)
    return { error: "Pick a provider to merge." };
  const duplicate = getProvider(duplicateId);
  if (!getProvider(survivorId) || !duplicate)
    return { error: "One of the providers no longer exists." };
  // Read the per-table re-point counts BEFORE the merge — afterward the links point
  // at the survivor and the absorbed row is gone, so the impact is unrecoverable.
  const impact = getProviderMergeImpact(duplicateId);
  try {
    mergeProviders(survivorId, duplicateId);
  } catch (err) {
    // Keep the client message generic (#478); the cause lands in the server log.
    log.error("provider merge failed", {
      survivorId,
      duplicateId,
      err: err instanceof Error ? err : String(err),
    });
    return { error: "Couldn't merge those providers." };
  }
  // Audit the absorb (issue #655): the absorbed row is now deleted and ids never
  // recycle, so this event carries its id + name + the surviving id + counts.
  recordAudit({
    loginId: admin.login.id,
    profileId: admin.profile.id,
    action: AUDIT_ACTIONS.providerMerge,
    target: String(survivorId),
    detail: formatProviderMergeAudit({
      survivorId,
      absorbedId: duplicateId,
      absorbedName: duplicate.name,
      impact,
    }),
  });
  revalidatePath("/records");
  revalidatePath(`/providers/${survivorId}`);
  redirect(`/providers/${survivorId}?merged=1`);
}

// ── Lifecycle: archive / un-archive (issue #1057) ─────────────────────────────
// GLOBAL, instance-level flag — admin-gated like the identity edit. Archiving never
// touches history (FK'd records keep their link); it only hides the provider from the
// default directory + picker suggestions.
export async function setProviderArchivedAction(
  formData: FormData
): Promise<{ error?: string }> {
  await requireAdmin();
  const id = Number(formData.get("id"));
  if (!id) return { error: "Missing provider." };
  const archived = String(formData.get("archived")) === "1";
  setProviderArchived(id, archived);
  revalidatePath(`/providers/${id}`);
  revalidatePath("/records");
  return {};
}

// ── Affiliations (issue #1055) ────────────────────────────────────────────────
// GLOBAL registry edges between an individual and an organization — admin-gated. The
// picker on a provider's card resolves the OTHER end by name (create-on-type over the
// opposite type), then links the pair; the suggestion accept/decline carry ids.

// Manual "Affiliated with…" link. `id` is the card's provider; `name` is the typed
// counterpart, resolved under `counterpart_type` (the opposite kind).
export async function linkAffiliationAction(
  formData: FormData
): Promise<{ error?: string }> {
  await requireAdmin();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  const counterpartType =
    String(formData.get("counterpart_type")) === "individual"
      ? "individual"
      : "organization";
  if (!id) return { error: "Missing provider." };
  if (!name) return { error: "Enter a provider to affiliate with." };
  const otherId = resolveProviderIdByName(name, counterpartType);
  if (!otherId || otherId === id)
    return { error: "Pick a different provider to affiliate with." };
  if (!linkAffiliation(id, otherId, "manual"))
    return {
      error: "Affiliations link an individual clinician to an organization.",
    };
  revalidatePath(`/providers/${id}`);
  revalidatePath(`/providers/${otherId}`);
  revalidatePath("/records");
  return {};
}

// Accept a suggested affiliation (both ids known).
export async function acceptAffiliationAction(
  formData: FormData
): Promise<{ error?: string }> {
  await requireAdmin();
  const individualId = Number(formData.get("individual_id"));
  const organizationId = Number(formData.get("organization_id"));
  if (!individualId || !organizationId) return { error: "Missing provider." };
  linkAffiliation(individualId, organizationId, "suggested");
  revalidatePath(`/providers/${individualId}`);
  revalidatePath(`/providers/${organizationId}`);
  revalidatePath("/records");
  return {};
}

// Decline a suggested affiliation — remembered so it never re-suggests.
export async function declineAffiliationAction(
  formData: FormData
): Promise<{ error?: string }> {
  await requireAdmin();
  const individualId = Number(formData.get("individual_id"));
  const organizationId = Number(formData.get("organization_id"));
  if (!individualId || !organizationId) return { error: "Missing provider." };
  declineAffiliation(individualId, organizationId);
  revalidatePath(`/providers/${individualId}`);
  revalidatePath(`/providers/${organizationId}`);
  revalidatePath("/records");
  return {};
}

// Remove an existing affiliation edge (un-link).
export async function unlinkAffiliationAction(
  formData: FormData
): Promise<{ error?: string }> {
  await requireAdmin();
  const id = Number(formData.get("id"));
  const otherId = Number(formData.get("other_id"));
  if (!id || !otherId) return { error: "Missing provider." };
  unlinkAffiliation(id, otherId);
  revalidatePath(`/providers/${id}`);
  revalidatePath(`/providers/${otherId}`);
  revalidatePath("/records");
  return {};
}
