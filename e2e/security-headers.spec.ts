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
  // The non-script directives are now ENFORCED (issue #595). Pin each graduated
  // directive so a regression that drops one — or silently moves it back to
  // report-only — fails CI.
  const csp = headers["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("connect-src 'self'");
  // script-src/style-src stay permissive (unsafe-inline) in the enforced header
  // pending the nonce follow-up; they must NOT have been tightened here.
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  // The report-only header is now the nonce test bed for script/style only.
  expect(headers["content-security-policy-report-only"]).toContain(
    "script-src"
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

test("document viewer page still renders under the enforced CSP", async ({
  page,
}) => {
  // The import document viewer embeds the stored file via a same-origin <img>
  // (or <iframe> for PDFs). object-src 'none' governs <object>/<embed> only —
  // not iframes — and the same-origin preview is allowed by default-src 'self',
  // so the enforced graduation must not break this surface. Assert the page
  // renders its preview card and still carries the enforced header.
  const resp = await page.goto("/import/908");
  expect(resp!.status()).toBeLessThan(400);
  expectGlobalHeaders(resp!.headers());
  await expect(
    page.getByRole("heading", { name: "Document", exact: true })
  ).toBeVisible();
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
