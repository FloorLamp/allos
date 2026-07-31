// DB INTEGRATION TIER — the remote document-upload endpoint (#1735), driven as the REAL
// route handlers with synthesized requests.
//
// This is a token-authenticated WRITE endpoint reachable without a cookie, so the tests
// that matter are the refusals: a wrong/absent/revoked token, a token whose capability
// doesn't cover this endpoint, a profile the login cannot reach, and a profile it can
// reach but only read. Each must refuse BEFORE any file is ingested — asserted by
// counting the profile's documents afterwards, not just by reading the status code.
//
// The happy paths pin the two things the route promises on top of the engine: a per-file
// outcome that is never a blanket success, and dedup that is per profile.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/documents/route";
import { GET } from "@/app/api/documents/profiles/route";
import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import { MAX_AI_BYTES } from "@/lib/upload-gate";

let adminLogin: number;
let memberLogin: number;
let strangerLogin: number;
let writeProfile: number;
let readProfile: number;
let otherProfile: number;
let memberToken: string;
let adminToken: string;
let strangerToken: string;

// A minimal but genuine PDF — the engine sniffs magic bytes, so a file claiming .pdf
// must actually start with %PDF- or it is (correctly) refused.
function pdfBytes(marker: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  );
}

function uploadRequest(
  token: string | null,
  profile: number | string | null,
  files: { name: string; bytes: Uint8Array<ArrayBuffer> }[]
): Request {
  const form = new FormData();
  for (const f of files) {
    form.append(
      "file",
      new Blob([f.bytes], { type: "application/pdf" }),
      f.name
    );
  }
  const qs = profile === null ? "" : `?profile=${profile}`;
  return new Request(`http://x/api/documents${qs}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

function listRequest(token: string | null): Request {
  return new Request("http://x/api/documents/profiles", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
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
  writeProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Upload Writable')").run()
      .lastInsertRowid
  );
  readProfile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Upload Readonly')").run()
      .lastInsertRowid
  );
  otherProfile = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES ('Upload Unreachable')")
      .run().lastInsertRowid
  );

  adminLogin = makeLogin("doc-admin", "admin");
  memberLogin = makeLogin("doc-member", "member");
  strangerLogin = makeLogin("doc-stranger", "member");

  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(memberLogin, writeProfile);
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
  ).run(memberLogin, readProfile);

  memberToken = (await createApiToken(memberLogin, "m", "upload:documents"))
    .token;
  adminToken = (await createApiToken(adminLogin, "a", "upload:documents"))
    .token;
  strangerToken = (await createApiToken(strangerLogin, "s", "upload:documents"))
    .token;
});

beforeEach(() => {
  db.exec("DELETE FROM medical_documents");
});

describe("POST /api/documents — authentication", () => {
  it("401s with no Authorization header, and stores nothing", async () => {
    const res = await POST(
      uploadRequest(null, writeProfile, [
        { name: "labs.pdf", bytes: pdfBytes("anon") },
      ])
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(docCount(writeProfile)).toBe(0);
  });

  it("401s a bogus token, and never echoes it back", async () => {
    const bogus = "4242.definitely-not-a-real-secret-00";
    const res = await POST(
      uploadRequest(bogus, writeProfile, [
        { name: "labs.pdf", bytes: pdfBytes("bogus") },
      ])
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("definitely-not-a-real-secret");
    expect(docCount(writeProfile)).toBe(0);
  });

  it("401s a REVOKED token", async () => {
    const minted = await createApiToken(
      memberLogin,
      "short-lived",
      "upload:documents"
    );
    revokeApiToken(minted.id, memberLogin, "member");
    const res = await POST(
      uploadRequest(minted.token, writeProfile, [
        { name: "labs.pdf", bytes: pdfBytes("revoked") },
      ])
    );
    expect(res.status).toBe(401);
    expect(docCount(writeProfile)).toBe(0);
  });
});

describe("POST /api/documents — authorization", () => {
  it("403s a profile the login cannot reach at all, storing nothing", async () => {
    const res = await POST(
      uploadRequest(strangerToken, writeProfile, [
        { name: "labs.pdf", bytes: pdfBytes("stranger") },
      ])
    );
    expect(res.status).toBe(403);
    expect(docCount(writeProfile)).toBe(0);
  });

  it("403s a profile granted READ-only", async () => {
    const res = await POST(
      uploadRequest(memberToken, readProfile, [
        { name: "labs.pdf", bytes: pdfBytes("readonly") },
      ])
    );
    expect(res.status).toBe(403);
    expect(docCount(readProfile)).toBe(0);
  });

  it("gives the same 403 for unreachable and read-only (no existence probe)", async () => {
    const unreachable = await POST(
      uploadRequest(memberToken, otherProfile, [
        { name: "a.pdf", bytes: pdfBytes("x") },
      ])
    );
    const readonly = await POST(
      uploadRequest(memberToken, readProfile, [
        { name: "a.pdf", bytes: pdfBytes("x") },
      ])
    );
    expect(unreachable.status).toBe(403);
    expect(readonly.status).toBe(403);
    expect((await unreachable.json()) as unknown).toEqual(
      (await readonly.json()) as unknown
    );
  });

  it("lets an admin upload to any profile (implicit all-write)", async () => {
    const res = await POST(
      uploadRequest(adminToken, otherProfile, [
        { name: "admin.pdf", bytes: pdfBytes("admin") },
      ])
    );
    expect(res.status).toBe(200);
    expect(docCount(otherProfile)).toBe(1);
  });

  it("revoking the member's grant refuses the SAME token on the next request", async () => {
    const ok = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "before.pdf", bytes: pdfBytes("before") },
      ])
    );
    expect(ok.status).toBe(200);

    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(memberLogin, writeProfile);
    const after = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "after.pdf", bytes: pdfBytes("after") },
      ])
    );
    expect(after.status).toBe(403);
    // Restore for the remaining tests.
    db.prepare(
      "UPDATE login_profiles SET access = 'write' WHERE login_id = ? AND profile_id = ?"
    ).run(memberLogin, writeProfile);
  });
});

describe("POST /api/documents — scope", () => {
  it("403s a token whose capability does not cover this endpoint", async () => {
    // Force a stored scope the endpoint does not demand. The column CHECK guards the
    // supported vocabulary, so this reaches past it deliberately to prove the ROUTE
    // checks the capability rather than trusting the row.
    const minted = await createApiToken(
      memberLogin,
      "wrong-scope",
      "upload:documents"
    );
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      "UPDATE api_tokens SET scope = 'read:documents' WHERE id = ?"
    ).run(minted.id);
    db.pragma("ignore_check_constraints = OFF");

    const res = await POST(
      uploadRequest(minted.token, writeProfile, [
        { name: "scope.pdf", bytes: pdfBytes("scope") },
      ])
    );
    expect(res.status).toBe(403);
    expect(docCount(writeProfile)).toBe(0);
  });
});

describe("POST /api/documents — request shape", () => {
  it("400s when no profile is named — it never guesses one", async () => {
    const res = await POST(
      uploadRequest(memberToken, null, [
        { name: "labs.pdf", bytes: pdfBytes("noprofile") },
      ])
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "profile"
    );
    expect(docCount(writeProfile)).toBe(0);
  });

  it("400s when the body carried no files", async () => {
    const res = await POST(uploadRequest(memberToken, writeProfile, []));
    expect(res.status).toBe(400);
    expect(docCount(writeProfile)).toBe(0);
  });

  it("400s a body that isn't multipart at all", async () => {
    const res = await POST(
      new Request(`http://x/api/documents?profile=${writeProfile}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      })
    );
    expect(res.status).toBe(400);
  });

  it("accepts the profile as a multipart field too", async () => {
    const form = new FormData();
    form.append("profile", String(writeProfile));
    form.append(
      "file",
      new Blob([pdfBytes("field")], { type: "application/pdf" }),
      "field.pdf"
    );
    const res = await POST(
      new Request("http://x/api/documents", {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);
    expect(docCount(writeProfile)).toBe(1);
  });
});

describe("POST /api/documents — per-file outcomes", () => {
  it("reports `stored` for a fresh file and lands one document", async () => {
    const res = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "labs.pdf", bytes: pdfBytes("fresh") },
      ])
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      profile: number;
      documents: { id: number; name: string; outcome: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.profile).toBe(writeProfile);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].outcome).toBe("stored");
    expect(body.documents[0].name).toBe("labs.pdf");
    expect(body.documents[0].id).toBeGreaterThan(0);
    expect(docCount(writeProfile)).toBe(1);
  });

  it("reports `duplicate` for the same bytes again, with the engine's reason", async () => {
    const bytes = pdfBytes("dup");
    await POST(
      uploadRequest(memberToken, writeProfile, [{ name: "labs.pdf", bytes }])
    );
    const res = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "labs-copy.pdf", bytes },
      ])
    );
    const body = (await res.json()) as {
      documents: { outcome: string; reason: string | null }[];
    };
    expect(body.documents[0].outcome).toBe("duplicate");
    expect(body.documents[0].reason).toMatch(/duplicate/i);
  });

  it("dedups PER PROFILE — the same file for a different person is stored", async () => {
    const bytes = pdfBytes("cross-profile");
    await POST(
      uploadRequest(memberToken, writeProfile, [{ name: "labs.pdf", bytes }])
    );
    const res = await POST(
      uploadRequest(adminToken, otherProfile, [{ name: "labs.pdf", bytes }])
    );
    const body = (await res.json()) as { documents: { outcome: string }[] };
    expect(body.documents[0].outcome).toBe("stored");
    expect(docCount(otherProfile)).toBe(1);
  });

  it("reports `failed` with the engine's reason for an oversized file", async () => {
    // A GENUINELY oversized body: `size` cannot be faked, because the Request
    // serializes the multipart body and req.formData() re-parses it, so the handler
    // always sees the real byte length. The engine rejects on file.size BEFORE
    // buffering (#695), so this is cheap despite the allocation.
    const oversized = new Uint8Array(MAX_AI_BYTES + 1);
    oversized.set(new TextEncoder().encode("%PDF-1.4\n"));
    const form = new FormData();
    form.append(
      "file",
      new Blob([oversized], { type: "application/pdf" }),
      "huge.pdf"
    );
    const res = await POST(
      new Request(`http://x/api/documents?profile=${writeProfile}`, {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: { outcome: string; reason: string | null }[];
    };
    expect(body.documents[0].outcome).toBe("failed");
    expect(body.documents[0].reason).toMatch(/too large/i);
  });

  it("reports `failed` for a file whose bytes contradict its name", async () => {
    const res = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "notreally.pdf", bytes: new TextEncoder().encode("hello") },
      ])
    );
    const body = (await res.json()) as {
      documents: { outcome: string; reason: string | null }[];
    };
    expect(body.documents[0].outcome).toBe("failed");
    expect(body.documents[0].reason).toBeTruthy();
  });

  it("never answers a blanket success — a mixed batch reports each file", async () => {
    const res = await POST(
      uploadRequest(memberToken, writeProfile, [
        { name: "good.pdf", bytes: pdfBytes("mixed-good") },
        { name: "bad.pdf", bytes: new TextEncoder().encode("not a pdf") },
      ])
    );
    const body = (await res.json()) as {
      ok: boolean;
      documents: { name: string; outcome: string }[];
    };
    // ok:true means "the request was handled", never "every file landed" — which is
    // exactly why each file carries its own verdict.
    expect(body.ok).toBe(true);
    expect(body.documents.map((d) => d.outcome)).toEqual(["stored", "failed"]);
  });
});

describe("GET /api/documents/profiles", () => {
  it("401s without a token", async () => {
    const res = await GET(listRequest(null));
    expect(res.status).toBe(401);
  });

  it("lists only the profiles the token may WRITE to", async () => {
    const res = await GET(listRequest(memberToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      profiles: { id: number; name: string }[];
    };
    expect(body.ok).toBe(true);
    const ids = body.profiles.map((p) => p.id);
    expect(ids).toContain(writeProfile);
    // Read-only and unreachable profiles are both absent.
    expect(ids).not.toContain(readProfile);
    expect(ids).not.toContain(otherProfile);
  });

  it("returns an empty list for a login with no grants at all", async () => {
    const res = await GET(listRequest(strangerToken));
    const body = (await res.json()) as { profiles: unknown[] };
    expect(body.profiles).toEqual([]);
  });

  it("carries names only — no health data, no counts", async () => {
    const res = await GET(listRequest(memberToken));
    const body = (await res.json()) as {
      profiles: Record<string, unknown>[];
    };
    for (const p of body.profiles) {
      expect(Object.keys(p).sort()).toEqual(["id", "name"]);
    }
  });

  it("disambiguates two profiles sharing a name, like the switcher does", async () => {
    const dupA = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Sam')").run()
        .lastInsertRowid
    );
    const dupB = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Sam')").run()
        .lastInsertRowid
    );
    const res = await GET(listRequest(adminToken));
    const body = (await res.json()) as {
      profiles: { id: number; name: string }[];
    };
    const names = new Map(body.profiles.map((p) => [p.id, p.name]));
    expect(names.get(dupA)).toBe("Sam (1)");
    expect(names.get(dupB)).toBe("Sam (2)");
    db.prepare("DELETE FROM profiles WHERE id IN (?, ?)").run(dupA, dupB);
  });
});
