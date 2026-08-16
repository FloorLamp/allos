// Withings' callback address. Base-URL resolution, in-app URL construction and
// loopback detection are NOT provider-specific — they live in
// lib/external-url.ts and lib/external-url-server.ts, shared with Strava, Health
// Connect and the calendar feed (#2959). What IS provider-specific is the path
// below, which must match the callback URL registered in the Withings developer
// app.
import { appUrl } from "@/lib/external-url-server";

export const WITHINGS_CALLBACK_PATH = "/api/integrations/withings/callback";

export async function withingsCallbackUrl(): Promise<string> {
  return appUrl(WITHINGS_CALLBACK_PATH);
}
