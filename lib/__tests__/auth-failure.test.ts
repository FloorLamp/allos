import { describe, it, expect } from "vitest";
import {
  isAuthPullFailure,
  isAuthRefreshFailure,
  syncFailureCopy,
  syncFailureKind,
} from "@/lib/integrations/auth-failure";

// Issue #326: classify an OAuth/token-refresh failure as a DEFINITIVE auth failure
// (dead/revoked grant → needs re-auth) vs a TRANSIENT one (retry next tick). Only the
// former may tear a connection out of `connected`.
describe("isAuthRefreshFailure", () => {
  // THE REFRESH DOOR'S WHOLE RULE, as (status, body) → verdict. A 401 is definitive
  // whatever the body says; a 400 is definitive ONLY on a body naming the rejected
  // grant; nothing else is. #3798: the bodyless/empty 400 rows used to answer `true`
  // off a default, which is how a CDN artifact in front of a token endpoint told a
  // person their connection had expired.
  it.each([
    // A 401 — the body is irrelevant, including when there is none.
    [401, null, true],
    [401, "", true],
    [401, "anything", true],
    // A 400 whose body names the rejected grant. Strava spells its dead refresh
    // token as a field reference rather than the bare OAuth `invalid_grant`.
    [400, '{"error":"invalid_grant"}', true],
    [400, "invalid grant", true],
    [400, '{"error":"invalid_token"}', true],
    [400, "The refresh_token is invalid", true],
    [400, "Unauthorized", true],
    // A 400 with NO evidence of revocation. The first two are the #3798 defect: a
    // gateway or CDN artifact, which carries no body or an HTML one.
    [400, null, false],
    [400, "", false],
    [400, "<html><head><title>400 Bad Request</title></head></html>", false],
    [400, '{"error":"invalid_scope"}', false],
    [400, "malformed request payload", false],
    // Transient: it said slow down, it broke on its own side, or there was no HTTP
    // response at all (the status-0 sentinel). 601 is Withings' over-quota envelope.
    [429, null, false],
    [500, null, false],
    [503, null, false],
    [0, null, false],
    [601, null, false],
    // Other 4xx are not auth-grant failures.
    [403, null, false],
    [404, null, false],
  ] as const)("%i + %o → %s", (status, body, expected) => {
    expect(isAuthRefreshFailure(status, body)).toBe(expected);
  });

  // WHERE THE TWO DOORS DISAGREE, PINNED SO A FUTURE MERGE OF THEM GOES RED (the
  // 2026-08-21 ruling; #3633 established the shape). It reads BOTH REAL RULES — a
  // data endpoint's 400 is a bad parameter, not a dead grant (#3007), and the refresh
  // rule adds exactly one case on top of that: a 400 whose body names the grant,
  // because at the token endpoint the grant IS the request. That single case is the
  // entire delta, and both bugs this pair guards against are a merge of the two rules
  // in one direction or the other.
  //
  // IT USED TO SPELL THE PULL RULE ITSELF, as a local `status === 401`, which pinned
  // one rule against a COPY of the other and so could not notice the pull door
  // changing underneath it. `isAuthPullFailure` is exported for this.
  it("differs from the data-pull rule on exactly the marker-bearing 400", () => {
    const cases: [number, string | null][] = [
      [400, '{"error":"invalid_grant"}'],
      [400, null],
      [400, ""],
      [400, "<html>400 Bad Request</html>"],
      [401, null],
      [403, null],
      [429, null],
      [500, null],
    ];
    const disagree = cases.filter(
      ([status, body]) =>
        isAuthRefreshFailure(status, body) !== isAuthPullFailure(status)
    );
    expect(disagree).toEqual([[400, '{"error":"invalid_grant"}']]);
  });
});

// Issue #3618: the SENTENCE a failed sync shows, in two halves — what a status
// MEANS, and how that is said. The end-to-end proof that these reach the card, the
// toast and the digest is lib/__db_tests__/sync-failure-copy.
describe("syncFailureKind", () => {
  it.each([
    // An HTTP status: transient is exactly {0, 429, [500,600)}.
    [0, "http", "transient"], // no response at all
    [429, "http", "transient"],
    [500, "http", "transient"],
    [599, "http", "transient"],
    [600, "http", "unknown"], // past the bound
    [601, "http", "unknown"],
    [2555, "http", "unknown"],
    [400, "http", "unknown"],
    [401, "http", "unknown"],
    [403, "http", "unknown"],
    [404, "http", "unknown"],
    // A VENDOR code is never transient, whatever it looks like. Withings' envelope
    // 503 is "Action parameters are incorrect" — deterministic, and sitting exactly
    // where HTTP puts "service unavailable".
    [503, "vendor", "unknown"],
    [0, "vendor", "unknown"],
    [429, "vendor", "unknown"],
    [601, "vendor", "unknown"],
    [250, "vendor", "unknown"],
  ] as const)("%i (%s) → %s", (status, origin, expected) => {
    expect(syncFailureKind(status, origin)).toBe(expected);
  });

  // THE INVARIANT THE DOC ASSERTS, MADE CHECKABLE. A dead grant is a fact about the
  // connection, not about a status — `runPullSync` reads it off the row AFTER the
  // transition. If this classifier could ever answer "reconnect", the app would be
  // able to ask for a reconnect on a row still marked `connected`, whose setup page
  // hides the reconnect affordance behind `needsReauth && !connected`.
  it("never answers reconnect, for any status in either space", () => {
    for (const origin of ["http", "vendor"] as const) {
      for (let status = -1; status <= 700; status++) {
        expect(syncFailureKind(status, origin)).not.toBe("reconnect");
      }
      for (const status of [2555, 601, 250, 342, NaN]) {
        expect(syncFailureKind(status, origin)).not.toBe("reconnect");
      }
    }
  });
});

describe("syncFailureCopy", () => {
  it.each([
    ["reconnect", "Reconnect Oura Ring to resume syncing."],
    // NO retry promise: this line only reaches the card and the digest after days of
    // continuous failure, by which point "the next sync will fix it" has been
    // falsified once an hour throughout (#3007's lesson).
    ["transient", "Oura Ring is having trouble."],
    ["unknown", "Couldn't sync Oura Ring."],
  ] as const)("%s → %s", (kind, expected) => {
    expect(syncFailureCopy("Oura Ring", kind)).toBe(expected);
  });

  it("never names a path, a status or a vendor error number", () => {
    for (const kind of ["reconnect", "transient", "unknown"] as const) {
      expect(syncFailureCopy("Oura Ring", kind)).not.toMatch(/\d|\//);
    }
  });
});
