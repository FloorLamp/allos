// DB INTEGRATION TIER — Deck's Health place on allos's own origin (FloorLamp/allos#6076,
// part 2): the `/api` session twins of the `/v1` routes, and the owner-only place.
//
// The twins are the SAME handlers, authenticated by the session cookie instead of a
// device credential: a person reaches only the profiles their login is granted, a
// read-only grant writes nothing, and no cookie is a 401. The place (page and module)
// is the admin role's alone: anyone else gets a 404, and the page carries the bundle's
// own CSP. Synthetic fixtures only.

import { describe, it, expect, beforeAll, vi } from "vitest";

// The place reads the session through the cookie jar. This tier's shared setup mocks
// @/lib/auth for the server-action suite; this file is about the real session.
const request = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) =>
      request.jar.has(name)
        ? { name, value: request.jar.get(name)! }
        : undefined,
  }),
}));

import { db } from "@/lib/db";
import { SESSION_COOKIE, createSession } from "@/lib/auth";
import { seedProfile } from "./fixtures";
import { GET as me } from "@/app/api/me/route";
import { GET as board } from "@/app/api/board/route";
import { POST as boardDose } from "@/app/api/board/[doseId]/route";
import { GET as page } from "@/app/deck/health/route";
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

  it("writes through a write grant and refuses a read-only one", async () => {
    const take = (token: string) =>
      boardDose(
        new Request(`http://allos.test/api/board/${myDoseId}`, {
          method: "POST",
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
          body: JSON.stringify({ action: "take" }),
        }),
        { params: Promise.resolve({ doseId: String(myDoseId) }) }
      );
    const refused = await take(viewer);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "access" });
    expect((await take(writer)).status).toBe(200);
  });
});

describe("the Health place — the owner's alone", () => {
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
