import { test, expect } from "@playwright/test";

// Global security headers (issue #21). The header set is configured in
// next.config.js `headers()` and applies to every route; /share/* layers
// STRICTER values on top via middleware.ts (withShareHeaders). These assertions
// pin the posture so a future config edit can't silently drop a header. Header
// names come back lowercased from Playwright's response.headers().

// Assert the common global set is present with the expected values.
function expectGlobalHeaders(headers: Record<string, string>) {
  expect(headers["strict-transport-security"]).toBe(
    "max-age=15552000; includeSubDomains"
  );
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  // frame-ancestors is enforced immediately; the rest of the CSP is report-only.
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'"
  );
  expect(headers["content-security-policy-report-only"]).toContain(
    "default-src 'self'"
  );
  expect(headers["content-security-policy-report-only"]).toContain(
    "object-src 'none'"
  );
}

test("login page carries the global security headers", async ({ page }) => {
  const resp = await page.goto("/login");
  const headers = resp!.headers();
  expectGlobalHeaders(headers);
  // On a normal (non-share) route the global Referrer-Policy applies.
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
});

test("authenticated app page carries the global security headers", async ({
  page,
}) => {
  // storageState (auth.setup.ts) starts this spec logged in, so "/" renders the
  // dashboard rather than redirecting to /login.
  const resp = await page.goto("/");
  expect(resp!.status()).toBeLessThan(400);
  expectGlobalHeaders(resp!.headers());
});

test("share route keeps its stricter middleware headers", async ({
  request,
}) => {
  // A bogus token 404s at the handler, but middleware still applies
  // withShareHeaders regardless — that's what we're asserting. No browser
  // needed; a raw request exposes the response headers directly.
  const resp = await request.get("/share/nonexistent-token-e2e", {
    failOnStatusCode: false,
  });
  const headers = resp.headers();
  // Stricter than the global default: no-referrer (global is
  // strict-origin-when-cross-origin) and an anti-cache/anti-index posture.
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
  // The global hardening still rides along.
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'"
  );
});
