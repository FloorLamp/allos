import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATHS } from "@/lib/public-paths";

// The middleware public-path allowlist (issue #985 extraction). This unit test
// stands in for "the existing public-path tests" the acceptance references: it pins
// that the session-free auth routes are allowlisted and that ordinary app routes
// are NOT, so the coarse Edge gate and this set can't drift.
describe("middleware public-path allowlist", () => {
  it("allows the auth login-lifecycle routes without a session", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/forgot-password")).toBe(true);
    expect(isPublicPath("/set-password")).toBe(true);
    // The forgot/set-password additions are in the concrete set, not just prefixes.
    expect(PUBLIC_PATHS.has("/forgot-password")).toBe(true);
    expect(PUBLIC_PATHS.has("/set-password")).toBe(true);
  });

  it("keeps the existing token-authed public surfaces public", () => {
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/share/abc123")).toBe(true);
    expect(isPublicPath("/api/calendar/xyz")).toBe(true);
    expect(isPublicPath("/apple-icon/1")).toBe(true);
  });

  it("does NOT make protected app routes public", () => {
    for (const p of [
      "/",
      "/settings",
      "/settings/server",
      "/settings/family",
      "/medications",
      "/set-password-extra", // not an exact match, no prefix rule
      "/api/integrations/strava/callback",
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});
