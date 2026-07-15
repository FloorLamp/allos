import { describe, it, expect } from "vitest";
import { buildCsp, generateNonce } from "@/lib/csp";

// Pure coverage for the Content-Security-Policy builder (issue #595, step 3).
// The end-to-end header wiring is covered by e2e/security-headers.spec.ts; this
// pins the policy SHAPE so a directive can't silently change or drop.

const NONCE = "TESTNONCE123456==";

describe("buildCsp", () => {
  it("emits the non-script directives unchanged in both modes", () => {
    for (const dev of [true, false]) {
      const csp = buildCsp(NONCE, dev);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("img-src 'self' data: blob:");
      expect(csp).toContain("connect-src 'self'");
      // style-src keeps 'unsafe-inline' by design (Tailwind + Next inline styles).
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    }
  });

  it("production script-src is nonce-based with NO 'unsafe-inline'", () => {
    const csp = buildCsp(NONCE, false);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${NONCE}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // No 'strict-dynamic': bare 'self' still admits same-origin chunk scripts.
    expect(scriptSrc).not.toContain("strict-dynamic");
  });

  it("dev script-src keeps 'unsafe-inline' + 'unsafe-eval' and omits the nonce", () => {
    const csp = buildCsp(NONCE, true);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
    // A nonce token would make browsers IGNORE 'unsafe-inline' and break HMR, so
    // the dev policy must NOT carry one.
    expect(scriptSrc).not.toContain("nonce-");
  });
});

describe("generateNonce", () => {
  it("returns a non-empty base64 string", () => {
    const nonce = generateNonce();
    expect(nonce.length).toBeGreaterThan(0);
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/);
    // 16 random bytes → 24 base64 chars (with padding).
    expect(nonce.length).toBe(24);
  });

  it("is unpredictable — distinct on each call", () => {
    const seen = new Set(Array.from({ length: 64 }, () => generateNonce()));
    expect(seen.size).toBe(64);
  });
});
