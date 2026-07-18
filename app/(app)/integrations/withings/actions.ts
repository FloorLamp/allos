"use server";
import { requireWriteAccess } from "@/lib/auth";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  setWithingsCredentials,
  setWithingsOAuthState,
  hasWithingsCredentials,
  disconnectWithings,
  getWithingsConfig,
} from "@/lib/integrations/connections";
import { runWithingsSync } from "@/lib/integrations/withings-sync";
import { createLogger } from "@/lib/log";
import { withingsCallbackUrl, isLoopbackUrl } from "./url";

// Withings' user-facing OAuth authorize page. Scope covers measures (metrics) +
// sleep/activity summaries.
const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
const SCOPE = "user.metrics,user.activity";
const log = createLogger("withings");

// Save the app-registration credentials (client id/secret) entered in the UI.
export async function saveWithingsCredentials(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecretInput = String(formData.get("clientSecret") ?? "").trim();
  // The secret field is never pre-filled (it isn't sent to the browser), so a blank
  // submission means "keep the existing secret" — e.g. when only the client ID is
  // being changed.
  const clientSecret =
    clientSecretInput || getWithingsConfig(profile.id).clientSecret || "";
  if (clientId && clientSecret)
    setWithingsCredentials(profile.id, clientId, clientSecret);
  revalidatePath("/integrations/withings");
}

// Begin the OAuth flow: store a single-use CSRF state, then redirect to Withings'
// authorize page.
export async function connectWithings() {
  const { profile } = await requireWriteAccess();
  if (!hasWithingsCredentials(profile.id)) {
    redirect("/integrations/withings?error=missing_credentials");
  }
  const callbackUrl = await withingsCallbackUrl();
  // Bail before starting OAuth if the callback resolves to loopback (no public URL
  // configured and the request host is localhost) — Withings would otherwise redirect
  // the browser back to the user's own machine.
  if (isLoopbackUrl(callbackUrl)) {
    redirect("/integrations/withings?error=set_public_url");
  }
  const state = crypto.randomBytes(16).toString("hex");
  setWithingsOAuthState(profile.id, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getWithingsConfig(profile.id).clientId ?? "",
    scope: SCOPE,
    redirect_uri: callbackUrl,
    state,
  });
  redirect(`${AUTHORIZE_URL}?${params.toString()}`);
}

// Pull from Withings on demand (form action on the setup page). runWithingsSync
// returns { error } for graceful failures and can throw on an unexpected network
// error; catch both so neither becomes an unhandled error page, and surface the
// failure via ?error=.
export async function syncWithingsAction() {
  const { profile } = await requireWriteAccess();
  let failed = false;
  try {
    const res = await runWithingsSync(profile.id);
    if (res && "error" in res) {
      log.error("withings sync failed", { error: res.error });
      failed = true;
    }
  } catch (err) {
    log.error("withings sync threw", { err: String(err) });
    failed = true;
  }
  for (const p of [
    "/",
    "/trends",
    "/timeline",
    "/integrations/withings",
    "/data",
  ]) {
    revalidatePath(p);
  }
  if (failed) redirect("/integrations/withings?error=sync_failed");
}

export interface SyncNowResult {
  status: "done" | "error";
  message: string;
}

// "Sync now" from the Data → Review "Connected sources" section (issue #208). Returns
// an inline result the button surfaces; runs the SAME idempotent runWithingsSync.
export async function syncWithingsNow(): Promise<SyncNowResult> {
  const { profile } = await requireWriteAccess();
  try {
    const res = await runWithingsSync(profile.id);
    if (res && "error" in res) {
      const message =
        res.error === "not connected"
          ? "Connect Withings first, then sync."
          : `Sync failed: ${res.error}`;
      log.error("withings sync-now failed", { error: res.error });
      return { status: "error", message };
    }
    for (const p of [
      "/",
      "/trends",
      "/timeline",
      "/integrations/withings",
      "/data",
    ]) {
      revalidatePath(p);
    }
    const parts: string[] = [];
    const body = res.bodyMetrics;
    if (body > 0)
      parts.push(`${body} body ${body === 1 ? "record" : "records"}`);
    if (res.vitals > 0)
      parts.push(`${res.vitals} ${res.vitals === 1 ? "vital" : "vitals"}`);
    if (res.samples > 0)
      parts.push(
        `${res.samples} sleep ${res.samples === 1 ? "record" : "records"}`
      );
    const body_ = parts.length ? parts.join(", ") : "no new readings";
    const suffix = res.truncated ? " (more to come next sync)" : "";
    return { status: "done", message: `Synced ${body_}.${suffix}` };
  } catch (err) {
    log.error("withings sync-now threw", { err: String(err) });
    return { status: "error", message: "Couldn't sync. Try again." };
  }
}

export async function disconnectWithingsAction() {
  const { profile } = await requireWriteAccess();
  disconnectWithings(profile.id);
  revalidatePath("/integrations/withings");
  revalidatePath("/data");
}
