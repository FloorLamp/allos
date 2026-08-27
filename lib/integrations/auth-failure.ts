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
// The signal is the same across sources even though they wrap it differently:
//   • Strava returns the OAuth error over the HTTP status — 400 (invalid_grant on a
//     refresh_token grant) or 401 (Unauthorized).
//   • Withings rides an error in its `{ status, body }` envelope (HTTP 200), so the
//     caller passes the ENVELOPE status here, where 401 means the token was rejected.
//   • Oura's personal access token has no refresh; a revoked token surfaces as a 401
//     on the data pull, passed through here the same way.

// True when a token-refresh (or Oura data-pull) HTTP/envelope status is a definitive
// auth failure requiring re-connection. `body`, when supplied, guards a 400 so a
// one-off malformed-request 400 isn't mistaken for a dead grant — a 400 whose body
// carries an invalid_grant/invalid_token marker (or no body at all) is treated as the
// grant being rejected. A 401 is always an auth failure. Everything else — 429, 5xx,
// and the status-0 sentinel a network error/timeout maps to — is transient.
export function isAuthRefreshFailure(
  status: number,
  body?: string | null
): boolean {
  if (status === 401) return true;
  if (status === 400) {
    if (body == null || body === "") return true;
    // Strava's dead-refresh-token 400 body references the refresh_token by name
    // (…"resource":"RefreshToken","field":"refresh_token","code":"invalid"…) rather
    // than the bare OAuth `invalid_grant`, so match either form. `invalid_scope` and
    // other malformed-request 400s carry none of these markers and stay transient.
    return /invalid[_ ]?grant|invalid[_ ]?token|invalid[_ ]?refresh|refresh[_ ]?token|unauthor/i.test(
      body
    );
  }
  return false;
}

// ---- What the person reads when a source answers with a status (#3618) ------

// A status the source will plausibly answer differently next time: it said "slow
// down" (429), it broke on its own side (5xx), or there was no HTTP response at all
// (the status-0 sentinel a network error/timeout maps to).
//
// BOUNDED AT 600 rather than left open, because this also receives Withings'
// ENVELOPE codes, which are not HTTP statuses and run into four digits: an
// unqualified `>= 500` read 2555 as a server error and promised a retry for
// something nobody had classified.
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 429 || (status >= 500 && status < 600);
}

// The sentence for a failed sync, keyed on WHAT THE STATUS MEANS rather than on the
// number. `Oura /v2/usercollection/sleep request failed (401)` named a path, a status
// and nothing a reader could do; the three branches here are three different asks,
// and collapsing them into one "sync failed" would throw away the half a person can
// act on:
//
//   • a dead grant is a DOOR — the card's Reconnect link and the digest item both
//     lead through it, so the sentence should say so;
//   • a source outage is not the person's problem and invites nothing;
//   • anything else is ours to look at, so it gets no retry advice (copy.md rule 1).
//
// The path and the status are not deleted — each source logs them beside the raw
// cause, which is where whoever debugs this reads.
//
// Keyed on `isAuthRefreshFailure` rather than a second status table, so this sentence
// and `markConnectionNeedsReauth` can never disagree about what a 401 meant.
// `canReconnect` is the caller's answer to "is there anything to reconnect?": a
// keyless source (Open-Meteo) holds no grant, and its bare 400 — which the predicate
// above reads as a rejected grant, correctly, for the token-refresh path it was
// written for — must not send a person hunting for a connect button that does not
// exist.
export function syncFailureCopy(
  sourceName: string,
  status: number,
  canReconnect: boolean
): string {
  if (canReconnect && isAuthRefreshFailure(status)) {
    return `Reconnect ${sourceName} to resume syncing.`;
  }
  if (isTransientStatus(status)) {
    return `${sourceName} is having trouble. The next sync will pick it up.`;
  }
  return `Couldn't sync ${sourceName}.`;
}
