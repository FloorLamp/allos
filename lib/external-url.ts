// The app's EXTERNALLY VISIBLE address — the one an OAuth provider redirects a
// browser back to, and the one a calendar client has to be able to reach (#2959).
//
// This was implemented four times (the calendar-feed and Health Connect pages,
// and the Strava and Withings url helpers), identically, which is the wrong
// number for a deployment-sensitive decision: proxy headers, callback hosts and
// loopback refusal have one right answer per deployment, and four copies is four
// places to get it wrong the next time a proxy header changes.
//
// PURE ON PURPOSE — no `next/headers`, no DB. The header lookup arrives as a
// function, so the rules are unit-testable without a request and a CLIENT
// component can import `absoluteUrl`/`isLoopbackUrl` from here without dragging
// a server-only dependency into the browser bundle. The request-bound wrapper
// lives in lib/external-url-server.ts.

// Reads one request header by lowercase name, or null.
export type HeaderLookup = (name: string) => string | null | undefined;

// The host to assume when the request carries no host at all — a background
// tick, or a test. Loopback, so `isLoopbackUrl` catches it rather than the app
// inventing a public-looking address it has no evidence for.
const FALLBACK_HOST = "localhost:3000";

// Configured public URL (Settings → Public app URL) wins outright: an admin who
// set it knows the address better than any header does. Otherwise derive it from
// the request — behind a reverse proxy `x-forwarded-*` carry the real host and
// scheme, while the bare `host` is the internal target.
//
// The scheme defaults to https when the proxy did not say, because a host that is
// not loopback is a real deployment; plain localhost stays http so a developer's
// browser is not sent to a TLS port nothing is listening on.
export function resolveExternalBaseUrl(
  configured: string | null | undefined,
  header: HeaderLookup
): string {
  if (configured) return configured;
  const host = header("x-forwarded-host") ?? header("host") ?? FALLBACK_HOST;
  const proto =
    header("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// Join an in-app path onto a base. Tolerates a path given with or without its
// leading slash so callers can pass a route constant either way.
export function joinUrl(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

// The CLIENT-side form: the server passes the base down as a prop, and an empty
// one falls back to the origin the browser actually loaded. Kept beside its
// server twin so the two cannot drift, and guarded for the SSR pass where the
// component renders before `window` exists.
export function absoluteUrl(base: string, path: string): string {
  const b =
    base || (typeof window !== "undefined" ? window.location.origin : "");
  return joinUrl(b, path);
}

// A callback URL is unusable for OAuth if it resolves to loopback — the provider
// would send the browser back to the user's own machine. Happens when no public
// URL is configured and the request host is localhost (e.g. a reverse proxy that
// does not forward the real host). Detected up-front so we can tell the admin to
// set the Public app URL rather than handing a provider an unreachable
// redirect_uri.
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
