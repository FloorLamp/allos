// DB INTEGRATION TIER — boundary NEGATIVE tests for the medical-file serve route
// (issue #1210). This route streams raw uploaded lab PDFs/scans by id — a PHI-serve
// path guarded by (1) a cookie-authoritative session check, (2) a `profile_id` scope
// so one profile can't fetch another's file by id, and (3) a path-containment guard
// so a tampered stored_path can't escape the upload root via `..` / an absolute path.
// e2e only ever traverses the happy path; these pin the DENIALS, where a regression is
// a direct PHI exposure.
//
// The route reads the acting session via getCurrentSession(); this file mocks THAT one
// function so the refusal cases (no session, wrong profile) are drivable without a
// cookie/request, keeping every real export (and the real DB) intact.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { CurrentSession } from "@/lib/auth";

// Mutable acting session the mocked getCurrentSession returns (vi.hoisted so it exists
// before the hoisted vi.mock factory runs).
const authState = vi.hoisted(() => ({
  session: null as CurrentSession | null,
}));

vi.mock("@/lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getCurrentSession: async () => authState.session };
});

import { db } from "@/lib/db";
import { GET } from "@/app/(app)/medical/file/[id]/route";

const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "uploads", "medical");

let profileA: number;
let profileB: number;
let loginA: number;
let docServe: number; // profile A, real file under the upload root
let docOther: number; // profile B (cross-profile)
let docEscape: number; // profile A, traversal stored_path
let docMissing: number; // profile A, contained path but no file on disk
let realFileAbs: string;

function sessionFor(profileId: number, loginId: number): CurrentSession {
  return {
    login: { id: loginId, username: `u${loginId}`, role: "member" },
    profile: {
      id: profileId,
      name: `P${profileId}`,
      photo_path: null,
      photo_version: 0,
    },
    access: "write",
  };
}

function insertDoc(
  profileId: number,
  storedPath: string,
  filename = "labs.pdf"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, mime_type, extraction_status)
         VALUES (?, ?, ?, 'application/pdf', 'done')`
      )
      .run(profileId, filename, storedPath).lastInsertRowid
  );
}

async function get(id: number | string): Promise<Response> {
  return GET(new Request(`http://x/medical/file/${id}`), {
    params: Promise.resolve({ id: String(id) }),
  });
}

beforeAll(() => {
  profileA = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('MedFile A')").run()
      .lastInsertRowid
  );
  profileB = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('MedFile B')").run()
      .lastInsertRowid
  );
  loginA = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES ('medfile_a', 'x', 'member')"
      )
      .run().lastInsertRowid
  );

  // A real, contained file for the happy-path serve. Uniquely named + cleaned up.
  const dir = path.join(UPLOAD_ROOT, String(profileA));
  fs.mkdirSync(dir, { recursive: true });
  realFileAbs = path.join(dir, `served-${process.pid}.pdf`);
  fs.writeFileSync(realFileAbs, "%PDF-1.4 synthetic");
  const relServe = path.relative(process.cwd(), realFileAbs);

  docServe = insertDoc(profileA, relServe);
  docOther = insertDoc(profileB, relServe); // owned by B
  // A tampered stored_path that resolves OUTSIDE the upload root.
  docEscape = insertDoc(
    profileA,
    `data/uploads/medical/${profileA}/../../../../../../etc/passwd`
  );
  // A contained path whose file does not exist on disk.
  docMissing = insertDoc(
    profileA,
    `data/uploads/medical/${profileA}/does-not-exist-${process.pid}.pdf`
  );
});

afterAll(() => {
  authState.session = null;
  try {
    fs.rmSync(realFileAbs, { force: true });
  } catch {
    // best-effort cleanup of the synthetic file
  }
});

describe("medical file route — denials (#1210)", () => {
  it("401s when there is no session", async () => {
    authState.session = null;
    const res = await get(docServe);
    expect(res.status).toBe(401);
  });

  it("404s a file owned by ANOTHER profile (cross-profile scope)", async () => {
    authState.session = sessionFor(profileA, loginA);
    const res = await get(docOther);
    expect(res.status).toBe(404);
    // Generic body — never leaks that the id exists for a different profile.
    expect(await res.text()).toBe("Not found");
  });

  it("404s an unknown id", async () => {
    authState.session = sessionFor(profileA, loginA);
    expect((await get(999_999)).status).toBe(404);
    // A non-numeric / zero id is rejected before any DB read.
    expect((await get("0")).status).toBe(404);
    expect((await get("not-a-number")).status).toBe(404);
  });

  it("404s a stored_path that escapes the upload root (path-containment guard)", async () => {
    authState.session = sessionFor(profileA, loginA);
    const res = await get(docEscape);
    expect(res.status).toBe(404);
  });

  it("410s a contained path whose file is missing on disk", async () => {
    authState.session = sessionFor(profileA, loginA);
    const res = await get(docMissing);
    expect(res.status).toBe(410);
  });

  it("serves the file to its owning profile and records an audit event", async () => {
    authState.session = sessionFor(profileA, loginA);
    const before = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'medical-file.view' AND active_profile_id = ?"
        )
        .get(profileA) as { n: number }
    ).n;
    const res = await get(docServe);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toContain("%PDF");
    const after = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'medical-file.view' AND active_profile_id = ?"
        )
        .get(profileA) as { n: number }
    ).n;
    expect(after).toBe(before + 1);
  });
});
