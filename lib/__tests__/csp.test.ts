import { describe, it, expect } from "vitest";
import { buildCsp, generateNonce, isSelfFramedPath } from "@/lib/csp";

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

// frame-ancestors is the ONE directive that varies by path (#3975): the route the
// import page frames its own stored PDF from gets 'self', everything else keeps
// 'none'. Both halves are asserted — a narrowing that also widened the pages would
// be the actual security regression, and only the 'none' case can see it.
describe("buildCsp frame-ancestors (#3975)", () => {
  it.each([
    [false, "frame-ancestors 'none'", "frame-ancestors 'self'"],
    [true, "frame-ancestors 'self'", "frame-ancestors 'none'"],
  ])("selfFramed=%s emits %s", (selfFramed, present, absent) => {
    for (const dev of [true, false]) {
      const csp = buildCsp(NONCE, dev, selfFramed);
      expect(csp.split("; ")).toContain(present);
      expect(csp).not.toContain(absent);
      // Nothing ELSE moves with it — the narrowing is one directive wide.
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self'");
    }
  });

  it("defaults to 'none' when the flag is omitted", () => {
    expect(buildCsp(NONCE, false)).toContain("frame-ancestors 'none'");
  });
});

describe("isSelfFramedPath", () => {
  // The trailing slash in the prefix is what keeps this from being a substring
  // match: /medical/files/1 is a different (hypothetical) route and must not
  // inherit the narrowing.
  it.each([
    ["/medical/file/1", true],
    ["/medical/file/908", true],
    ["/medical/file", false],
    ["/medical/files/1", false],
    ["/medical", false],
    ["/import/44", false],
    ["/share/token", false],
    ["/", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isSelfFramedPath(pathname)).toBe(expected);
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
