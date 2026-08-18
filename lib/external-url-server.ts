import "server-only";
import { headers } from "next/headers";
import { getPublicUrl } from "./settings";
import { joinUrl, resolveExternalBaseUrl } from "./external-url";

// The request-bound half of lib/external-url.ts (#2959): pulls the configured
// public URL and the request headers, and hands both to the pure resolver.
//
// `server-only` is the point of the split. Client components need `absoluteUrl`
// and `isLoopbackUrl` from the pure module, and importing `next/headers` into
// their bundle is a build error rather than a subtle one — so the impure edge is
// isolated here and the rules stay testable without a request.

// The app's externally visible base URL for THIS request. The single authority:
// the calendar feed, Health Connect, Strava and Withings all resolve it here, so
// a proxy-header change is one edit rather than four.
//
// The early return is BEHAVIOUR, not an optimization. All four helpers this
// replaced returned before touching `headers()`, so with a public URL configured
// they worked with NO request context at all — from a background tick, a
// notification job, a CLI. `headers()` throws outside a request scope, so
// awaiting it unconditionally would have quietly narrowed where
// `stravaCallbackUrl()` and `withingsCallbackUrl()` can be called. The pure
// resolver holds the same "configured wins" rule; this is about not REQUIRING a
// request in order to reach it.
export async function externalBaseUrl(): Promise<string> {
  const configured = getPublicUrl();
  if (configured) return configured;
  const h = await headers();
  return resolveExternalBaseUrl(configured, (name) => h.get(name));
}

// An absolute URL to an in-app path, off the externally visible base.
//
// An OAuth callback route MUST redirect through this rather than
// `new URL(path, req.url)`: behind a reverse proxy `req.url`'s host is the
// internal target (localhost:3000), so a redirect built from it bounces the
// browser to the user's own machine.
export async function appUrl(path: string): Promise<string> {
  return joinUrl(await externalBaseUrl(), path);
}
