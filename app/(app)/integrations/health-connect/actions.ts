"use server";
import { requireSession } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import {
  generateHealthConnectToken,
  disconnectHealthConnect,
} from "@/lib/integrations/connections";

// Generate (or rotate) the ingest token and mark the integration connected.
export async function connectHealthConnect() {
  const { profile } = requireSession();
  generateHealthConnectToken(profile.id);
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
