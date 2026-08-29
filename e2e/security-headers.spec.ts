import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath, workerDir } from "./worker-env";
// Global security headers (issue #21). The non-CSP header set is configured in
// next.config.js `headers()`; the Content-Security-Policy is emitted per-request
// by middleware.ts (issue #595, step 3 — nonce'd script-src) and /share/* layers
// STRICTER values on top via middleware.ts (withShareHeaders). These assertions
// pin the posture so a future edit can't silently drop a header. Header names
// come back lowercased from Playwright's response.headers().

// A nonce token in a directive: 'nonce-<base64>'. We assert the SHAPE, never a
// value — the nonce is per-request and changes every load.
const NONCE_TOKEN = /'nonce-[A-Za-z0-9+/=]+'/;

// THE APP UNDER TEST IS ALWAYS PRODUCTION, so there is no dev branch here.
// e2e/fixtures.ts spawns every worker's server as `next start` with
// NODE_ENV: "production", unconditionally — that is what DB-per-worker (#1538)
// replaced the old `webServer` block with, and its own comment explains why dev
// mode cannot be used per worker. middleware.ts branches script-src on NODE_ENV,
// so the nonce'd, no-'unsafe-inline' policy is the ONLY one this suite can ever
// observe.
//
// This used to read `process.env.CI` as a proxy for that, which was true of the
// runner and false of everything else: locally the spec took a dev branch that
// the server had already made unreachable, demanded 'unsafe-inline', got a
// correct production nonce policy, and failed. Three specs here could not pass on
// a developer machine — so `npm run test:e2e` could not go green locally, which
// is exactly when you most want to run it. The proxy stood in for a fact the
// harness already decides; asserting that fact directly is simpler and honest.

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
  // script-src (step 3): a per-request nonce token and NO 'unsafe-inline'.
  const scriptSrc = scriptSrcDirective(csp);
  expect(scriptSrc).toMatch(NONCE_TOKEN);
  expect(scriptSrc).not.toContain("'unsafe-inline'");
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
  // The per-worker storageState (e2e/fixtures.ts) starts this spec logged in, so
  // "/" renders the dashboard rather than redirecting to /login.
  const resp = await page.goto("/");
  expect(resp!.status()).toBeLessThan(400);
  expectGlobalHeaders(resp!.headers());
});

test("each request gets a distinct script-src nonce", async ({ request }) => {
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
  // `next start` retains no-store. The loosened /no-store|no-cache/ alternative
  // that used to sit behind `if (process.env.CI)` was for a `next dev` harness
  // this suite has not had since #1538, and it weakened the assertion everywhere
  // it was taken.
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
  // The global hardening still rides along.
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'"
  );
});

// ── The one route the app frames itself (#3975) ──────────────────────────────
//
// /import/[id] previews a stored PDF with <iframe src="/medical/file/<id>">, and
// the blanket frame-ancestors 'none' above forbade it: a spec-compliant browser
// refused, and the Document pane rendered the browser's own refusal page. The
// refusal raises NO error event, so #1340's "Preview unavailable" fallback could
// not fire either — nothing in the app could see it, which is why it survived
// from #624 until it was found on prod.
//
// So the guard is the WIRE and the RENDERED FRAME, never the config that intends
// them. The header half would pass on a page that still refuses; the frame half
// is what fails when the refusal comes back.

const PDF_DOC = "e2e-3975-framed.pdf";

/** A stored PDF for THIS spec, on disk under the worker server's own cwd. */
function seedFramedPdf(): number {
  const rel = path.join("data", "uploads", "medical", "1", PDF_DOC);
  const abs = path.join(workerDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `%PDF-1.4\n% allos e2e document 3975\n%%EOF\n`);
  const handle = new Database(workerDbPath());
  try {
    handle
      .prepare(`DELETE FROM medical_documents WHERE filename = ?`)
      .run(PDF_DOC);
    return Number(
      handle
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, mime_type, size_bytes, doc_type,
              extraction_status, extracted_count, uploaded_at)
           VALUES (1, ?, ?, 'application/pdf', 42, 'Lab report', 'done', 0,
                   '2026-07-10 09:00:00')`
        )
        .run(PDF_DOC, rel).lastInsertRowid
    );
  } finally {
    handle.close();
  }
}

test("the stored-file route carries frame-ancestors 'self', and nothing else does", async ({
  request,
}) => {
  const id = seedFramedPdf();
  const resp = await request.get(`/medical/file/${id}`);
  expect(resp.status()).toBe(200);
  const headers = resp.headers();
  const csp = headers["content-security-policy"];
  // The narrowing, on the wire.
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toContain("frame-ancestors 'none'");
  // The legacy mirror moves with it: a DENY left beside a 'self' is ignored by
  // browsers but is a trap for the next reader.
  expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
  // …and NOTHING else about the policy moved.
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(scriptSrcDirective(csp)).toMatch(NONCE_TOKEN);
  // The CONVERSE, in the same test: an ordinary page is still 'none'/DENY, so a
  // widening that fixed this route by loosening every page cannot pass here.
  const page = (await request.get("/login")).headers();
  expect(page["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page["x-frame-options"]).toBe("DENY");
});

test("the import page's PDF pane really frames the document", async ({
  page,
}) => {
  const id = seedFramedPdf();
  await page.goto(`/import/${id}`);
  await expect(page.getByTestId("document-preview-frame")).toBeVisible();
  // A frame REFUSAL leaves the <iframe> ELEMENT in place and swaps the document
  // inside it for the browser's own (chrome-error://chromewebdata/) — so
  // asserting the element, or its caption, is exactly the assertion that missed
  // this from #624 until prod. Assert what the frame COMMITTED instead.
  await expect
    .poll(() => page.mainFrame().childFrames()[0]?.url() ?? "")
    .toContain(`/medical/file/${id}`);
  // …and that it really is our PDF document in there, not an error document that
  // happens to sit at the same URL.
  const framed = page.mainFrame().childFrames()[0];
  expect(await framed.evaluate(() => document.contentType)).toBe(
    "application/pdf"
  );
});
