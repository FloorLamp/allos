// DB INTEGRATION TIER — `GET /api/documents/portals` (#1759), driven as the REAL route
// handler with synthesized requests.
//
// This endpoint exists so a tool can INGEST the allos-minted slug vocabulary instead of
// transcribing it. That makes two things worth pinning, and they are the whole file:
//
//   THE GATE mirrors the card's (#1753's owner ruling) — write access to at least one
//   profile — so a read-only-everywhere caregiver is refused rather than handed an empty
//   list, and an absent/revoked token never reaches the registry at all.
//
//   THE DISCLOSURE BOUNDARY. The payload carries slug/name/software and the accounts'
//   slug/name/implicit, and NOTHING else. There is no address-shaped field (allos has no
//   column for one) and no patient labels — mapped, pending and ignored bindings alike.
//   Those are asserted over the SERIALIZED response, recursively, so a field added to
//   `Portal` or `PortalAccount` later cannot leak by being spread into the shape.
//
//   THE REACHABILITY BOUNDARY (#1796), a third thing since the owner ruled the registry
//   scoped: passing the gate no longer buys the whole instance's vocabulary. WHICH rows
//   come back is decided by the one reachability computation #1791 wrote for run reports
//   (`lib/portal-visibility.ts`), so those two boundaries stay separate and separately
//   tested — `buildToolConfig` owns what a row may CARRY, the reader owns which rows
//   there ARE.
//
// NOT TESTED, because it is unrepresentable: a "wrong scope" 403. `API_TOKEN_SCOPES` has
// exactly one member today and `apiTokenById` coerces an unknown stored scope back to it,
// so a token carrying a different capability cannot be constructed. When a second scope
// lands (a rebuild migration, per lib/api-token-format.ts), that case belongs here.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { GET } from "@/app/api/documents/portals/route";
import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import {
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  ignorePortalIdentity,
  recordPendingIdentity,
  accountsForPortal,
  portalById,
} from "@/lib/portals";

let writerToken: string;
let readOnlyToken: string;
let strangerToken: string;
let revokedToken: string;
let adminToken: string;

let ochsnerId: number;
let baptistId: number;
let writeProfile: number;

function req(token: string | null): Request {
  return new Request("http://x/api/documents/portals", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function makeLogin(username: string, role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'scrypt$2$1$1$00$00', ?)"
      )
      .run(username, role).lastInsertRowid
  );
}

// Every string anywhere in a JSON value, so a disclosure assertion cannot be defeated by
// a field moving one level deeper.
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  return out;
}

beforeAll(async () => {
  writeProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Portals Writable')").run()
      .lastInsertRowid
  );
  const readProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Portals Readonly')").run()
      .lastInsertRowid
  );

  const writerLogin = makeLogin("portals-writer", "member");
  const readOnlyLogin = makeLogin("portals-readonly", "member");
  const strangerLogin = makeLogin("portals-stranger", "member");
  const adminLogin = makeLogin("portals-admin", "admin");

  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(writerLogin, writeProfile);
  // The caregiver who can SEE a profile but may not write it — the population the card
  // deliberately does not show, so the token is deliberately refused.
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(readOnlyLogin, readProfile);

  writerToken = (await createApiToken(writerLogin, "w", "upload:documents"))
    .token;
  readOnlyToken = (await createApiToken(readOnlyLogin, "r", "upload:documents"))
    .token;
  strangerToken = (await createApiToken(strangerLogin, "s", "upload:documents"))
    .token;
  adminToken = (await createApiToken(adminLogin, "a", "upload:documents"))
    .token;

  const revoked = await createApiToken(writerLogin, "x", "upload:documents");
  revokedToken = revoked.token;
  revokeApiToken(revoked.id, writerLogin, "member");

  // Two portals: one multi-login (implicit + two named), one single-login.
  const ochsner = createPortal("Test Ochsner MyChart", "mychart");
  expect(ochsner.ok).toBe(true);
  ochsnerId = ochsner.ok ? ochsner.id : 0;
  const baptist = createPortal("Test Baptist Health");
  expect(baptist.ok).toBe(true);
  baptistId = baptist.ok ? baptist.id : 0;

  expect(createPortalAccount(ochsnerId, "Mom").ok).toBe(true);
  expect(createPortalAccount(ochsnerId, "Dad").ok).toBe(true);

  // Household information the payload must never carry: a bound patient, an ignored
  // one, and one still waiting to be mapped.
  const mom = accountsForPortal(ochsnerId).find((a) => a.slug === "mom")!;
  expect(mom.slug).toBe("mom");
  expect(
    bindPortalIdentity(mom.id, "TESTPATIENT, BOUND", writeProfile).ok
  ).toBe(true);
  expect(ignorePortalIdentity(mom.id, "TESTPATIENT, IGNORED").ok).toBe(true);
  recordPendingIdentity(
    "test-ochsner-mychart",
    "mom",
    "TESTPATIENT, PENDING",
    "unmapped-sync-report"
  );
});

describe("GET /api/documents/portals — the gate", () => {
  it("401s without a token", async () => {
    const res = await GET(req(null));
    expect(res.status).toBe(401);
  });

  it("401s a revoked token", async () => {
    const res = await GET(req(revokedToken));
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
  });

  it("403s a read-only-everywhere caregiver", async () => {
    const res = await GET(req(readOnlyToken));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Refused, not "here are your zero portals". The gate is about the CAPABILITY, and
    // it stayed exactly where #1753 put it when #1796 scoped the ANSWER: a caregiver who
    // may not write anywhere cannot ask the question at all, so there is no scoped empty
    // list to hand back.
    expect(body.portals).toBeUndefined();
  });

  it("403s a login with no access anywhere", async () => {
    const res = await GET(req(strangerToken));
    expect(res.status).toBe(403);
  });

  it("serves a member with write access to at least one profile", async () => {
    const res = await GET(req(writerToken));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("serves an admin (write everywhere by role)", async () => {
    const res = await GET(req(adminToken));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/documents/portals — the shape", () => {
  it("returns each portal's slug, name, software and accounts", async () => {
    const body = await (await GET(req(writerToken))).json();
    const portals = body.portals as {
      slug: string;
      name: string;
      software: string | null;
      accounts: { slug: string; name: string; implicit: boolean }[];
    }[];

    const ochsner = portals.find((p) => p.slug === "test-ochsner-mychart")!;
    expect(ochsner).toBeDefined();
    expect(ochsner.name).toBe("Test Ochsner MyChart");
    expect(ochsner.software).toBe("mychart");

    const baptist = portals.find((p) => p.slug === "test-baptist-health")!;
    expect(baptist.software).toBeNull();
    // A single-login portal: exactly one account, and it is the implicit one — which is
    // precisely what lets a tool derive "I may omit `account` on the wire".
    expect(baptist.accounts).toEqual([
      { slug: "default", name: "Default login", implicit: true },
    ]);
  });

  it("orders accounts implicit-first, then by name, and flags implicit honestly", async () => {
    const body = await (await GET(req(writerToken))).json();
    const ochsner = (
      body.portals as { slug: string; accounts: unknown[] }[]
    ).find((p) => p.slug === "test-ochsner-mychart")!;
    expect(ochsner.accounts).toEqual([
      { slug: "default", name: "Default login", implicit: true },
      { slug: "dad", name: "Dad", implicit: false },
      { slug: "mom", name: "Mom", implicit: false },
    ]);
  });

  it("names the registry rows the card shows, keyed the way the wire spells them", async () => {
    const body = await (await GET(req(writerToken))).json();
    const ochsner = (
      body.portals as { slug: string; accounts: { slug: string }[] }[]
    ).find((p) => p.slug === "test-ochsner-mychart")!;
    // The slugs a tool writes into local config are exactly the stored ones — the whole
    // point of the endpoint is that these two can never diverge by transcription.
    expect(portalById(ochsnerId)!.slug).toBe(ochsner.slug);
    expect(
      accountsForPortal(ochsnerId)
        .map((a) => a.slug)
        .sort()
    ).toEqual(ochsner.accounts.map((a) => a.slug).sort());
    expect(baptistId).toBeGreaterThan(0);
  });
});

describe("GET /api/documents/portals — the disclosure boundary", () => {
  it("carries no patient labels — mapped, ignored or pending", async () => {
    const body = await (await GET(req(writerToken))).json();
    const strings = allStrings(body).join(" ");
    expect(strings).not.toContain("TESTPATIENT");
    expect(strings).not.toContain("BOUND");
    expect(strings).not.toContain("IGNORED");
    expect(strings).not.toContain("PENDING");
    // And the household's own bookkeeping stays out too: no profile ids, no counts.
    expect(allKeys(body)).not.toContain("profileId");
    expect(allKeys(body)).not.toContain("identities");
    expect(allKeys(body)).not.toContain("pending");
  });

  it("carries no URL-shaped field anywhere", async () => {
    const res = await GET(req(writerToken));
    const raw = await res.text();
    // Over the RAW serialization, so nothing hides in a nested object or an array.
    expect(raw).not.toMatch(/https?:\/\//i);
    expect(raw.toLowerCase()).not.toContain("://");
    const keys = allKeys(JSON.parse(raw)).map((k) => k.toLowerCase());
    for (const banned of [
      "url",
      "address",
      "host",
      "hostname",
      "domain",
      "endpoint",
      "link",
      "href",
    ]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("exposes exactly the declared key set and nothing more", async () => {
    const body = await (await GET(req(writerToken))).json();
    expect(Object.keys(body).sort()).toEqual(["ok", "portals"]);
    for (const p of body.portals as Record<string, unknown>[]) {
      expect(Object.keys(p).sort()).toEqual([
        "accounts",
        "name",
        "slug",
        "software",
      ]);
      for (const a of p.accounts as Record<string, unknown>[]) {
        expect(Object.keys(a).sort()).toEqual(["implicit", "name", "slug"]);
      }
    }
  });
});

// ── The reachability boundary (#1796) ────────────────────────────────────────
//
// The registry used to be instance-wide: any token that passed the gate read every
// portal slug, every account nickname, every software tag on the instance. An account
// nickname is household composition spelled out ("Mom", "Dad"), so the owner ruled the
// endpoint scoped to what the caller can reach — the same posture #1791 gave run
// reports, through the same computation.
//
// The fixture grows a SECOND household rather than a second file: a foreign portal whose
// accounts are all claimed by a profile the writer cannot reach, plus a login that can
// reach that profile and nothing else. Everything above still runs against the original
// rows, because this suite's fixture is built in its own beforeAll.
describe("GET /api/documents/portals — the reachability boundary (#1796)", () => {
  const FOREIGN_PORTAL = "Test Foreign Clinic";
  const FOREIGN_ACCOUNT = "Auntie";
  let foreignToken: string;
  let foreignPortalId: number;

  beforeAll(async () => {
    const foreignProfile = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Portals Foreign')").run()
        .lastInsertRowid
    );
    const foreignLogin = makeLogin("portals-foreign", "member");
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(foreignLogin, foreignProfile);
    foreignToken = (
      await createApiToken(foreignLogin, "f", "upload:documents")
    ).token;

    const foreign = createPortal(FOREIGN_PORTAL, "cerner");
    expect(foreign.ok).toBe(true);
    foreignPortalId = foreign.ok ? foreign.id : 0;
    expect(createPortalAccount(foreignPortalId, FOREIGN_ACCOUNT).ok).toBe(true);
    // BOTH accounts claimed, the implicit default included: an account nobody has bound
    // yet belongs to no household, and stays visible to everyone who could set it up —
    // otherwise `tool init` could never learn the slug of a portal created a minute ago,
    // which is the reason this endpoint exists. A portal disappears once its accounts
    // are claimed, and only then.
    for (const acc of accountsForPortal(foreignPortalId)) {
      expect(
        bindPortalIdentity(acc.id, `TESTPATIENT, ${acc.slug}`, foreignProfile)
          .ok
      ).toBe(true);
    }
  });

  it("omits a portal whose accounts are all claimed by an unreachable household", async () => {
    const res = await GET(req(writerToken));
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugs = (body.portals as { slug: string }[]).map((p) => p.slug);
    expect(slugs).not.toContain("test-foreign-clinic");
    // The disclosure assertion proper: neither the portal name nor the nickname appears
    // anywhere in the serialized payload, whatever shape it grows.
    const strings = allStrings(body).join(" ");
    expect(strings).not.toContain(FOREIGN_PORTAL);
    expect(strings).not.toContain(FOREIGN_ACCOUNT);
    // …and the writer still gets its own household's portals, so the endpoint was
    // scoped, not blanked.
    expect(slugs).toContain("test-ochsner-mychart");
    expect(slugs).toContain("test-baptist-health");
  });

  it("filters accounts WITHIN a portal both households touch", async () => {
    // The foreign login reaches its own profile only. Ochsner's "Mom" is bound to the
    // WRITER's profile, so it is withheld — while the portal itself, and the accounts
    // nobody has claimed, still come back. Visibility is decided per ACCOUNT.
    const body = await (await GET(req(foreignToken))).json();
    const ochsner = (
      body.portals as { slug: string; accounts: { slug: string }[] }[]
    ).find((p) => p.slug === "test-ochsner-mychart")!;
    expect(ochsner).toBeDefined();
    expect(ochsner.accounts.map((a) => a.slug).sort()).toEqual([
      "dad",
      "default",
    ]);
    expect(allStrings(body).join(" ")).not.toContain("Mom");
    // Its own portal is there in full, both accounts.
    const own = (
      body.portals as { slug: string; accounts: { slug: string }[] }[]
    ).find((p) => p.slug === "test-foreign-clinic")!;
    expect(own.accounts.map((a) => a.slug).sort()).toEqual(["auntie", "default"]);
  });

  it("hands an admin the full registry", async () => {
    // No admin branch in the reader: an admin reaches every profile, so every claimed
    // account satisfies the same clause an ordinary member's does.
    const body = await (await GET(req(adminToken))).json();
    const portals = body.portals as {
      slug: string;
      accounts: { slug: string }[];
    }[];
    const registrySlugs = new Set(portals.map((p) => p.slug));
    for (const slug of [
      "test-foreign-clinic",
      "test-ochsner-mychart",
      "test-baptist-health",
    ]) {
      expect(registrySlugs.has(slug)).toBe(true);
    }
    const foreign = portals.find((p) => p.slug === "test-foreign-clinic")!;
    expect(foreign.accounts.map((a) => a.slug).sort()).toEqual([
      "auntie",
      "default",
    ]);
    // The instance-wide truth is unchanged underneath — the endpoint filters, the
    // registry itself did not shrink.
    expect(portalById(foreignPortalId)!.slug).toBe("test-foreign-clinic");
  });

  it("still carries no patient labels once scoping is in play", async () => {
    // The scoped read joins portal_identities to decide visibility; the labels it joins
    // on must not ride back out with the answer.
    for (const token of [writerToken, foreignToken, adminToken]) {
      const strings = allStrings(await (await GET(req(token))).json()).join(" ");
      expect(strings).not.toContain("TESTPATIENT");
    }
  });
});
