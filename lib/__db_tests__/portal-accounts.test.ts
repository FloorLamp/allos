// DB INTEGRATION TIER — the patient-portal acquirer's identity surface (#1739) and the
// two #1735 extensions, driven as the real route handlers.
//
// The tests that matter here are the REFUSALS, because the harm this feature exists to
// prevent is a document landing under the wrong person:
//   • an unbound identity refuses (typed) and never defaults onto any profile;
//   • an IGNORED identity refuses identically — the endpoint never reveals which of the
//     two it was;
//   • the same label under TWO LOGINS is two different people and never collapses;
//   • an omitted account on a multi-login portal refuses rather than picking;
//   • a bound identity whose profile the pushing token cannot write is refused too — a
//     mapping is never a bypass of profile authorization.
// Plus discovery (the routine path by which allos learns identities), the per-identity
// sync accounting, and provenance.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { POST as UPLOAD } from "@/app/api/documents/route";
import { POST as SYNC_REPORT } from "@/app/api/documents/sync-report/route";
import { createApiToken } from "@/lib/api-tokens";
import { getImportLogDocuments } from "@/lib/queries";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  deletePortal,
  deletePortalAccount,
  dismissPendingIdentity,
  identitySyncStatuses,
  ignorePortalIdentity,
  listPendingIdentities,
  listPortalIdentities,
  listPortalRunReports,
  listPortals,
  portalBySlug,
  recordPendingIdentity,
  recordPortalRunReport,
  renamePortal,
  resolveAccount,
  resolvePortalIdentity,
  unbindPortalIdentity,
  unignorePortalIdentity,
  PENDING_PER_ACCOUNT_CAP,
} from "@/lib/portals";

let memberLogin: number;
let strangerLogin: number;
let mineProfile: number;
let readOnlyProfile: number;
let strangersProfile: number;
let memberToken: string;
let strangerToken: string;
let portalId: number;
// The portal's implicit login, created with it.
let defaultAccount: number;

function pdfBytes(marker: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  );
}

function uploadByIdentity(
  token: string,
  portal: string,
  patient: string,
  marker: string,
  account?: string
): Request {
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdfBytes(marker)], { type: "application/pdf" }),
    "labs.pdf"
  );
  const qs =
    `?portal=${encodeURIComponent(portal)}` +
    (account ? `&account=${encodeURIComponent(account)}` : "") +
    `&patient=${encodeURIComponent(patient)}`;
  return new Request(`http://x/api/documents${qs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

function report(token: string, body: unknown): Request {
  return new Request("http://x/api/documents/sync-report", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function docCount(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_documents WHERE profile_id = ?"
      )
      .get(profileId) as { n: number }
  ).n;
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

// The implicit login of a portal, by slug — the account every binding names when a
// household has only one.
function implicitAccountOf(portalId: number): number {
  return accountsForPortal(portalId).find((a) => a.implicit)!.id;
}

beforeAll(async () => {
  mineProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Portal Mine')").run()
      .lastInsertRowid
  );
  readOnlyProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Portal ReadOnly')").run()
      .lastInsertRowid
  );
  strangersProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Portal Stranger')").run()
      .lastInsertRowid
  );

  memberLogin = makeLogin("portal-member", "member");
  strangerLogin = makeLogin("portal-stranger", "member");
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(memberLogin, mineProfile);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(memberLogin, readOnlyProfile);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(strangerLogin, strangersProfile);

  memberToken = (await createApiToken(memberLogin, "tool", "upload:documents"))
    .token;
  strangerToken = (
    await createApiToken(strangerLogin, "tool", "upload:documents")
  ).token;

  const made = createPortal("Ochsner MyChart", "mychart");
  expect(made.ok).toBe(true);
  portalId = made.ok ? made.id : 0;
  defaultAccount = implicitAccountOf(portalId);
});

beforeEach(() => {
  db.exec("DELETE FROM medical_documents");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  db.exec("DELETE FROM portal_identities");
  db.exec("DELETE FROM pending_portal_identities");
  db.exec("DELETE FROM portal_run_reports");
  // Leave only the implicit login on the shared portal, so a test that adds one starts
  // from the single-login world every household starts in.
  db.exec(
    `DELETE FROM portal_accounts WHERE portal_id = ${portalId} AND implicit = 0`
  );
});

describe("portal registry", () => {
  it("MINTS the slug from the display name and finds it back", () => {
    // The user names the thing; allos derives the key every tool config quotes.
    expect(portalBySlug("ochsner-mychart")?.id).toBe(portalId);
    expect(portalBySlug("OCHSNER-MYCHART")?.id).toBe(portalId);
    expect(listPortals().some((p) => p.slug === "ochsner-mychart")).toBe(true);
  });

  it("disambiguates a colliding name rather than refusing it", () => {
    const a = createPortal("Baptist Health");
    const b = createPortal("Baptist Health");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const slugs = listPortals()
      .filter((p) => p.id === a.id || p.id === b.id)
      .map((p) => p.slug);
    expect(slugs).toContain("baptist-health");
    expect(slugs).toContain("baptist-health-2");
    deletePortal(a.id);
    deletePortal(b.id);
  });

  it("REFUSES a URL in the display name — the no-address invariant", () => {
    // The schema has no address column at all; this closes the one free-text field
    // where an address could otherwise enter the authoritative record.
    const r = createPortal("https://mychart.evil.example/login");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/never a web address/i);
  });

  it("refuses a name with nothing slug-able in it, rather than inventing a key", () => {
    expect(createPortal("•••").ok).toBe(false);
    expect(createPortal("   ").ok).toBe(false);
  });

  it("refuses an unknown software tag", () => {
    expect(createPortal("Some Portal", "epic-hyperspace").ok).toBe(false);
  });

  it("has no address column, and cannot grow one by accident", () => {
    const cols = (
      db.prepare("PRAGMA table_info(portals)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols.sort()).toEqual([
      "created_at",
      "id",
      "name",
      "slug",
      "software",
    ]);
    for (const forbidden of [
      "url",
      "base_url",
      "host",
      "login_url",
      "address",
    ]) {
      expect(cols, `portals must never carry ${forbidden}`).not.toContain(
        forbidden
      );
    }
  });

  it("RENAMES without touching the slug — every tool config keeps working", () => {
    const made = createPortal("Renamable Health");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(renamePortal(made.id, "Renamed Health System").ok).toBe(true);
    const after = portalBySlug("renamable-health");
    expect(after?.name).toBe("Renamed Health System");
    expect(after?.id).toBe(made.id);
    deletePortal(made.id);
  });

  it("gets an IMPLICIT login with the portal, so a one-login household never meets the concept", () => {
    const accounts = accountsForPortal(portalId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].implicit).toBe(true);
    expect(accounts[0].slug).toBe("default");
  });

  it("deleting a portal takes its logins and bindings with it", () => {
    const p = createPortal("Temp Portal");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    bindPortalIdentity(implicitAccountOf(p.id), "Jane Doe", mineProfile);
    expect(deletePortal(p.id)).toBe(true);
    expect(listPortalIdentities().some((i) => i.portalId === p.id)).toBe(false);
    expect(accountsForPortal(p.id)).toHaveLength(0);
  });
});

describe("portal logins (accounts)", () => {
  it("adds a named login, scoped to its portal", () => {
    const other = createPortal("Baptist Portal");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(createPortalAccount(portalId, "Mom").ok).toBe(true);
    expect(createPortalAccount(other.id, "Mom").ok).toBe(true);
    // "Mom" under two portals is two unrelated logins — the slug is scoped, not global.
    expect(accountsForPortal(portalId).some((a) => a.slug === "mom")).toBe(
      true
    );
    expect(accountsForPortal(other.id).some((a) => a.slug === "mom")).toBe(
      true
    );
    deletePortal(other.id);
  });

  it("disambiguates two logins with the same nickname on one portal", () => {
    expect(createPortalAccount(portalId, "Mom").ok).toBe(true);
    expect(createPortalAccount(portalId, "Mom").ok).toBe(true);
    const slugs = accountsForPortal(portalId).map((a) => a.slug);
    expect(slugs).toContain("mom");
    expect(slugs).toContain("mom-2");
  });

  it("refuses an address-shaped or empty nickname", () => {
    expect(
      createPortalAccount(portalId, "https://portal.example/login").ok
    ).toBe(false);
    expect(createPortalAccount(portalId, "   ").ok).toBe(false);
  });

  it("ACCEPTS an email address as a login name (#1829)", () => {
    // A portal login usually IS an email, so that is the nickname a person reaches for.
    // An email is an identity label, never something a tool could dereference.
    const made = createPortalAccount(portalId, "mom@example.com");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const account = accountsForPortal(portalId).find((a) => a.id === made.id);
    // Stored verbatim as the display name; the SLUG is minted from it as usual, so a
    // tool's config still quotes plain kebab text.
    expect(account?.name).toBe("mom@example.com");
    expect(account?.slug).toBe("mom-example-com");
  });

  it("still refuses every dereferenceable shape in a login name", () => {
    for (const bad of [
      "mailto:mom@example.com",
      "https://user@portal.example",
      "user@portal.example/login",
      "portal.example",
      "192.168.1.10",
    ]) {
      const r = createPortalAccount(portalId, bad);
      expect(r.ok, bad).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatch(/never a web address/i);
    }
  });

  it("keeps a PORTAL name fully strict — an email there is not a name", () => {
    // A portal is an institution, and this is the field that historically tempts
    // URL-pasting. The allowance is the account path's alone.
    const r = createPortal("mom@example.com");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/never a web address/i);
  });

  it("REFUSES to remove a portal's last login — that would be a dead end", () => {
    // Every binding must name a login, so a portal with none could never be bound again.
    expect(deletePortalAccount(defaultAccount)).toBe(false);
    expect(accountsForPortal(portalId)).toHaveLength(1);
  });

  it("removes a named login and everything keyed to it", () => {
    const made = createPortalAccount(portalId, "Dad");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    bindPortalIdentity(made.id, "Dad Patient", mineProfile);
    expect(deletePortalAccount(made.id)).toBe(true);
    expect(listPortalIdentities().some((i) => i.accountId === made.id)).toBe(
      false
    );
  });
});

describe("account resolution — the omitted-account rule", () => {
  it("resolves an omitted account when the portal has exactly one login", () => {
    const r = resolveAccount("ochsner-mychart", null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.account.id).toBe(defaultAccount);
  });

  it("REFUSES an omitted account once a second login exists — it never picks", () => {
    // Picking the implicit one, the oldest one, or the only one with bindings would each
    // be a guess about whose login a run came from. The loud refusal is what tells the
    // household to name their login in the tool config.
    expect(createPortalAccount(portalId, "Mom").ok).toBe(true);
    expect(resolveAccount("ochsner-mychart", null).ok).toBe(false);
    // …and naming it resolves again.
    expect(resolveAccount("ochsner-mychart", "mom").ok).toBe(true);
    expect(resolveAccount("ochsner-mychart", "default").ok).toBe(true);
  });

  it("refuses an unknown portal or an unknown login, identically", () => {
    expect(resolveAccount("no-such-portal", null).ok).toBe(false);
    expect(resolveAccount("ochsner-mychart", "nobody").ok).toBe(false);
  });
});

describe("identity bindings", () => {
  it("binds a label on a login and resolves it back", () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const r = resolvePortalIdentity("ochsner-mychart", null, "Jane Doe");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profileId).toBe(mineProfile);
    expect(r.accountId).toBe(defaultAccount);
  });

  it("keeps the SAME LABEL under two logins apart — the whole reason for the account", () => {
    // Father's proxy list shows "SMITH, ALEX" meaning himself; mother's shows a different
    // "SMITH, ALEX" meaning a Jr. Under a two-part key these collapsed into one binding.
    const mom = createPortalAccount(portalId, "Mom");
    const dad = createPortalAccount(portalId, "Dad");
    expect(mom.ok && dad.ok).toBe(true);
    if (!mom.ok || !dad.ok) return;

    bindPortalIdentity(mom.id, "SMITH, ALEX", mineProfile);
    bindPortalIdentity(dad.id, "SMITH, ALEX", strangersProfile);

    const viaMom = resolvePortalIdentity(
      "ochsner-mychart",
      "mom",
      "SMITH, ALEX"
    );
    const viaDad = resolvePortalIdentity(
      "ochsner-mychart",
      "dad",
      "SMITH, ALEX"
    );
    expect(viaMom.ok && viaDad.ok).toBe(true);
    if (!viaMom.ok || !viaDad.ok) return;
    expect(viaMom.profileId).toBe(mineProfile);
    expect(viaDad.profileId).toBe(strangersProfile);
    expect(
      listPortalIdentities().filter((i) => i.patientLabel === "SMITH, ALEX")
    ).toHaveLength(2);
  });

  it("is MANY-TO-ONE: one profile bound under two portals is the normal case", () => {
    const other = createPortal("Second Health");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    bindPortalIdentity(implicitAccountOf(other.id), "DOE, JANE", mineProfile);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      true
    );
    expect(resolvePortalIdentity("second-health", null, "DOE, JANE").ok).toBe(
      true
    );
    deletePortal(other.id);
  });

  it("resolves through the same whitespace normalization the write used", () => {
    bindPortalIdentity(defaultAccount, "  Jane   Doe  ", mineProfile);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      true
    );
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane\nDoe").ok).toBe(
      true
    );
  });

  it("does NOT collapse two visibly different labels", () => {
    // A label is a key, not a search. Unifying these is how one patient's records land
    // under another's profile.
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(resolvePortalIdentity("ochsner-mychart", null, "JANE DOE").ok).toBe(
      false
    );
    expect(
      resolvePortalIdentity("ochsner-mychart", null, "Jane Q. Doe").ok
    ).toBe(false);
  });

  it("re-binding REPLACES rather than creating a second answer", () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    bindPortalIdentity(defaultAccount, "Jane Doe", strangersProfile);
    const rows = listPortalIdentities().filter(
      (i) => i.patientLabel === "Jane Doe"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].profileId).toBe(strangersProfile);
  });

  it("refuses an empty label and an unknown login", () => {
    expect(bindPortalIdentity(defaultAccount, "   ", mineProfile).ok).toBe(
      false
    );
    expect(bindPortalIdentity(999999, "Jane Doe", mineProfile).ok).toBe(false);
  });

  it("unbinds, and only for the profile the binding actually points at (#1747)", () => {
    const b = bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // The delete is scoped to (id, profile_id): naming the right row under the WRONG
    // profile deletes nothing. That is what makes it a compare-and-swap rather than a
    // delete-by-surrogate-id an unrelated authorization could ride.
    expect(unbindPortalIdentity(b.id, strangersProfile)).toBe(false);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      true
    );

    expect(unbindPortalIdentity(b.id, mineProfile)).toBe(true);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      false
    );
  });

  it("dies with its profile (OWNED_TABLES / FK cascade)", () => {
    const doomed = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Doomed')").run()
        .lastInsertRowid
    );
    bindPortalIdentity(defaultAccount, "Doomed Patient", doomed);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM profiles WHERE id = ?").run(doomed);
    // A dangling binding would resolve an upload onto a profile that no longer exists.
    expect(
      resolvePortalIdentity("ochsner-mychart", null, "Doomed Patient").ok
    ).toBe(false);
  });
});

describe("ignored bindings", () => {
  it("an IGNORED identity refuses exactly like an unknown one, and carries no profile", () => {
    const r = ignorePortalIdentity(defaultAccount, "Not Ours");
    expect(r.ok).toBe(true);
    const resolved = resolvePortalIdentity("ochsner-mychart", null, "Not Ours");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // Same typed reason as an identity nobody ever mentioned — the endpoint is
    // non-oracular about what a household declined.
    expect(resolved.reason).toBe("unmapped-identity");

    const row = listPortalIdentities().find(
      (i) => i.patientLabel === "Not Ours"
    );
    expect(row?.ignored).toBe(true);
    expect(row?.profileId).toBeNull();
  });

  it("the CHECK makes 'ignored with a profile' unrepresentable", () => {
    const b = bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(() =>
      db
        .prepare("UPDATE portal_identities SET ignored = 1 WHERE id = ?")
        .run(b.id)
    ).toThrow();
    expect(() =>
      db
        .prepare("UPDATE portal_identities SET profile_id = NULL WHERE id = ?")
        .run(b.id)
    ).toThrow();
  });

  it("ignoring REPLACES a live binding, and un-ignoring clears the row", () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(ignorePortalIdentity(defaultAccount, "Jane Doe").ok).toBe(true);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      false
    );
    const row = listPortalIdentities().find(
      (i) => i.patientLabel === "Jane Doe"
    )!;
    // The un-ignore path is scoped to ignored = 1, so it can never remove a live binding.
    expect(unignorePortalIdentity(row.id)).toBe(true);
    expect(listPortalIdentities()).toHaveLength(0);
  });

  it("un-ignore refuses a LIVE binding — it is not a back door around the profile gate", () => {
    const b = bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(unignorePortalIdentity(b.id)).toBe(false);
    expect(resolvePortalIdentity("ochsner-mychart", null, "Jane Doe").ok).toBe(
      true
    );
  });
});

describe("POST /api/documents — identity form", () => {
  it("ingests under the BOUND profile", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner-mychart", "Jane Doe", "bound")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      profile: number;
      documents: { outcome: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.profile).toBe(mineProfile);
    expect(body.documents[0].outcome).toBe("stored");
    expect(docCount(mineProfile)).toBe(1);
  });

  it("routes by LOGIN when two logins share a label", async () => {
    const mom = createPortalAccount(portalId, "Mom");
    const dad = createPortalAccount(portalId, "Dad");
    expect(mom.ok && dad.ok).toBe(true);
    if (!mom.ok || !dad.ok) return;
    bindPortalIdentity(mom.id, "SMITH, ALEX", mineProfile);
    bindPortalIdentity(dad.id, "SMITH, ALEX", strangersProfile);

    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "SMITH, ALEX",
        "via-mom",
        "mom"
      )
    );
    expect(res.status).toBe(200);
    expect(docCount(mineProfile)).toBe(1);
    expect(docCount(strangersProfile)).toBe(0);
  });

  it("REFUSES an omitted account once the portal has two logins, storing nothing", async () => {
    expect(createPortalAccount(portalId, "Mom").ok).toBe(true);
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner-mychart", "Jane Doe", "ambiguous")
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unmapped-identity"
    );
    expect(docCount(mineProfile)).toBe(0);
  });

  it("refuses an UNMAPPED identity with the typed outcome, storing nothing", async () => {
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Nobody Known",
        "unmapped"
      )
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unmapped-identity");
    // The whole point: it did not land anywhere.
    expect(docCount(mineProfile)).toBe(0);
    expect(docCount(readOnlyProfile)).toBe(0);
    expect(docCount(strangersProfile)).toBe(0);
  });

  it("refuses an IGNORED identity indistinguishably from an unknown one", async () => {
    ignorePortalIdentity(defaultAccount, "Declined Person");
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Declined Person",
        "ignored"
      )
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("unmapped-identity");
    // An ignored identity is not re-offered as pending — the household already answered.
    expect(listPendingIdentities()).toHaveLength(0);
  });

  it("refuses a binding to a profile the token may only READ", async () => {
    bindPortalIdentity(defaultAccount, "Read Only", readOnlyProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner-mychart", "Read Only", "readonly")
    );
    expect(res.status).toBe(403);
    expect(docCount(readOnlyProfile)).toBe(0);
  });

  it("refuses a binding to a profile the token cannot reach — a mapping is not a bypass", async () => {
    bindPortalIdentity(defaultAccount, "Someone Else", strangersProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner-mychart", "Someone Else", "cross")
    );
    expect(res.status).toBe(403);
    expect(docCount(strangersProfile)).toBe(0);
  });

  it("another token with the right grant CAN use the same binding", async () => {
    bindPortalIdentity(defaultAccount, "Someone Else", strangersProfile);
    const res = await UPLOAD(
      uploadByIdentity(
        strangerToken,
        "ochsner-mychart",
        "Someone Else",
        "theirs"
      )
    );
    expect(res.status).toBe(200);
    expect(docCount(strangersProfile)).toBe(1);
  });

  it("400s when BOTH a profile and an identity are named", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("both")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request(
        `http://x/api/documents?profile=${mineProfile}&portal=ochsner-mychart&patient=Jane%20Doe`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${memberToken}` },
          body: form,
        }
      )
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "not both"
    );
    expect(docCount(mineProfile)).toBe(0);
  });

  it("400s a malformed account rather than ignoring it", async () => {
    // Silently dropping a named login is how a run lands under the wrong one.
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Jane Doe",
        "badaccount",
        "Not A Slug"
      )
    );
    expect(res.status).toBe(400);
  });

  it("still accepts the plain profile form (the human CLI is unchanged)", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("plain")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request(`http://x/api/documents?profile=${mineProfile}`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);
    expect(docCount(mineProfile)).toBe(1);
  });
});

describe("acquired-by provenance (#1748)", () => {
  function acquiredOf(profileId: number): (number | null)[] {
    return (
      db
        .prepare(
          "SELECT acquired_portal_id AS p FROM medical_documents WHERE profile_id = ? ORDER BY id"
        )
        .all(profileId) as { p: number | null }[]
    ).map((r) => r.p);
  }

  it("stamps the resolved portal on a document pushed through the identity form", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Jane Doe",
        "prov-stored"
      )
    );
    expect(res.status).toBe(200);
    expect(acquiredOf(mineProfile)).toEqual([portalId]);
  });

  it("leaves it NULL on the plain profile form — the human CLI path", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("prov-cli")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request(`http://x/api/documents?profile=${mineProfile}`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);
    expect(acquiredOf(mineProfile)).toEqual([null]);
  });

  it("surfaces the portal's display NAME in the Review feed, and nothing for a hand upload", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    await UPLOAD(
      uploadByIdentity(memberToken, "ochsner-mychart", "Jane Doe", "prov-feed")
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("prov-feed-cli")], { type: "application/pdf" }),
      "byhand.pdf"
    );
    await UPLOAD(
      new Request(`http://x/api/documents?profile=${mineProfile}`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
    );

    const rows = getImportLogDocuments(mineProfile);
    expect(
      rows.find((r) => r.filename === "labs.pdf")?.acquired_portal_name
    ).toBe("Ochsner MyChart");
    expect(
      rows.find((r) => r.filename === "byhand.pdf")?.acquired_portal_name ??
        null
    ).toBeNull();
  });

  it("loses the label — and only the label — when the portal leaves the registry", async () => {
    const temp = createPortal("Temp Provenance");
    expect(temp.ok).toBe(true);
    if (!temp.ok) return;
    bindPortalIdentity(implicitAccountOf(temp.id), "Jane Doe", mineProfile);
    await UPLOAD(
      uploadByIdentity(memberToken, "temp-provenance", "Jane Doe", "prov-drop")
    );
    expect(acquiredOf(mineProfile)).toEqual([temp.id]);

    expect(deletePortal(temp.id)).toBe(true);
    // The DOCUMENT survives; only the name of how it arrived goes.
    expect(docCount(mineProfile)).toBe(1);
    expect(acquiredOf(mineProfile)).toEqual([null]);
  });
});

describe("pending identities", () => {
  it("remembers an identity the UPLOAD route refused", async () => {
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "New Proxy Patient",
        "pend-1"
      )
    );
    expect(res.status).toBe(404);
    const pending = listPendingIdentities();
    expect(pending).toHaveLength(1);
    expect(pending[0].patientLabel).toBe("New Proxy Patient");
    expect(pending[0].accountId).toBe(defaultAccount);
    expect(pending[0].lastOutcome).toBe("unmapped-upload");
    expect(pending[0].seenCount).toBe(1);
    // Remembering is not filing: no document landed anywhere.
    expect(docCount(mineProfile)).toBe(0);
  });

  it("NEVER writes for an unauthenticated request", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("anon")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request(
        "http://x/api/documents?portal=ochsner-mychart&patient=Anonymous",
        { method: "POST", body: form }
      )
    );
    expect(res.status).toBe(401);
    // No credential, no row — this table is not an anonymous write amplifier.
    expect(listPendingIdentities()).toHaveLength(0);
  });

  it("DEDUPES on the identity: a retrying tool bumps one row instead of growing the table", () => {
    recordPendingIdentity(
      "ochsner-mychart",
      null,
      "Repeat Patient",
      "unmapped-upload"
    );
    recordPendingIdentity(
      "ochsner-mychart",
      null,
      "Repeat Patient",
      "unmapped-sync-report"
    );
    recordPendingIdentity(
      "ochsner-mychart",
      null,
      "Repeat Patient",
      "unmapped-upload"
    );
    const pending = listPendingIdentities();
    expect(pending).toHaveLength(1);
    expect(pending[0].seenCount).toBe(3);
    // The FIRST sighting is kept — "this has been waiting since Tuesday" is the useful
    // sentence — while the outcome tracks the most recent refusal.
    expect(pending[0].firstSeenAt).toBeTruthy();
    expect(pending[0].lastOutcome).toBe("unmapped-upload");
  });

  it("keeps the same label under two logins as two separate pending rows", () => {
    const mom = createPortalAccount(portalId, "Mom");
    expect(mom.ok).toBe(true);
    recordPendingIdentity(
      "ochsner-mychart",
      "default",
      "SMITH, ALEX",
      "discovered"
    );
    recordPendingIdentity(
      "ochsner-mychart",
      "mom",
      "SMITH, ALEX",
      "discovered"
    );
    expect(listPendingIdentities()).toHaveLength(2);
  });

  it("refuses to remember an unknown portal, an unknown login, or an empty label", () => {
    expect(
      recordPendingIdentity("no-such-portal", null, "Someone", "discovered")
    ).toBe(false);
    expect(
      recordPendingIdentity(
        "ochsner-mychart",
        "nobody",
        "Someone",
        "discovered"
      )
    ).toBe(false);
    expect(
      recordPendingIdentity("ochsner-mychart", null, "   ", "discovered")
    ).toBe(false);
    expect(listPendingIdentities()).toHaveLength(0);
  });

  it("never re-offers an identity that is already bound or ignored", () => {
    bindPortalIdentity(defaultAccount, "Bound Person", mineProfile);
    ignorePortalIdentity(defaultAccount, "Declined Person");
    expect(
      recordPendingIdentity(
        "ochsner-mychart",
        null,
        "Bound Person",
        "discovered"
      )
    ).toBe(false);
    expect(
      recordPendingIdentity(
        "ochsner-mychart",
        null,
        "Declined Person",
        "discovered"
      )
    ).toBe(false);
    expect(listPendingIdentities()).toHaveLength(0);
  });

  it("is BOUNDED per login, evicting the least recently seen", () => {
    for (let i = 0; i < PENDING_PER_ACCOUNT_CAP + 10; i++) {
      recordPendingIdentity(
        "ochsner-mychart",
        null,
        `Patient ${i}`,
        "discovered"
      );
    }
    const pending = listPendingIdentities();
    expect(pending).toHaveLength(PENDING_PER_ACCOUNT_CAP);
    // The most recent sighting is the one a household most needs to act on.
    expect(
      pending.some(
        (p) => p.patientLabel === `Patient ${PENDING_PER_ACCOUNT_CAP + 9}`
      )
    ).toBe(true);
  });

  it("caps PER LOGIN, so a noisy login cannot evict another's real patient", () => {
    const mom = createPortalAccount(portalId, "Mom");
    expect(mom.ok).toBe(true);
    recordPendingIdentity(
      "ochsner-mychart",
      "mom",
      "Real Patient",
      "discovered"
    );
    for (let i = 0; i < PENDING_PER_ACCOUNT_CAP + 5; i++) {
      recordPendingIdentity(
        "ochsner-mychart",
        "default",
        `Noise ${i}`,
        "discovered"
      );
    }
    expect(
      listPendingIdentities().some((p) => p.patientLabel === "Real Patient")
    ).toBe(true);
  });

  it("BINDING the identity clears its pending row in the same write", async () => {
    await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Soon Mapped",
        "pend-bind"
      )
    );
    expect(listPendingIdentities()).toHaveLength(1);

    expect(
      bindPortalIdentity(defaultAccount, "Soon Mapped", mineProfile).ok
    ).toBe(true);
    // No window where the card still offers to map something already mapped.
    expect(listPendingIdentities()).toHaveLength(0);

    // …and the identity now resolves, so the next run lands normally.
    const res = await UPLOAD(
      uploadByIdentity(
        memberToken,
        "ochsner-mychart",
        "Soon Mapped",
        "pend-bound"
      )
    );
    expect(res.status).toBe(200);
    expect(docCount(mineProfile)).toBe(1);
  });

  it("IGNORING clears the pending row too, and it never comes back", () => {
    recordPendingIdentity("ochsner-mychart", null, "Not Ours", "discovered");
    expect(ignorePortalIdentity(defaultAccount, "Not Ours").ok).toBe(true);
    expect(listPendingIdentities()).toHaveLength(0);
    // "Not ever": a later report does not resurrect it.
    expect(
      recordPendingIdentity("ochsner-mychart", null, "Not Ours", "discovered")
    ).toBe(false);
    expect(listPendingIdentities()).toHaveLength(0);
  });

  it("DISMISSING clears the row, and a later sighting brings it back", () => {
    recordPendingIdentity("ochsner-mychart", null, "Later", "discovered");
    const [row] = listPendingIdentities();
    expect(dismissPendingIdentity(row.id)).toBe(true);
    expect(listPendingIdentities()).toHaveLength(0);
    // "Not now" answers the ROW, not the portal — the difference from IGNORE.
    recordPendingIdentity("ochsner-mychart", null, "Later", "discovered");
    expect(listPendingIdentities()).toHaveLength(1);
    expect(dismissPendingIdentity(999999)).toBe(false);
  });

  it("carries no profile_id at all — it cannot have one", () => {
    const cols = (
      db.prepare("PRAGMA table_info(pending_portal_identities)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    // An unmapped identity has no profile BY DEFINITION. A profile_id here would mean
    // some profile had been guessed, which is the harm the refusal exists to prevent.
    expect(cols).not.toContain("profile_id");
  });
});

describe("POST /api/documents/sync-report", () => {
  function events(profileId: number) {
    return db
      .prepare(
        `SELECT ok, inserted, updated, unchanged, skipped, error,
                portal_id AS portalId, account_id AS accountId,
                patient_label AS patientLabel
           FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'patient-portals'
          ORDER BY id DESC`
      )
      .all(profileId) as {
      ok: number;
      inserted: number | null;
      updated: number | null;
      unchanged: number | null;
      skipped: number | null;
      error: string | null;
      portalId: number | null;
      accountId: number | null;
      patientLabel: string | null;
    }[];
  }

  it("401s without a token", async () => {
    const res = await SYNC_REPORT(
      new Request("http://x/api/documents/sync-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "nothing-new", profile: 1 }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("lands a downloaded run as a sync event with its counts AND its identity", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        inserted: 3,
        updated: 1,
        unchanged: 2,
      })
    );
    expect(res.status).toBe(200);
    const rows = events(mineProfile);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].inserted).toBe(3);
    expect(rows[0].unchanged).toBe(2);
    // WHICH identity the run was about — what per-(login, patient) "Last synced" reads.
    expect(rows[0].portalId).toBe(portalId);
    expect(rows[0].accountId).toBe(defaultAccount);
    expect(rows[0].patientLabel).toBe("Jane Doe");
  });

  it("records nothing-new as a CALM SUCCESS that advances Last synced", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        unchanged: 5,
      })
    );
    expect(res.status).toBe(200);
    const rows = events(mineProfile);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].error).toBeNull();
    const conn = db
      .prepare(
        "SELECT status, last_sync_at AS at FROM integration_connections WHERE profile_id = ? AND provider = 'patient-portals'"
      )
      .get(mineProfile) as { status: string; at: string | null } | undefined;
    expect(conn?.status).toBe("connected");
    expect(conn?.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("gives per-(login, patient) Last synced, not one answer per profile", async () => {
    const mom = createPortalAccount(portalId, "Mom");
    expect(mom.ok).toBe(true);
    if (!mom.ok) return;
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    bindPortalIdentity(mom.id, "John Doe", mineProfile);

    await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        account: "default",
        patient: "Jane Doe",
      })
    );
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        account: "mom",
        patient: "John Doe",
        message: "portal login timed out",
      })
    );

    const statuses = identitySyncStatuses(mineProfile, "patient-portals");
    expect(statuses).toHaveLength(2);
    const jane = statuses.find((s) => s.patientLabel === "Jane Doe")!;
    const john = statuses.find((s) => s.patientLabel === "John Doe")!;
    expect(jane.lastOkAt).toBeTruthy();
    expect(jane.lastFailedAt).toBeNull();
    // A failure never invents a success, and never erases one either.
    expect(john.lastOkAt).toBeNull();
    expect(john.lastFailedAt).toBeTruthy();
  });

  it("records a failed run as ok:false with its message", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        failed: 2,
        message: "portal login timed out",
      })
    );
    const rows = events(mineProfile);
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toBe("portal login timed out");
    expect(rows[0].skipped).toBe(2);
    const conn = db
      .prepare(
        "SELECT last_sync_at AS at FROM integration_connections WHERE profile_id = ? AND provider = 'patient-portals'"
      )
      .get(mineProfile) as { at: string | null } | undefined;
    expect(conn?.at ?? null).toBeNull();
  });

  it("refuses an unmapped identity, recording no event but REMEMBERING the identity", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Nobody Known",
      })
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unmapped-identity"
    );
    expect(events(mineProfile)).toHaveLength(0);
    expect(listPendingIdentities()[0]?.lastOutcome).toBe(
      "unmapped-sync-report"
    );
  });

  it("400s an unknown status and a non-object body", async () => {
    expect(
      (
        await SYNC_REPORT(
          report(memberToken, { status: "ok", profile: mineProfile })
        )
      ).status
    ).toBe(400);
    expect((await SYNC_REPORT(report(memberToken, [1, 2]))).status).toBe(400);
  });

  it("clamps hostile counts rather than trusting the tool", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        inserted: -99,
        updated: 1e12,
      })
    );
    const rows = events(mineProfile);
    expect(rows[0].inserted).toBe(0);
    expect(rows[0].updated).toBeLessThanOrEqual(1_000_000);
  });
});

describe("discovery — the routine path to a mapping", () => {
  it("learns the proxy list from a run report, verbatim, and echoes the count", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        identities: ["Jane Doe", "SMITH, ALEX", "Ruth O'Hara-Smith"],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discovered?: number };
    // TWO, not three (#1756): "Jane Doe" is already bound, so she is not waiting for
    // anything and the tool must not be told she is.
    expect(body.discovered).toBe(2);

    const pending = listPendingIdentities()
      .map((p) => p.patientLabel)
      .sort();
    // "Jane Doe" is already bound, so it is NOT re-offered — that is what makes a
    // steady-state run idempotent.
    expect(pending).toEqual(["Ruth O'Hara-Smith", "SMITH, ALEX"]);
    expect(listPendingIdentities()[0].lastOutcome).toBe("discovered");
  });

  it("learns the proxy list even when the reporting patient is itself unmapped", async () => {
    // FIRST CONTACT: nothing is bound yet, so the run's own identity refuses — but the
    // list it discovered is exactly what the household needs to map.
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner-mychart",
        patient: "Unknown Reporter",
        identities: ["Unknown Reporter", "Second Patient"],
      })
    );
    expect(res.status).toBe(404);
    const labels = listPendingIdentities()
      .map((p) => p.patientLabel)
      .sort();
    expect(labels).toEqual(["Second Patient", "Unknown Reporter"]);
  });

  it("learns the proxy list from a FAILED run that got far enough to see it", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        message: "export download timed out",
        identities: ["New Person"],
      })
    );
    expect(
      listPendingIdentities().some((p) => p.patientLabel === "New Person")
    ).toBe(true);
  });

  it("re-reporting the same list adds nothing — one row per identity, bumped", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const body = {
      status: "nothing-new",
      portal: "ochsner-mychart",
      patient: "Jane Doe",
      identities: ["Someone New"],
    };
    await SYNC_REPORT(report(memberToken, body));
    await SYNC_REPORT(report(memberToken, body));
    await SYNC_REPORT(report(memberToken, body));
    const pending = listPendingIdentities();
    expect(pending).toHaveLength(1);
    expect(pending[0].seenCount).toBe(3);
  });

  it("SANITIZES the reported list: junk dropped, duplicates collapsed, length capped", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const identities: unknown[] = [
      "  Spacey   Name  ",
      "Spacey Name",
      42,
      null,
      "",
      "   ",
    ];
    for (let i = 0; i < 40; i++) identities.push(`Bulk ${i}`);
    await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
        identities,
      })
    );
    const labels = listPendingIdentities().map((p) => p.patientLabel);
    // Whitespace-normalized, so the two spellings are ONE identity — but never
    // case-folded, because a label is a key.
    expect(labels.filter((l) => l === "Spacey Name")).toHaveLength(1);
    expect(labels).not.toContain("42");
    // Bounded at the parse, before anything is stored.
    expect(labels.length).toBeLessThanOrEqual(25);
  });

  it("ignores a discovered list from an unresolvable login", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "no-such-portal",
        patient: "Someone",
        identities: ["Invented Person"],
      })
    );
    expect(res.status).toBe(404);
    expect(listPendingIdentities()).toHaveLength(0);
  });
});

// ── The account-level run report (#1756) ─────────────────────────────────────
//
// The walkthrough found a dead zone at the worst possible moment: the very FIRST run
// signs in, enumerates the proxy list, is refused because its own patient is not bound
// yet — and left no trace at all, so the card said "No run reported yet." directly under
// its own promise that every run is reported. The same hole made a PORTAL-LEVEL failure
// ("the login page changed") inexpressible without fabricating a patient label.
//
// These pin the trace, and pin what it is NOT: it is not a sync event, it does not touch
// a profile, and it does not appear for a run the token was not allowed to make.
describe("account-level run reports", () => {
  function reportsFor(accountId: number) {
    return listPortalRunReports().filter((r) => r.accountId === accountId);
  }

  function syncEventCount(): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM integration_sync_events").get() as {
        n: number;
      }
    ).n;
  }

  it("FIRST CONTACT leaves a trace even though the report is refused", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Unknown Reporter",
        identities: ["Unknown Reporter", "SMITH, ALEX", "Ruth O'Hara-Smith"],
      })
    );
    // The refusal still stands — nothing may be filed under a guess.
    expect(res.status).toBe(404);
    expect(syncEventCount()).toBe(0);

    // …but the run happened, and the card can now say so.
    const rows = reportsFor(defaultAccount);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].status).toBe("nothing-new");
    expect(rows[0].portalName).toBe("Ochsner MyChart");
    // The NEWLY-WAITING count, which is what the card and the tool both quote.
    expect(rows[0].discovered).toBe(3);
    expect(rows[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("a resolved run stamps the login too, and rewrites rather than accumulating", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    for (const status of ["downloaded", "nothing-new"] as const) {
      const res = await SYNC_REPORT(
        report(memberToken, {
          status,
          portal: "ochsner-mychart",
          patient: "Jane Doe",
        })
      );
      expect(res.status).toBe(200);
    }
    // ONE row per login: "the last run this login reported". A tool reporting every five
    // minutes forever cannot grow this table.
    const rows = reportsFor(defaultAccount);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("nothing-new");
    expect(rows[0].ok).toBe(true);
  });

  it("stamps NOTHING when the token may not write the profile the binding names", async () => {
    // The stranger's token resolves a real login, but the binding points at a profile it
    // cannot write. A refused run must not get to stamp a household's card.
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(strangerToken, {
        status: "downloaded",
        portal: "ochsner-mychart",
        patient: "Jane Doe",
      })
    );
    expect(res.status).toBe(403);
    expect(reportsFor(defaultAccount)).toHaveLength(0);
    expect(syncEventCount()).toBe(0);
  });

  it("is a fact about the LOGIN, not about a profile", () => {
    const cols = (
      db.prepare("PRAGMA table_info(portal_run_reports)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    // A profile_id here would mean a profile-less run had been attributed to one.
    expect(cols).not.toContain("profile_id");
    expect(cols).toContain("account_id");
  });

  it("goes away with the login it describes, and with the portal", () => {
    const mom = createPortalAccount(portalId, "Mom");
    expect(mom.ok).toBe(true);
    if (!mom.ok) return;
    const account = accountsForPortal(portalId).find((a) => a.id === mom.id)!;
    recordPortalRunReport(account, {
      ok: false,
      status: "failed",
      message: "portal login page changed",
      discovered: 0,
    });
    expect(reportsFor(mom.id)).toHaveLength(1);
    expect(deletePortalAccount(mom.id)).toBe(true);
    expect(reportsFor(mom.id)).toHaveLength(0);

    const other = createPortal("Run Report Teardown");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const implicit = accountsForPortal(other.id)[0];
    recordPortalRunReport(implicit, {
      ok: true,
      status: "nothing-new",
      message: null,
      discovered: 0,
    });
    expect(reportsFor(implicit.id)).toHaveLength(1);
    expect(deletePortal(other.id)).toBe(true);
    expect(reportsFor(implicit.id)).toHaveLength(0);
  });
});

// A PORTAL-LEVEL failure (#1756). "The login page changed", "the Document Center moved" —
// the likely failure mode, and a PRE-PATIENT one. It is true of every patient on that
// login and of none in particular, so before this the tool had to invent a patient label
// to say it: a lie in the one table whose job is honest patient labels.
describe("a `failed` report that names only a portal", () => {
  it("is accepted, and lands as an account-level trace with no sync event", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        message: "portal login page changed",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      portal: string;
      account: string;
      status: string;
    };
    expect(body).toMatchObject({
      ok: true,
      portal: "ochsner-mychart",
      account: "default",
      status: "failed",
    });

    const rows = listPortalRunReports().filter(
      (r) => r.accountId === defaultAccount
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].message).toBe("portal login page changed");
    // No profile was guessed, so there is no profile-owned row to find.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM integration_sync_events")
          .get() as { n: number }
      ).n
    ).toBe(0);
  });

  it("still learns the proxy list a broken run managed to see", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        message: "document centre moved",
        identities: ["SMITH, ALEX"],
      })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { discovered?: number }).discovered).toBe(1);
    expect(listPendingIdentities().map((p) => p.patientLabel)).toEqual([
      "SMITH, ALEX",
    ]);
  });

  it("obeys the SAME omitted-account rule as everything else", async () => {
    const mom = createPortalAccount(portalId, "Mom");
    expect(mom.ok).toBe(true);
    if (!mom.ok) return;

    // Two logins now, so "one of your logins is failing" is not an actionable sentence:
    // the tool must say which. Refused with the same typed, non-oracular answer.
    const vague = await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        message: "portal login page changed",
      })
    );
    expect(vague.status).toBe(404);
    expect(((await vague.json()) as { error: string }).error).toBe(
      "unmapped-identity"
    );
    expect(listPortalRunReports()).toHaveLength(0);

    // Named, and it lands — under Mom, not under the implicit login.
    const named = await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner-mychart",
        account: "mom",
        message: "portal login page changed",
      })
    );
    expect(named.status).toBe(200);
    const rows = listPortalRunReports();
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(mom.id);
  });

  it("refuses an unknown portal without revealing that it is unknown", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, { status: "failed", portal: "no-such-portal" })
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unmapped-identity"
    );
    expect(listPortalRunReports()).toHaveLength(0);
  });

  it("does NOT let a non-failed status drop its patient", async () => {
    // "I checked and found nothing" is a claim about a patient's records, and is
    // meaningless without one. Same refusal text it always had.
    for (const status of ["downloaded", "nothing-new"] as const) {
      const res = await SYNC_REPORT(
        report(memberToken, { status, portal: "ochsner-mychart" })
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "`patient` must be a non-empty patient label"
      );
    }
    expect(listPortalRunReports()).toHaveLength(0);
  });
});

// The `discovered` echo (#1756). docs/api-tokens.md promises the field lets a tool tell
// its user "2 NEW patients need mapping in allos". The route used to echo the length of
// the reported list, so a steady-state run reporting the same three patients forever
// answered 3 — a number that means nothing and never changes.
describe("the `discovered` echo counts what is NEW", () => {
  const body = {
    status: "nothing-new",
    portal: "ochsner-mychart",
    patient: "Jane Doe",
    identities: ["SMITH, ALEX", "Ruth O'Hara-Smith"],
  };

  async function discoveredOf(req: Request): Promise<number | undefined> {
    const res = await SYNC_REPORT(req);
    return ((await res.json()) as { discovered?: number }).discovered;
  }

  it("answers the newly-waiting count on the first run and nothing on the second", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    expect(await discoveredOf(report(memberToken, body))).toBe(2);
    // Nothing new was learned, so the honest answer is "nothing" — the field is absent
    // rather than repeating a stale 2.
    expect(await discoveredOf(report(memberToken, body))).toBeUndefined();
    // And the third run, once one of them has been answered, still says nothing new.
    ignorePortalIdentity(defaultAccount, "SMITH, ALEX");
    expect(await discoveredOf(report(memberToken, body))).toBeUndefined();
  });

  it("counts only the newcomer when the list grows", async () => {
    bindPortalIdentity(defaultAccount, "Jane Doe", mineProfile);
    await SYNC_REPORT(report(memberToken, body));
    expect(
      await discoveredOf(
        report(memberToken, {
          ...body,
          identities: [...body.identities, "Third Person"],
        })
      )
    ).toBe(1);
  });

  it("is honest on the REFUSED path too, where the tool needs it most", async () => {
    // First contact: the run's own patient is unmapped, so this 404 is the only place
    // the tool hears how much setup is left.
    const first = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Unknown Reporter",
        identities: ["Unknown Reporter", "SMITH, ALEX"],
      })
    );
    expect(first.status).toBe(404);
    expect(((await first.json()) as { discovered?: number }).discovered).toBe(
      2
    );

    const second = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner-mychart",
        patient: "Unknown Reporter",
        identities: ["Unknown Reporter", "SMITH, ALEX"],
      })
    );
    expect(second.status).toBe(404);
    expect(
      ((await second.json()) as { discovered?: number }).discovered
    ).toBeUndefined();
  });
});
