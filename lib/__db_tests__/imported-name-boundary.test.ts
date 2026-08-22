// DB INTEGRATION TIER — the imported-name boundary (#3480) over the REAL import
// pipeline: extractFromCcda → healthRecordToPersistInput → persistDocumentImport,
// then the offer read and the adopt write.
//
// What it pins, in the order the person meets it:
//   • an imported medication's name lands VERBATIM — the import writes what the
//     document said and rewrites nothing, which is the half of the doctrine that
//     would be silently lost if somebody ever "helpfully" cleaned it on the way in;
//   • the offer FIRES on that row, and the portal string is what it fires on;
//   • the SCOPE GATE holds: a hand-entered medication with the same shouting shape
//     is never offered, at any profile, because the read is `source = 'extracted'`;
//   • accepting stores the clean name AND preserves the document's label;
//   • the preserved label survives a SECOND adoption — it records what the DOCUMENT
//     said, not the previous name;
//   • declining leaves the row exactly as the import wrote it;
//   • another profile's row is unreachable from this profile's document.
//
// EACH HALF OF THE SCOPING IS ASSERTED BY A ROW THAT DIFFERS ONLY IN THAT HALF, and
// that is not pedantry — it is the difference between a guard and a comment. The
// first version of this file attacked `profile_id` with a row in a DIFFERENT
// DOCUMENT, so `document_id` rejected it and the profile clause never ran: replacing
// `profile_id = ?` with `? IS NOT NULL` in all three statements left this file 12/12
// green while a cross-profile rename succeeded from the action tier. The scope gate
// had the same hole in the other direction — its manual row carried no `document_id`
// at all, so `AND source = 'extracted'` could be deleted outright with the whole pure
// and DB tiers green. An attack row must be IDENTICAL on every other predicate.
//
// The RxNorm network step is the Server Action's, not this core's, so the
// candidate/code pair arrives here as an argument — the same seam the DB tier uses
// for every other network-fed write.
//
// All fixtures synthetic. The medication string is the one the issue observed, which
// is a product label, not anybody's data.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { getDocumentImportedNameOffers } from "@/lib/queries";
import {
  adoptImportedName,
  importedMedicationName,
} from "@/lib/imported-name-write";
import { isImportedDocumentName } from "@/lib/imported-name";

// The observed defect, as a portal would render it in a CCD med list: the generic
// pair, then the portal's own ALL-CAPS label with its dose-form code ("OR" = oral).
const PORTAL_NAME = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";

// What RxNorm answers for that string, and the code it answers under. Fixed here
// rather than fetched — the lookup is the action's step, and a test that reached the
// network would be measuring NLM's uptime.
const CLEAN_NAME = "Calcium Carbonate / Cholecalciferol";
const CLEAN_RXCUI = "904458";
const CLEAN_INGREDIENTS = ["1897", "2418"];

function medsCcd(name: string): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260701"/>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
    <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Medications</title>
    <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <statusCode code="active"/>
      <effectiveTime type="IVL_TS"><low value="20260701"/></effectiveTime>
      <consumable><manufacturedProduct><manufacturedMaterial>
        <name>${name}</name>
      </manufacturedMaterial></manufacturedProduct></consumable>
    </substanceAdministration></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'meds.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

function importCcd(profileId: number, docId: number, xml: string): void {
  persistDocumentImport(
    profileId,
    docId,
    healthRecordToPersistInput(extractFromCcda(xml), "ccd-test", "CCD")
  );
}

function medRows(profileId: number): {
  id: number;
  name: string;
  source_name: string | null;
  rxcui: string | null;
  rxcui_ingredients: string | null;
  source: string | null;
}[] {
  return db
    .prepare(
      `SELECT id, name, source_name, rxcui, rxcui_ingredients, source
         FROM intake_items WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    name: string;
    source_name: string | null;
    rxcui: string | null;
    rxcui_ingredients: string | null;
    source: string | null;
  }[];
}

// A hand-entered medication carrying the SAME shouting shape — the control for the
// scope gate. Somebody who types "HCTZ 25 MG" meant to.
function typeMedication(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source)
         VALUES (?, ?, 'medication', 'manual')`
      )
      .run(profileId, name).lastInsertRowid
  );
}

// The SAME hand-entered row, but stamped with this document's id — the isolated
// control for `AND source = 'extracted'`. Every other predicate the offer read and
// the write apply matches: profile, document, kind, a non-blank name that the
// predicate would say `true` about. `source` is the only thing left that can reject
// it, so if the clause goes, this row starts being offered and renamed.
//
// The shape is reachable, not hypothetical: `document_id` is a plain column on
// intake_items and rows have been re-pointed at documents by reassign and merge.
function typeMedicationInDocument(
  profileId: number,
  documentId: number,
  name: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
         VALUES (?, ?, 'medication', 'manual', ?)`
      )
      .run(profileId, name, documentId).lastInsertRowid
  );
}

// Re-save an imported medication as a Supplement — exactly what `updateIntakeItem`
// writes when somebody changes the kind select on the medication form, which leaves
// `source` and `document_id` alone.
function reclassifyAsSupplement(itemId: number): void {
  db.prepare("UPDATE intake_items SET kind = 'supplement' WHERE id = ?").run(
    itemId
  );
}

describe("the import writes the document's name unchanged", () => {
  it("lands the portal string verbatim, with nothing preserved yet", () => {
    const p = newProfile("import verbatim");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));

    const rows = medRows(p);
    expect(rows).toHaveLength(1);
    // VERBATIM. If this ever fails because the import started cleaning names, the
    // doctrine has been inverted, not improved: a silent rewrite is the thing #3480
    // exists to prevent, and it would be invisible to everyone downstream.
    expect(rows[0].name).toBe(PORTAL_NAME);
    expect(rows[0].source_name).toBeNull();
    expect(rows[0].source).toBe("extracted");
  });
});

describe("the offer", () => {
  it("fires on the imported document string", () => {
    const p = newProfile("offer fires");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));

    const offers = getDocumentImportedNameOffers(p, doc);
    expect(offers.map((o) => o.name)).toEqual([PORTAL_NAME]);
    // And it fires because of the string, not because the row was imported: an
    // imported name that reads fine is left alone.
    expect(isImportedDocumentName(PORTAL_NAME)).toBe(true);
  });

  it("stays silent on an imported name that reads fine", () => {
    const p = newProfile("offer silent");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd("Lisinopril 10 mg"));

    expect(medRows(p).map((r) => r.name)).toEqual(["Lisinopril"]);
    expect(getDocumentImportedNameOffers(p, doc)).toEqual([]);
  });

  it("never examines a name somebody typed — the scope gate", () => {
    const p = newProfile("scope gate");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    // Same shouting shape, hand-entered. The predicate would say true about the
    // string; the READ never asks it, because the row is not `extracted`.
    typeMedication(p, "HCTZ 25 MG TAB");
    expect(isImportedDocumentName("HCTZ 25 MG TAB")).toBe(true);

    const offers = getDocumentImportedNameOffers(p, doc);
    expect(offers.map((o) => o.name)).toEqual([PORTAL_NAME]);
  });
});

describe("accepting the offer", () => {
  it("stores the clean name, preserves the document's label, adopts the code", () => {
    const p = newProfile("accept");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;

    expect(
      adoptImportedName(
        p,
        doc,
        itemId,
        CLEAN_NAME,
        CLEAN_RXCUI,
        CLEAN_INGREDIENTS
      )
    ).toEqual({ ok: true });

    const row = medRows(p)[0];
    expect(row.name).toBe(CLEAN_NAME);
    expect(row.source_name).toBe(PORTAL_NAME);
    expect(row.rxcui).toBe(CLEAN_RXCUI);
    expect(row.rxcui_ingredients).toBe(JSON.stringify(CLEAN_INGREDIENTS));
  });

  it("keeps the row listed afterwards, so the page records what happened", () => {
    const p = newProfile("accept listed");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;
    adoptImportedName(p, doc, itemId, CLEAN_NAME, CLEAN_RXCUI, []);

    const offers = getDocumentImportedNameOffers(p, doc);
    expect(offers.map((o) => [o.name, o.source_name])).toEqual([
      [CLEAN_NAME, PORTAL_NAME],
    ]);
  });

  it("still preserves the DOCUMENT's label after a second adoption", () => {
    const p = newProfile("second adoption");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;
    adoptImportedName(p, doc, itemId, CLEAN_NAME, CLEAN_RXCUI, []);
    // A better concept, later. `source_name` records what the DOCUMENT said — not
    // the previous name — so this must not shift to CLEAN_NAME.
    adoptImportedName(p, doc, itemId, "Calcium Carbonate", "1897", []);

    const row = medRows(p)[0];
    expect(row.name).toBe("Calcium Carbonate");
    expect(row.source_name).toBe(PORTAL_NAME);
  });

  it("refuses a candidate that is not an improvement", () => {
    const p = newProfile("refuse");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;

    expect(
      adoptImportedName(p, doc, itemId, "CALCIUM CARBONATE 500 MG TAB", "1", [])
    ).toEqual({ ok: false, reason: "not-cleaner" });
    expect(medRows(p)[0].name).toBe(PORTAL_NAME);
    expect(medRows(p)[0].source_name).toBeNull();
  });
});

describe("declining, and what the write cannot reach", () => {
  it("leaves the row exactly as the import wrote it", () => {
    const p = newProfile("decline");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const before = medRows(p);
    // Declining is not an action — it is the absence of one. The assertion is that
    // nothing else in the boundary touches the row on its own.
    expect(getDocumentImportedNameOffers(p, doc)).toHaveLength(1);
    expect(medRows(p)).toEqual(before);
  });

  it("cannot rename a hand-entered medication", () => {
    const p = newProfile("manual unreachable");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const manualId = typeMedication(p, "HCTZ 25 MG TAB");

    expect(importedMedicationName(p, doc, manualId)).toBeNull();
    expect(
      adoptImportedName(p, doc, manualId, "Hydrochlorothiazide", "5487", [])
    ).toEqual({ ok: false, reason: "not-found" });
    expect(medRows(p).find((r) => r.id === manualId)?.name).toBe(
      "HCTZ 25 MG TAB"
    );
  });

  it("cannot rename another profile's medication", () => {
    const mine = newProfile("mine");
    const theirs = newProfile("theirs");
    const myDoc = newDocument(mine);
    const theirDoc = newDocument(theirs);
    importCcd(mine, myDoc, medsCcd(PORTAL_NAME));
    importCcd(theirs, theirDoc, medsCcd(PORTAL_NAME));
    const theirItem = medRows(theirs)[0].id;

    expect(
      adoptImportedName(mine, myDoc, theirItem, CLEAN_NAME, CLEAN_RXCUI, [])
    ).toEqual({ ok: false, reason: "not-found" });
    expect(medRows(theirs)[0].name).toBe(PORTAL_NAME);
  });

  it("cannot rename a row belonging to a different document", () => {
    const p = newProfile("cross document");
    const docA = newDocument(p);
    const docB = newDocument(p);
    importCcd(p, docA, medsCcd(PORTAL_NAME));
    const itemA = medRows(p)[0].id;

    expect(
      adoptImportedName(p, docB, itemA, CLEAN_NAME, CLEAN_RXCUI, [])
    ).toEqual({ ok: false, reason: "not-found" });
    expect(medRows(p)[0].name).toBe(PORTAL_NAME);
  });
});

describe("the scoping, one clause at a time", () => {
  // Each case below builds an attack row that is IDENTICAL to a legitimate one on
  // every predicate except the one under test. Delete that one clause and the case
  // goes red; delete any other and it stays green, which is what makes it an
  // observer of that clause rather than of its neighbours.

  it("refuses another profile's row IN THAT PROFILE'S OWN DOCUMENT — profile_id alone", () => {
    const mine = newProfile("profile clause mine");
    const theirs = newProfile("profile clause theirs");
    const theirDoc = newDocument(theirs);
    importCcd(theirs, theirDoc, medsCcd(PORTAL_NAME));
    const theirItem = medRows(theirs)[0].id;

    // `theirDoc` and `theirItem` are BOTH passed, so document_id matches, source
    // matches, the name is non-blank. Only `profile_id = ?` can say no — and both
    // ids are small global integers a forged form could carry.
    expect(importedMedicationName(mine, theirDoc, theirItem)).toBeNull();
    expect(
      adoptImportedName(mine, theirDoc, theirItem, CLEAN_NAME, CLEAN_RXCUI, [])
    ).toEqual({ ok: false, reason: "not-found" });
    expect(medRows(theirs)[0].name).toBe(PORTAL_NAME);
    expect(medRows(theirs)[0].source_name).toBeNull();
  });

  it("never offers a typed row stamped with this document — source alone", () => {
    const p = newProfile("scope clause read");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const typed = typeMedicationInDocument(p, doc, "HCTZ 25 MG TAB");
    // The predicate WOULD say true about this string; the read must never ask it.
    expect(isImportedDocumentName("HCTZ 25 MG TAB")).toBe(true);

    const offers = getDocumentImportedNameOffers(p, doc);
    expect(offers.map((o) => o.id)).not.toContain(typed);
    expect(offers.map((o) => o.name)).toEqual([PORTAL_NAME]);
  });

  it("cannot rename a typed row stamped with this document — source alone", () => {
    const p = newProfile("scope clause write");
    const doc = newDocument(p);
    const typed = typeMedicationInDocument(p, doc, "HCTZ 25 MG TAB");

    expect(importedMedicationName(p, doc, typed)).toBeNull();
    expect(
      adoptImportedName(p, doc, typed, "Hydrochlorothiazide", "5487", [])
    ).toEqual({ ok: false, reason: "not-found" });
    expect(medRows(p).find((r) => r.id === typed)?.name).toBe("HCTZ 25 MG TAB");
  });

  it("refuses a blank imported name — nothing to preserve, and COALESCE is forever", () => {
    const p = newProfile("blank name");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;
    db.prepare("UPDATE intake_items SET name = '' WHERE id = ?").run(itemId);

    expect(importedMedicationName(p, doc, itemId)).toBeNull();
    expect(
      adoptImportedName(p, doc, itemId, CLEAN_NAME, CLEAN_RXCUI, [])
    ).toEqual({ ok: false, reason: "not-found" });
    // The refusal matters because `source_name` is written ONCE: an empty string
    // there would be preserved by COALESCE for the life of the row.
    expect(medRows(p)[0].source_name).toBeNull();
  });
});

describe("a row somebody re-saved as a supplement", () => {
  // THE ASYMMETRY THIS PR FIXES. The offer read has never filtered on `kind`; the
  // write used to require `kind = 'medication'`. So one pass through the shipped
  // medication form — change the kind select, save — left the card listing a row
  // whose "Use this name" button could only ever answer "Couldn't rename that
  // medication." The write is now scoped on provenance, like the read.
  //
  // These two cases are the observers for that decision. Re-add `AND kind =
  // 'medication'` to lib/imported-name-write.ts and both go red.

  it("is still offered, because the offer follows provenance not kind", () => {
    const p = newProfile("supplement offered");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;
    reclassifyAsSupplement(itemId);

    expect(getDocumentImportedNameOffers(p, doc).map((o) => o.name)).toEqual([
      PORTAL_NAME,
    ]);
  });

  it("can still be renamed, and keeps the document's label", () => {
    const p = newProfile("supplement renamed");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(PORTAL_NAME));
    const itemId = medRows(p)[0].id;
    reclassifyAsSupplement(itemId);

    expect(importedMedicationName(p, doc, itemId)).toBe(PORTAL_NAME);
    expect(
      adoptImportedName(p, doc, itemId, CLEAN_NAME, CLEAN_RXCUI, [])
    ).toEqual({ ok: true });

    const row = medRows(p)[0];
    expect(row.name).toBe(CLEAN_NAME);
    expect(row.source_name).toBe(PORTAL_NAME);
    // And the person's own classification is untouched by the rename.
    expect(
      (
        db
          .prepare("SELECT kind FROM intake_items WHERE id = ?")
          .get(itemId) as {
          kind: string;
        }
      ).kind
    ).toBe("supplement");
  });
});
