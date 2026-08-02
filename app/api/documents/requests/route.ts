import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { authenticateApiToken } from "@/lib/api-tokens";
import { apiTokenRateLimitKey } from "@/lib/api-token-format";
import { buildSyncRequestList } from "@/lib/acquirer-identity";
import { openSyncRequestsForProfiles } from "@/lib/portal-requests";
import { checkRateLimit } from "@/lib/rate-limit";

// THE OPEN SYNC REQUESTS A TOOL MAY VOLUNTEER FOR (issue #1889).
//
// ── THE LINE THIS CROSSES, AND WHY IT MOVED ──────────────────────────────────
//
// The sync-request design said, in as many words, that the tool never learns requests
// exist: the row just watches for the report the contract already sends. That line was
// load-bearing when a portal run NEEDED a person — two-factor codes, sessions that idle
// out in minutes — because a request could then only ever reach a person, and anything
// the tool could read would be a schedule allos cannot honour.
//
// Unattended runs changed the PREMISE, not the principle. A portal whose browser profile
// holds the password and the device-trust cookie signs itself in headless, collects, and
// pushes, with nobody at the keyboard. For those logins a request could be the thing that
// actually STARTS the run — and the payoff is the whole reason to bother: a `post-visit`
// request fires the moment new records appear, and a fixed daily schedule collects them
// the following morning at best.
//
// EVERYTHING THE LINE PROTECTED IS PRESERVED, deliberately and completely:
//
//   SLUGS ONLY, NEVER AN ADDRESS. Allos has no address column anywhere (migration 128),
//   and the payload shape is fixed by the pure `buildSyncRequestList` builder — portal
//   slug, account slug, reason, expiry day, and nothing else. No URL, no hostname, no
//   credential hint, and no account NICKNAME either: "Mom" is household composition.
//
//   NO CLAIM STATE, NO ACKNOWLEDGMENT, NO PUSH CHANNEL. This is a pull-only volunteer
//   list. There is no write path here, nothing to claim, nothing to release, and no
//   cleanup burden — a client that never calls it is unaffected, and a client that calls
//   it forever creates no rows.
//
//   THE PERSON STILL GETS ASKED. Requests continue to reach a household through Upcoming
//   and the morning digest, unchanged. The machine only volunteers for the subset it can
//   actually do.
//
// THE POLL/RUN RACE IS HARMLESS, and the client needs no coordination for it. A request
// this endpoint listed may be answered by somebody else between the poll and the run —
// and then the run's own report closes it exactly as it does today, while a double
// collection lands as `covered`/dedup on the upload path. The idempotence a client already
// has is the whole protocol.
//
// ── AUTH: THE `held` ENDPOINT'S, APPLIED TO A LIST ───────────────────────────
//
// Same `upload:documents` scope, same rate-limit-before-scrypt-verify posture in its own
// key namespace, same demo refusal, and the same WRITE-SET scoping: `held` answers only
// for a profile the token could write, so this lists only requests whose portal login
// covers at least one profile the token could write. A token that could not file a single
// document from that run has no business being told the run is wanted. Reach is checked
// FIRST and access second, the order every route here uses — accessForProfile assumes
// reachability and must never be consulted alone.
//
// A read-only-everywhere caregiver therefore gets an empty list rather than a 403: unlike
// the registry endpoint (#1759), where the gate is the CAPABILITY to know the vocabulary
// at all, this answer is a per-account intersection that is simply empty for them. A
// demo-restricted token is refused outright, exactly as it would be at an upload.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A scheduled pass polls this before deciding what to run — a handful of calls an hour at
// most. Generous, still capped, in its own namespace so it cannot consume the upload
// budget.
const REQUESTS_RATE_LIMIT = 120;
const REQUESTS_RATE_WINDOW_MS = 5 * 60 * 1000;

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(req: Request): Promise<Response> {
  const limit = checkRateLimit(
    `requests:${apiTokenRateLimitKey(req.headers.get("authorization"))}`,
    { limit: REQUESTS_RATE_LIMIT, windowMs: REQUESTS_RATE_WINDOW_MS }
  );
  if (!limit.ok) {
    return Response.json(
      { ok: false, error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const auth = await authenticateApiToken(req, "upload:documents");
  if (!auth.ok) return jsonError(auth.error, auth.status);
  const { login } = auth;

  if (isDemoRestricted(isDemoMode(), login.role)) {
    return jsonError("no write access to any profile", 403);
  }

  // The token's WRITE set, resolved here at the auth boundary and handed to the reader as
  // already-authorized ids — the cross-profile reader convention. Reach first, then
  // access.
  const writable = accessibleProfilesForLogin(login.id)
    .filter((p) => accessForProfile(login.id, login.role, p.id) === "write")
    .map((p) => p.id);

  // Open AND unexpired is what `openSyncRequests` means — the one definition every
  // surface reads (lib/sync-requests.ts: isSyncRequestOpen), so this endpoint cannot
  // disagree with the household's own Upcoming about which asks are live.
  return Response.json({
    ok: true,
    requests: buildSyncRequestList(openSyncRequestsForProfiles(writable)),
  });
}
