// PURE classification of an OAuth / token-refresh failure (issue #326). Kept free
// of any `@/lib/db` import so it lives in the pure unit tier (lib/__tests__) — the
// impure state transition (markConnectionNeedsReauth) lives in connections.ts.
//
// The question every refresh path asks on a non-OK response: is this a DEFINITIVE
// auth failure — the refresh token / grant is dead or revoked and the user must
// re-connect — or a TRANSIENT one (network blip, 429 rate-limit, source 5xx) that
// will clear on its own and should just be retried on the next hourly tick? Only a
// definitive auth failure may flip a connection out of `connected`; a transient one
// must NOT, or a passing cloud hiccup would tear down a healthy connection.
//
// The signal differs across sources even though both end in the same transition:
//   • Strava returns a structured Fault over HTTP 400, or an HTTP 401.
//   • Withings rides an error in its `{ status, body }` envelope (HTTP 200), so the
//     caller passes the ENVELOPE status here, where 401 means the token was rejected.
//   • Oura's personal access token has no refresh, so it never reaches this door: the
//     DATA-PULL rule is `isAuthPullFailure` below. The two are deliberately different
//     and live side by side here so a reader meets both at once — and so the guard that
//     pins where they disagree (lib/__tests__/auth-failure.test.ts) can read the real
//     rule rather than a copy of it.

// True when a token-refresh (or Withings envelope) status is a definitive auth
// failure requiring re-connection. A 401 is always one. A Strava 400 is one ONLY
// when its structured Fault names the rejected refresh token; every Withings HTTP
// 400 and everything else — 429, 5xx, and status 0 — is transient.
//
// `body` IS REQUIRED, AND A BODYLESS 400 IS TRANSIENT (#3798). This predicate used
// to default `body == null || body === "" ⇒ dead grant`, so an HTTP 400 carrying no
// body — what a CDN or gateway artifact in front of a token endpoint looks like —
// read as a revoked grant. That matters most for Withings, which answers 200 with a
// status envelope, so an *HTTP* 400 there is almost always infrastructure. Since
// #3618 the verdict is a sentence telling the person their connection expired and to
// reconnect, and `pull-tick.ts` then stops syncing a non-`connected` source at all —
// so guessing wrong now issues a false instruction and halts a healthy sync. The
// evidence for "revoked" has to BE evidence, not the absence of any. Required rather
// than defaulted because the defect was a call site that inherited the default while
// holding a body it never passed: there is no default left to inherit, and the
// caller with no body in its space (Withings' vendor envelope) says `null` out loud.
type AuthRefreshProvider = "strava" | "withings";

export function isAuthRefreshFailure(
  provider: AuthRefreshProvider,
  status: number,
  body: string | null
): boolean {
  if (status === 401) return true;
  if (status !== 400 || provider !== "strava") return false;
  if (body == null || body === "") return false;

  // Strava documents revoked tokens and its structured Fault/Error response model:
  // https://developers.strava.com/docs/authentication/
  // https://developers.strava.com/docs/reference/#api-models-Fault
  // A captured dead-refresh-token response uses this exact Error triple. Parsing the
  // Fault keeps arbitrary HTML/prose (including "Unauthorized") out of the verdict.
  let fault: unknown;
  try {
    fault = JSON.parse(body);
  } catch {
    return false;
  }
  if (!fault || typeof fault !== "object") return false;
  const errors = (fault as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (error) =>
      error !== null &&
      typeof error === "object" &&
      (error as { resource?: unknown }).resource === "RefreshToken" &&
      (error as { field?: unknown }).field === "refresh_token" &&
      (error as { code?: unknown }).code === "invalid"
  );
}

// THE OTHER DOOR: 401 AND NOTHING ELSE on a data pull (#3618).
//
// It used to ask `isAuthRefreshFailure`, and the difference between the two rules is the
// whole reason this one exists separately. At a TOKEN endpoint the grant IS the request,
// so a 400 naming the grant is a revocation; at a DATA endpoint a 400 is a bad
// parameter, and #3007 is this repo's own measurement of one answering 400 for an
// out-of-range window. Flipping needs_reauth on that was not a copy defect: `pull-tick`
// auto-syncs `connected` rows only, so one malformed request stopped the source
// permanently.
//
// IT LIVES HERE RATHER THAN INLINE IN `pull-sync.ts`, and that is the point of the
// export. The rule was a bare `outcome.status === 401` at its call site, so the guard
// asserting the two doors disagree on exactly one input had to SPELL the pull rule
// itself — pinning one rule against a copy of the other, which cannot notice this door
// changing. `pull-sync.ts` imports the db; this module deliberately does not, which is
// also what keeps the guard in the pure tier.
export function isAuthPullFailure(status: number | undefined): boolean {
  return status === 401;
}

// ---- What the person reads when a sync fails (#3618) ------------------------

// The three things a broken sync can be, FROM THE PERSON'S SIDE. It is not a
// taxonomy of statuses: it is a taxonomy of what there is to do, which is why
// `reconnect` is not derivable from a status at all (see below).
export type SyncFailureKind = "reconnect" | "transient" | "unknown";

// WHERE a number came from, because the two spaces collide. Withings answers over
// HTTP 200 with its own code in the envelope, and its 503 is "Action parameters are
// incorrect" — a deterministic client error sitting exactly where HTTP puts
// "service unavailable". Nothing generic can know which numbers in one company's
// table will clear on their own, so a vendor code is never read as transient.
export type StatusOrigin = "http" | "vendor";

// What a failing STATUS means. Transient is exactly {0, 429, [500,600)}: it said
// "slow down", it broke on its own side, or there was no HTTP response at all (the
// status-0 sentinel a network error/timeout maps to). The upper bound is closed
// because an unbounded `>= 500` swept up Withings' four-digit envelope codes.
//
// IT NEVER RETURNS `reconnect`, AND THAT IS THE POINT. A dead grant is a fact about
// the CONNECTION, not about a status: only the paths that call
// `markConnectionNeedsReauth` know it, and only ONE of the three pull gathers
// (Oura's) reports a status to the runner at all. A status-keyed guess wrote "Reconnect Strava" onto
// a row still marked `connected`, whose setup page gates its reconnect affordance on
// `needsReauth && !connected` — so the app asked for something it was hiding. The
// runner reads the row instead, AFTER the transition.
export function syncFailureKind(
  status: number,
  origin: StatusOrigin = "http"
): SyncFailureKind {
  if (origin !== "http") return "unknown";
  const transient =
    status === 0 || status === 429 || (status >= 500 && status < 600);
  return transient ? "transient" : "unknown";
}

// THE ONE AUTHOR of every sentence a failed sync shows a person. The integration
// card, the "Sync now" toast and the morning digest all render
// `integration_sync_events.error` verbatim, and it used to hold the wire —
// `Oura /v2/usercollection/sleep request failed (401)`. Each source keeps the path
// and the status in its own log.error, the only reader they were any use to.
//
// Every sentence NAMES THE SOURCE because the toast is global (Toast, not a card
// slot) and a digest line is read on a phone: none of these can borrow their subject
// from what happens to be next to them.
export function syncFailureCopy(
  sourceName: string,
  kind: SyncFailureKind
): string {
  switch (kind) {
    case "reconnect":
      return `Reconnect ${sourceName} to resume syncing.`;
    case "transient":
      // NO "the next sync will try again" (#3007's lesson, second-hand). This
      // sentence only reaches the card and the digest once a source has failed
      // continuously past its multi-day silence tolerance — by which point the
      // promise has been falsified once an hour for days. Saying whose problem it
      // is was the whole of what a person could use anyway.
      return `${sourceName} is having trouble.`;
    case "unknown":
      // No retry advice for a failure nobody has classified (copy.md rule 1).
      return `Couldn't sync ${sourceName}.`;
  }
}
