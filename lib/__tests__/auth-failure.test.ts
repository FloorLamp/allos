import { describe, it, expect } from "vitest";
import {
  isAuthRefreshFailure,
  syncFailureCopy,
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

// Issue #3618: the SENTENCE a status turns into. The end-to-end proof that these
// reach the card, the toast and the digest is lib/__db_tests__/sync-failure-copy;
// this table is the vocabulary itself, including the two edges that decide whether
// it can be wrong — a keyless source has no grant to renew, and a Withings envelope
// code is not an HTTP status however much it looks like one.
describe("syncFailureCopy", () => {
  it.each([
    // status, canReconnect, expected
    [401, true, "Reconnect Oura to resume syncing."],
    [400, true, "Reconnect Oura to resume syncing."], // a rejected grant
    [401, false, "Couldn't sync Oura."], // nothing to reconnect
    [400, false, "Couldn't sync Oura."], // #3007's out-of-range window
    [0, true, "Oura is having trouble. The next sync will pick it up."],
    [429, true, "Oura is having trouble. The next sync will pick it up."],
    [503, true, "Oura is having trouble. The next sync will pick it up."],
    [601, true, "Couldn't sync Oura."], // a vendor code, not a 6xx server error
    [2555, true, "Couldn't sync Oura."],
    [403, true, "Couldn't sync Oura."],
    [404, true, "Couldn't sync Oura."],
  ] as const)(
    "%i (reconnectable: %s) → %s",
    (status, canReconnect, expected) => {
      expect(syncFailureCopy("Oura", status, canReconnect)).toBe(expected);
    }
  );

  it("never names a path, a status or a vendor error number", () => {
    for (const status of [0, 400, 401, 403, 429, 500, 503, 601, 2555]) {
      for (const canReconnect of [true, false]) {
        expect(syncFailureCopy("Oura", status, canReconnect)).not.toMatch(
          /\d|\//
        );
      }
    }
  });
});
