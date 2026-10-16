// DB INTEGRATION TIER — the device API (`/v1`, FloorLamp/allos#6076), driven as the
// REAL route handlers with synthesized requests and a stubbed boarding.
//
// What matters here is the boundary: a credential boarding refuses (none, malformed,
// revoked or expired) is 401; boarding not answering is 503 and never a device; a
// device without the route's scope is 403; a verified device the owner never linked is
// 403; and a linked device reads and writes ONLY the profiles its login is granted —
// another profile's rows never come back, and another profile's dose id writes
// nothing. Then each route's shape.
//
// Every credential below is made up at runtime. No health data: synthetic fixtures only.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { seedProfile } from "./fixtures";
import { linkDevice } from "@/lib/device-logins";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { GET as webAccounts } from "@/app/api/accounts/route";
import { GET as accounts } from "@/app/v1/accounts/route";
import {
  upsertConnection,
  recordSyncEvent,
} from "@/lib/integrations/connections";
import {
  createPortal,
  accountsForPortal,
  bindPortalIdentity,
  recordPortalRunReport,
} from "@/lib/portals";
import { setPublicUrl, setSetting } from "@/lib/settings";
import { GET as healthz } from "@/app/healthz/route";
import { GET as needs } from "@/app/v1/needs/route";
import { GET as me } from "@/app/v1/me/route";
import { GET as profiles } from "@/app/v1/profiles/route";
import { GET as find } from "@/app/v1/find/route";
import { GET as record } from "@/app/v1/record/route";
import { GET as ask } from "@/app/v1/ask/route";
import { GET as board } from "@/app/v1/board/route";
import { POST as boardDose } from "@/app/v1/board/[doseId]/route";
import { GET as readings, POST as logReading } from "@/app/v1/readings/route";
import { GET as labs } from "@/app/v1/labs/route";

// Exercise the real device and cookie authorization boundaries.
vi.unmock("@/lib/auth");

// ── A boarding stand-in ──────────────────────────────────────────────────────────
//
// Boarding is asked for a credential's SHA-256 and answers the device and its scopes
// (or null). The stub keeps that table keyed the same way, so the verifier's own
// hashing is exercised; `down` makes it unreachable (a thrown fetch) and `broken`
// makes it answer nonsense, both of which must fail closed.
type Answer = { name: string; scopes: string[]; expires?: string } | null;
const answers = new Map<string, Answer>();
let down = false;
let broken = false;
// `failing`: a well-formed device answer under a non-200 status (boarding erroring
// mid-answer) must still fail closed: the status is checked, not only the body.
let failing = false;

function credential(answer: Answer): string {
  const token = `dev_${randomBytes(32).toString("base64url")}`;
  answers.set(createHash("sha256").update(token).digest("hex"), answer);
  return token;
}

beforeAll(() => {
  vi.stubEnv("DECK_ORIGIN", "https://deck.example.internal");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (down) throw new Error("ECONNREFUSED");
      if (broken) return new Response("boom", { status: 500 });
      const { sha256 } = JSON.parse(String(init?.body)) as { sha256: string };
      const device = answers.has(sha256) ? answers.get(sha256) : null;
      return Response.json({ device }, { status: failing ? 503 : 200 });
    })
  );
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function req(
  path: string,
  token: string | null,
  init: RequestInit = {}
): Request {
  return new Request(`http://allos.test${path}`, {
    ...init,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function post(path: string, token: string, body: unknown): Request {
  return new Request(`http://allos.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const ALL = ["allos:read", "allos:ask", "allos:log"];

function makeLogin(username: string, role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────
let mine: ReturnType<typeof seedProfile>;
let theirs: ReturnType<typeof seedProfile>;
let myDoseId: number;
let theirDoseId: number;
// A device linked to a member who writes `mine` only.
let phone: string;
// A device linked to a member who may only READ `mine`.
let reader: string;
// Verified by boarding, linked by nobody.
let stranger: string;
// Linked, but holding `allos:read` alone.
let readOnlyScopes: string;
// Linked to the owner's account (allos's `admin` role).
let ownerDesk: string;

beforeAll(() => {
  mine = seedProfile("DevMine");
  theirs = seedProfile("DevTheirs");
  const dose = (itemId: number) =>
    (
      db
        .prepare("SELECT id FROM intake_item_doses WHERE item_id = ?")
        .get(itemId) as { id: number }
    ).id;
  myDoseId = dose(mine.medicationId);
  theirDoseId = dose(theirs.medicationId);

  const writer = makeLogin("device-writer", "member");
  const viewer = makeLogin("device-viewer", "member");
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(writer, mine.profileId);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(viewer, mine.profileId);

  phone = credential({ name: "pixel", scopes: ALL });
  reader = credential({ name: "kiosk", scopes: ALL });
  stranger = credential({ name: "loaner", scopes: ALL });
  readOnlyScopes = credential({ name: "macmini", scopes: ["allos:read"] });
  ownerDesk = credential({ name: "win11", scopes: ALL });
  linkDevice("pixel", writer);
  linkDevice("kiosk", viewer);
  linkDevice("macmini", writer);
  linkDevice("win11", makeLogin("device-owner", "admin"));
});

// ── The credential ───────────────────────────────────────────────────────────────
describe("/v1 — the device credential, verified with boarding", () => {
  it("401s with no credential, and never asks boarding", async () => {
    const before = vi.mocked(fetch).mock.calls.length;
    const res = await needs(req("/v1/needs", null));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "token" });
    expect(vi.mocked(fetch).mock.calls.length).toBe(before);
  });

  it("401s a credential boarding does not know (revoked, expired, never issued)", async () => {
    const res = await needs(req("/v1/needs", credential(null)));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: "token" });
  });

  it("401s a credential whose expiry has passed, once boarding's answer lapses", async () => {
    // Boarding answers an expiry in the past: the verifier must not cache it as live.
    const token = credential({
      name: "old-phone",
      scopes: ALL,
      expires: "2001-01-01T00:00:00Z",
    });
    linkDevice("old-phone", makeLogin("device-expired", "admin"));
    const first = await needs(req("/v1/needs", token));
    expect(first.status).toBe(200);
    answers.set(createHash("sha256").update(token).digest("hex"), null);
    const second = await needs(req("/v1/needs", token));
    expect(second.status).toBe(401);
  });

  it("503s when boarding answers a device under a non-200 status", async () => {
    const token = credential({ name: "m1x", scopes: ALL });
    failing = true;
    try {
      const res = await needs(req("/v1/needs", token));
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "boarding" });
    } finally {
      failing = false;
    }
  });

  it("503s when boarding is unreachable, and again when it answers nonsense — never a device", async () => {
    const token = credential({ name: "m1x", scopes: ALL });
    down = true;
    try {
      const res = await needs(req("/v1/needs", token));
      expect(res.status).toBe(503);
      expect(await json(res)).toEqual({ error: "boarding" });
    } finally {
      down = false;
    }
    broken = true;
    try {
      const res = await needs(req("/v1/needs", token));
      expect(res.status).toBe(503);
    } finally {
      broken = false;
    }
  });

  it("403s a device without the route's scope", async () => {
    const res = await ask(req("/v1/ask?q=glucose", readOnlyScopes));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "scope" });
  });

  it("403s a verified device the owner never linked to a login", async () => {
    const res = await needs(req("/v1/needs", stranger));
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "device" });
  });
});

// ── Profile scoping ──────────────────────────────────────────────────────────────
describe("/v1 — a device sees only its login's profiles", () => {
  it("/v1/me names the linked login; owner is allos's admin role, never a name", async () => {
    const owner = await json(await me(req("/v1/me", ownerDesk)));
    expect(owner.owner).toBe(true);
    expect(owner.login).toEqual({
      id: expect.any(Number),
      label: "device-owner",
    });
    // An admin reaches every profile, so both seeded ones are listed.
    expect(owner.profiles).toEqual(
      expect.arrayContaining([
        { id: mine.profileId, label: "DevMine" },
        { id: theirs.profileId, label: "DevTheirs" },
      ])
    );
    const member = await json(await me(req("/v1/me", phone)));
    expect(member.owner).toBe(false);
    expect(member.profiles).toEqual([{ id: mine.profileId, label: "DevMine" }]);
    const unlinked = await me(req("/v1/me", stranger));
    expect(unlinked.status).toBe(403);
    expect(await json(unlinked)).toEqual({ error: "device" });
  });

  it("lists the granted profile with its access, and refuses an ungranted one", async () => {
    const res = await profiles(req("/v1/profiles", phone));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.profile).toBe(mine.profileId);
    expect(body.profiles).toEqual([
      { id: mine.profileId, name: "DevMine", access: "write" },
    ]);
    const other = await profiles(
      req(`/v1/profiles?profile=${theirs.profileId}`, phone)
    );
    expect(other.status).toBe(403);
    expect(await json(other)).toEqual({ error: "profile" });
  });

  it("finds only the linked profile's records", async () => {
    const hits = await json(await find(req("/v1/find?q=DevMine", phone)));
    const results = hits.results as { kind: string; title: string }[];
    expect(results.some((r) => r.title === "DevMine Lisinopril")).toBe(true);
    expect(JSON.stringify(results)).not.toContain("DevTheirs");
    const none = await json(await find(req("/v1/find?q=DevTheirs", phone)));
    expect(
      (none.results as { kind: string }[]).filter((r) => r.kind !== "page")
    ).toEqual([]);
  });

  it("reads a record by key for its own profile and 404s another's", async () => {
    const ok = await record(
      req(`/v1/record?key=document:${mine.documentId}`, phone)
    );
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body.kind).toBe("document");
    expect((body.record as { filename: string }).filename).toBe(
      "DevMine-labs.pdf"
    );
    expect(body.record).not.toHaveProperty("stored_path");
    const no = await record(
      req(`/v1/record?key=document:${theirs.documentId}`, phone)
    );
    expect(no.status).toBe(404);
  });
});

// ── Shapes ───────────────────────────────────────────────────────────────────────
describe("/v1 — each route's shape", () => {
  it("/healthz answers ok with an empty needs list; /v1/needs the same list", async () => {
    const h = await json(await healthz());
    expect(h.ok).toBe(true);
    expect(h.needs).toEqual([]);
    expect(await json(await needs(req("/v1/needs", phone)))).toEqual({
      needs: [],
    });
  });

  it("/v1/ask answers offline from the profile's own citations when no model is configured", async () => {
    const body = await json(await ask(req("/v1/ask?q=glucose", phone)));
    expect(body.offline).toBe(true);
    const citations = body.citations as { kind: string; title: string }[];
    expect(citations.some((c) => c.kind === "clinical-result")).toBe(true);
    expect(citations.every((c) => !c.title.includes("DevTheirs"))).toBe(true);
    expect((await ask(req("/v1/ask", phone))).status).toBe(400);
  });

  it("/v1/labs lists the latest lab per marker with its freshness", async () => {
    const body = await json(await labs(req("/v1/labs", phone)));
    expect(body.day).toBe(mine.todayStr);
    expect(body.labs).toEqual([
      expect.objectContaining({
        name: "Glucose",
        value: String(mine.glucoseValueNum),
        unit: "mg/dL",
        date: mine.todayStr,
        freshness: "current",
      }),
    ]);
  });

  it("/v1/board lists today's scheduled doses; take, restate, clear write through the one core", async () => {
    const before = await json(await board(req("/v1/board", phone)));
    expect(before.day).toBe(mine.todayStr);
    const meds = before.meds as {
      id: number;
      name: string;
      doses: { id: number; status: string | null }[];
    }[];
    const med = meds.find((m) => m.id === mine.medicationId);
    expect(med?.name).toBe("DevMine Lisinopril");
    expect(med?.doses).toEqual([
      expect.objectContaining({ id: myDoseId, status: null }),
    ]);

    const taken = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "take" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(taken.status).toBe(200);
    expect((await json(taken)).outcome).toBe("logged");
    const after = await json(await board(req("/v1/board", phone)));
    const dose = (after.meds as typeof meds)
      .flatMap((m) => m.doses)
      .find((d) => d.id === myDoseId);
    expect(dose?.status).toBe("taken");

    // A taken dose is never deleted and re-taken: the row keeps its id, recorded_at,
    // logged_via, amount and time, whether `at` parses or not.
    const row = () =>
      db
        .prepare(
          "SELECT id, recorded_at, occurred_at, logged_via, amount FROM intake_item_logs WHERE dose_id = ? AND date = ?"
        )
        .all(myDoseId, mine.todayStr);
    const kept = row();
    expect(kept).toHaveLength(1);
    const again = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "take", at: "07:30" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: "already-taken" });
    expect(row()).toEqual(kept);
    const unparsed = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "take", at: "half past" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(unparsed.status).toBe(400);
    expect(await json(unparsed)).toEqual({ error: "at" });
    expect(row()).toEqual(kept);

    const cleared = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "clear" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect((await json(cleared)).outcome).toBe("cleared");
    // A non-string `at` on an untaken dose is refused, not logged as a take with no time.
    const numeric = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "take", at: 730 }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(numeric.status).toBe(400);
    expect(await json(numeric)).toEqual({ error: "at" });
    expect(row()).toEqual([]);

    const bad = await boardDose(
      post(`/v1/board/${myDoseId}`, phone, { action: "eat" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(bad.status).toBe(400);
  });

  it("/v1/board/<doseId> writes nothing for another profile's dose, nor for a read-only grant", async () => {
    const foreign = await boardDose(
      post(`/v1/board/${theirDoseId}`, phone, { action: "take" }),
      { params: Promise.resolve({ doseId: String(theirDoseId) }) }
    );
    expect(foreign.status).toBe(404);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM intake_item_logs WHERE dose_id = ?")
        .get(theirDoseId)
    ).toEqual({ n: 0 });

    const readOnly = await boardDose(
      post(`/v1/board/${myDoseId}`, reader, { action: "take" }),
      { params: Promise.resolve({ doseId: String(myDoseId) }) }
    );
    expect(readOnly.status).toBe(403);
    expect(await json(readOnly)).toEqual({ error: "access" });
  });

  it("/v1/readings logs a weigh-in in the stated unit and reads it back in kg", async () => {
    const wrote = await logReading(
      post("/v1/readings", phone, { weight: 180, weightUnit: "lb" })
    );
    expect(wrote.status).toBe(200);
    expect((await json(wrote)).wrote).toEqual(["body"]);
    const body = await json(await readings(req("/v1/readings", phone)));
    const weight = (
      body.readings as {
        kind: string;
        value: number;
        unit: string;
        date: string;
      }[]
    ).find((r) => r.kind === "weight");
    expect(weight).toEqual({
      kind: "weight",
      value: expect.closeTo(81.65, 1),
      unit: "kg",
      date: mine.todayStr,
    });

    const empty = await logReading(post("/v1/readings", phone, {}));
    expect(empty.status).toBe(400);
    const future = await logReading(
      post("/v1/readings", phone, { weight: 80, day: "2999-01-01" })
    );
    expect(future.status).toBe(400);
    const readOnly = await logReading(
      post("/v1/readings", reader, { weight: 80 })
    );
    expect(readOnly.status).toBe(403);
  });
});

describe("/v1/accounts", () => {
  it("lists only granted connections, with coverage and no patient or credential content", async () => {
    setPublicUrl("https://allos.example");
    upsertConnection(mine.profileId, "oura", {
      status: "connected",
      config: { token: "secret-token" },
    });
    upsertConnection(mine.profileId, "health-connect", { status: "connected" });
    upsertConnection(theirs.profileId, "strava", {
      status: "connected",
      config: { token: "other-secret" },
    });
    recordSyncEvent(mine.profileId, "oura", {
      ok: true,
      written: 7,
      windowStart: "2026-10-01",
      windowEnd: "2026-10-02",
    });
    const portal = createPortal("Example Clinic", "mychart");
    if (!portal.ok) throw new Error(portal.error);
    const account = accountsForPortal(portal.id)[0];
    bindPortalIdentity(account.id, "PRIVATE PATIENT MRN", mine.profileId);
    recordPortalRunReport(account, {
      ok: false,
      status: "failed",
      message: "PRIVATE DIAGNOSIS",
      discovered: 1,
    });
    const hidden = createPortal("Hidden Clinic", "ecw");
    if (!hidden.ok) throw new Error(hidden.error);
    bindPortalIdentity(
      accountsForPortal(hidden.id)[0].id,
      "OTHER PATIENT",
      theirs.profileId
    );
    setSetting(
      "accounts_rover_origins",
      JSON.stringify({ [account.id]: "rover:example" })
    );
    const res = await accounts(req("/v1/accounts", phone));
    expect(res.status).toBe(200);
    const body = await res.text();
    const data = JSON.parse(body);
    expect(data.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          institution: "Oura Ring",
          state: "ok",
          lastRun: { at: expect.stringMatching(/Z$/), outcome: "success" },
          data: {
            kind: "readings",
            count: 7,
            from: "2026-10-01",
            to: "2026-10-02",
            storedAt: "allos",
          },
        }),
        expect.objectContaining({
          institution: "Google Health Connect",
          state: "unknown",
          lastRun: null,
        }),
        expect.objectContaining({
          institution: "Example Clinic",
          state: "failing",
          from: { backend: "rover", id: "rover:example" },
        }),
      ])
    );
    for (const secret of [
      "secret-token",
      "other-secret",
      "PRIVATE",
      "OTHER PATIENT",
      "Hidden Clinic",
      "Strava",
      "scrypt$",
    ])
      expect(body).not.toContain(secret);
    for (const row of data.accounts) {
      expect(row.id).toMatch(/^[a-z0-9][a-z0-9:._@-]{0,199}$/);
      expect(row.person).toBe("DevMine");
      expect(row.actions[0].url).toMatch(/^https:\/\/allos.example\//);
    }
    const cached = await accounts(
      new Request("http://allos.test/v1/accounts", {
        headers: {
          authorization: `Bearer ${phone}`,
          "if-none-match": res.headers.get("etag")!,
        },
      })
    );
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    recordSyncEvent(mine.profileId, "health-connect", {
      ok: false,
      error: "PRIVATE DOCUMENT TITLE",
      windowStart: "PRIVATE MRN",
    });
    const safe = await accounts(req("/v1/accounts", phone));
    expect(await safe.text()).not.toContain("PRIVATE");
    upsertConnection(mine.profileId, "health-connect", {
      status: "disconnected",
    });
    const changed = await accounts(
      new Request("http://allos.test/v1/accounts", {
        headers: {
          authorization: `Bearer ${phone}`,
          "if-none-match": res.headers.get("etag")!,
        },
      })
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(res.headers.get("etag"));
  });

  it("uses session grants across profiles; the admin's own profile is owner whoever asks", async () => {
    const login = makeLogin("accounts-session", "member");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(login, mine.profileId);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(login, theirs.profileId);
    db.prepare("UPDATE profiles SET name = 'Cloris Family' WHERE id = ?").run(
      theirs.profileId
    );
    db.prepare(
      "UPDATE logins SET own_profile_id = ? WHERE username = 'device-owner'"
    ).run(mine.profileId);
    const { token } = createSession(login);
    const res = await webAccounts(
      new Request("http://allos.test/api/accounts", {
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: "https://deck.example.internal",
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://deck.example.internal"
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
    for (const [origin, allowed] of [
      ["https://evil.example.internal", null],
      ["", null],
    ] as const) {
      const other = await webAccounts(
        new Request("http://allos.test/api/accounts", {
          headers: { cookie: `${SESSION_COOKIE}=${token}`, origin },
        })
      );
      expect(other.status).toBe(200);
      expect(other.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(other.headers.get("vary")).toBe("Origin");
    }
    for (const [headers, status] of [
      [
        {
          "if-none-match": res.headers.get("etag")!,
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        304,
      ],
      [{}, 401],
      [
        {
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        403,
      ],
    ] as const) {
      const response = await webAccounts(
        new Request(
          `http://allos.test/api/accounts${status === 403 ? "?profile=999999" : ""}`,
          {
            headers: { ...headers, origin: "https://deck.example.internal" },
          }
        )
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://deck.example.internal"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe(
        "true"
      );
      expect(response.headers.get("vary")).toBe("Origin");
    }
    expect((await res.json()).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ institution: "Strava", person: "Cloris" }),
        expect.objectContaining({ institution: "Oura Ring", person: "owner" }),
      ])
    );
    const owner = await accounts(req("/v1/accounts", ownerDesk));
    expect((await owner.json()).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ institution: "Oura Ring", person: "owner" }),
        expect.objectContaining({ institution: "Strava", person: "Cloris" }),
      ])
    );
    expect(
      (await webAccounts(new Request("http://allos.test/api/accounts"))).status
    ).toBe(401);
  });

  it("uses the configured Deck origin and disables CORS when unset", async () => {
    vi.stubEnv("DECK_ORIGIN", "https://deck.example");
    try {
      for (const origin of [
        "https://deck.example",
        "https://deck.example.internal",
      ]) {
        const res = await webAccounts(
          new Request("http://allos.test/api/accounts", { headers: { origin } })
        );
        expect(res.status).toBe(401);
        expect(res.headers.get("access-control-allow-origin")).toBe(
          origin === "https://deck.example" ? origin : null
        );
      }
      vi.stubEnv("DECK_ORIGIN", "");
      const res = await webAccounts(
        new Request("http://allos.test/api/accounts", {
          headers: { origin: "https://deck.example" },
        })
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      vi.stubEnv("DECK_ORIGIN", "https://deck.example.internal");
    }
  });

  // allos's own standing decides `state` (lib/integrations/source-state.ts): a feed
  // silent past its tolerance is failing, as on its Integrations page, never a
  // stale "ok" from the last event.
  it("reads a source silent past its tolerance as failing", async () => {
    upsertConnection(mine.profileId, "oura", { status: "connected" });
    recordSyncEvent(mine.profileId, "oura", { ok: true, written: 1 });
    const oura = async () =>
      (
        (await (await accounts(req("/v1/accounts", phone))).json())
          .accounts as {
          institution: string;
          state: string;
        }[]
      ).find((a) => a.institution === "Oura Ring")?.state;
    expect(await oura()).toBe("ok");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 30 * 86_400_000);
      expect(await oura()).toBe("failing");
    } finally {
      vi.useRealTimers();
    }
  });

  // Deck's Accounts place reads the twin from https://deck.example.internal: that origin
  // exactly, with credentials, on every answer; never a sibling or reflected one.
  it("lets Deck's origin read the accounts twin, and no other origin", async () => {
    const login = makeLogin("accounts-cors", "member");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(login, mine.profileId);
    const { token } = createSession(login);
    const call = (origin: string, cookie = true) =>
      webAccounts(
        new Request("http://allos.test/api/accounts", {
          headers: {
            origin,
            ...(cookie ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
          },
        })
      );
    const deck = await call("https://deck.example.internal");
    expect(deck.status).toBe(200);
    expect(deck.headers.get("access-control-allow-origin")).toBe(
      "https://deck.example.internal"
    );
    expect(deck.headers.get("access-control-allow-credentials")).toBe("true");
    expect(deck.headers.get("vary")).toMatch(/Origin/);
    expect((await deck.json()).accounts.length).toBeGreaterThan(0);
    const sibling = await call("https://evil.example.internal");
    expect(sibling.headers.get("access-control-allow-origin")).toBeNull();
    expect(sibling.headers.get("vary")).toMatch(/Origin/);
    const refused = await call("https://deck.example.internal", false);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe(
      "https://deck.example.internal"
    );
  });

  it("refuses a credential without allos:read", async () => {
    const res = await accounts(
      req(
        "/v1/accounts",
        credential({ name: "accounts-no-read", scopes: ["allos:log"] })
      )
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "scope" });
  });
});
