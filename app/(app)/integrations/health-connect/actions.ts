"use server";
import { requireSession } from "@/lib/auth";

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
  const { profile } = requireSession();
  const raw = formData?.get("expiry");
  const expiry = isValidExpiryChoice(raw) ? raw : "never";
  generateHealthConnectToken(profile.id, expiry);
  revalidatePath("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}

// Disconnect: clear the token and status. The endpoint then rejects all requests.
export async function disconnect() {
  const { profile } = requireSession();
  disconnectHealthConnect(profile.id);
  revalidatePath("/integrations/health-connect");
  // The connect-card grid (status) now lives on the Data hub's Import tab.
  revalidatePath("/data");
}
