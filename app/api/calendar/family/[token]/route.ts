import { today } from "@/lib/db";
import {
  resolveLoginByConsolidatedCalendarToken,
  getCalendarFeed,
  getTimezone,
} from "@/lib/settings";
import { accessibleProfilesForLogin } from "@/lib/auth";
import { getAppointments } from "@/lib/queries";
import {
  buildAppointmentIcs,
  selectConsolidatedFeedEvents,
  type ConsolidatedProfileFeed,
} from "@/lib/calendar-ics";
import { checkRateLimit } from "@/lib/rate-limit";

// Token-authenticated, PUBLIC (session-free) CONSOLIDATED calendar subscribe feed:
// one ".ics" spanning every profile the token's LOGIN can currently access (the
// "family calendar"). The secret token in the path identifies the LOGIN — not a
// session — and the set of profiles is re-resolved from LIVE grants on every
// request (accessibleProfilesForLogin), so a revoked grant stops appearing at once
// and a deleted login's token (cascaded away with login_settings) 404s. Each
// profile's OWN detail level + timezone are honored, and every read is profile-
// scoped (getAppointments per profile). A sibling of the per-profile feed route
// rather than an overload of it: the per-profile route (app/api/calendar/[token])
// stays literally untouched, the two token kinds never share a lookup, and the
// two-segment path (/api/calendar/family/<token>) can't collide with the one-
// segment per-profile path. Both are covered by the same "/api/calendar/" middleware
// allowlist. Any bad/revoked/expired token yields a uniform 404 (token never logged).
export const dynamic = "force-dynamic";

// Same envelope as the per-profile feed: a subscribed client refetches on the order
// of hours; 30 req/min per token far exceeds legitimate use while capping abuse.
const CALENDAR_RATE_LIMIT = 30;
const CALENDAR_RATE_WINDOW_MS = 60 * 1000;

export async function GET(
  _req: Request,
  { params }: { params: { token: string } }
) {
  // Accept "<token>" or "<token>.ics" (calendar clients key off the extension).
  const raw = params.token.replace(/\.ics$/i, "");

  // Rate-limit on the presented token before resolving it, so a flood of bad
  // tokens can't hammer the lookup either. Distinct bucket from the per-profile feed.
  const rl = checkRateLimit(`calendar-family:${raw}`, {
    limit: CALENDAR_RATE_LIMIT,
    windowMs: CALENDAR_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });
  }

  const loginId = resolveLoginByConsolidatedCalendarToken(raw);
  if (loginId === null) {
    return new Response("Not found", { status: 404 });
  }

  // Access control at REQUEST TIME: the login's live grants decide which profiles
  // are in the feed (a since-revoked grant is gone; an admin sees every profile).
  const profiles = accessibleProfilesForLogin(loginId);
  const feeds: ConsolidatedProfileFeed[] = profiles.map((p) => ({
    profileId: p.id,
    profileName: p.name,
    // Each profile's OWN detail level + timezone + day boundary — a minimal profile
    // stays minimal even inside the shared feed. Reads are profile-scoped.
    detail: getCalendarFeed(p.id).detail,
    tz: getTimezone(p.id),
    today: today(p.id),
    appts: getAppointments(p.id),
  }));

  const events = selectConsolidatedFeedEvents(feeds);
  const ics = buildAppointmentIcs(events, {
    dtstamp: new Date(),
    prodId: "-//Allos//Family Appointments//EN",
  });

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="allos-family-appointments.ics"',
      // Short, private cache: token-authed and PHI-bearing, so no shared proxy may
      // store it, but a subscribed client can still refetch cheaply.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
