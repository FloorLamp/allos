"use server";
import { requireWriteAccess } from "@/lib/auth";

import crypto from "node:crypto";
import { revalidateRoute } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import {
  setStravaCredentials,
  setStravaOAuthState,
  hasStravaCredentials,
  disconnectStrava,
  getStravaConfig,
} from "@/lib/integrations/connections";
import { stravaCallbackUrl } from "./url";
import { isLoopbackUrl } from "@/lib/external-url";
import {
  queueIntegrationBackfill,
  runIntegrationBackfillJob,
} from "@/lib/integrations/backfill-jobs";
import { recheckStravaAnsweredSessions } from "@/lib/integrations/strava-sync";
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
  revalidateRoute("/integrations/strava");
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
  revalidateRoute("/integrations/strava");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidateRoute("/data");
}

export async function backfillStravaRideDetails(): Promise<StravaBackfillActionResult> {
  const { profile } = await requireWriteAccess();
  const queued = queueIntegrationBackfill(profile.id, "strava", "ride-details");
  if ("error" in queued) {
    return { status: "error", message: queued.error };
  }
  if (!queued.shouldRun) {
    return {
      status: "done",
      message:
        queued.job.status === "completed"
          ? "All Strava ride details are complete."
          : "The ride detail backfill is already running.",
    };
  }

  void runIntegrationBackfillJob(profile.id, "strava", "ride-details").catch(
    (err) => {
      log.error("Strava ride-detail backfill runner rejected", {
        profileId: profile.id,
        err: String(err),
      });
    }
  );
  revalidateRoute("/integrations/strava");
  revalidateRoute("/data");
  return {
    status: "done",
    message: "Ride detail backfill started. Progress and ETA are shown below.",
  };
}

// Forget what Strava answered for the sessions it said had nothing, so the next
// backfill asks about them again (#3037). A person chooses this; nothing does it
// automatically. That is the whole trade the owner's ruling makes — the badge can
// reach zero because the answer is stored, and a session made public again, or one
// whose streams finished processing, is still recoverable on request.
export async function recheckStravaEmptySessions(): Promise<StravaBackfillActionResult> {
  const { profile } = await requireWriteAccess();
  const cleared = recheckStravaAnsweredSessions(profile.id);
  revalidateRoute("/integrations/strava");
  revalidateRoute("/data");
  return {
    status: "done",
    message:
      cleared === 0
        ? "No sessions to re-check."
        : `${cleared} session${cleared === 1 ? "" : "s"} queued for another look. Run the backfill to ask Strava again.`,
  };
}
