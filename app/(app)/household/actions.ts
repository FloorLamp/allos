"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  requireSession,
  requireProfileWriteAccess,
  setActiveProfile,
} from "@/lib/auth";
import { today } from "@/lib/db";
import { markDoseTaken } from "@/lib/queries";
import type { DoseConfirmResult } from "@/lib/dose-outcome-text";

// Switch the current session's active profile to the clicked household card and
// jump to that profile's dashboard — the same "set active profile + navigate" the
// header switcher does, in one click. Open to any logged-in caller (issue #31):
// setActiveProfile independently re-checks that the login may act as the target
// (admins may act as any; members only their granted profiles), so a read-only
// member can still switch, and an inaccessible target is a no-op.
export async function openProfileAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  if (profileId) await setActiveProfile(profileId);
  redirect("/");
}

// Confirm a due dose for a household member WITHOUT switching the active profile
// (issue #31). The target profile comes from the form, so this must gate on THAT
// profile, not the active one: requireProfileWriteAccess(profileId) asserts the
// caller can reach AND write the target (a read-only caregiver is bounced to the
// app root before any write). markDoseTaken is itself profile-scoped and idempotent
// — it verifies the dose belongs to the target profile via its parent supplement
// and logs it once — so a tampered dose_id from another profile is dropped even
// past the access gate.
//
// The result CARRIES markDoseTaken's typed outcome (#2106): this surface's own
// one-tap registry entry declares `outcome-toast`, and the action had been dropping
// the outcome and returning void — so a tap on a dose whose item was meanwhile
// paused, or whose dose row a schedule edit retired, logged nothing and said
// nothing, on a medication-adherence surface. The card's confirm button renders
// every branch through doseConfirmMessage.
export async function confirmDoseAction(
  formData: FormData
): Promise<DoseConfirmResult> {
  const profileId = Number(formData.get("profileId"));
  const doseId = Number(formData.get("dose_id"));
  if (!profileId || !doseId)
    return { ok: false, error: "Couldn't find that dose." };
  await requireProfileWriteAccess(profileId);
  const outcome = markDoseTaken(profileId, doseId, null, today(profileId));
  revalidatePath("/household");
  revalidatePath("/nutrition");
  revalidatePath("/medications");
  revalidatePath("/");
  return { ok: true, outcome };
}
