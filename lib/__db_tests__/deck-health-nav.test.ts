// DB INTEGRATION TIER — Deck's Health page on allos's own origin (FloorLamp/allos#6076,
// part 2): the `/api` session twins of the `/v1` routes, and the owner-only page.
//
// The twins are the SAME handlers, authenticated by the session cookie instead of a
// device credential: a person reaches only the profiles their login is granted, a
// read-only grant writes nothing, and no cookie is a 401. The page (page and module)
// is the admin role's alone: anyone else gets a 404, and the page carries the bundle's
// own CSP. Synthetic fixtures only.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";

// The page reads the session through the cookie jar. This tier's shared setup mocks
// @/lib/auth for the server-action suite; this file is about the real session.
const request = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ host: "allos.test" }),
  cookies: async () => ({
    get: (name: string) =>
      request.jar.has(name)
        ? { name, value: request.jar.get(name)! }
        : undefined,
  }),
}));

// The answer path behind /api/ask, counted: a refused call must never reach it
// (FloorLamp/allos#6088), and a refused call writes no ai-log row either.
vi.mock("@/lib/record-qa-answer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/record-qa-answer")>();
  return {
    ...actual,
    answerRecordQuestion: vi.fn(actual.answerRecordQuestion),
  };
});

import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import {
  SESSION_COOKIE,
  createSession,
  resolveBrowserSession,
} from "@/lib/auth";
import { aiLogSize } from "@/lib/ai-log";
import { answerRecordQuestion } from "@/lib/record-qa-answer";
import { seedProfile } from "./fixtures";
import { GET as me } from "@/app/api/me/route";
import { GET as board } from "@/app/api/board/route";
import { POST as boardDose } from "@/app/api/board/[doseId]/route";
import * as askRoute from "@/app/api/ask/route";
import { GET as page } from "@/app/deck/health/route";
import { deckHealthScript } from "@/lib/deck-ui";
import pin from "@/lib/deck-ui-pin.json";
import { GET as script } from "@/app/deck/health.js/route";

function makeLogin(username: string, role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

const get = (path: string, token: string | null): Request =>
  new Request(`http://allos.test${path}`, {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  });

let mine: ReturnType<typeof seedProfile>;
let theirs: ReturnType<typeof seedProfile>;
let myDoseId: number;
let owner: string;
let writer: string;
let viewer: string;

beforeAll(() => {
  mine = seedProfile("WebMine");
  theirs = seedProfile("WebTheirs");
  myDoseId = (
    db
      .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
      .get(mine.medicationId) as { id: number }
  ).id;
  const grant = (login: number, access: "read" | "write") =>
    db
      .prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
      )
      .run(login, mine.profileId, access);
  const w = makeLogin("web-writer", "member");
  const v = makeLogin("web-viewer", "member");
  grant(w, "write");
  grant(v, "read");
  owner = createSession(makeLogin("web-owner", "admin")).token;
  writer = createSession(w).token;
  viewer = createSession(v).token;
});

describe("/api twins — the session, not a device credential", () => {
  it("lets Boarding cookies reach Health and sends unsigned viewers to Boarding", () => {
    const url = "https://allos.test/health";
    expect(
      middleware(
        new NextRequest(url, {
          headers: { cookie: "__Host-boarding_member=synthetic-session" },
        })
      ).status
    ).toBe(200);
    expect(middleware(new NextRequest(url)).headers.get("location")).toBe(
      "https://allos.test/boarding/sign-in?to=%2Fhealth"
    );
  });

  it("accepts only a Boarding-verified owner for Health data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubEnv("DECK_ORIGIN", "https://trusted.test");
    const admins = db
      .prepare("SELECT id FROM logins WHERE role = 'admin'")
      .all() as { id: number }[];
    db.prepare("UPDATE logins SET role = 'member' WHERE role = 'admin'").run();
    const id = makeLogin("boarding-owner", "admin");
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      mine.profileId,
      id
    );
    const fetch = vi.fn<() => Promise<Response> | Response>(async () =>
      Response.json({ owner: true, who: "synthetic-owner" })
    );
    vi.stubGlobal("fetch", fetch);
    const req = () =>
      new Request("https://allos.test/api/board", {
        headers: {
          cookie: "__Host-boarding_member=synthetic-session",
          host: "attacker.test",
          "x-forwarded-host": "attacker.test",
        },
      });
    try {
      const res = await board(req());
      expect(res.status).toBe(200);
      expect((await res.json()).meds).toHaveLength(1);
      request.jar.set("__Host-boarding_member", "synthetic-session");
      expect((await page()).status).toBe(200);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/owner"),
        expect.objectContaining({
          headers: {
            cookie: "__Host-boarding_member=synthetic-session",
            "x-forwarded-host": "trusted.test",
          },
        })
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      // Cached verification never caches the admin mapping.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      db.prepare("UPDATE logins SET role = 'member' WHERE id = ?").run(id);
      expect(
        await resolveBrowserSession("__Host-boarding_member=synthetic-session")
      ).toBeNull();
      db.prepare("UPDATE logins SET role = 'admin' WHERE id = ?").run(id);
      const extra = makeLogin("extra-boarding-admin", "admin");
      expect(
        await resolveBrowserSession("__Host-boarding_member=synthetic-session")
      ).toBeNull();
      expect(warn).toHaveBeenCalled();
      db.prepare("DELETE FROM logins WHERE id = ?").run(extra);
      warn.mockRestore();
      for (const reply of [
        () => Response.json({ owner: false }),
        () => Response.json({ owner: true }, { status: 503 }),
        () => new Response("not json"),
        () => Response.json(null),
        () => {
          throw new Error("unavailable");
        },
      ]) {
        vi.advanceTimersByTime(10_001);
        fetch.mockImplementation(reply);
        const calls = fetch.mock.calls.length;
        expect((await board(req())).status).toBe(401);
        expect((await board(req())).status).toBe(401);
        expect(fetch).toHaveBeenCalledTimes(calls + 1);
      }
      vi.advanceTimersByTime(10_001);
      fetch.mockImplementation(async () => Response.json({ owner: true }));
      const beforeConcurrent = fetch.mock.calls.length;
      await Promise.all([board(req()), board(req())]);
      expect(fetch).toHaveBeenCalledTimes(beforeConcurrent + 1);
      const calls = fetch.mock.calls.length;
      await resolveBrowserSession("__Host-boarding_member=another-session");
      expect(fetch).toHaveBeenCalledTimes(calls + 1);
      vi.stubEnv("DECK_ORIGIN", "https://other-trusted.test");
      await board(req());
      expect(fetch).toHaveBeenCalledTimes(calls + 2);
      for (const origin of ["", "invalid", "http://trusted.test"]) {
        vi.stubEnv("DECK_ORIGIN", origin);
        expect((await board(req())).status).toBe(401);
      }
      expect(fetch).toHaveBeenCalledTimes(calls + 2);
    } finally {
      request.jar.delete("__Host-boarding_member");
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
      db.prepare("DELETE FROM logins WHERE id = ?").run(id);
      for (const admin of admins)
        db.prepare("UPDATE logins SET role = 'admin' WHERE id = ?").run(
          admin.id
        );
    }
  });

  it("401s without a session cookie", async () => {
    const res = await me(get("/api/me", null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token" });
  });

  it("answers who the session is, with the owner flag from the admin role", async () => {
    const asOwner = (await (await me(get("/api/me", owner))).json()) as {
      owner: boolean;
    };
    const asMember = (await (await me(get("/api/me", writer))).json()) as {
      owner: boolean;
      profiles: { id: number }[];
    };
    expect(asOwner.owner).toBe(true);
    expect(asMember.owner).toBe(false);
    expect(asMember.profiles.map((p) => p.id)).toEqual([mine.profileId]);
  });

  it("refuses a profile the login is not granted", async () => {
    const res = await board(
      get(`/api/board?profile=${theirs.profileId}`, writer)
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "profile" });
  });

  const take = (
    token: string,
    headers: Record<string, string> = {
      origin: "http://allos.test",
      "content-type": "application/json",
    }
  ) =>
    boardDose(
      new Request(`http://allos.test/api/board/${myDoseId}`, {
        method: "POST",
        headers: {
          host: "allos.test",
          cookie: `${SESSION_COOKIE}=${token}`,
          ...headers,
        },
        body: JSON.stringify({ action: "take" }),
      }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
  const taken = async () => {
    const { meds } = (await (
      await board(get("/api/board", writer))
    ).json()) as {
      meds: { doses: { id: number; status: string | null }[] }[];
    };
    return meds.flatMap((m) => m.doses).find((d) => d.id === myDoseId)?.status;
  };
  const json = { "content-type": "application/json" };

  it("refuses a write from another origin, even a sibling site's, and writes nothing", async () => {
    for (const headers of [
      { ...json, origin: "https://evil.example.internal" },
      { ...json, origin: "https://evil.example" },
      { ...json, origin: "http://allos.test", "sec-fetch-site": "same-site" },
      json,
    ]) {
      const res = await take(writer, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin" });
    }
    expect(await taken()).toBeNull();
  });

  it("415s a body that is not JSON, from the right origin", async () => {
    const res = await take(writer, {
      origin: "http://allos.test",
      "content-type": "text/plain",
    });
    expect(res.status).toBe(415);
    expect(await taken()).toBeNull();
  });

  it("writes through a write grant and refuses a read-only one", async () => {
    const refused = await take(viewer);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "access" });
    expect((await take(writer)).status).toBe(200);
    expect(await taken()).toBe("taken");
  });

  // /api/ask is a write-shaped POST (#6088): a cookie-authenticated GET would let a
  // cross-site <img>, no-cors fetch or navigation spend a model call.
  const ask = (
    headers: Record<string, string>,
    body: Record<string, unknown> = { q: "glucose" },
    token = writer
  ) =>
    askRoute.POST(
      new Request("http://allos.test/api/ask", {
        method: "POST",
        headers: {
          host: "allos.test",
          cookie: `${SESSION_COOKIE}=${token}`,
          ...headers,
        },
        body: JSON.stringify(body),
      })
    );

  it("has no GET on /api/ask (405), and a cross-site POST neither answers nor logs", async () => {
    expect("GET" in askRoute).toBe(false);
    const logBefore = aiLogSize();
    const calls = vi.mocked(answerRecordQuestion).mock.calls.length;
    for (const headers of [
      { ...json, origin: "https://evil.example.internal" },
      { ...json, origin: "http://allos.test", "sec-fetch-site": "same-site" },
      json,
    ]) {
      const res = await ask(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin" });
    }
    expect(vi.mocked(answerRecordQuestion).mock.calls.length).toBe(calls);
    expect(aiLogSize()).toBe(logBefore);
  });

  it("answers a same-origin JSON POST from the session's own profile", async () => {
    const calls = vi.mocked(answerRecordQuestion).mock.calls.length;
    const res = await ask({ ...json, origin: "http://allos.test" });
    expect(res.status).toBe(200);
    // The spy sees an answered call, so the refusal test's unchanged count means something.
    expect(vi.mocked(answerRecordQuestion).mock.calls.length).toBe(calls + 1);
    const body = (await res.json()) as {
      profile: number;
      offline: boolean;
      citations: { title: string }[];
    };
    expect(body.profile).toBe(mine.profileId);
    expect(body.offline).toBe(true);
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations.every((c) => !c.title.includes("WebTheirs"))).toBe(
      true
    );
    const empty = await ask(
      { ...json, origin: "http://allos.test" },
      { q: " " }
    );
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "q" });
  });

  // Deck's web host sends the chosen profile in the body (deck-ui host/backends.js
  // webPost): it must decide the profile, under the same grants as `?profile=`.
  it("asks the body's profile when the login reaches it, else 403s before any model call", async () => {
    const same = { ...json, origin: "http://allos.test" };
    const other = await ask(
      same,
      { q: "glucose", profile: theirs.profileId },
      owner
    );
    expect(other.status).toBe(200);
    const answered = (await other.json()) as {
      profile: number;
      citations: { title: string }[];
    };
    expect(answered.profile).toBe(theirs.profileId);
    expect(answered.citations.every((c) => !c.title.includes("WebMine"))).toBe(
      true
    );

    const logBefore = aiLogSize();
    const calls = vi.mocked(answerRecordQuestion).mock.calls.length;
    const refused = await ask(same, {
      q: "glucose",
      profile: theirs.profileId,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "profile" });
    expect(vi.mocked(answerRecordQuestion).mock.calls.length).toBe(calls);
    expect(aiLogSize()).toBe(logBefore);
  });
});

describe("the Health page — the owner's alone", () => {
  const as = (token: string | null) => {
    request.jar.clear();
    if (token) request.jar.set(SESSION_COOKIE, token);
  };

  it("404s the page and its module for a member and for no session", async () => {
    for (const token of [writer, null]) {
      as(token);
      expect((await page()).status).toBe(404);
      expect((await script()).status).toBe(404);
    }
  });

  it.each(["", "/health"])(
    "mounts Health with API transport and links under %s",
    async (base) => {
      vi.stubEnv("DECK_BASE_PATH", base);
      as(owner);
      const calls: string[] = [];
      const fetch = async (input: string | URL) => {
        calls.push(String(input));
        if (String(input).startsWith("https:")) return Response.json({});
        return new Response(
          readFileSync(`public${String(input).slice(base.length)}`, "utf8")
        );
      };
      const mount = vi.fn();
      const host = vi.fn((transport: { fetch: typeof fetch }) => {
        void transport.fetch("https://deck.test/allos/api/board?profile=7");
        return { backends: ["allos"] };
      });
      try {
        const entry = deckHealthScript();
        expect(
          [...entry.matchAll(/^import .* from "([^"]+)";/gm)].map(
            (match) => match[1]
          )
        ).toEqual([
          `${base}/deck-ui/${pin.version}/ui/src/mount.js`,
          `${base}/deck-ui/${pin.version}/ui/src/host/web.js`,
          `${base}/deck-ui/${pin.version}/ui/src/host/backends.js`,
        ]);
        // Execute the actual entry module with synthetic browser and mount boundaries.
        const execute = new Function(
          "mountHealth",
          "webHost",
          "ALLOS_OPS",
          "window",
          "location",
          "navigator",
          "localStorage",
          "WebSocket",
          "fetch",
          "document",
          `return (async () => {${entry.replace(/^import .*;$/gm, "")} })()`
        );
        await execute(
          mount,
          host,
          {},
          { open() {}, matchMedia() {} },
          { origin: "https://deck.test" },
          {},
          {},
          class {},
          fetch,
          { getElementById: () => "mount" }
        );
        expect(calls).toEqual([
          `${base}/deck-ui/${pin.version}/ui/contract/nav.json`,
          `https://deck.test${base}/api/board?profile=7`,
        ]);
        expect(mount).toHaveBeenCalledWith(
          "mount",
          { backends: ["allos"] },
          {
            nav: expect.arrayContaining([
              {
                id: "health",
                label: "Health",
                backend: "allos",
                group: "top",
                href: base || "/",
              },
            ]),
          }
        );
        const pageBody = await (await page()).text();
        expect(pageBody).toContain(`src="${base}/health.js"`);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it("serves the owner the page under the bundle's CSP, with no inline script", async () => {
    as(owner);
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "script-src 'self'"
    );
    expect(await res.text()).not.toMatch(/<script(?![^>]* src=)/);
    expect((await script()).status).toBe(200);
  });
});
