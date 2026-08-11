"use server";

import { redirect } from "next/navigation";
import { destroySession, getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

// Log out: revoke the authentication session (deletes the row, clears the cookie)
// then send the login identity back to the login page.
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
