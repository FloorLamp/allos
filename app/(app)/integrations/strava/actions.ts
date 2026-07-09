"use server";
import { requireWriteAccess } from "@/lib/auth";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  setStravaCredentials,
  setStravaOAuthState,
  hasStravaCredentials,
  disconnectStrava,
  getStravaConfig,
} from "@/lib/integrations/connections";
import { runStravaSync } from "@/lib/integrations/strava-sync";
import { createLogger } from "@/lib/log";
import { stravaCallbackUrl, isLoopbackUrl } from "./url";

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const log = createLogger("strava");

// Save the app-registration credentials (client id/secret) entered in the UI.
export async function saveStravaCredentials(formData: FormData) {
  const { profile } = requireWriteAccess();
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecretInput = String(formData.get("clientSecret") ?? "").trim();
  // The secret field is never pre-filled (it isn't sent to the browser), so a
  // blank submission means "keep the existing secret" — e.g. when only the
  // client ID is being changed.
  const clientSecret =
    clientSecretInput || getStravaConfig(profile.id).clientSecret || "";
  if (clientId && clientSecret)
    setStravaCredentials(profile.id, clientId, clientSecret);
  revalidatePath("/integrations/strava");
}

// Begin the OAuth flow: store a single-use CSRF state, then redirect to Strava's
// authorize page. activity:read_all covers private activities.
export async function connectStrava() {
  const { profile } = requireWriteAccess();
  if (!hasStravaCredentials(profile.id)) {
    redirect("/integrations/strava?error=missing_credentials");
  }
  const callbackUrl = stravaCallbackUrl();
  // Bail before starting OAuth if the callback resolves to loopback (no public
  // URL configured and the request host is localhost — typically a reverse proxy
  // that doesn't forward the real host). Strava would otherwise redirect the
  // browser back to the user's own machine; point the admin at the Public app
  // URL setting instead of handing Strava an unreachable redirect_uri.
  if (isLoopbackUrl(callbackUrl)) {
    redirect("/integrations/strava?error=set_public_url");
  }
  const state = crypto.randomBytes(16).toString("hex");
  setStravaOAuthState(profile.id, state);
  const params = new URLSearchParams({
    client_id: getStravaConfig(profile.id).clientId ?? "",
    response_type: "code",
    redirect_uri: callbackUrl,
    approval_prompt: "auto",
    scope: "activity:read_all",
    state,
  });
  redirect(`${AUTHORIZE_URL}?${params.toString()}`);
}

// Pull from Strava on demand, then refresh the views the data feeds. The result
// is persisted by runStravaSync (recordSync) and shown via the revalidated
// last-sync summary, so this returns void to satisfy the form-action signature.
export async function syncStravaAction() {
  const { profile } = requireWriteAccess();
  // runStravaSync returns { error } for graceful failures and can throw on an
  // unexpected network error; catch both so neither becomes an unhandled error
  // page, and surface the failure to the page via the ?error= param.
  let failed = false;
  try {
    const res = await runStravaSync(profile.id);
    if (res && "error" in res) {
      log.error("strava sync failed", { error: res.error });
      failed = true;
    }
  } catch (err) {
    log.error("strava sync threw", { err: String(err) });
    failed = true;
  }
  for (const p of ["/", "/training", "/trends", "/integrations/strava"]) {
    revalidatePath(p);
  }
  if (failed) redirect("/integrations/strava?error=sync_failed");
}

export async function disconnectStravaAction() {
  const { profile } = requireWriteAccess();
  disconnectStrava(profile.id);
  revalidatePath("/integrations/strava");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}
