"use server";

import { redirect } from "next/navigation";
import { requireAdmin, setActiveProfile } from "@/lib/auth";

// Switch the current session's active profile to the clicked household card and
// jump to that profile's dashboard — the same "set active profile + navigate"
// the header switcher does, in one click. Admin-only: the household page and its
// cards are admin surfaces, and setActiveProfile independently re-checks that the
// login may act as the target profile (admins may act as any).
export async function openProfileAction(formData: FormData) {
  requireAdmin();
  const profileId = Number(formData.get("profileId"));
  if (profileId) setActiveProfile(profileId);
  redirect("/");
}
