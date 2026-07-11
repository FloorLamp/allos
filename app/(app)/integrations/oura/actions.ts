"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setOuraToken, disconnectOura } from "@/lib/integrations/connections";
import { runOuraSync, validateOuraToken } from "@/lib/integrations/oura-sync";
import { createLogger } from "@/lib/log";

const log = createLogger("oura");

// Connect: validate the pasted personal access token with the Oura v2 whoami
// (GET /v2/usercollection/personal_info) BEFORE storing it, so a typo/expired token
// is rejected up front instead of failing silently on the first hourly sync. On
// success the token + captured identity are stored and the connection goes live; the
// page re-renders in its connected state.
export async function connectOura(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const token = String(formData.get("token") ?? "").trim();
  if (!token) redirect("/integrations/oura?error=missing_token");

  let res;
  try {
    res = await validateOuraToken(token);
  } catch (err) {
    log.error("oura validate threw", { err: String(err) });
    redirect("/integrations/oura?error=validation_failed");
  }
  if (!res.ok) {
    redirect(
      `/integrations/oura?error=${res.status === 401 ? "invalid_token" : "validation_failed"}`
    );
  }
  setOuraToken(profile.id, token, res.info);
  revalidatePath("/integrations/oura");
  revalidatePath("/data");
}

// Pull from Oura on demand (form action on the setup page). runOuraSync returns
// { error } for graceful failures and can throw on an unexpected error — catch both
// so neither becomes an unhandled error page; surface the failure via ?error=.
export async function syncOuraAction() {
  const { profile } = await requireWriteAccess();
  let failed = false;
  try {
    const res = await runOuraSync(profile.id);
    if (res && "error" in res) {
      log.error("oura sync failed", { error: res.error });
      failed = true;
    }
  } catch (err) {
    log.error("oura sync threw", { err: String(err) });
    failed = true;
  }
  for (const p of [
    "/",
    "/training",
    "/trends",
    "/integrations/oura",
    "/data",
  ]) {
    revalidatePath(p);
  }
  if (failed) redirect("/integrations/oura?error=sync_failed");
}

export interface SyncNowResult {
  status: "done" | "error";
  message: string;
}

// "Sync now" from the Data → Review "Connected sources" section (issue #208). Returns
// an inline result the button surfaces; runs the SAME idempotent runOuraSync.
export async function syncOuraNow(): Promise<SyncNowResult> {
  const { profile } = await requireWriteAccess();
  try {
    const res = await runOuraSync(profile.id);
    if (res && "error" in res) {
      const message =
        res.error === "not connected"
          ? "Connect Oura first, then sync."
          : `Sync failed: ${res.error}`;
      log.error("oura sync-now failed", { error: res.error });
      return { status: "error", message };
    }
    for (const p of [
      "/",
      "/training",
      "/trends",
      "/integrations/oura",
      "/data",
    ]) {
      revalidatePath(p);
    }
    const parts = [
      `${res.workouts} ${res.workouts === 1 ? "workout" : "workouts"}`,
    ];
    const nights = res.bodyMetrics + res.samples;
    if (nights > 0) parts.push(`${nights} sleep/HR records`);
    const suffix = res.truncated ? " (more to come next sync)" : "";
    return { status: "done", message: `Synced ${parts.join(", ")}.${suffix}` };
  } catch (err) {
    log.error("oura sync-now threw", { err: String(err) });
    return { status: "error", message: "Sync failed — please try again." };
  }
}

export async function disconnectOuraAction() {
  const { profile } = await requireWriteAccess();
  disconnectOura(profile.id);
  revalidatePath("/integrations/oura");
  revalidatePath("/data");
}
