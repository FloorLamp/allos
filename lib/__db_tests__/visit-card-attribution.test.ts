// DB INTEGRATION TIER — Timeline visit cards must not cross-attribute records in a
// multi-visit portal export (issue #2920).
//
// #662 built the visit card's linked-context section by DOCUMENT LINEAGE — "the
// care-plan items / meds / procedures it produced" — which equates document with
// visit. That held for the single-visit CCDs it was built on. A MyChart "all visits"
// container gives every encounter in it the same document_id, so every record the
// container produced attached to every visit in it: the observed card read "From this
// visit's document — Medication: albuterol" on a pediatric OPHTHALMOLOGY visit.
//
// The scoping signal already existed and was ignored here: procedures and intake_items
// carry encounter_id (#1050/#1053), which the encounter detail page's own "From this
// visit" section reads (#1350). These tests write both shapes and read back which
// chips each visit card actually carries.
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getTimelineEvents } from "@/lib/timeline";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'done', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// `sourceId` is the portal's own encounter id. Stored DOCUMENT-SCOPED, exactly as
// scopedExternalId writes it (lib/import-persist), so two uploads of one summary keep
// separate physical rows and the representative collapse is what unifies them.
function newEncounter(
  profileId: number,
  documentId: number,
  sourceId: string,
  date: string,
  type: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters
           (profile_id, document_id, external_id, date, type, source)
         VALUES (?, ?, ?, ?, ?, 'document:import')`
      )
      .run(
        profileId,
        documentId,
        `document:${documentId}|ccda:encounter:${sourceId}`,
        date,
        type
      ).lastInsertRowid
  );
}

function newMedication(
  profileId: number,
  documentId: number,
  name: string,
  encounterId: number | null
): void {
  db.prepare(
    `INSERT INTO intake_items
       (profile_id, document_id, kind, name, source, encounter_id)
     VALUES (?, ?, 'medication', ?, 'extracted', ?)`
  ).run(profileId, documentId, name, encounterId);
}

function newProcedure(
  profileId: number,
  documentId: number,
  name: string,
  date: string,
  encounterId: number | null
): void {
  db.prepare(
    `INSERT INTO procedures
       (profile_id, document_id, name, date, source, encounter_id)
     VALUES (?, ?, ?, ?, 'document:import', ?)`
  ).run(profileId, documentId, name, date, encounterId);
}

function newCarePlanItem(
  profileId: number,
  documentId: number,
  description: string,
  plannedDate: string
): void {
  db.prepare(
    `INSERT INTO care_plan_items
       (profile_id, document_id, description, planned_date, status, source)
     VALUES (?, ?, ?, ?, 'active', 'document:import')`
  ).run(profileId, documentId, description, plannedDate);
}

// Every visit card's chips, keyed by encounter id, plus the scope its heading claims.
function visitCards(profileId: number) {
  const out = new Map<
    string,
    { labels: string[]; scope: string | undefined }
  >();
  for (const e of getTimelineEvents(profileId, { limit: 200 })) {
    if (e.category !== "visit") continue;
    out.set(e.id, {
      labels: (e.linkedRefs ?? []).map((r) => r.label),
      scope: e.linkedRefsScope,
    });
  }
  return out;
}

describe("a multi-visit container's visit cards (#2920)", () => {
  it("chips only the rows genuinely linked to each visit", () => {
    const profile = newProfile("Container Household");
    const docId = newDocument(profile, "all-visits.xml");
    const eye = newEncounter(
      profile,
      docId,
      "900001",
      "2019-04-02",
      "Ophthalmology"
    );
    const lungs = newEncounter(
      profile,
      docId,
      "900002",
      "2019-08-15",
      "Pulmonology"
    );
    // The med list the container carried: no encounter link, so it belongs to no
    // visit in the container. This is the observed albuterol-on-an-eye-visit chip.
    newMedication(profile, docId, "albuterol", null);
    // A procedure the import DID correlate to the eye visit (#1050 Tier-1 stamp).
    newProcedure(profile, docId, "Visual field test", "2019-04-02", eye);
    // Standing plan items — care_plan_items has no encounter link at all.
    newCarePlanItem(profile, docId, "Flu vaccine", "2019-10-01");

    const cards = visitCards(profile);
    const eyeCard = cards.get(`visit:${eye}`)!;
    const lungCard = cards.get(`visit:${lungs}`)!;

    // The unlinked med chips on NEITHER visit.
    expect(eyeCard.labels).not.toContain("Medication: albuterol");
    expect(lungCard.labels).not.toContain("Medication: albuterol");
    // The linked procedure chips on exactly its own visit.
    expect(eyeCard.labels).toEqual(["Procedure: Visual field test"]);
    expect(lungCard.labels).toEqual([]);
    // And the card claims only the attribution it has.
    expect(eyeCard.scope).toBe("visit");
    // Plan items are document-scoped by construction, so a container shows none.
    expect(eyeCard.labels).not.toContain("Care plan: Flu vaccine");
    expect(lungCard.labels).not.toContain("Care plan: Flu vaccine");
  });

  it("keeps a linked med on its own visit and off the others", () => {
    const profile = newProfile("Linked Meds");
    const docId = newDocument(profile, "all-visits.xml");
    const spring = newEncounter(
      profile,
      docId,
      "900001",
      "2019-04-02",
      "Office Visit"
    );
    const summer = newEncounter(
      profile,
      docId,
      "900002",
      "2019-08-15",
      "Office Visit"
    );
    newMedication(profile, docId, "lisinopril", summer);

    const cards = visitCards(profile);
    expect(cards.get(`visit:${summer}`)!.labels).toEqual([
      "Medication: lisinopril",
    ]);
    expect(cards.get(`visit:${spring}`)!.labels).toEqual([]);
  });
});

describe("a single-visit document's visit card (#2920)", () => {
  it("keeps today's document-lineage behavior and heading", () => {
    const profile = newProfile("One Visit Summary");
    const docId = newDocument(profile, "one-visit.xml");
    const visit = newEncounter(
      profile,
      docId,
      "900001",
      "2019-04-02",
      "Office Visit"
    );
    // None of these carries an encounter link — in a per-visit summary, document IS
    // visit, so lineage is honest attribution and stays.
    newMedication(profile, docId, "lisinopril", null);
    newProcedure(profile, docId, "Blood pressure check", "2019-04-02", null);
    newCarePlanItem(profile, docId, "Flu vaccine", "2019-10-01");

    const card = visitCards(profile).get(`visit:${visit}`)!;
    expect(card.labels).toEqual([
      "Procedure: Blood pressure check",
      "Care plan: Flu vaccine",
      "Medication: lisinopril",
    ]);
    expect(card.scope).toBe("document");
  });

  it("still counts as one visit when the same summary was uploaded twice", () => {
    // Two overlapping uploads of ONE per-visit summary produce two physical encounter
    // rows that collapse to one representative — that is not a container, so the
    // surviving card keeps its document lineage.
    const profile = newProfile("Uploaded Twice");
    const firstDoc = newDocument(profile, "summary-1.xml");
    const secondDoc = newDocument(profile, "summary-2.xml");
    newEncounter(profile, firstDoc, "900001", "2019-04-02", "Office Visit");
    const second = newEncounter(
      profile,
      secondDoc,
      "900001",
      "2019-04-02",
      "Office Visit"
    );
    newMedication(profile, secondDoc, "lisinopril", null);

    const card = visitCards(profile).get(`visit:${second}`)!;
    expect(card.labels).toEqual(["Medication: lisinopril"]);
    expect(card.scope).toBe("document");
  });
});
