"use server";
// Admin-only action for Settings → Logs & audit → Notify tick (issue #2209).
// Clearing the persisted tick log is a global, admin-gated operation: the lines mix
// profile names, item names and finding text across every profile, so a member must
// never reach it. Mirrors clearErrors() for the sibling errors.jsonl surface.
import { requireAdmin } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { clearNotifyLog } from "@/lib/notify-log";

export async function clearNotifyEvents(): Promise<void> {
  await requireAdmin();
  clearNotifyLog();
  revalidateRoute("/settings/notify-log");
}
