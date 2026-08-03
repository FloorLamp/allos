// DB INTEGRATION TIER — the two background-job liveness endpoints the completion
// toasters poll (issue #1878).
//
// WHY THEY EXIST AS ROUTES AT ALL. Both were read Server Actions until the #1878
// ruling. A Server Action's response carries a freshly rendered page tree that
// Next's router applies, so a background poll repainted the page underneath a
// half-typed record form with no `router.refresh()` anywhere — outside everything
// the dirty-form registry gates. Over `fetch` nothing can repaint, so the poll
// keeps observing at full cadence and the ONLY repaint left is the registry's.
//
// What this tier owes them is what the browser tier cannot show: the DENIALS and
// the SCOPE. No session is a 401 the poller retries — never an empty set, which
// would wipe its seed and re-announce every finished job (#296). And one profile's
// poll must never see another's rows, which is the invariant that survived the
// move out of `requireSession()`.
//
// Both routes read the acting session via getCurrentSession(); this file mocks
// THAT one function so the refusals are drivable without a cookie, keeping every
// other real export (and the real DB) intact.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { CurrentSession } from "@/lib/auth";

const authState = vi.hoisted(() => ({
  session: null as CurrentSession | null,
}));

vi.mock("@/lib/auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, getCurrentSession: async () => authState.session };
});

import { db } from "@/lib/db";
import { GET as getImports } from "@/app/api/jobs/imports/route";
import { GET as getExtractions } from "@/app/api/jobs/extractions/route";
import {
  isExtractionState,
  isImportJobState,
  readStatesEnvelope,
} from "@/lib/toaster-poll";

let profileA: number;
let profileB: number;
let loginA: number;

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

async function body(res: Response): Promise<unknown> {
  return res.json();
}

beforeAll(() => {
  profileA = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Jobs Route A')").run()
      .lastInsertRowid
  );
  profileB = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Jobs Route B')").run()
      .lastInsertRowid
  );
  loginA = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES ('jobs_route_a', 'x', 'member')"
      )
      .run().lastInsertRowid
  );

  db.prepare(
    "INSERT INTO import_jobs (profile_id, type, status, summary) VALUES (?, 'workouts', 'ready', '3 workouts')"
  ).run(profileA);
  db.prepare(
    "INSERT INTO import_jobs (profile_id, type, status, error) VALUES (?, 'biomarkers', 'failed', 'no rows')"
  ).run(profileA);
  db.prepare(
    "INSERT INTO import_jobs (profile_id, type, status) VALUES (?, 'workouts', 'processing')"
  ).run(profileB);

  db.prepare(
    `INSERT INTO medical_documents
       (profile_id, filename, stored_path, extraction_status, extracted_count)
     VALUES (?, 'jobs-route-a.pdf', 'data/uploads/jobs-route-a.pdf', 'done', 4)`
  ).run(profileA);
  db.prepare(
    `INSERT INTO medical_documents
       (profile_id, filename, stored_path, extraction_status, extracted_count)
     VALUES (?, 'jobs-route-b.pdf', 'data/uploads/jobs-route-b.pdf', 'processing', 0)`
  ).run(profileB);
});

afterAll(() => {
  authState.session = null;
});

describe("/api/jobs/* — background-job liveness for the toasters (#1878)", () => {
  it("401s when there is no session", async () => {
    authState.session = null;
    expect((await getImports()).status).toBe(401);
    expect((await getExtractions()).status).toBe(401);
  });

  it("answers a 401 the poller reads as a REFUSAL, not an empty set", async () => {
    // The whole point of the typed refusal: a lapsed session must not look like
    // "this profile has no jobs", which would replace the toaster's seed with an
    // empty map and re-announce every finished job on the next successful poll.
    authState.session = null;
    const res = await getImports();
    expect(
      readStatesEnvelope(res.status, await body(res), isImportJobState)
    ).toEqual({ ok: false, reason: "http" });
  });

  it("returns only the acting profile's import jobs", async () => {
    authState.session = sessionFor(profileA, loginA);
    const res = await getImports();
    expect(res.status).toBe(200);
    const observed = readStatesEnvelope(
      res.status,
      await body(res),
      isImportJobState
    );
    if (!observed.ok) throw new Error("expected a well-formed envelope");
    expect(observed.states.map((s) => s.status).sort()).toEqual([
      "failed",
      "ready",
    ]);
    expect(observed.states.map((s) => s.summary)).toContain("3 workouts");
    expect(observed.states.map((s) => s.error)).toContain("no rows");
  });

  it("returns only the acting profile's document extractions", async () => {
    authState.session = sessionFor(profileA, loginA);
    const res = await getExtractions();
    expect(res.status).toBe(200);
    const observed = readStatesEnvelope(
      res.status,
      await body(res),
      isExtractionState
    );
    if (!observed.ok) throw new Error("expected a well-formed envelope");
    expect(observed.states.map((s) => s.filename)).toEqual([
      "jobs-route-a.pdf",
    ]);
    expect(observed.states[0]).toMatchObject({ status: "done", count: 4 });
  });

  it("shows profile B its own rows and none of A's", async () => {
    // The scope is the session's active profile, so a switch changes the answer —
    // which is exactly what the toasters' per-profile seed reset (#296) assumes.
    authState.session = sessionFor(profileB, loginA);
    const jobs = await getImports();
    const observedJobs = readStatesEnvelope(
      jobs.status,
      await body(jobs),
      isImportJobState
    );
    if (!observedJobs.ok) throw new Error("expected a well-formed envelope");
    expect(observedJobs.states.map((s) => s.status)).toEqual(["processing"]);

    const docs = await getExtractions();
    const observedDocs = readStatesEnvelope(
      docs.status,
      await body(docs),
      isExtractionState
    );
    if (!observedDocs.ok) throw new Error("expected a well-formed envelope");
    expect(observedDocs.states.map((s) => s.filename)).toEqual([
      "jobs-route-b.pdf",
    ]);
  });

  it("is never cached — a liveness answer that is stale is a wrong one", async () => {
    authState.session = sessionFor(profileA, loginA);
    expect((await getImports()).headers.get("cache-control")).toBe("no-store");
    expect((await getExtractions()).headers.get("cache-control")).toBe(
      "no-store"
    );
  });
});
