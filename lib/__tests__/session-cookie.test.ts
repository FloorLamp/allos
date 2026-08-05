// PURE TIER (issue #676). lib/session-cookie.ts is the dependency-free source of
// truth for the session cookie NAME, the Secure/`__Host-` decision, and the
// cookie ATTRIBUTES (httpOnly/sameSite/secure/path/maxAge) — imported by both the
// Edge middleware and the Node auth layer, so it must not pull in better-sqlite3
// or next/headers. These tests pin those attributes without a DB or a request.
//
// The Secure flag is computed from NODE_ENV at module-eval time, so the
// production branch (`__Host-` prefix + Secure) is exercised via a re-import under
// a stubbed env.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SESSION_COOKIE,
  TWO_FACTOR_COOKIE,
  SESSION_COOKIE_SECURE,
  SESSION_SLIDE_MARK_COOKIE,
  SESSION_SLIDE_MARK_VALUE,
  SESSION_TTL_SEC,
  sessionCookieOptions,
} from "@/lib/session-cookie";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("session cookie attributes (dev / non-production)", () => {
  it("uses the plain cookie names and Secure=false off production", () => {
    // Vitest runs with NODE_ENV=test, so the Secure-gated prefix is off.
    expect(SESSION_COOKIE_SECURE).toBe(false);
    expect(SESSION_COOKIE).toBe("ht_session");
    expect(TWO_FACTOR_COOKIE).toBe("ht_2fa");
    expect(SESSION_SLIDE_MARK_COOKIE).toBe("ht_slid");
  });

  it("pins httpOnly / sameSite / secure / path / maxAge", () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.secure).toBe(false); // matches SESSION_COOKIE_SECURE off prod
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(SESSION_TTL_SEC);
  });

  it("defaults maxAge to the 30-day session TTL", () => {
    expect(SESSION_TTL_SEC).toBe(30 * 24 * 60 * 60);
    expect(sessionCookieOptions().maxAge).toBe(2592000);
  });

  it("honors an explicit maxAge (the short-lived 2FA-challenge case)", () => {
    expect(sessionCookieOptions(300).maxAge).toBe(300);
    // Every other attribute is unchanged by the maxAge argument.
    const opts = sessionCookieOptions(300);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
  });
});

describe("session cookie attributes (production)", () => {
  it("switches to the __Host- prefixed names and Secure=true", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const mod = await import("@/lib/session-cookie");
    expect(mod.SESSION_COOKIE_SECURE).toBe(true);
    // The __Host- prefix a browser only accepts when Secure + Path=/ + no Domain.
    expect(mod.SESSION_COOKIE).toBe("__Host-ht_session");
    expect(mod.TWO_FACTOR_COOKIE).toBe("__Host-ht_2fa");
    // The slide mark (#2058) is hardened identically — it rides beside the
    // session cookie on every refresh, so a mark a sibling subdomain could
    // inject would be a lever on when the real cookie gets re-issued.
    expect(mod.SESSION_SLIDE_MARK_COOKIE).toBe("__Host-ht_slid");
    const opts = mod.sessionCookieOptions();
    expect(opts.secure).toBe(true);
    expect(opts.path).toBe("/"); // __Host- mandates Path=/
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
  });
});

describe("the slide mark carries no secret (#2058)", () => {
  it("is a constant, never the session token", () => {
    // The mark exists to be present or absent; its value is never read. Deriving
    // it from the token would put a second copy of the credential in the jar.
    expect(SESSION_SLIDE_MARK_VALUE).toBe("1");
  });
});
