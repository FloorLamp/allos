"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  destroySession,
  getCurrentSession,
  requireSession,
  setActiveProfile,
  toggleViewProfile,
} from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

// Log out: revoke the session (deletes the row, clears the cookie) then send the
// user to the login page.
export async function logoutAction() {
  // Capture who's logging out BEFORE the session row is torn down.
  const session = await getCurrentSession();
  if (session)
    recordAudit({
      loginId: session.login.id,
      profileId: session.profile.id,
      action: AUDIT_ACTIONS.logout,
    });
  await destroySession();
  redirect("/login");
}

// Switch the active profile on the current session, then refresh the app so the
// new profile's data renders. Grant/admin is enforced inside setActiveProfile.
export async function switchProfileAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  if (profileId) await setActiveProfile(profileId);
  revalidatePath("/", "layout");
}

// Toggle one profile in/out of the session's multi-profile VIEW-SET (issue #1096) —
// the banner's per-chip "show in view" control. A READ overlay only: it changes
// whose data multi-view pages merge, never the write target. toggleViewProfile is
// grant-validated (an ungranted id is a silent no-op) and always keeps the acting
// profile in view, so a tampered form can neither widen the view past the login's
// grants nor hide the acting profile. Revalidates the whole layout so the banner
// strip + every multi-view page re-render against the new view-set.
export async function setViewProfileAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  if (profileId) await toggleViewProfile(profileId);
  revalidatePath("/", "layout");
}
