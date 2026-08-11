"use server";

import { redirect } from "next/navigation";
import { revalidateRoute } from "@/lib/revalidate";
import {
  requireSession,
  setActiveProfile,
  toggleViewProfile,
} from "@/lib/auth";
import { isSafeNextPath, safeNextPath } from "@/lib/login-security";

// Switch the active profile on the current session, then refresh the app so the
// new profile's data renders. Grant/admin access is enforced by setActiveProfile.
export async function switchProfileAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  if (profileId) await setActiveProfile(profileId);
  revalidateRoute("/", "layout");

  // Profile-owned links may use the shared switcher chip to change context and
  // continue to their destination in one explicit gesture. Accept internal paths
  // only: form fields are client-controlled, so the same hardened validator used
  // by login redirects owns the open-redirect boundary here too.
  const rawReturnTo = formData.get("returnTo");
  if (isSafeNextPath(rawReturnTo)) redirect(safeNextPath(rawReturnTo));
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
  revalidateRoute("/", "layout");
}
