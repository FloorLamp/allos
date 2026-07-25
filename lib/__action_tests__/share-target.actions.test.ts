// SERVER-ACTION TIER — the PWA share-target route (issue #1423). The route is a
// cookie-authed Route Handler rather than a Server Action, but it resolves the
// acting identity through the SAME lib/auth chokepoint this tier mocks
// (getCurrentSession / accessForProfile, both faithful against the real temp DB),
// so the whole write path is driveable end-to-end: a multipart POST in, a real
// medical_documents row out.
//
// What it pins:
//   (a) a shared file lands a document for the ACTIVE profile and redirects (303 —
//       never a method-preserving 307) to that stored document;
//   (b) the shared engine's content-hash DEDUP applies — a second share of the same
//       bytes doesn't store a second copy, it lands the 'skipped' duplicate row;
//   (c) no session → 303 to /login and NOTHING is persisted (the v1 contract: the
//       shared file is dropped, the user retries after signing in);
//   (d) a read-only acting session is refused with the #478 JSON error shape, and
//       an empty multipart body likewise;
//   (e) an unsupported file is rejected BY THE SHARED ENGINE (a 'failed' document
//       row carrying the reason), not by a second gate in the route.
//
// FIXTURES are synthetic and AI-free on purpose: the "successfully stored" cases use
// a tiny fictional FHIR bundle, which the pipeline imports DETERMINISTICALLY (no
// Anthropic call, no key, no background race) — so the tier never depends on model
// availability. No PHI: a fictional patient, no identifiers.

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { POST } from "@/app/share-target/route";
import { UPLOAD_DIR } from "@/lib/medical-pipeline";
import {
  createLogin,
  createProfile,
  seedActor,
  actAs,
  type TestProfile,
} from "./harness";
import { clearActingSession } from "./session-state";

// A minimal, valid FHIR bundle — deterministic import path, zero AI.
function healthBundle(salt: string): File {
  const body = JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    id: `share-target-${salt}`,
    entry: [],
  });
  return new File([Buffer.from(body)], `shared-${salt}.json`, {
    type: "application/fhir+json",
  });
}

function shareRequest(files: File[]): Request {
  const form = new FormData();
  // Same field name the upload form posts under (app/manifest.ts declares it).
  for (const f of files) form.append("file", f);
  return new Request("http://test/share-target", {
    method: "POST",
    body: form,
  });
}

interface DocRow {
  id: number;
  filename: string;
  status: string;
  error: string | null;
  stored_path: string | null;
}

function docRows(profileId: number): DocRow[] {
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, extraction_error AS error, stored_path
         FROM medical_documents WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as DocRow[];
}

function totalDocs(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM medical_documents").get() as {
      n: number;
    }
  ).n;
}

// Files land under data/uploads/medical/<profileId>/ relative to cwd (the repo, not
// the temp DB dir), so drop the per-profile directories this file created.
const touchedProfiles: TestProfile[] = [];
afterAll(() => {
  for (const p of touchedProfiles) {
    try {
      fs.rmSync(path.join(UPLOAD_DIR, String(p.id)), {
        recursive: true,
        force: true,
      });
    } catch {
      // best-effort cleanup of a gitignored scratch dir
    }
  }
});

describe("share-target route: a shared file reaches the medical pipeline", () => {
  it("stores the file for the ACTIVE profile and 303s to that document", async () => {
    const { profile } = seedActor({ profileName: "Share Target Subject" });
    touchedProfiles.push(profile);

    const res = await POST(shareRequest([healthBundle("one")]));

    // 303 See Other: the browser must follow with GET, never re-POST the body.
    expect(res.status).toBe(303);
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("shared-one.json");
    expect(rows[0].stored_path).toBeTruthy();
    // …and the redirect points at THAT stored document — the detail page, which is
    // where the "Wrong person?" reassign control lives (a share sheet can't pick a
    // profile, so the choice has to be visible and correctable).
    expect(res.headers.get("location")).toBe(`/import/${rows[0].id}`);
  });

  it("dedups a re-shared file instead of storing a second copy", async () => {
    const { profile } = seedActor({ profileName: "Share Target Dedup" });
    touchedProfiles.push(profile);

    await POST(shareRequest([healthBundle("dup")]));
    const first = docRows(profile.id);
    expect(first).toHaveLength(1);

    // The same bytes again (as a re-share of the same file would be).
    const res = await POST(shareRequest([healthBundle("dup")]));
    expect(res.status).toBe(303);

    const rows = docRows(profile.id);
    expect(rows).toHaveLength(2);
    const dupe = rows[1];
    expect(dupe.status).toBe("skipped");
    expect(dupe.error ?? "").toMatch(/duplicate upload/i);
    // No second file on disk — the duplicate row carries no stored path.
    expect(dupe.stored_path ?? "").toBe("");
  });

  it("sends several shared files to the Review feed rather than one document", async () => {
    const { profile } = seedActor({ profileName: "Share Target Batch" });
    touchedProfiles.push(profile);

    const res = await POST(
      shareRequest([healthBundle("batch-a"), healthBundle("batch-b")])
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/data?section=review");
    expect(docRows(profile.id)).toHaveLength(2);
  });

  it("lets the SHARED engine reject an unsupported file (a failed document row)", async () => {
    const { profile } = seedActor({ profileName: "Share Target Unsupported" });
    touchedProfiles.push(profile);

    const res = await POST(
      shareRequest([
        new File([Buffer.from("not a document")], "note.txt", {
          type: "text/plain",
        }),
      ])
    );

    // The route adds NO type gate of its own (a second copy would drift from the
    // upload form's): the engine lands its usual failed-document row, and the user
    // is sent to it so the reason is visible.
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error ?? "").toMatch(/unsupported file type/i);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/import/${rows[0].id}`);
  });
});

describe("share-target route: the auth + input gates", () => {
  it("drops an anonymous share: 303 to /login, nothing persisted", async () => {
    const before = totalDocs();
    clearActingSession();

    const res = await POST(shareRequest([healthBundle("anon")]));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/login?next=%2Fdata%3Fsection%3Dimport"
    );
    // v1 contract: NOTHING is stashed for later — no row anywhere, for any profile.
    expect(totalDocs()).toBe(before);
  });

  it("refuses a read-only acting session with the JSON error shape", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Share Target Read Only", login.id);
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(login.id, profile.id);
    actAs(login, profile, "read");

    const res = await POST(shareRequest([healthBundle("readonly")]));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no write access to the active profile",
    });
    expect(docRows(profile.id)).toHaveLength(0);
  });

  it("answers a share carrying no file with a 400 and the JSON error shape", async () => {
    const { profile } = seedActor({ profileName: "Share Target Empty" });

    const res = await POST(shareRequest([]));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "no file was shared",
    });
    expect(docRows(profile.id)).toHaveLength(0);
  });
});
