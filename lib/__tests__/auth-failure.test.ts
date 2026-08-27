import { describe, it, expect } from "vitest";
import {
  isAuthRefreshFailure,
  syncFailureCopy,
  syncFailureKind,
} from "@/lib/integrations/auth-failure";

// Issue #326: classify an OAuth/token-refresh failure as a DEFINITIVE auth failure
// (dead/revoked grant → needs re-auth) vs a TRANSIENT one (retry next tick). Only the
// former may tear a connection out of `connected`.
describe("isAuthRefreshFailure", () => {
  it("treats 401 as a definitive auth failure regardless of body", () => {
    expect(isAuthRefreshFailure(401)).toBe(true);
    expect(isAuthRefreshFailure(401, "")).toBe(true);
    expect(isAuthRefreshFailure(401, "anything")).toBe(true);
  });

  it("treats a bare 400 (no body) as a rejected grant", () => {
    expect(isAuthRefreshFailure(400)).toBe(true);
    expect(isAuthRefreshFailure(400, "")).toBe(true);
    expect(isAuthRefreshFailure(400, null)).toBe(true);
  });

  it("treats a 400 carrying an invalid_grant-style marker as auth", () => {
    expect(isAuthRefreshFailure(400, '{"error":"invalid_grant"}')).toBe(true);
    expect(isAuthRefreshFailure(400, "invalid grant")).toBe(true);
    expect(isAuthRefreshFailure(400, '{"error":"invalid_token"}')).toBe(true);
    expect(isAuthRefreshFailure(400, "The refresh_token is invalid")).toBe(
      true
    );
    expect(isAuthRefreshFailure(400, "Unauthorized")).toBe(true);
  });

  it("does NOT treat a 400 with an unrelated body as auth", () => {
    expect(isAuthRefreshFailure(400, '{"error":"invalid_scope"}')).toBe(false);
    expect(isAuthRefreshFailure(400, "malformed request payload")).toBe(false);
  });

  it("treats transient statuses (429/5xx/network-0) as NOT auth failures", () => {
    expect(isAuthRefreshFailure(429)).toBe(false);
    expect(isAuthRefreshFailure(500)).toBe(false);
    expect(isAuthRefreshFailure(503)).toBe(false);
    expect(isAuthRefreshFailure(0)).toBe(false); // network error / timeout sentinel
    expect(isAuthRefreshFailure(601)).toBe(false); // Withings over-quota envelope
  });

  it("does not misclassify other 4xx (403/404) as an auth-grant failure", () => {
    expect(isAuthRefreshFailure(403)).toBe(false);
    expect(isAuthRefreshFailure(404)).toBe(false);
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
