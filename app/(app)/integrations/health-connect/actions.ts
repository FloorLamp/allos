"use server";
import { requireSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

import { revalidatePath } from "next/cache";
import {
  generateHealthConnectToken,
  disconnectHealthConnect,
} from "@/lib/integrations/connections";
import { isValidExpiryChoice } from "@/lib/token-lifecycle";

// Generate (or rotate) the ingest token and mark the integration connected. The
// optional `expiry` form field (issue #24) sets a mint-time expiry; anything but
// the three known choices falls back to "never" to preserve behaviour.
export async function connectHealthConnect(formData?: FormData) {
  const { profile, login } = requireSession();
  const raw = formData?.get("expiry");
  const expiry = isValidExpiryChoice(raw) ? raw : "never";
  generateHealthConnectToken(profile.id, expiry);
  // Covers both first mint and rotation (minting replaces any prior token).
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenMint,
    target: "health-connect",
    detail: `expiry:${expiry}`,
  });
  revalidatePath("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}

// Disconnect: clear the token and status. The endpoint then rejects all requests.
export async function disconnect() {
  const { profile, login } = requireSession();
  disconnectHealthConnect(profile.id);
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenRevoke,
    target: "health-connect",
  });
  revalidatePath("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}
