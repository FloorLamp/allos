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
