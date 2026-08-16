// DB INTEGRATION TIER — the run → documents association (#2999), driven as the REAL
// route handlers in the order a companion tool uses them: upload each archive, then
// report the run.
//
// THE DEFECT this pins is a promise the feed could not keep. `ProvenanceTable` was a
// closed discriminator over the five RECORD tables, and a portal run's product is an
// archive — so a run could record nothing at all, the Imports feed's "What this wrote —
// 2 records" drill-in listed nothing, and the label rewrote itself to "0 records" in
// front of the reader.
//
// The claim has to be EXACT, which is what these assertions are about: a run claims the
// documents its own delivery pushed, never a previous run's, never another login's, and
// never another person's. The window is the previous report's stamp — read before the
// one-row-per-login upsert destroys it — and the unclaimed guard is what makes the
// inclusive comparison safe when an upload and a report land in the same second.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { POST as UPLOAD } from "@/app/api/documents/route";
import { POST as SYNC_REPORT } from "@/app/api/documents/sync-report/route";
import { createApiToken } from "@/lib/api-tokens";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  type PortalAccount,
} from "@/lib/portals";
import { getSyncRowProvenance } from "@/lib/queries/integrations";
import { getImportDocumentsFeed } from "@/lib/queries/imports";
import { recordSyncEvent } from "@/lib/integrations/connections";
import { feedItemView } from "@/lib/import-feed";

let toolLogin: number;
let toolToken: string;

let portalId: number;
let accountOne: PortalAccount;
let accountTwo: PortalAccount;
let profileOne: number;
let profileTwo: number;
let bystanderProfile: number;

const LABEL_ONE = "DELIVERY ONE";
const LABEL_TWO = "DELIVERY TWO";

// A minimal but genuine PDF — the engine sniffs magic bytes, so a file claiming .pdf
// must actually start with %PDF- or it is (correctly) refused.
function pdfBytes(marker: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  );
}

async function upload(
  account: PortalAccount,
  patient: string,
  filename: string
): Promise<number> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdfBytes(filename)], { type: "application/pdf" }),
    filename
  );
  const portalSlug = (
    db.prepare("SELECT slug FROM portals WHERE id = ?").get(portalId) as {
      slug: string;
    }
  ).slug;
  const res = await UPLOAD(
    new Request(
      `http://x/api/documents?portal=${portalSlug}&account=${account.slug}&patient=${encodeURIComponent(patient)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${toolToken}` },
        body: form,
      }
    )
  );
  const body = (await res.json()) as {
    ok: boolean;
    documents: { id: number | null }[];
  };
  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  const id = body.documents[0]?.id;
  expect(id).not.toBeNull();
  return id as number;
}

async function reportRun(
  account: PortalAccount,
  patient: string
): Promise<number> {
  const portalSlug = (
    db.prepare("SELECT slug FROM portals WHERE id = ?").get(portalId) as {
      slug: string;
    }
  ).slug;
  const res = await SYNC_REPORT(
    new Request("http://x/api/documents/sync-report", {
      method: "POST",
      headers: {
        authorization: `Bearer ${toolToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "downloaded",
        portal: portalSlug,
        account: account.slug,
        patient,
        contacted: false,
        inserted: 1,
      }),
    })
  );
  expect(res.status).toBe(200);
  // The event this run recorded — the newest one for that login.
  const row = db
    .prepare(
      `SELECT id FROM integration_sync_events
        WHERE account_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(account.id) as { id: number };
  return row.id;
}

function claimedDocuments(eventId: number): number[] {
  return (
    db
      .prepare(
        `SELECT target_id AS id FROM integration_sync_rows
          WHERE event_id = ? AND target_table = 'medical_documents'
          ORDER BY target_id`
      )
      .all(eventId) as { id: number }[]
  ).map((r) => r.id);
}

beforeAll(async () => {
  toolLogin = Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES ('doc-prov-tool', 'scrypt$2$1$1$00$00', 'member')"
      )
      .run().lastInsertRowid
  );
  toolToken = (await createApiToken(toolLogin, "tool", "upload:documents"))
    .token;

  const mk = (name: string): number =>
    Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
  profileOne = mk("Doc Prov One");
  profileTwo = mk("Doc Prov Two");
  bystanderProfile = mk("Doc Prov Bystander");
  for (const p of [profileOne, profileTwo, bystanderProfile]) {
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(toolLogin, p);
  }

  // ONE portal with TWO logins — the shape that makes `acquired_portal_id` too coarse to
  // correlate a delivery with the run that delivered it, and the reason the ACCOUNT is
  // the half worth recording.
  const portal = createPortal("Doc Prov Portal", "mychart");
  if (!portal.ok) throw new Error("fixture portal");
  portalId = portal.id;
  accountOne = accountsForPortal(portalId).find((a) => a.implicit)!;
  const second = createPortalAccount(portalId, "Second Login");
  if (!second.ok) throw new Error("fixture login");
  accountTwo = accountsForPortal(portalId).find((a) => a.id === second.id)!;

  expect(bindPortalIdentity(accountOne.id, LABEL_ONE, profileOne).ok).toBe(
    true
  );
  expect(bindPortalIdentity(accountTwo.id, LABEL_TWO, profileTwo).ok).toBe(
    true
  );
});

describe("the upload route records which LOGIN a document was acquired for (#2999)", () => {
  it("stamps the account beside the portal it already stamped", async () => {
    const docId = await upload(accountOne, LABEL_ONE, "acquisition-a1.pdf");
    const row = db
      .prepare(
        "SELECT acquired_portal_id AS portal, acquired_account_id AS account FROM medical_documents WHERE id = ?"
      )
      .get(docId) as { portal: number | null; account: number | null };
    expect(row.portal).toBe(portalId);
    expect(row.account).toBe(accountOne.id);
  });
});

describe("a run claims exactly the documents it delivered (#2999)", () => {
  it("claims this run's documents, and none from a previous run or another login", async () => {
    // Login TWO delivers first, on its own patient. Nothing below may ever claim these.
    const otherDoc = await upload(accountTwo, LABEL_TWO, "other-login-b1.pdf");

    // RUN 1 on login ONE: two archives, then the report.
    const first = await upload(accountOne, LABEL_ONE, "run-one-a1.pdf");
    const second = await upload(accountOne, LABEL_ONE, "run-one-a2.pdf");
    const runOne = await reportRun(accountOne, LABEL_ONE);

    const claimedByOne = claimedDocuments(runOne);
    expect(claimedByOne).toContain(first);
    expect(claimedByOne).toContain(second);
    expect(claimedByOne).not.toContain(otherDoc);

    // RUN 2 on the same login: one more archive.
    const third = await upload(accountOne, LABEL_ONE, "run-two-a3.pdf");
    const runTwo = await reportRun(accountOne, LABEL_ONE);

    expect(claimedDocuments(runTwo)).toEqual([third]);
    // …and run 1's claim is untouched: a document belongs to exactly one run.
    expect(claimedDocuments(runOne)).toEqual(claimedByOne);
    expect(claimedByOne).not.toContain(third);
  });

  it("never claims a document acquired for another login", async () => {
    const theirs = await upload(accountTwo, LABEL_TWO, "theirs-b2.pdf");
    const ours = await upload(accountOne, LABEL_ONE, "ours-a4.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(run)).toEqual([ours]);
    expect(claimedDocuments(run)).not.toContain(theirs);
  });

  it("leaves a hand-uploaded document unclaimed — no login acquired it", async () => {
    const handUploaded = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (filename, stored_path, mime_type, size_bytes, extraction_status,
              uploaded_at, profile_id)
           VALUES ('by-hand.pdf', '', 'application/pdf', 10, 'done',
                   strftime('%Y-%m-%d %H:%M:%S','now'), ?)`
        )
        .run(profileOne).lastInsertRowid
    );
    const mine = await upload(accountOne, LABEL_ONE, "after-hand-a5.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(run)).toEqual([mine]);
    expect(claimedDocuments(run)).not.toContain(handUploaded);
  });
});

describe("getSyncRowProvenance resolves a delivered document (#2999)", () => {
  it("names the file, dates it, and links its import page — profile-scoped", async () => {
    const docId = await upload(accountOne, LABEL_ONE, "resolvable-a6.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);

    const rows = getSyncRowProvenance(profileOne, run);
    const doc = rows.find((r) => r.targetId === docId)!;
    expect(doc.targetTable).toBe("medical_documents");
    expect(doc.label).toBe("resolvable-a6.pdf");
    expect(doc.href).toBe(`/import/${docId}`);
    expect(doc.deleted).toBe(false);
    expect(doc.date).not.toBeNull();

    // ANOTHER PROFILE RESOLVES NOTHING. The event is not theirs, so the read returns
    // empty rather than resolving somebody else's archive by id.
    expect(getSyncRowProvenance(bystanderProfile, run)).toEqual([]);
  });

  it("marks a document that has since been deleted rather than inventing a link", async () => {
    const docId = await upload(accountOne, LABEL_ONE, "removed-a7.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);
    db.prepare("DELETE FROM medical_documents WHERE id = ?").run(docId);

    const doc = getSyncRowProvenance(profileOne, run).find(
      (r) => r.targetId === docId
    )!;
    expect(doc.deleted).toBe(true);
    expect(doc.label).toBe("Document");
  });
});

// ── What the Imports feed then shows (#2999 Fix 2 and Fix 3) ─────────────────

describe("the Imports feed after a delivery (#2999)", () => {
  it("offers a drill-in whose promised count is the provenance count, in DOCUMENTS", async () => {
    const first = await upload(accountOne, LABEL_ONE, "feed-a1.pdf");
    const second = await upload(accountOne, LABEL_ONE, "feed-a2.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);

    const entry = getImportDocumentsFeed(profileOne, 200).find(
      (e) => e.stream === "sync" && e.event.id === run
    );
    expect(entry?.stream).toBe("sync");
    if (entry?.stream !== "sync") throw new Error("unreachable");
    // The count the reader is promised BEFORE the fetch is exactly what the fetch
    // returns — the #1991 rule, on this feed at last.
    expect(entry.drilldown?.count).toBe(2);
    expect(entry.drilldown?.noun).toBe("document");
    expect(getSyncRowProvenance(profileOne, run)).toHaveLength(2);
    expect(claimedDocuments(run)).toEqual(
      [first, second].sort((a, b) => a - b)
    );
  });

  it("offers NO drill-in for a run that recorded no provenance (#1771)", async () => {
    // A report with nothing acquired for this login since the last one: the run wrote
    // records somewhere else, or nothing itemizable at all.
    const run = await reportRun(accountOne, LABEL_ONE);
    const entry = getImportDocumentsFeed(profileOne, 200).find(
      (e) => e.stream === "sync" && e.event.id === run
    );
    if (entry?.stream !== "sync") throw new Error("unreachable");
    expect(entry.drilldown).toBeNull();
  });

  it("drops a successful zero-write run, and never drops a failure", () => {
    const quiet = recordSyncEvent(profileTwo, "patient-portals", {
      ok: true,
      received: 1,
      written: 0,
      inserted: 0,
      updated: 0,
      unchanged: 1,
      skipped: 0,
    });
    const failed = recordSyncEvent(profileTwo, "patient-portals", {
      ok: false,
      error: "the login page changed",
    });
    const ids = getImportDocumentsFeed(profileTwo, 200)
      .filter((e) => e.stream === "sync")
      .map((e) => (e.stream === "sync" ? e.event.id : 0));
    expect(ids).not.toContain(quiet);
    expect(ids).toContain(failed);
  });

  it("renders no data window for a portal run, which structurally has none", async () => {
    await upload(accountOne, LABEL_ONE, "window-a1.pdf");
    const run = await reportRun(accountOne, LABEL_ONE);
    const entry = getImportDocumentsFeed(profileOne, 200).find(
      (e) => e.stream === "sync" && e.event.id === run
    )!;
    // "—" on every run of this source is a column pretending to be information
    // (#1991 defect 5).
    expect(feedItemView(entry, (id) => id).meta).toBeNull();
  });
});
