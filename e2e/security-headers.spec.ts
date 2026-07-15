import { test, expect } from "@playwright/test";

// Global security headers (issue #21). The non-CSP header set is configured in
// next.config.js `headers()`; the Content-Security-Policy is emitted per-request
// by middleware.ts (issue #595, step 3 — nonce'd script-src) and /share/* layers
// STRICTER values on top via middleware.ts (withShareHeaders). These assertions
// pin the posture so a future edit can't silently drop a header. Header names
// come back lowercased from Playwright's response.headers().

// A nonce token in a directive: 'nonce-<base64>'. We assert the SHAPE, never a
// value — the nonce is per-request and changes every load.
const NONCE_TOKEN = /'nonce-[A-Za-z0-9+/=]+'/;

// The e2e app boots in production mode ONLY under CI (`next start`, NODE_ENV=
// production — see playwright.config.ts); a local run uses `next dev`
// (NODE_ENV=development). middleware.ts branches script-src on NODE_ENV, so the
// nonce'd, no-'unsafe-inline' policy is what CI serves, while dev keeps
// 'unsafe-inline' + 'unsafe-eval' for HMR. The spec reads the SAME CI switch so
// both runs stay green and the strict hardening is verified where it applies.
const IS_PROD_RUN = process.env.CI === "true" || process.env.CI === "1";

function scriptSrcDirective(csp: string): string {
  return csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
}

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
  // The non-script directives are ENFORCED (issue #595). Pin each so a regression
  // that drops one fails CI.
  const csp = headers["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("connect-src 'self'");
  // style-src keeps 'unsafe-inline' by design (Tailwind + Next inline styles).
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  // script-src (step 3): the production run carries a per-request nonce token and
  // NO 'unsafe-inline'; the dev run keeps 'unsafe-inline' + 'unsafe-eval' for HMR.
  const scriptSrc = scriptSrcDirective(csp);
  if (IS_PROD_RUN) {
    expect(scriptSrc).toMatch(NONCE_TOKEN);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  } else {
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
  }
  // The report-only test bed was removed once the nonce tightening graduated.
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
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

test("each request gets a distinct script-src nonce", async ({ request }) => {
  // Nonce assertions only apply to the production run (dev has no nonce token).
  test.skip(
    !IS_PROD_RUN,
    "dev script-src is nonce-free (unsafe-inline for HMR)"
  );
  // The nonce is per-request: two loads of the same page must carry different
  // nonce tokens (a fixed nonce would defeat the whole mechanism). Use raw
  // requests so no client cache collapses the two.
  const a = (await request.get("/login")).headers()["content-security-policy"];
  const b = (await request.get("/login")).headers()["content-security-policy"];
  const nonceA = a.match(NONCE_TOKEN)?.[0];
  const nonceB = b.match(NONCE_TOKEN)?.[0];
  expect(nonceA).toBeTruthy();
  expect(nonceB).toBeTruthy();
  expect(nonceA).not.toBe(nonceB);
});

test("the nonce in the header is stamped onto the served inline scripts", async ({
  request,
}) => {
  test.skip(
    !IS_PROD_RUN,
    "dev script-src is nonce-free (unsafe-inline for HMR)"
  );
  // The middleware's nonce and the layout's <script nonce> must agree, or the
  // theme-boot script would be blocked in production. Assert against the RAW HTML
  // (not the live DOM — browsers blank the nonce attribute after parsing to stop
  // CSS-selector exfiltration): the header nonce must appear as a nonce="..."
  // attribute on an inline <script> in the response body.
  const resp = await request.get("/login");
  const nonceToken = resp
    .headers()
    ["content-security-policy"].match(NONCE_TOKEN)?.[0];
  expect(nonceToken).toBeTruthy();
  const nonceValue = nonceToken!.slice("'nonce-".length, -1);
  const html = await resp.text();
  expect(html).toContain(`nonce="${nonceValue}"`);
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
