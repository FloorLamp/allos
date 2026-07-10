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
export async function confirmDoseAction(formData: FormData) {
  const profileId = Number(formData.get("profileId"));
  const doseId = Number(formData.get("dose_id"));
  if (!profileId || !doseId) return;
  await requireProfileWriteAccess(profileId);
  markDoseTaken(profileId, doseId, null, today(profileId));
  revalidatePath("/household");
  revalidatePath("/medicine");
  revalidatePath("/");
}
