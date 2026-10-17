// The middleware's sliding session-cookie refresh is NAVIGATIONS-FIRST: every
// GET/HEAD, and a non-navigation only once the slide MARK has expired.
//
// WHY NAVIGATIONS. Next merges a middleware Set-Cookie into a Server Action's
// mutable cookie jar (x-middleware-set-cookie), and a cookie modified during an
// action marks the whole action response "revalidated": the reply then carries a
// full page re-render and invalidates the client router cache. Sliding the cookie
// on POSTs therefore turned EVERY action — including pure reads like the Training Log's
// loadTrainingLogPage — into an implicit page refresh, contradicting the documented
// contract (docs/internals/server-action-refresh.md) and feeding a client fetch
// loop: TrainingLogView re-fetches the filtered feed whenever the server refreshes its
// first page, so each fetch's cookie-stamped reply triggered the next fetch and
// clobbered "Load more" pages (see the companion training-log-search-depth browser
// spec).
//
// WHY NOT NAVIGATIONS *ONLY* (#2058). The DB-side expiry slide (SESSION_TOUCH in
// lib/auth.ts) runs on every request, POST included. A session driven purely by
// action POSTs — a tab parked on one page, logging through forms, never
// navigating — therefore held a server session sliding out toward the 90-day
// ceiling behind a browser cookie quietly expiring 30 days after the last GET:
// a silent sign-out with a live session on the other end. So a non-navigation
// re-issues the cookie too, but only when the mark (a valueless companion cookie
// with a 7-day Max-Age, re-set whenever the session cookie is) has aged out —
// at most one stamped action response per mark TTL, and none at all for a session
// that ever navigates.
//
// middleware() is Edge code but pure over its request, so it unit-tests directly.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  SESSION_COOKIE,
  SESSION_SLIDE_MARK_COOKIE,
  SESSION_SLIDE_MARK_TTL_SEC,
  SESSION_TTL_SEC,
  shouldSlideSessionCookie,
} from "@/lib/session-cookie";

function request(
  method: string,
  path: string,
  opts: { token?: boolean; mark?: boolean } = {}
): NextRequest {
  const { token = true, mark = true } = opts;
  const jar = [
    token ? `${SESSION_COOKIE}=tok-123` : null,
    mark ? `${SESSION_SLIDE_MARK_COOKIE}=1` : null,
  ].filter((c): c is string => c != null);
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: jar.length ? { cookie: jar.join("; ") } : {},
  });
}

describe("middleware sliding session cookie", () => {
  it("re-sets the cookie AND its mark on GET and HEAD navigations", () => {
    for (const method of ["GET", "HEAD"]) {
      const res = middleware(request(method, "/training"));
      const slid = res.cookies.get(SESSION_COOKIE);
      expect(slid?.value).toBe("tok-123");
      expect(slid?.maxAge).toBe(SESSION_TTL_SEC);
      // The mark rides along, so its expiry always dates the cookie beside it.
      expect(res.cookies.get(SESSION_SLIDE_MARK_COOKIE)?.maxAge).toBe(
        SESSION_SLIDE_MARK_TTL_SEC
      );
    }
  });

  it("sets no cookie on a POST while the mark is fresh (Server Actions must not read as revalidated)", () => {
    const res = middleware(request("POST", "/training"));
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(res.cookies.get(SESSION_SLIDE_MARK_COOKIE)).toBeUndefined();
    // Not by bouncing the request: the action itself still goes through.
    expect(res.status).toBe(200);
  });

  it("re-issues on a POST once the mark has expired, so a POST-only session can't age out (#2058)", () => {
    const res = middleware(request("POST", "/training", { mark: false }));
    const slid = res.cookies.get(SESSION_COOKIE);
    expect(slid?.value).toBe("tok-123");
    expect(slid?.maxAge).toBe(SESSION_TTL_SEC);
    // A new mark starts the next quiet window, so this stays a once-per-TTL event
    // rather than a Set-Cookie on every subsequent action.
    expect(res.cookies.get(SESSION_SLIDE_MARK_COOKIE)?.maxAge).toBe(
      SESSION_SLIDE_MARK_TTL_SEC
    );
    expect(res.status).toBe(200);
  });

  it("applies the same rule on public paths", () => {
    expect(
      middleware(request("GET", "/login")).cookies.get(SESSION_COOKIE)?.value
    ).toBe("tok-123");
    expect(
      middleware(request("POST", "/login")).cookies.get(SESSION_COOKIE)
    ).toBeUndefined();
    expect(
      middleware(request("POST", "/login", { mark: false })).cookies.get(
        SESSION_COOKIE
      )?.value
    ).toBe("tok-123");
    // No session, no cookie — an expired mark never conjures one for a signed-out
    // visitor on a public page.
    expect(
      middleware(
        request("POST", "/login", { token: false, mark: false })
      ).cookies.get(SESSION_COOKIE)
    ).toBeUndefined();
  });

  it("still redirects an unauthenticated GET and 401s an unauthenticated API call", () => {
    const redirect = middleware(request("GET", "/training", { token: false }));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toContain("/login");
    const api = middleware(
      request("POST", "/api/anything", { token: false, mark: false })
    );
    expect(api.status).toBe(401);
  });
});

describe("shouldSlideSessionCookie — the policy itself", () => {
  it("always slides a navigation, marked or not", () => {
    for (const method of ["GET", "HEAD"]) {
      expect(shouldSlideSessionCookie(method, true)).toBe(true);
      expect(shouldSlideSessionCookie(method, false)).toBe(true);
    }
  });

  it("slides any other method only when the mark is gone", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(shouldSlideSessionCookie(method, true)).toBe(false);
      expect(shouldSlideSessionCookie(method, false)).toBe(true);
    }
  });

  it("keeps the mark strictly shorter-lived than the session cookie", () => {
    // The whole mechanism depends on the mark dying FIRST: the re-issue it
    // triggers has to happen while the session cookie is still alive, and the gap
    // between the two is the worst case by which a POST-only session's browser
    // lifetime can lag its DB expires_at.
    expect(SESSION_SLIDE_MARK_TTL_SEC).toBeLessThan(SESSION_TTL_SEC);
  });
});

describe("Accounts CORS before session authentication", () => {
  it("lets Deck read the real no-cookie 401 without opening other origins or APIs", async () => {
    vi.stubEnv("DECK_ORIGIN", "https://deck.example");
    try {
      for (const origin of [
        "https://deck.example",
        "https://other.example",
        "https://deck.example.evil.test",
      ]) {
        const response = middleware(
          new NextRequest("https://allos.test/api/accounts", {
            headers: { origin },
          })
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Unauthorized" });
        expect(response.headers.get("access-control-allow-origin")).toBe(
          origin === "https://deck.example" ? origin : null
        );
        expect(response.headers.get("access-control-allow-credentials")).toBe(
          origin === "https://deck.example" ? "true" : null
        );
        expect(response.headers.get("vary")).toBe("Origin");
      }
      const otherApi = middleware(
        new NextRequest("https://allos.test/api/me", {
          headers: { origin: "https://deck.example" },
        })
      );
      expect(otherApi.headers.get("access-control-allow-origin")).toBeNull();
      vi.stubEnv("DECK_ORIGIN", "");
      const unconfigured = middleware(
        new NextRequest("https://allos.test/api/accounts", {
          headers: { origin: "https://deck.example" },
        })
      );
      expect(
        unconfigured.headers.get("access-control-allow-origin")
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
