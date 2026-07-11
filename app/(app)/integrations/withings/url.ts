import { headers } from "next/headers";
import { getPublicUrl } from "@/lib/settings";

// The app's externally-visible base URL: the configured public URL (Settings →
// Public app URL) when set, else derived from the request headers (behind a reverse
// proxy, x-forwarded-* carry the real host/proto). Same logic as the Strava config
// page. Used to build the OAuth redirect_uri, which must match the callback URL
// registered in the Withings developer app.
export async function baseUrl(): Promise<string> {
  const configured = getPublicUrl();
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const WITHINGS_CALLBACK_PATH = "/api/integrations/withings/callback";

export async function withingsCallbackUrl(): Promise<string> {
  return `${await baseUrl()}${WITHINGS_CALLBACK_PATH}`;
}

// Build an absolute URL to an in-app path off the externally-visible base URL. The
// OAuth callback route MUST redirect through this rather than `new URL(path, req.url)`:
// behind a reverse proxy, `req.url`'s host is the internal target (localhost:3000), so
// a redirect built from it bounces the browser to localhost.
export async function appUrl(path: string): Promise<string> {
  return `${await baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

// A callback URL is unusable for OAuth if it resolves to loopback — Withings would
// send the browser back to the user's own machine. Happens when no public URL is
// configured and the request host is localhost (e.g. a reverse proxy that doesn't
// forward the real host). Detected up-front so we can tell the admin to set the
// Public app URL instead of handing Withings an unreachable redirect_uri.
export function isLoopbackUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}
