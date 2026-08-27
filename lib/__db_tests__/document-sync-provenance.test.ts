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
// documents its own delivery pushed, never a previous run's, never another patient's,
// never another login's, and never another person's.
//
// ── WHY THE KEY IS THE IDENTITY, AND WHY THE SPACING IN THESE FIXTURES MATTERS ──
//
// The first cut keyed the claim to the LOGIN and windowed it on that login's last report
// stamp. One push files ONE REPORT PER PATIENT, so the first patient's report moved the
// window past everything the second patient's report was going to claim — and the
// unclaimed guard then kept those documents eligible forever without ever making them
// reachable. That is #2914's opening sentence: eight bundles across four profiles, three
// of four showing nothing.
//
// It also only failed AT REALISTIC SPACING. When the uploads and the report land in the
// same second, the inclusive comparison accidentally rescues the second patient's
// archive, so the bug passed in a fast test and failed in production. The fixtures below
// therefore force `uploaded_at` to the observed 5-second spacing before reporting, and
// several of them would have to be rewritten to pass on the old mechanism.

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
  remapPortalIdentity,
  type PortalAccount,
} from "@/lib/portals";
import { getSyncRowProvenance } from "@/lib/queries/integrations";
import { getImportDocumentsFeed } from "@/lib/queries/imports";
import { deliveredDocumentCountsByAccount } from "@/lib/portal-visibility";
import { testAuthorizedIds as authorized } from "../__tests__/authorized-ids";
import {
  pruneSyncEvents,
  recordSyncEvent,
} from "@/lib/integrations/connections";
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
// A second patient on LOGIN ONE, bound to a DIFFERENT profile — one push, two people.
const LABEL_SIBLING = "DELIVERY SIBLING";
// A third patient on LOGIN ONE, bound to the SAME profile as LABEL_ONE.
const LABEL_ALIAS = "DELIVERY ALIAS";
// A patient on LOGIN TWO whose binding is later re-pointed at a different person.
const LABEL_REMAP = "DELIVERY REMAP";

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

// A file allos REFUSES: an unsupported type that is not a health record. The engine
// still lands a row — `insertFailedDoc`, `stored_path = ''`, zero bytes on disk — so
// Review can show that the tool is pushing something allos will not take.
async function uploadRefused(
  account: PortalAccount,
  patient: string,
  filename: string
): Promise<number> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new TextEncoder().encode("not a health record at all")], {
      type: "application/x-shockwave-flash",
    }),
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
  const body = (await res.json()) as { documents: { id: number | null }[] };
  const id = body.documents[0]?.id as number;
  // It is a MARKER, not a document: a row with no bytes behind it.
  expect(
    db
      .prepare("SELECT stored_path AS p FROM medical_documents WHERE id = ?")
      .get(id)
  ).toEqual({ p: "" });
  return id;
}

// The seconds a real push spans: the observed run uploaded documents at 19:36:17–19:36:24
// and reported 1–5s later. Forcing `uploaded_at` back is what makes these fixtures spaced
// rather than same-second, and same-second is what used to hide the loss.
function spaceUploads(docIds: number[], startSecondsAgo: number): void {
  docIds.forEach((id, i) => {
    db.prepare(
      `UPDATE medical_documents
          SET uploaded_at = strftime('%Y-%m-%d %H:%M:%S','now', ?)
        WHERE id = ?`
    ).run(`-${startSecondsAgo - i * 5} seconds`, id);
  });
}

async function reportRun(
  account: PortalAccount,
  patient: string,
  over: {
    status?: "downloaded" | "nothing-new" | "failed";
    inserted?: number;
    unchanged?: number;
    message?: string;
  } = {}
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
        status: over.status ?? "downloaded",
        portal: portalSlug,
        account: account.slug,
        patient,
        contacted: false,
        inserted: over.inserted ?? 1,
        unchanged: over.unchanged ?? 0,
        ...(over.message ? { message: over.message } : {}),
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

// How many runs claimed this document — 1 for every delivered archive, and the number
// the login-keyed window turned into 0 for everybody but the first-reported patient.
function claimedAnywhere(documentId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM integration_sync_rows
          WHERE target_table = 'medical_documents' AND target_id = ?`
      )
      .get(documentId) as { n: number }
  ).n;
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
  // TWO PATIENTS ON ONE LOGIN — the shape #2914 was filed from. A household's portal
  // login covers the whole proxy list, and the tool files one report per patient.
  expect(bindPortalIdentity(accountOne.id, LABEL_SIBLING, profileTwo).ok).toBe(
    true
  );
  // And two patient LABELS on one login bound to the SAME person, which a portal
  // rendering a name two ways produces.
  expect(bindPortalIdentity(accountOne.id, LABEL_ALIAS, profileOne).ok).toBe(
    true
  );
});

describe("the upload route records which IDENTITY a document was acquired for (#2999)", () => {
  it("stamps the patient identity beside the portal it already stamped", async () => {
    const docId = await upload(accountOne, LABEL_ONE, "acquisition-a1.pdf");
    const row = db
      .prepare(
        `SELECT d.acquired_portal_id AS portal, pi.account_id AS account,
                pi.patient_label AS patient
           FROM medical_documents d
           LEFT JOIN portal_identities pi ON pi.id = d.acquired_identity_id
          WHERE d.id = ?`
      )
      .get(docId) as {
      portal: number | null;
      account: number | null;
      patient: string | null;
    };
    expect(row.portal).toBe(portalId);
    expect(row.account).toBe(accountOne.id);
    expect(row.patient).toBe(LABEL_ONE);
  });

  it("does not fail the ingest when the provenance stamp cannot be written", async () => {
    // The archive has already landed by the time this runs. A provenance write must never
    // turn a successful ingest into a 500 the tool answers by pushing everything again —
    // the same contract recordSyncRows honours.
    db.exec("DROP INDEX IF EXISTS idx_medical_documents_acquired_identity");
    db.exec(
      `CREATE TRIGGER doc_prov_stamp_boom BEFORE UPDATE OF acquired_identity_id
         ON medical_documents
         BEGIN SELECT RAISE(ABORT, 'provenance is down'); END`
    );
    try {
      const docId = await upload(accountOne, LABEL_ONE, "ingest-survives.pdf");
      expect(docId).toBeGreaterThan(0);
      expect(
        db
          .prepare(
            "SELECT acquired_identity_id AS id FROM medical_documents WHERE id = ?"
          )
          .get(docId)
      ).toEqual({ id: null });
    } finally {
      db.exec("DROP TRIGGER doc_prov_stamp_boom");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_medical_documents_acquired_identity
           ON medical_documents(acquired_identity_id)`
      );
    }
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

describe("one login, two patients: nobody's documents go unclaimed (#2914)", () => {
  it("credits each patient's run with its own archives, at production spacing", async () => {
    // The reported case, reduced to two people: one push, two patients on one login,
    // two profiles, reports filed one after the other. Uploads are spaced five seconds
    // apart and land before either report — which is exactly the arrangement that made
    // the login-keyed window claim patient one's archive and lose patient two's to
    // nobody at all.
    const forOne = await upload(accountOne, LABEL_ONE, "push-sibling-a1.pdf");
    const forTwo = await upload(
      accountOne,
      LABEL_SIBLING,
      "push-sibling-b1.pdf"
    );
    spaceUploads([forOne, forTwo], 12);

    const runOne = await reportRun(accountOne, LABEL_ONE);
    const runTwo = await reportRun(accountOne, LABEL_SIBLING);

    expect(claimedDocuments(runOne)).toEqual([forOne]);
    expect(claimedDocuments(runTwo)).toEqual([forTwo]);
    // Neither archive is stranded: every one of them belongs to exactly one run.
    expect(claimedAnywhere(forOne)).toBe(1);
    expect(claimedAnywhere(forTwo)).toBe(1);
  });

  it("does not credit one patient's run with another patient's archive, same profile", async () => {
    // Two labels on one login for the SAME person — no privacy question, and the
    // drill-in's stated property (every document belongs to THAT run) still has to hold.
    const asOne = await upload(accountOne, LABEL_ONE, "alias-a2.pdf");
    const asAlias = await upload(accountOne, LABEL_ALIAS, "alias-a3.pdf");
    spaceUploads([asOne, asAlias], 12);

    const runOne = await reportRun(accountOne, LABEL_ONE);
    const runAlias = await reportRun(accountOne, LABEL_ALIAS);

    expect(claimedDocuments(runOne)).toEqual([asOne]);
    expect(claimedDocuments(runAlias)).toEqual([asAlias]);
  });

  it("never claims a document belonging to another PERSON, whatever the identity says", async () => {
    // The claim's profile filter, pinned by behaviour rather than by the source scanner.
    // A row mis-stamped with this identity but owned by somebody else stays unclaimed:
    // the identity is not authority over whose document this is.
    const mine = await upload(accountOne, LABEL_ONE, "scoped-a4.pdf");
    const identityId = (
      db
        .prepare(
          "SELECT acquired_identity_id AS id FROM medical_documents WHERE id = ?"
        )
        .get(mine) as { id: number }
    ).id;
    const theirs = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (filename, stored_path, mime_type, size_bytes, extraction_status,
              uploaded_at, profile_id, acquired_identity_id)
           VALUES ('not-mine.pdf', '', 'application/pdf', 10, 'done',
                   strftime('%Y-%m-%d %H:%M:%S','now'), ?, ?)`
        )
        .run(bystanderProfile, identityId).lastInsertRowid
    );

    const run = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(run)).toEqual([mine]);
    expect(claimedAnywhere(theirs)).toBe(0);
  });
});

describe("a run delivers DOCUMENTS, not markers (#2999)", () => {
  it("never claims a file allos refused, and does not render it as a delivery", async () => {
    // `medical_documents` holds markers as well as archives. A refused file lands a
    // `failed` row with `stored_path = ''` and no bytes anywhere, and it carries the
    // acquiring identity exactly like a real archive — so a claim that filtered only on
    // identity said the run had delivered the very documents it refused: two refused
    // files and an honest `nothing-new` report rendered "Delivered 2 documents", with a
    // drill-in resolving them by filename and linking /import/N. A fabricated delivery,
    // out of a run the drop rule would otherwise have dropped.
    //
    // It is also the same fact `duplicate` and `blocked` already state by creating no row
    // at all: a delivery that carried nothing allos would store delivered nothing.
    const refusedOne = await uploadRefused(
      accountOne,
      LABEL_ONE,
      "refused-one.swf"
    );
    const refusedTwo = await uploadRefused(
      accountOne,
      LABEL_ONE,
      "refused-two.swf"
    );
    spaceUploads([refusedOne, refusedTwo], 12);

    const run = await reportRun(accountOne, LABEL_ONE, {
      status: "nothing-new",
      inserted: 0,
      unchanged: 0,
    });

    expect(claimedDocuments(run)).toEqual([]);
    expect(claimedAnywhere(refusedOne)).toBe(0);
    expect(claimedAnywhere(refusedTwo)).toBe(0);
    // Not marked either — nothing about them is a delivery.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM medical_documents
            WHERE id IN (?, ?) AND delivered_at IS NOT NULL`
        )
        .get(refusedOne, refusedTwo)
    ).toEqual({ n: 0 });
    // …so the run is the empty run it honestly was, and the feed drops it.
    const ids = getImportDocumentsFeed(profileOne, 200)
      .filter((e) => e.stream === "sync")
      .map((e) => (e.stream === "sync" ? e.event.id : 0));
    expect(ids).not.toContain(run);
  });

  it("claims the real archives in a push that also carried a refused file", async () => {
    const refused = await uploadRefused(accountOne, LABEL_ONE, "mixed.swf");
    const real = await upload(accountOne, LABEL_ONE, "mixed-real.pdf");
    spaceUploads([refused, real], 12);
    const run = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(run)).toEqual([real]);
  });
});

describe("the claim is written whole or not at all (#2999)", () => {
  it("strands nothing when the provenance rows cannot be written", async () => {
    // WHY THIS IS A TEST AND NOT A COMMENT. The claim selects, lists and stamps in ONE
    // transaction, sharing `insertSyncRows` rather than calling `recordSyncRows` —
    // because that wrapper swallows its own failures, so the mark would commit over rows
    // that were never written and the archives would be stamped, unlistable and
    // unre-claimable, permanently. "Unify the two provenance writers" is the most natural
    // cleanup anyone will ever propose here, and it would reintroduce exactly that with
    // the suite green.
    const doc = await upload(accountOne, LABEL_ONE, "atomic-a1.pdf");
    spaceUploads([doc], 10);

    db.exec(
      `CREATE TRIGGER doc_prov_rows_boom BEFORE INSERT ON integration_sync_rows
         BEGIN SELECT RAISE(ABORT, 'provenance is down'); END`
    );
    let failedRun: number;
    try {
      failedRun = await reportRun(accountOne, LABEL_ONE);
    } finally {
      db.exec("DROP TRIGGER doc_prov_rows_boom");
    }

    // Nothing was written — not the rows, and CRUCIALLY not the mark.
    expect(claimedDocuments(failedRun)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT delivered_at AS at FROM medical_documents WHERE id = ?"
        )
        .get(doc)
    ).toEqual({ at: null });

    // …so the next successful run for this identity claims it, exactly once.
    const recovered = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(recovered)).toEqual([doc]);
    expect(claimedAnywhere(doc)).toBe(1);
  });
});

describe("the #388 retention sweep does not release a claimed archive (#2999)", () => {
  it("keeps every claim past the sweep, and an empty run after it claims nothing", async () => {
    // THE TRAP THIS PINS. The claim's guard used to be "does a provenance row name this
    // document" — and provenance rows are children of integration_sync_events with
    // ON DELETE CASCADE, which the 90-day sweep deletes. The guard forgot, the archives
    // became claimable again, and the next ordinary run — one that delivered NOTHING —
    // claimed a year of history and rendered it as today's delivery. Worse, the drop rule
    // then KEPT that run, because it now had claims: the sweep manufactured a delivery
    // row out of a run it had correctly suppressed the hour before.
    //
    // A test that never invokes the sweep cannot see this class of bug, which is exactly
    // why nothing caught it. This one runs it.
    const delivered: number[] = [];
    for (const n of [1, 2, 3]) {
      const doc = await upload(accountOne, LABEL_ONE, `retained-a${n}.pdf`);
      spaceUploads([doc], 10);
      const run = await reportRun(accountOne, LABEL_ONE);
      expect(claimedDocuments(run)).toEqual([doc]);
      delivered.push(doc);
      // Age this run's event past the retention window.
      db.prepare(
        `UPDATE integration_sync_events SET at = ?
          WHERE id = ?`
      ).run("2026-01-05T09:00:00Z", run);
    }

    // Every archive is claimed exactly once, before the sweep.
    for (const doc of delivered) expect(claimedAnywhere(doc)).toBe(1);

    // THE SWEEP ITSELF — the real one, on the real schema.
    expect(pruneSyncEvents()).toBeGreaterThan(0);

    // The provenance rows went with their events. That is correct: the run they belonged
    // to no longer exists, so it has no drill-in to offer.
    const survivingRows = delivered.filter((d) => claimedAnywhere(d) > 0);
    expect(survivingRows.length).toBeLessThan(delivered.length);

    // …and the CLAIM survived anyway, because it lives on the document.
    for (const doc of delivered) {
      expect(
        db
          .prepare(
            "SELECT delivered_at AS at FROM medical_documents WHERE id = ?"
          )
          .get(doc)
      ).not.toEqual({ at: null });
    }

    // The run that fabricated a delivery: `nothing-new`, all-zero split, nothing
    // uploaded. It must claim nothing and it must not reach the feed.
    const empty = await reportRun(accountOne, LABEL_ONE, {
      status: "nothing-new",
      inserted: 0,
      unchanged: 0,
    });
    expect(claimedDocuments(empty)).toEqual([]);
    const ids = getImportDocumentsFeed(profileOne, 200)
      .filter((e) => e.stream === "sync")
      .map((e) => (e.stream === "sync" ? e.event.id : 0));
    expect(ids).not.toContain(empty);
  });

  it("still states a swept login's delivery on its login row", async () => {
    // The count is read from the documents, so it outlives the runs. A login whose events
    // have aged out still says what it delivered instead of falling to zero.
    const doc = await upload(accountOne, LABEL_ONE, "swept-a8.pdf");
    spaceUploads([doc], 10);
    const run = await reportRun(accountOne, LABEL_ONE);
    db.prepare("UPDATE integration_sync_events SET at = ? WHERE id = ?").run(
      "2026-01-06T09:00:00Z",
      run
    );
    pruneSyncEvents();

    const delivered = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false,
      "UTC"
    ).get(accountOne.id);
    expect(delivered?.count).toBeGreaterThan(0);
  });
});

describe("re-pointing a binding never re-attributes an archive (#2999)", () => {
  it("leaves the previous person's documents where they are, claimed by nobody", async () => {
    // A binding is a mapping from a portal's patient LABEL to a person, and a household
    // can move it (#1747/#2103's compare-and-swap) — the portal started rendering a name
    // that turns out to be somebody else. `remapPortalIdentity` updates the row IN PLACE,
    // so the identity id a document already carries now points at a DIFFERENT profile.
    //
    // The claim's own `profile_id` filter is what makes that safe, and this is the
    // property to attack: the archive belongs to the person it landed for, and the
    // re-pointed identity must not drag it into the new person's run. It becomes
    // unclaimable rather than re-attributed, which is the honest outcome — nobody can
    // truthfully say whose delivery it was any more.
    expect(bindPortalIdentity(accountTwo.id, LABEL_REMAP, profileTwo).ok).toBe(
      true
    );
    const theirs = await upload(accountTwo, LABEL_REMAP, "remapped-b3.pdf");
    spaceUploads([theirs], 10);
    const identityId = (
      db
        .prepare(
          "SELECT acquired_identity_id AS id FROM medical_documents WHERE id = ?"
        )
        .get(theirs) as { id: number }
    ).id;

    expect(remapPortalIdentity(identityId, profileTwo, bystanderProfile)).toBe(
      true
    );

    const run = await reportRun(accountTwo, LABEL_REMAP);
    expect(claimedDocuments(run)).toEqual([]);
    expect(claimedAnywhere(theirs)).toBe(0);
    // The document did not move either — only the label's mapping did.
    expect(
      db
        .prepare("SELECT profile_id AS p FROM medical_documents WHERE id = ?")
        .get(theirs)
    ).toEqual({ p: profileTwo });
    // And the new person's run resolves nothing of theirs.
    expect(getSyncRowProvenance(bystanderProfile, run)).toEqual([]);
  });
});

describe("a failed run consumes nothing (#2999)", () => {
  it("leaves the documents for the next successful report", async () => {
    const doc = await upload(accountOne, LABEL_ONE, "after-failure-a5.pdf");
    spaceUploads([doc], 10);

    const failed = await reportRun(accountOne, LABEL_ONE, {
      status: "failed",
      inserted: 0,
      message: "the download timed out",
    });
    expect(claimedDocuments(failed)).toEqual([]);

    const recovered = await reportRun(accountOne, LABEL_ONE);
    expect(claimedDocuments(recovered)).toEqual([doc]);
  });
});

describe("a delivery reported as nothing-new is still a delivery (#2914)", () => {
  it("keeps its feed row, lists its documents, and states the count on the login row", async () => {
    // The observed input: a push that delivered archives under a report whose status was
    // `nothing-new` and whose split was all zeroes. Reading the split made the feed drop
    // the row that owned the documents — stranding them, because the unclaimed guard
    // stops any later run re-claiming them — and made the login row say "Delivered no
    // documents" over a real delivery.
    const first = await upload(accountOne, LABEL_ONE, "quiet-a6.pdf");
    const second = await upload(accountOne, LABEL_ONE, "quiet-a7.pdf");
    spaceUploads([first, second], 12);
    const run = await reportRun(accountOne, LABEL_ONE, {
      status: "nothing-new",
      inserted: 0,
      unchanged: 0,
    });

    expect(claimedDocuments(run)).toEqual(
      [first, second].sort((a, b) => a - b)
    );

    const entry = getImportDocumentsFeed(profileOne, 200).find(
      (e) => e.stream === "sync" && e.event.id === run
    );
    if (entry?.stream !== "sync") throw new Error("the run was dropped");
    expect(entry.drilldown?.count).toBe(2);
    expect(entry.drilldown?.noun).toBe("document");
  });

  it("gives the page and the drill-in ONE number for one delivery (#1991)", async () => {
    // Three archives, reported `inserted 1, unchanged 2`. Deriving the login row from
    // that split said "1" while the drill-in listed 3.
    const docs = [
      await upload(accountOne, LABEL_ONE, "one-number-a8.pdf"),
      await upload(accountOne, LABEL_ONE, "one-number-a9.pdf"),
      await upload(accountOne, LABEL_ONE, "one-number-b1.pdf"),
    ];
    spaceUploads(docs, 20);
    const run = await reportRun(accountOne, LABEL_ONE, {
      inserted: 1,
      unchanged: 2,
    });

    const entry = getImportDocumentsFeed(profileOne, 200).find(
      (e) => e.stream === "sync" && e.event.id === run
    );
    if (entry?.stream !== "sync") throw new Error("unreachable");
    const drilldown = entry.drilldown?.count ?? 0;
    expect(drilldown).toBe(3);

    // The page's number is everything this login delivered on that day — every run this
    // file has driven — so the two surfaces are compared to EACH OTHER, not to a literal.
    const page = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false,
      "UTC"
    ).get(accountOne.id)!;
    const deliveredThatDay = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM medical_documents d
             JOIN portal_identities pi ON pi.id = d.acquired_identity_id
            WHERE pi.account_id = ? AND d.profile_id = ?
              AND substr(d.delivered_at, 1, 10) = ?`
        )
        .get(accountOne.id, profileOne, page.day) as { n: number }
    ).n;
    expect(page.count).toBe(deliveredThatDay);
    expect(drilldown).toBeLessThanOrEqual(page.count);
  });

  it("lets a deleted archive part the two counts, and each stays true", () => {
    // THE ONE PLACE THE TWO NUMBERS LEGITIMATELY DIVERGE, pinned so nobody reads the
    // equality above as an invariant it is not. Deleting a document from Data → Review
    // removes the row the page counts, while the run's provenance row survives — the run
    // DID deliver three archives, and saying otherwise would rewrite history. The
    // drill-in marks the missing one `deleted` rather than inventing a link, which is
    // #1991's rule doing its job: what the label promises is still what the list shows.
    const before = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false,
      "UTC"
    ).get(accountOne.id)!;
    const victim = (
      db
        .prepare(
          `SELECT id FROM medical_documents
            WHERE profile_id = ? AND delivered_at IS NOT NULL
            ORDER BY id DESC LIMIT 1`
        )
        .get(profileOne) as { id: number }
    ).id;
    const owningRun = (
      db
        .prepare(
          `SELECT event_id AS id FROM integration_sync_rows
            WHERE target_table = 'medical_documents' AND target_id = ?`
        )
        .get(victim) as { id: number }
    ).id;

    db.prepare("DELETE FROM medical_documents WHERE id = ?").run(victim);

    const after = deliveredDocumentCountsByAccount(
      authorized([profileOne]),
      false,
      "UTC"
    ).get(accountOne.id)!;
    // The page counts the archives allos still holds…
    expect(after.count).toBe(before.count - 1);
    // …the run still lists everything it delivered, and names the gap honestly.
    const rows = getSyncRowProvenance(profileOne, owningRun);
    expect(rows.some((r) => r.targetId === victim && r.deleted)).toBe(true);
    // And the deletion does not release the archive back to the claim: the row is gone,
    // so there is nothing left to claim twice.
    expect(claimedAnywhere(victim)).toBe(1);
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

  it("drops a successful zero-write PORTAL run, and nothing else", () => {
    const quiet = recordSyncEvent(bystanderProfile, "patient-portals", {
      ok: true,
      received: 1,
      written: 0,
      inserted: 0,
      updated: 0,
      unchanged: 1,
      skipped: 0,
    });
    const failed = recordSyncEvent(bystanderProfile, "patient-portals", {
      ok: false,
      error: "the login page changed",
    });
    // A re-handed Google Takeout archive: `inserted 0 / unchanged 900`. Deliberate,
    // user-initiated, and with no integration page of its own to fall back on — dropping
    // it leaves the import with no trace anywhere in the app.
    const takeout = recordSyncEvent(bystanderProfile, "fitbit-takeout", {
      ok: true,
      received: 900,
      written: 0,
      inserted: 0,
      updated: 0,
      unchanged: 900,
      skipped: 0,
    });
    // A portal run whose entire content is three documents it could not push.
    const skipped = recordSyncEvent(bystanderProfile, "patient-portals", {
      ok: true,
      received: 3,
      written: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 3,
    });
    const ids = getImportDocumentsFeed(bystanderProfile, 200)
      .filter((e) => e.stream === "sync")
      .map((e) => (e.stream === "sync" ? e.event.id : 0));
    expect(ids).not.toContain(quiet);
    expect(ids).toContain(failed);
    expect(ids).toContain(takeout);
    expect(ids).toContain(skipped);
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
