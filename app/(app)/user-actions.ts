"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  destroySession,
  getCurrentSession,
  requireSession,
  setActiveProfile,
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
