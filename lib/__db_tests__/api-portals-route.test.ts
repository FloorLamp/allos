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
    // Refused, not "here are your zero portals": the registry is instance-wide, so an
    // empty array would be a claim about the household rather than a scoped answer.
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
