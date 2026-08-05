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
import { stravaCallbackUrl, isLoopbackUrl } from "./url";
import { runStravaDetailsBackfill } from "@/lib/integrations/strava-sync";
import { createLogger } from "@/lib/log";

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const log = createLogger("strava-backfill");

export interface StravaBackfillActionResult {
  status: "done" | "error";
  message: string;
}

// Save the app-registration credentials (client id/secret) entered in the UI.
export async function saveStravaCredentials(formData: FormData) {
  const { profile } = await requireWriteAccess();
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
// authorize page. profile:read_all is needed for FTP and athlete zone snapshots;
// activity:read_all covers private activities and their streams.
export async function connectStrava() {
  const { profile } = await requireWriteAccess();
  if (!hasStravaCredentials(profile.id)) {
    redirect("/integrations/strava?error=missing_credentials");
  }
  const callbackUrl = await stravaCallbackUrl();
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
    scope: "read,activity:read_all,profile:read_all",
    state,
  });
  redirect(`${AUTHORIZE_URL}?${params.toString()}`);
}

export async function disconnectStravaAction() {
  const { profile } = await requireWriteAccess();
  disconnectStrava(profile.id);
  revalidatePath("/integrations/strava");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}

export async function backfillStravaRideDetails(): Promise<StravaBackfillActionResult> {
  const { profile } = await requireWriteAccess();
  try {
    const result = await runStravaDetailsBackfill(profile.id);
    if ("error" in result) {
      return {
        status: "error",
        message:
          result.error === "not connected"
            ? "Connect Strava first, then backfill ride details."
            : "Couldn’t backfill ride details. Try again.",
      };
    }
    revalidatePath("/integrations/strava");
    revalidatePath("/training");
    revalidatePath("/training/rides/[id]", "page");
    if (result.backfilled === 0 && result.remaining === 0) {
      return {
        status: "done",
        message: "All Strava ride details are complete.",
      };
    }
    const filled = `${result.backfilled} ${result.backfilled === 1 ? "ride" : "rides"}`;
    const failed =
      result.failed > 0 ? ` ${result.failed} couldn’t be fetched.` : "";
    const remaining =
      result.remaining > 0
        ? ` ${result.remaining} ${result.remaining === 1 ? "ride remains" : "rides remain"}.`
        : " Backfill complete.";
    const quota = result.paused
      ? " Paused before Strava’s read limit; run it again after the quota resets."
      : "";
    return {
      status: "done",
      message: `Added details to ${filled}.${failed}${remaining}${quota}`,
    };
  } catch (err) {
    log.error("Strava ride-detail backfill failed", {
      profileId: profile.id,
      err: String(err),
    });
    return {
      status: "error",
      message: "Couldn’t backfill ride details. Try again.",
    };
  }
}
