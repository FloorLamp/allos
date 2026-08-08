"use server";
import { requireWriteAccess } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

import { revalidateRoute } from "@/lib/revalidate";
import {
  generateHealthConnectToken,
  disconnectHealthConnect,
} from "@/lib/integrations/connections";
import { isValidExpiryChoice } from "@/lib/token-lifecycle";

export type HealthConnectTokenResult =
  { ok: true; token: string } | { ok: false; error: string };

// Generate (or rotate) the ingest token and mark the integration connected. The
// token is stored HASHED at rest (#1209), so this returns the raw plaintext EXACTLY
// ONCE — the client reveal-once panel shows it, and it can never be re-displayed
// (rotate mints a fresh one, invalidating the old value). The optional `expiry`
// (issue #24) sets a mint-time expiry; anything but the three known choices falls
// back to "never". Called directly by the client panel (not as a form action) so it
// can return the value.
export async function connectHealthConnect(
  expiry?: string
): Promise<HealthConnectTokenResult> {
  const { profile, login } = await requireWriteAccess();
  const choice = isValidExpiryChoice(expiry) ? expiry : "never";
  const token = generateHealthConnectToken(profile.id, choice);
  // Covers both first mint and rotation (minting replaces any prior token).
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenMint,
    target: "health-connect",
    detail: `expiry:${choice}`,
  });
  revalidateRoute("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidateRoute("/data");
  return { ok: true, token };
}

// Disconnect: clear the token and status. The endpoint then rejects all requests.
export async function disconnect(): Promise<{ ok: true }> {
  const { profile, login } = await requireWriteAccess();
  disconnectHealthConnect(profile.id);
  recordAudit({
    loginId: login.id,
    profileId: profile.id,
    action: AUDIT_ACTIONS.tokenRevoke,
    target: "health-connect",
  });
  revalidateRoute("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidateRoute("/data");
  return { ok: true };
}
