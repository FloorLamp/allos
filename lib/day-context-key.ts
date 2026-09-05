// WHICH SUBJECT, WHICH DAY, AT WHAT REACH — the one identity a day context has.
//
// Two pieces of work need this value and neither owns it: the day-context provider
// (#5211) uses it to decide what a consumer may offer, and the offline layer (#3416)
// keys last-good data and in-flight results by it. Two spellings of one identity is
// how a delayed today response populates a yesterday form, which is the failure #3416
// is being asked to prevent — so the identity is named once, here, and both sides
// import it rather than inventing a spelling apiece.
//
// THE CONTRACT THIS SERVES IS PROPOSED AND UNANSWERED. #5211's 2026-09-05 comment puts
// four clauses to the #3416 lane; nothing has answered yet. This module deliberately
// carries only the first — no provider, no context, no React, no state — so amending
// the rest costs one file and blocks nobody in the meantime.
import type { TapReach } from "./log-manifest";

// The reach vocabulary is the manifest's, re-exported under its own name rather than
// restated: `TapReach` is declared once, beside `TAP_REACH`, and a consumer that is not
// a core reaches it here with the key it travels with. Add reach kinds there, never
// here — a second `bounded` is the drift this re-export exists to prevent.
export type { TapReach } from "./log-manifest";

// NUL IS THE SEPARATOR, the composite-key spelling this repo already uses
// (lib/integrations/sync-log.ts, lib/queries/coverage.ts, registered with their reasons
// in lib/__tests__/nul-byte-census.test.ts): no component can carry one, so no value
// can forge a key. Spelled as an escape so this file stays plain text to a default
// grep, which is what that census asks of new code.
const SEP = "\u0000";

/**
 * The triple a day context is: the subject, the profile-local day it stands on, and the
 * reach of the offer that put it there.
 */
export interface DayContextParts {
  /** The data subject — a profile id, never a login. */
  readonly profileId: number;
  /** A profile-local day, `YYYY-MM-DD`. Not an instant. */
  readonly day: string;
  /** How far the mount that selected this day may offer. */
  readonly reach: TapReach;
}

/**
 * A day context's identity. Opaque, only ever compared or used as a lookup key; mint it
 * through `dayContextKey` so there is one spelling.
 */
export type DayContextKey = string & { readonly __dayContext: unique symbol };

// A REACH IS IDENTIFIED BY WHAT IT OFFERS, not by the argument for offering it.
// `TapReach`'s `reason` and `ref` are the declaration's justification — required at the
// declaration, carrying no day — so two mounts offering the same window are the same
// offer. A key that moved when prose was edited would discard every in-flight response
// for a comment change, which is the opposite of what clause 3 asks for.
function reachToken(reach: TapReach): string {
  return reach.kind === "bounded"
    ? `bounded${SEP}${reach.back}${SEP}${reach.forward}`
    : reach.kind;
}

/**
 * The key for a day context. Total — every triple has one — and equal triples produce
 * equal keys, which is the property both consumers rest on.
 *
 * A DERIVED STRING RATHER THAN A STRUCT, because every consumer is a lookup. #3416 keys
 * last-good data and in-flight results by this, and clause 3 asks "was this response
 * issued for the context still on screen"; a struct answers neither without a
 * hand-written comparator, and two structurally equal structs are two different `Map`
 * keys. A string is `===`, and it is the same value in a `Map`, an object field and an
 * IndexedDB key.
 *
 * NO PARSE, deliberately. Whoever holds the key already holds the parts, and a parse
 * would have to invent the `reason` and `ref` the key drops on purpose. A consumer that
 * needs the parts back stores them beside the key rather than reading them out of it.
 */
export function dayContextKey({
  profileId,
  day,
  reach,
}: DayContextParts): DayContextKey {
  return `${profileId}${SEP}${day}${SEP}${reachToken(reach)}` as DayContextKey;
}
