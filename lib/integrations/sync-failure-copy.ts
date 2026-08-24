import {
  houseErrorSentence,
  type UserErrorContext,
} from "@/lib/user-error-copy";

// A FAILING RESPONSE STATUS IN, HOUSE COPY OUT (#3618).
//
// The sibling of lib/user-error-copy.ts, one axis over. That module translates a
// CAUGHT error — text minted at runtime by code that never considered a reader
// (#3198, #3592). This one translates an AUTHORED line: a source's page loop met a
// non-OK response and wrote the status into a sentence a person reads.
//
//     Oura /v2/usercollection/sleep request failed (401)
//     Withings /measure request failed (401)
//     weather fetch failed (503)
//
// Those three rendered on the integration card, in the "Sync now" toast and in the
// morning digest. Every one of them names an HTTP path, an HTTP status or a vendor
// error number, and none of it is something a person can act on. What they most
// often mean — the connection's token died — has an obvious answer the line never
// gave: reconnect.
//
// THE VOCABULARY IS KEYED ON WHAT THE STATUS MEANS, and the meaning is read from the
// status itself rather than from a source name hard-coded at a call site, so a fifth
// source inherits it by calling this.
//
// WHERE THE RECONNECT SENTENCE COMES FROM, and why it is not here: a status alone
// cannot answer "does this source even have a connection to re-authorize?" — keyless
// Open-Meteo answers 400 for a bad parameter and has no connection at all. So the
// reconnect line is chosen by lib/integrations/pull-sync.ts from the connection's
// OWN RECORDED STATE (`needs_reauth`), in the same failure exit that put it there.
// That is the same state every reconnect affordance already keys on — the notice on
// each source page, and ConnectedSources' "Reconnect <name> →" link — so the
// sentence cannot tell a person to reach for a control the app never rendered.
//
// PURE (no db, no fs, no clock).

// `upstream` — asking again may well work, and the hourly tick will. The other end
//              did not answer, answered that it was broken, or answered "not now".
// `refused`  — the request itself was rejected and will be rejected the same way
//              next time (#3007's `isDeterministicFailure` reads the same split).
//              Nothing for a person to do, so no retry advice is offered.
export type SyncFailureFamily = "upstream" | "refused";

// THE QUESTION IS "WILL ASKING AGAIN HELP?", not "was the status a 4xx?". Those two
// coincide for most of the range and part company at exactly two codes:
//
//   • 429 Too Many Requests and 408 Request Timeout are the other end saying "not
//     now" — the next hourly tick fixes them by itself. Reading them off the 4xx
//     boundary told a person there was nothing to try over a rate limit, which is
//     the opposite of what a rate limit means. Oura/Strava/Withings never reach here
//     with a 429 (pageOutcome truncates first) but Open-Meteo's hourly fetch has no
//     rate-limit truncate and does, and it is the half whose failure IS the run's.
//
// Status 0 is every pull source's marker for "the request THREW — there was no HTTP
// response at all". A NEGATIVE status is Withings' marker for an envelope this app
// could not read a status out of at all (a gateway's HTML page in place of the JSON).
// Both group with 5xx: nobody was refused anything, and a retry is the right advice.
export function syncFailureFamily(status: number): SyncFailureFamily {
  if (status === 429 || status === 408) return "upstream";
  return status <= 0 || status >= 500 ? "upstream" : "refused";
}

// WHICH STATUS DIALECT a caller is spending. HTTP is the default; `vendor` is for a
// source that rides its own error codes inside a body served over HTTP 200 —
// Withings' `{status, body}` envelope (601 over-quota, 2554/2555/2556 "unknown
// error, try again"), which is the only one today.
//
// It exists because ONE sentence in the bank makes a claim only the HTTP dialect can
// support. `upstream` with a service name reads "Couldn't reach Withings." — and for
// every code in this dialect we DID reach Withings; they answered HTTP 200 and put a
// number in the payload. The family is still right (2555's own documented advice is
// to try again, and an unparseable envelope is worth retrying); it is the "reach"
// that is false. So the vendor dialect spends the same family's SERVICE-LESS
// sentence — "Couldn't sync your Withings data. Try again." — which is true either
// way. `refused` needs no such care: it never names the third party.
export type StatusDialect = "http" | "vendor";

// The house sentence for a source that answered a failing status. Takes the same
// context `userErrorCopy` takes, so a source declares its verb phrase and its
// third-party name ONCE and both its throw branch and its status branch spend it.
export function syncFailureCopy(
  status: number,
  ctx: UserErrorContext,
  dialect: StatusDialect = "http"
): string {
  // `refused` spends the bank's no-advice sentence rather than its `write` one. A
  // 4xx on a pull IS usually our request being wrong, and "It's a bug on our side."
  // would be the kinder line — but this classifier reads two status dialects and a
  // 403 is a missing grant rather than a bug, so it would be asserting a cause it
  // cannot know. What it CAN say honestly is that there is nothing to try again.
  if (syncFailureFamily(status) !== "upstream") {
    return houseErrorSentence("unknown", ctx);
  }
  // The one place the dialect matters (see StatusDialect): a vendor code arrived
  // over a 200, so the sentence must not claim we failed to reach anyone. Dropping
  // `service` falls through to the same family's verb-phrase sentence, which keeps
  // the retry advice and drops only the claim.
  return houseErrorSentence(
    "upstream",
    dialect === "vendor" ? { doing: ctx.doing } : ctx
  );
}

// The line for a connection this app has recorded as `needs_reauth`. Two sentences:
// the state, then the one next step — and the step matches an affordance actually on
// screen (copy.md rule 4), because the same `needs_reauth` that licenses this
// sentence is what renders "Reconnect <name> →" beside it.
//
// The second sentence is lib/attention.ts's own fallback for a broken integration,
// reused verbatim rather than re-minted: that surface and this one describe the same
// state and must not describe it in two voices.
export function reconnectCopy(name: string): string {
  return `Your ${name} connection expired. Reconnect to resume syncing.`;
}
