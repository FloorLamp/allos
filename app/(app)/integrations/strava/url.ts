// Strava's callback address. Base-URL resolution, in-app URL construction and
// loopback detection are NOT provider-specific — they live in
// lib/external-url.ts and lib/external-url-server.ts, shared with Withings,
// Health Connect and the calendar feed (#2959). What IS provider-specific is the
// path below, which must match the Authorization Callback Domain registered in
// the Strava app settings.
import { appUrl } from "@/lib/external-url-server";

export const STRAVA_CALLBACK_PATH = "/api/integrations/strava/callback";

export async function stravaCallbackUrl(): Promise<string> {
  return appUrl(STRAVA_CALLBACK_PATH);
}
