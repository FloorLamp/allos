"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { setDashboardLayout } from "@/lib/settings";

// Persist the active profile's dashboard customization (issue #156): the widget
// display order and the set of hidden widget ids. Profile-scoped like the other
// per-profile settings; the layout is merged defensively against the registry on
// read, so ids aren't validated here.
export async function saveDashboardLayout(order: string[], hidden: string[]) {
  const { profile } = requireSession();
  setDashboardLayout(profile.id, { order, hidden });
  revalidatePath("/");
}
