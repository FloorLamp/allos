import { describe, it, expect } from "vitest";
import {
  isAuthPullFailure,
  isAuthRefreshFailure,
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

// THE DATA-PULL RULE IS ITS OWN, AND NARROWER (#3618 review). The refresh rule above
// answers "did the token endpoint reject this grant?" — where a 400 with no usable
// body can only be the grant. A data pull sends a window, a page token and a field
// list, so its 400 is ordinarily one of those, and reading the refresh rule there
// told people their connection had expired over an out-of-range `end_date`.
describe("isAuthPullFailure", () => {
  it("is a 401 and nothing else", () => {
    expect(isAuthPullFailure(401)).toBe(true);
    // Oura's personal access token has no refresh; a revoked one surfaces here.
  });

  it("does NOT read a data-pull 400 as a dead grant, unlike the refresh rule", () => {
    // The two rules disagree on exactly this number, deliberately. If they ever
    // agree again, an ordinary parameter-validation 400 is once more minting "Your
    // Oura Ring connection expired.", flipping the connection, and stopping the sync.
    expect(isAuthPullFailure(400)).toBe(false);
    expect(isAuthRefreshFailure(400)).toBe(true);
  });

  it("leaves every other status transient", () => {
    for (const status of [
      -1, 0, 403, 404, 408, 422, 429, 500, 503, 601, 2555,
    ]) {
      expect(isAuthPullFailure(status), `status ${status}`).toBe(false);
    }
  });
});
