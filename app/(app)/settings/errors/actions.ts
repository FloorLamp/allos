"use server";
// Admin-only action for the Settings → Errors tab (issue #596). Clearing the
// server error log is a global, admin-gated operation — the error detail mixes
// PHI-adjacent content across profiles, so a member must never reach it.
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { clearErrorLog } from "@/lib/error-log";

export async function clearErrors(): Promise<void> {
  await requireAdmin();
  clearErrorLog();
  revalidatePath("/settings/errors");
}
