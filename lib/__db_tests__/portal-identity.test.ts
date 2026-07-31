// DB INTEGRATION TIER — the MyChart acquirer's identity surface (#1739) and the two
// #1735 extensions, driven as the real route handlers.
//
// The tests that matter here are the REFUSALS, because the harm this feature exists to
// prevent is a document landing under the wrong person:
//   • an unbound identity refuses (typed) and never defaults onto any profile;
//   • a bound identity whose profile the pushing token cannot write is refused too — a
//     mapping is never a bypass of profile authorization;
//   • two visibly different patient labels never collapse into one binding.
// Plus the sync-report accounting, where "nothing new" must read as calm success.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { POST as UPLOAD } from "@/app/api/documents/route";
import { POST as SYNC_REPORT } from "@/app/api/documents/sync-report/route";
import { createApiToken } from "@/lib/api-tokens";
import {
  bindPortalIdentity,
  createPortal,
  deletePortal,
  listPortalIdentities,
  listPortals,
  portalBySlug,
  resolvePortalIdentity,
  unbindPortalIdentity,
} from "@/lib/portals";

let memberLogin: number;
let strangerLogin: number;
let mineProfile: number;
let readOnlyProfile: number;
let strangersProfile: number;
let memberToken: string;
let strangerToken: string;
let portalId: number;

function pdfBytes(marker: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  );
}

function uploadByIdentity(
  token: string,
  portal: string,
  patient: string,
  marker: string
): Request {
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdfBytes(marker)], { type: "application/pdf" }),
    "labs.pdf"
  );
  const qs = `?portal=${encodeURIComponent(portal)}&patient=${encodeURIComponent(patient)}`;
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

  const made = createPortal("ochsner", "Ochsner MyChart");
  expect(made.ok).toBe(true);
  portalId = made.ok ? made.id : 0;
});

beforeEach(() => {
  db.exec("DELETE FROM medical_documents");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  db.exec("DELETE FROM portal_identities");
});

describe("portal registry", () => {
  it("registers a portal and finds it by slug, case-insensitively", () => {
    expect(portalBySlug("OCHSNER")?.id).toBe(portalId);
    expect(listPortals().some((p) => p.slug === "ochsner")).toBe(true);
  });

  it("refuses a duplicate slug", () => {
    expect(createPortal("ochsner", "Another").ok).toBe(false);
  });

  it("refuses a slug that is not a slug", () => {
    expect(createPortal("Not A Slug", "x").ok).toBe(false);
    expect(createPortal("", "x").ok).toBe(false);
  });

  it("REFUSES a URL in the display name — the no-address invariant", () => {
    // The schema has no address column at all; this closes the one free-text field
    // where an address could otherwise enter the authoritative record.
    const r = createPortal("evilportal", "https://mychart.evil.example/login");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/never a web address/i);
  });

  it("has no address column, and cannot grow one by accident", () => {
    const cols = (
      db.prepare("PRAGMA table_info(portals)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols.sort()).toEqual(["created_at", "id", "name", "slug"]);
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

  it("deleting a portal takes its bindings with it", () => {
    const p = createPortal("temp-portal", "Temp");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    bindPortalIdentity(p.id, "Jane Doe", mineProfile);
    expect(deletePortal(p.id)).toBe(true);
    expect(listPortalIdentities().some((i) => i.portalId === p.id)).toBe(false);
  });
});

describe("identity bindings", () => {
  it("binds a label to a profile and resolves it back", () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    const r = resolvePortalIdentity("ochsner", "Jane Doe");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profileId).toBe(mineProfile);
  });

  it("resolves through the same whitespace normalization the write used", () => {
    bindPortalIdentity(portalId, "  Jane   Doe  ", mineProfile);
    expect(resolvePortalIdentity("ochsner", "Jane Doe").ok).toBe(true);
    expect(resolvePortalIdentity("ochsner", "Jane\nDoe").ok).toBe(true);
  });

  it("does NOT collapse two visibly different labels", () => {
    // A label is a key, not a search. Unifying these is how one patient's records land
    // under another's profile.
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    expect(resolvePortalIdentity("ochsner", "JANE DOE").ok).toBe(false);
    expect(resolvePortalIdentity("ochsner", "Jane Q. Doe").ok).toBe(false);
  });

  it("re-binding REPLACES rather than creating a second answer", () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    bindPortalIdentity(portalId, "Jane Doe", strangersProfile);
    const rows = listPortalIdentities().filter(
      (i) => i.patientLabel === "Jane Doe"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].profileId).toBe(strangersProfile);
  });

  it("refuses an empty label and an unknown portal", () => {
    expect(bindPortalIdentity(portalId, "   ", mineProfile).ok).toBe(false);
    expect(bindPortalIdentity(999999, "Jane Doe", mineProfile).ok).toBe(false);
  });

  it("unbinds, and only for the profile the binding actually points at (#1747)", () => {
    const b = bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    // The delete is scoped to (id, profile_id): naming the right row under the WRONG
    // profile deletes nothing. That is what makes it a compare-and-swap rather than a
    // delete-by-surrogate-id an unrelated authorization could ride.
    expect(unbindPortalIdentity(b.id, strangersProfile)).toBe(false);
    expect(resolvePortalIdentity("ochsner", "Jane Doe").ok).toBe(true);

    expect(unbindPortalIdentity(b.id, mineProfile)).toBe(true);
    expect(resolvePortalIdentity("ochsner", "Jane Doe").ok).toBe(false);
  });

  it("dies with its profile (OWNED_TABLES / FK cascade)", () => {
    const doomed = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Doomed')").run()
        .lastInsertRowid
    );
    bindPortalIdentity(portalId, "Doomed Patient", doomed);
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM profiles WHERE id = ?").run(doomed);
    // A dangling binding would resolve an upload onto a profile that no longer exists.
    expect(resolvePortalIdentity("ochsner", "Doomed Patient").ok).toBe(false);
  });
});

describe("POST /api/documents — identity form", () => {
  it("ingests under the BOUND profile", async () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner", "Jane Doe", "bound")
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

  it("refuses an UNMAPPED identity with the typed outcome, storing nothing", async () => {
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner", "Nobody Known", "unmapped")
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

  it("refuses a binding to a profile the token may only READ", async () => {
    bindPortalIdentity(portalId, "Read Only", readOnlyProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner", "Read Only", "readonly")
    );
    expect(res.status).toBe(403);
    expect(docCount(readOnlyProfile)).toBe(0);
  });

  it("refuses a binding to a profile the token cannot reach — a mapping is not a bypass", async () => {
    // The binding is perfectly valid; this token just has no business writing there.
    bindPortalIdentity(portalId, "Someone Else", strangersProfile);
    const res = await UPLOAD(
      uploadByIdentity(memberToken, "ochsner", "Someone Else", "cross")
    );
    expect(res.status).toBe(403);
    expect(docCount(strangersProfile)).toBe(0);
  });

  it("another token with the right grant CAN use the same binding", async () => {
    bindPortalIdentity(portalId, "Someone Else", strangersProfile);
    const res = await UPLOAD(
      uploadByIdentity(strangerToken, "ochsner", "Someone Else", "theirs")
    );
    expect(res.status).toBe(200);
    expect(docCount(strangersProfile)).toBe(1);
  });

  it("400s when BOTH a profile and an identity are named", async () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("both")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request(
        `http://x/api/documents?profile=${mineProfile}&portal=ochsner&patient=Jane%20Doe`,
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

  it("400s when NEITHER is named", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([pdfBytes("neither")], { type: "application/pdf" }),
      "labs.pdf"
    );
    const res = await UPLOAD(
      new Request("http://x/api/documents", {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
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

describe("POST /api/documents/sync-report", () => {
  function events(profileId: number) {
    return db
      .prepare(
        `SELECT ok, inserted, updated, unchanged, skipped, error
           FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'mychart'
          ORDER BY id DESC`
      )
      .all(profileId) as {
      ok: number;
      inserted: number | null;
      updated: number | null;
      unchanged: number | null;
      skipped: number | null;
      error: string | null;
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

  it("lands a downloaded run as a sync event with its counts", async () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner",
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
  });

  it("records nothing-new as a CALM SUCCESS that advances Last synced", async () => {
    // The common case, and the reason this endpoint exists: zero documents pushed, but
    // the run must leave a trace or a quiet week reads as broken.
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner",
        patient: "Jane Doe",
        unchanged: 5,
      })
    );
    expect(res.status).toBe(200);
    const rows = events(mineProfile);
    expect(rows[0].ok).toBe(1);
    expect(rows[0].error).toBeNull();
    expect(rows).toHaveLength(1);
    // "Last synced" must ACTUALLY populate — a quiet check is still a check, and the
    // connection is demonstrably alive. The first successful report is also what creates
    // the connection row: an external-attended integration has no OAuth dance or token
    // paste to create it beforehand.
    const conn = db
      .prepare(
        "SELECT status, last_sync_at AS at FROM integration_connections WHERE profile_id = ? AND provider = 'mychart'"
      )
      .get(mineProfile) as { status: string; at: string | null } | undefined;
    expect(conn?.status).toBe("connected");
    expect(conn?.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("records a failed run as ok:false with its message", async () => {
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner",
        patient: "Jane Doe",
        failed: 2,
        message: "portal login timed out",
      })
    );
    const rows = events(mineProfile);
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toBe("portal login timed out");
    expect(rows[0].skipped).toBe(2);
    // A failing run never invents a "last synced" it didn't earn.
    const conn = db
      .prepare(
        "SELECT last_sync_at AS at FROM integration_connections WHERE profile_id = ? AND provider = 'mychart'"
      )
      .get(mineProfile) as { at: string | null } | undefined;
    expect(conn?.at ?? null).toBeNull();
  });

  it("a failure AFTER a success leaves the earlier timestamp standing", async () => {
    // The card must show how long it has actually been since the portal was last read
    // successfully — not reset to "just now" because a failed attempt happened.
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner",
        patient: "Jane Doe",
        inserted: 1,
      })
    );
    const readStamp = () =>
      (
        db
          .prepare(
            "SELECT last_sync_at AS at FROM integration_connections WHERE profile_id = ? AND provider = 'mychart'"
          )
          .get(mineProfile) as { at: string | null }
      ).at;
    const afterSuccess = readStamp();
    expect(afterSuccess).toBeTruthy();

    await SYNC_REPORT(
      report(memberToken, {
        status: "failed",
        portal: "ochsner",
        patient: "Jane Doe",
        message: "portal unreachable",
      })
    );
    expect(readStamp()).toBe(afterSuccess);
    // …and the failure is still recorded, so the Review badge fires.
    expect(events(mineProfile)[0].ok).toBe(0);
  });

  it("refuses an unmapped identity, recording nothing", async () => {
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "nothing-new",
        portal: "ochsner",
        patient: "Nobody Known",
      })
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unmapped-identity"
    );
    expect(events(mineProfile)).toHaveLength(0);
  });

  it("refuses a profile the token cannot write, recording nothing", async () => {
    bindPortalIdentity(portalId, "Someone Else", strangersProfile);
    const res = await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner",
        patient: "Someone Else",
        inserted: 1,
      })
    );
    expect(res.status).toBe(403);
    expect(events(strangersProfile)).toHaveLength(0);
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
    bindPortalIdentity(portalId, "Jane Doe", mineProfile);
    await SYNC_REPORT(
      report(memberToken, {
        status: "downloaded",
        portal: "ochsner",
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
