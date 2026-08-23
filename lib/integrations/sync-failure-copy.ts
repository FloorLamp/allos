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
// cannot answer "does this source even have a connection to re-authorize?".
// `isAuthRefreshFailure(400)` is TRUE with no body — correct for a token refresh,
// and wrong for keyless Open-Meteo, which answers 400 for a bad parameter. So the
// reconnect line is chosen by lib/integrations/pull-sync.ts from the connection's
// OWN RECORDED STATE (`needs_reauth`), in the same failure exit that put it there.
// That is the same state every reconnect affordance already keys on — the notice on
// each source page, and ConnectedSources' "Reconnect <name> →" link — so the
// sentence cannot tell a person to reach for a control the app never rendered.
//
// PURE (no db, no fs, no clock).

// `upstream` — the other end did not answer, or answered that it was broken. Asking
//              again may well work, and the hourly tick will.
// `refused`  — the request itself was rejected and will be rejected the same way
//              next time (#3007's `isDeterministicFailure` reads the same split).
//              Nothing for a person to do, so no retry advice is offered.
export type SyncFailureFamily = "upstream" | "refused";

// Status 0 is every pull source's marker for "the request THREW — there was no HTTP
// response at all". It groups with 5xx because it is the same thing to a reader.
//
// This runs over TWO STATUS DIALECTS: HTTP codes, and Withings' `{status, body}`
// envelope, whose codes are its own (601 over-quota, 2555 "unknown error, try
// again"). The split is chosen to be true in both — a Withings 2555 lands in
// `upstream` and its documented advice IS to try again — and to fail toward the
// branch that promises less.
export function syncFailureFamily(status: number): SyncFailureFamily {
  return status === 0 || status >= 500 ? "upstream" : "refused";
}

// The house sentence for a source that answered a failing status. Takes the same
// context `userErrorCopy` takes, so a source declares its verb phrase and its
// third-party name ONCE and both its throw branch and its status branch spend it.
export function syncFailureCopy(
  status: number,
  ctx: UserErrorContext
): string {
  // `refused` spends the bank's no-advice sentence rather than its `write` one. A
  // 4xx on a pull IS usually our request being wrong, and "It's a bug on our side."
  // would be the kinder line — but this classifier reads two status dialects and a
  // 403 is a missing grant rather than a bug, so it would be asserting a cause it
  // cannot know. What it CAN say honestly is that there is nothing to try again.
  return houseErrorSentence(
    syncFailureFamily(status) === "upstream" ? "upstream" : "unknown",
    ctx
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
