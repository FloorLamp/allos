"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import {
  getProvider,
  updateProviderIdentity,
  mergeProviders,
  getProviderMergeImpact,
} from "@/lib/queries";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { formatProviderMergeAudit } from "@/lib/provider-merge";
import type { ProviderType } from "@/lib/types";

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
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save." };
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
  revalidatePath("/providers");
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
    return { error: err instanceof Error ? err.message : "Could not merge." };
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
  revalidatePath("/providers");
  revalidatePath(`/providers/${survivorId}`);
  redirect(`/providers/${survivorId}?merged=1`);
}
