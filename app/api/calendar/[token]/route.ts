import { today } from "@/lib/db";
import {
  resolveProfileByCalendarToken,
  getCalendarFeed,
  getTimezone,
} from "@/lib/settings";
import { getAppointments } from "@/lib/queries";
import {
  buildAppointmentIcs,
  appointmentToIcsEvent,
  selectFeedAppointments,
} from "@/lib/calendar-ics";
import { checkRateLimit } from "@/lib/rate-limit";

// A subscribed calendar client refetches on the order of hours; 30 requests/min
// per token is far above legitimate use while capping a client (or scraper)
// hammering this token-authed, PHI-bearing feed.
const CALENDAR_RATE_LIMIT = 30;
const CALENDAR_RATE_WINDOW_MS = 60 * 1000;

// Token-authenticated, PUBLIC (session-free) calendar subscribe feed. A calendar
// client (Google/Apple/Outlook) fetches this `.ics` URL on a schedule; the secret
// token in the path — NOT a session — identifies whose appointments to return.
// The token is re-resolved to a single profile id and every read below is scoped
// to THAT profile, so the feed can never surface another profile's data. Any bad,
// revoked, or disabled token yields a uniform 404 that reveals nothing (and the
// token itself is never logged). The route path is allow-listed in middleware.ts.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { token: string } }
) {
  // The token may be presented as "<token>" or "<token>.ics" (calendar clients
  // key off the extension) — strip a trailing .ics before resolving.
  const raw = params.token.replace(/\.ics$/i, "");

  // Rate-limit on the presented token before resolving it, so a flood of bad
  // tokens can't hammer the lookup either.
  const rl = checkRateLimit(`calendar:${raw}`, {
    limit: CALENDAR_RATE_LIMIT,
    windowMs: CALENDAR_RATE_WINDOW_MS,
  });
  if (!rl.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });
  }

  const profileId = resolveProfileByCalendarToken(raw);
  if (profileId === null) {
    return new Response("Not found", { status: 404 });
  }

  const { detail } = getCalendarFeed(profileId);
  const tz = getTimezone(profileId);
  const todayStr = today(profileId);

  // Profile-scoped read; the pure selector drops history and bounds the window.
  const appts = selectFeedAppointments(getAppointments(profileId), {
    today: todayStr,
  });
  const events = appts.map((a) => appointmentToIcsEvent(a, { tz, detail }));
  const ics = buildAppointmentIcs(events, { dtstamp: new Date() });

  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="allos-appointments.ics"',
      // Short cache: a subscribed client refetches periodically; keep it fresh
      // enough that a new/changed appointment shows up soon, but private so no
      // shared proxy stores this token-authed, PHI-bearing response.
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
