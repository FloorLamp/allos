// DB INTEGRATION TIER — `GET /api/documents/held` (#1776), driven as the REAL route
// handler with synthesized requests.
//
// The endpoint answers one question — "what does allos have for this identity?" — in
// four states, and the ones that are NOT "held" are the reason it is safe to build at all:
//
//   held    — hashes with stored bytes.
//   deleted — content-hash tombstones (#1777).
//   covered — offers refused as duplicates (#1828): nothing stored, but the records are
//             already held under other packaging.
//   none of them — send it.
//
// A bare `held` list would invite diff-and-send, and diff-and-send against a two-state
// answer resurrects every document the user deleted. So the tests below spend most of
// their time on the truthfulness of the split: a stored document is held and not
// deleted; a deleted one is deleted and not held; the lists never overlap; and a
// marker row (a 'skipped' duplicate, a 'failed' rejection) carries a hash but is NOT
// held, because a client told otherwise would stop sending a document allos does not
// have.
//
// The gate is the UPLOAD's, so it is pinned as such: same scope, same reachability-then-
// access order, same non-oracular `unmapped-identity` refusal, and never an answer
// beyond the authenticated identity's scope.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { GET } from "@/app/api/documents/held/route";
import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import {
  bindPortalIdentity,
  createPortal,
  accountsForPortal,
} from "@/lib/portals";
import { writeDocumentTombstone } from "@/lib/document-tombstones";
import { recordCoverageMarker } from "@/lib/document-coverage";

let writerToken: string;
let otherToken: string;
let revokedToken: string;
let readOnlyToken: string;

let heldProfile: number;
let otherProfile: number;
let readProfile: number;
let portalSlug: string;

// Low-entropy, obviously-fictional content hashes: a realistic sha-256 literal is what
// trips the repo's secret scanning, and nothing here needs one.
const STORED_HASH = "e2e-doc-hash-held-stored-1";
const DELETED_HASH = "e2e-doc-hash-held-deleted-1";
const DUPLICATE_MARKER_HASH = "e2e-doc-hash-held-marker-1";
const FAILED_MARKER_HASH = "e2e-doc-hash-held-failed-1";
const PROCESSING_HASH = "e2e-doc-hash-held-processing-1";
const OTHER_PROFILE_HASH = "e2e-doc-hash-held-otherprofile-1";

function req(token: string | null, query: string): Request {
  return new Request(`http://x/api/documents/held?${query}`, {
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

function insertDoc(
  profileId: number,
  filename: string,
  contentHash: string,
  status: string,
  storedPath: string
): void {
  db.prepare(
    `INSERT INTO medical_documents
       (filename, stored_path, mime_type, size_bytes, content_hash,
        extraction_status, uploaded_at, profile_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    filename,
    storedPath,
    "application/pdf",
    512,
    contentHash,
    status,
    sqlNow(),
    profileId
  );
}

// A stored document that CARRIES a clinical identity (#1780) — the thing a coverage
// marker points at. Its own content hash is unique per call and irrelevant to the
// coverage question, which keys on the clinical key alone.
function insertKeyedDoc(
  profileId: number,
  filename: string,
  clinicalKey: string
): void {
  db.prepare(
    `INSERT INTO medical_documents
       (filename, stored_path, mime_type, size_bytes, content_hash, clinical_key,
        extraction_status, uploaded_at, profile_id)
     VALUES (?,?,?,?,?,?,'done',?,?)`
  ).run(
    filename,
    `data/uploads/medical/${profileId}/${filename}`,
    "application/xml",
    512,
    `e2e-doc-hash-held-${clinicalKey}`,
    clinicalKey,
    sqlNow(),
    profileId
  );
}

beforeAll(async () => {
  heldProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Held Inventory')").run()
      .lastInsertRowid
  );
  otherProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Held Other')").run()
      .lastInsertRowid
  );
  readProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Held Readonly')").run()
      .lastInsertRowid
  );

  const writerLogin = makeLogin("held-writer", "member");
  const otherLogin = makeLogin("held-other", "member");
  const readOnlyLogin = makeLogin("held-readonly", "member");

  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(writerLogin, heldProfile);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(otherLogin, otherProfile);
  // A caregiver who may LOOK at a profile but not file documents into it.
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(readOnlyLogin, readProfile);

  writerToken = (await createApiToken(writerLogin, "w", "upload:documents"))
    .token;
  otherToken = (await createApiToken(otherLogin, "o", "upload:documents"))
    .token;
  readOnlyToken = (await createApiToken(readOnlyLogin, "r", "upload:documents"))
    .token;
  const revoked = await createApiToken(writerLogin, "x", "upload:documents");
  revokedToken = revoked.token;
  revokeApiToken(revoked.id, writerLogin, "member");

  // A stored document, plus the three rows that carry a hash but hold no bytes.
  insertDoc(
    heldProfile,
    "stored.pdf",
    STORED_HASH,
    "done",
    `data/uploads/medical/${heldProfile}/stored.pdf`
  );
  insertDoc(heldProfile, "dupe.pdf", DUPLICATE_MARKER_HASH, "skipped", "");
  insertDoc(heldProfile, "toobig.pdf", FAILED_MARKER_HASH, "failed", "");
  // In flight: no stored_path YET, but the bytes are on their way — held, so a second
  // sender cannot race in beside it.
  insertDoc(heldProfile, "inflight.pdf", PROCESSING_HASH, "processing", "");

  // A document this profile DELETED.
  writeDocumentTombstone(heldProfile, DELETED_HASH, "deleted-labs.pdf");

  // Another profile's stored document, to prove the answer never leaks across.
  insertDoc(
    otherProfile,
    "other.pdf",
    OTHER_PROFILE_HASH,
    "done",
    `data/uploads/medical/${otherProfile}/other.pdf`
  );

  // A portal identity resolving to the held profile, for the acquirer's destination form.
  const portal = createPortal("Held Inventory Portal", "mychart");
  expect(portal.ok).toBe(true);
  const portalId = portal.ok ? portal.id : 0;
  portalSlug = "held-inventory-portal";
  const account = accountsForPortal(portalId)[0];
  expect(
    bindPortalIdentity(account.id, "HELDPATIENT, ONE", heldProfile).ok
  ).toBe(true);
});

describe("GET /api/documents/held — the gate", () => {
  it("401s without a token", async () => {
    expect((await GET(req(null, `profile=${heldProfile}`))).status).toBe(401);
  });

  it("401s a revoked token", async () => {
    expect(
      (await GET(req(revokedToken, `profile=${heldProfile}`))).status
    ).toBe(401);
  });

  it("403s a token that may not WRITE the profile", async () => {
    // The gate mirrors the upload's exactly, so the inventory can never answer for a
    // profile the same token would be refused at.
    const res = await GET(req(readOnlyToken, `profile=${readProfile}`));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.held).toBeUndefined();
  });

  it("403s another login's profile — never a probe for what exists", async () => {
    // Unreachable and reachable-but-read-only answer identically.
    const res = await GET(req(otherToken, `profile=${heldProfile}`));
    expect(res.status).toBe(403);
    expect((await res.json()).held).toBeUndefined();
  });

  it("400s a request naming no destination, or naming both", async () => {
    expect((await GET(req(writerToken, ""))).status).toBe(400);
    expect(
      (await GET(req(writerToken, `profile=${heldProfile}&portal=x&patient=y`)))
        .status
    ).toBe(400);
  });

  it("404s an unmapped identity with the upload's typed refusal", async () => {
    const res = await GET(
      req(writerToken, `portal=${portalSlug}&patient=NOBODY%2C%20HERE`)
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    // One case for a client to handle, worded identically on both endpoints.
    expect(body.error).toBe("unmapped-identity");
  });

  it("records NO pending identity for a refused read", async () => {
    const before = (
      db.prepare("SELECT COUNT(*) AS n FROM portal_identities").get() as {
        n: number;
      }
    ).n;
    await GET(req(writerToken, `portal=${portalSlug}&patient=GHOST%2C%20TWO`));
    const after = (
      db.prepare("SELECT COUNT(*) AS n FROM portal_identities").get() as {
        n: number;
      }
    ).n;
    // The pending list belongs to the WRITE paths, where a refusal is a real attempt to
    // file something. A read that could append to it would let a token grow a
    // household's list forever without ever pushing a document.
    expect(after).toBe(before);
  });
});

describe("GET /api/documents/held — the three states", () => {
  it("answers held and deleted for the profile form", async () => {
    const res = await GET(req(writerToken, `profile=${heldProfile}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.profile).toBe(heldProfile);

    // HELD: real bytes, and the in-flight row whose bytes are on their way.
    expect(body.held).toContain(STORED_HASH);
    expect(body.held).toContain(PROCESSING_HASH);

    // NOT HELD: rows that carry a hash but hold nothing. Telling a client otherwise
    // would make it stop sending a document allos does not have — the exact silent,
    // permanent failure this endpoint exists to end.
    expect(body.held).not.toContain(DUPLICATE_MARKER_HASH);
    expect(body.held).not.toContain(FAILED_MARKER_HASH);

    // DELETED: the tombstone, which is what stops diff-and-send from resurrecting it.
    expect(body.deleted).toContain(DELETED_HASH);
    expect(body.held).not.toContain(DELETED_HASH);
  });

  it("keeps held and deleted disjoint", async () => {
    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    const overlap = (body.held as string[]).filter((h) =>
      (body.deleted as string[]).includes(h)
    );
    expect(overlap).toEqual([]);
  });

  it("answers the same inventory through the acquirer's identity form", async () => {
    const res = await GET(
      req(writerToken, `portal=${portalSlug}&patient=HELDPATIENT%2C%20ONE`)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Resolved to the same profile, so the two destination forms cannot disagree about
    // what is held.
    expect(body.profile).toBe(heldProfile);
    expect(body.held).toContain(STORED_HASH);
    expect(body.deleted).toContain(DELETED_HASH);
  });

  it("never answers beyond the identity's own profile", async () => {
    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    expect(body.held).not.toContain(OTHER_PROFILE_HASH);
  });

  it("discloses hashes ONLY — no filenames reach an automated client", async () => {
    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    const serialized = JSON.stringify(body);
    // The names of documents a person deleted are shown to PEOPLE, in Data → Review.
    expect(serialized).not.toContain("deleted-labs.pdf");
    expect(serialized).not.toContain("stored.pdf");
    expect(Object.keys(body).sort()).toEqual([
      "covered",
      "deleted",
      "held",
      "ok",
      "profile",
    ]);
  });

  // ── The third list (#1828) ────────────────────────────────────────────────
  it("answers `covered` for a hash it refused as a records-duplicate", async () => {
    // Nothing was stored for these bytes, so they are in neither of the other two lists —
    // which is exactly why the two-list rule told a client to re-send them forever.
    const key = "e2e-clinical-key-covered-present-1";
    insertKeyedDoc(heldProfile, "covering-present.xml", key);
    const hash = "e2e-doc-hash-held-covered-1";
    recordCoverageMarker(heldProfile, hash, key);

    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    expect(body.covered).toContain(hash);
    expect(body.held).not.toContain(hash);
    expect(body.deleted).not.toContain(hash);
  });

  it("omits a hash whose records nothing holds any more", async () => {
    // The marker exists but its covering document never did — the state a delete leaves
    // behind. Validity is recomputed at READ, so there is no invalidation hook that could
    // be forgotten, and the client re-offers on its very next run having been told
    // nothing.
    const hash = "e2e-doc-hash-held-uncovered-1";
    recordCoverageMarker(heldProfile, hash, "e2e-clinical-key-nobody-holds-1");
    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    expect(body.covered).not.toContain(hash);
  });

  it("keeps all three lists disjoint", async () => {
    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    const held = body.held as string[];
    const deleted = body.deleted as string[];
    const covered = body.covered as string[];
    expect(covered.filter((h) => held.includes(h))).toEqual([]);
    expect(covered.filter((h) => deleted.includes(h))).toEqual([]);
  });

  it("never answers another profile's coverage", async () => {
    const key = "e2e-clinical-key-otherprofile-1";
    insertKeyedDoc(otherProfile, "covering-other.xml", key);
    const hash = "e2e-doc-hash-held-covered-other-1";
    recordCoverageMarker(otherProfile, hash, key);

    const body = await (
      await GET(req(writerToken, `profile=${heldProfile}`))
    ).json();
    expect(body.covered).not.toContain(hash);
  });
});
