"use server";
// Admin-only action for the Settings → AI logs tab (issue #1842). Clearing the
// AI activity log is a global, admin-gated operation — it mixes extraction
// content (names, biomarkers) across every profile, so a member must never
// reach it. Mirrors the Errors tab's clearErrors.
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { clearAiLog } from "@/lib/ai-log";

export async function clearAiLogAction(): Promise<void> {
  await requireAdmin();
  clearAiLog();
  revalidatePath("/settings/logs");
}
