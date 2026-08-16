// The externally visible base URL, and what hangs off it (#2959). These rules
// were implemented four times — the calendar-feed and Health Connect pages, and
// the Strava and Withings url helpers — and never tested once, because each copy
// sat behind `next/headers` in a Server Component. Splitting the pure decision
// out from the request lookup is what makes them reachable here.

import { describe, it, expect } from "vitest";
import {
  resolveExternalBaseUrl,
  joinUrl,
  absoluteUrl,
  isLoopbackUrl,
} from "../external-url";

// A stand-in for the request's header bag, keyed the way `headers().get()` is.
function headersOf(h: Record<string, string>) {
  return (name: string) => h[name] ?? null;
}

describe("resolveExternalBaseUrl", () => {
  it("prefers the configured public URL over every header", () => {
    // The admin who set it knows the address better than a proxy header does.
    const base = resolveExternalBaseUrl(
      "https://allos.example",
      headersOf({
        "x-forwarded-host": "wrong.example",
        "x-forwarded-proto": "http",
        host: "also-wrong.example",
      })
    );
    expect(base).toBe("https://allos.example");
  });

  it("does not consult the headers at all when one is configured", () => {
    // The server wrapper returns before awaiting `headers()` in this case, and
    // that is BEHAVIOUR rather than speed: `headers()` throws outside a request
    // scope, so a configured deployment can build a callback URL from a
    // background tick or a CLI. All four helpers this replaced could.
    let looked = 0;
    const base = resolveExternalBaseUrl("https://allos.example", (name) => {
      looked++;
      return name === "host" ? "wrong.example" : null;
    });
    expect(base).toBe("https://allos.example");
    expect(looked).toBe(0);
  });

  it("treats an unset public URL as absent", () => {
    // getPublicUrl() returns "" rather than null when nothing is stored.
    const header = headersOf({ host: "allos.example" });
    expect(resolveExternalBaseUrl("", header)).toBe("https://allos.example");
    expect(resolveExternalBaseUrl(null, header)).toBe("https://allos.example");
    expect(resolveExternalBaseUrl(undefined, header)).toBe(
      "https://allos.example"
    );
  });

  it("uses the forwarded host and proto behind a reverse proxy", () => {
    // The bare `host` is the internal target; the forwarded pair is the address
    // the user actually reached us on, and it wins.
    const base = resolveExternalBaseUrl(
      "",
      headersOf({
        "x-forwarded-host": "allos.example",
        "x-forwarded-proto": "https",
        host: "localhost:3000",
      })
    );
    expect(base).toBe("https://allos.example");
  });

  it("assumes https for a non-loopback host when the proxy did not say", () => {
    const base = resolveExternalBaseUrl(
      "",
      headersOf({ host: "allos.example" })
    );
    expect(base).toBe("https://allos.example");
  });

  it("keeps http for localhost, so a dev browser is not sent to a TLS port", () => {
    expect(
      resolveExternalBaseUrl("", headersOf({ host: "localhost:3000" }))
    ).toBe("http://localhost:3000");
  });

  it("honours an explicit forwarded proto even on localhost", () => {
    const base = resolveExternalBaseUrl(
      "",
      headersOf({ host: "localhost:3000", "x-forwarded-proto": "https" })
    );
    expect(base).toBe("https://localhost:3000");
  });

  it("falls back to loopback when the request carries no host at all", () => {
    // A background tick or a test. Loopback rather than an invented public
    // address, so isLoopbackUrl below catches it and the admin is told to set
    // the Public app URL.
    const base = resolveExternalBaseUrl("", headersOf({}));
    expect(base).toBe("http://localhost:3000");
    expect(isLoopbackUrl(base)).toBe(true);
  });
});

describe("joinUrl", () => {
  it("joins a path with or without its leading slash", () => {
    expect(joinUrl("https://allos.example", "/api/x")).toBe(
      "https://allos.example/api/x"
    );
    expect(joinUrl("https://allos.example", "api/x")).toBe(
      "https://allos.example/api/x"
    );
  });
});

describe("absoluteUrl", () => {
  it("uses the server-provided base when there is one", () => {
    expect(absoluteUrl("https://allos.example", "/feed.ics")).toBe(
      "https://allos.example/feed.ics"
    );
  });

  it("falls back to the browser's origin when the base is empty", () => {
    // The plain localhost/dev setup, where no public URL is configured and the
    // page was loaded from the origin the feed will be fetched from.
    const had = "window" in globalThis;
    try {
      (globalThis as { window?: unknown }).window = {
        location: { origin: "http://localhost:3000" },
      };
      expect(absoluteUrl("", "/feed.ics")).toBe(
        "http://localhost:3000/feed.ics"
      );
    } finally {
      if (!had) delete (globalThis as { window?: unknown }).window;
    }
  });

  it("degrades to a bare path during the server render, not to a crash", () => {
    // The same client component renders once on the server, where `window` does
    // not exist. A relative href is wrong-but-harmless; a ReferenceError is not.
    // Asserted against an explicitly window-less global rather than the ambient
    // one — the pure tier shares a module registry per worker, so ambient state
    // is not this spec's to assume.
    const saved = (globalThis as { window?: unknown }).window;
    try {
      delete (globalThis as { window?: unknown }).window;
      expect(absoluteUrl("", "/feed.ics")).toBe("/feed.ics");
    } finally {
      if (saved !== undefined) {
        (globalThis as { window?: unknown }).window = saved;
      }
    }
  });
});

describe("isLoopbackUrl", () => {
  it("recognises every loopback spelling a callback could arrive as", () => {
    for (const u of [
      "http://localhost:3000/cb",
      "https://localhost/cb",
      "http://127.0.0.1:3000/cb",
      "http://[::1]:3000/cb",
    ]) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
  });

  it("passes a real public callback", () => {
    expect(isLoopbackUrl("https://allos.example/api/x/callback")).toBe(false);
  });

  it("does not match a host that merely contains a loopback name", () => {
    expect(isLoopbackUrl("https://localhost.example.com/cb")).toBe(false);
    expect(isLoopbackUrl("https://notlocalhost/cb")).toBe(false);
  });

  it("returns false for something that is not a URL", () => {
    // A malformed base must not read as "safe to hand a provider" OR throw
    // out of the action that is checking it.
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
