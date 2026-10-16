import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { deckDestination } from "@/lib/public-paths";

afterEach(() => vi.unstubAllEnvs());

describe.each(["", "/health"])("Deck mount %s", (base) => {
  it("rewrites its page, module, API and vendor assets without moving other routes", () => {
    vi.stubEnv("DECK_BASE_PATH", base);
    for (const [path, destination] of [
      [base || "/", "/deck/health"],
      [`${base}/health.js`, "/deck/health.js"],
      [`${base}/api/board/123`, "/api/board/123"],
      [
        `${base}/deck-ui/0.1.165/ui/src/mount.js`,
        "/deck-ui/0.1.165/ui/src/mount.js",
      ],
    ]) {
      const response = middleware(
        new NextRequest(`https://deck.test${path}?profile=7`, {
          headers: { cookie: "__Host-boarding_member=synthetic-session" },
        })
      );
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        `https://deck.test${destination}?profile=7`
      );
    }
    for (const path of [
      "/v1/me",
      "/login",
      "/api/health",
      `${base}/api/settings`,
      "/healthy/",
    ])
      expect(deckDestination(path)).toBeNull();
    expect(
      middleware(new NextRequest("https://allos.test/api/health")).status
    ).toBe(200);
    expect(middleware(new NextRequest("https://allos.test/v1/me")).status).toBe(
      200
    );
  });

  it("refuses unsigned API requests and returns the browser to Boarding at its external path", () => {
    vi.stubEnv("DECK_BASE_PATH", base);
    expect(
      middleware(new NextRequest(`https://deck.test${base}/api/me`)).status
    ).toBe(401);
    const path = base || "/";
    expect(
      middleware(new NextRequest(`https://deck.test${path}`)).headers.get(
        "location"
      )
    ).toBe(`https://deck.test/boarding/sign-in?to=${encodeURIComponent(path)}`);
  });
});

it("301s only the legacy Deck browser route, retaining the query", () => {
  vi.stubEnv("DECK_BASE_PATH", "/health");
  vi.stubEnv("DECK_ORIGIN", "https://deck.test");
  const response = middleware(
    new NextRequest("https://allos.test/deck/health?profile=7")
  );
  expect(response.status).toBe(301);
  expect(response.headers.get("location")).toBe(
    "https://deck.test/health?profile=7"
  );
});
