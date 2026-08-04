// The middleware's sliding session-cookie refresh is NAVIGATIONS-ONLY (GET/HEAD).
//
// WHY THIS MATTERS. Next merges a middleware Set-Cookie into a Server Action's
// mutable cookie jar (x-middleware-set-cookie), and a cookie modified during an
// action marks the whole action response "revalidated": the reply then carries a
// full page re-render and invalidates the client router cache. Sliding the cookie
// on POSTs therefore turned EVERY action — including pure reads like the Journal's
// loadJournalPage — into an implicit page refresh, contradicting the documented
// contract (docs/internals/server-action-refresh.md) and feeding a client fetch
// loop: JournalView re-fetches the filtered feed whenever the server refreshes its
// first page, so each fetch's cookie-stamped reply triggered the next fetch and
// clobbered "Load more" pages (see the companion journal-search-depth browser
// spec). GETs happen on every navigation, so the browser-lifetime slide loses
// nothing; the DB-side expiry slide (SESSION_TOUCH in lib/auth.ts) still runs on
// every request.
//
// middleware() is Edge code but pure over its request, so it unit-tests directly.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { SESSION_COOKIE } from "@/lib/session-cookie";

function request(method: string, path: string, withToken = true): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: withToken ? { cookie: `${SESSION_COOKIE}=tok-123` } : {},
  });
}

describe("middleware sliding session cookie", () => {
  it("re-sets the cookie on GET and HEAD navigations", () => {
    for (const method of ["GET", "HEAD"]) {
      const res = middleware(request(method, "/training"));
      const slid = res.cookies.get(SESSION_COOKIE);
      expect(slid?.value).toBe("tok-123");
      expect(slid?.maxAge).toBe(30 * 24 * 60 * 60);
    }
  });

  it("never sets a cookie on a POST (Server Actions must not read as revalidated)", () => {
    const res = middleware(request("POST", "/training"));
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    // Not by bouncing the request: the action itself still goes through.
    expect(res.status).toBe(200);
  });

  it("applies the same navigation-only rule on public paths", () => {
    expect(
      middleware(request("GET", "/login")).cookies.get(SESSION_COOKIE)?.value
    ).toBe("tok-123");
    expect(
      middleware(request("POST", "/login")).cookies.get(SESSION_COOKIE)
    ).toBeUndefined();
  });

  it("still redirects an unauthenticated GET and 401s an unauthenticated API call", () => {
    const redirect = middleware(request("GET", "/training", false));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toContain("/login");
    const api = middleware(request("POST", "/api/anything", false));
    expect(api.status).toBe(401);
  });
});
