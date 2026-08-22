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
//   • another profile's row is unreachable from this profile's document;
//   • and nutrient recognition follows the STORED NAME, so accepting an offer moves
//     it exactly as typing the same name over the old one does — the equivalence is
//     asserted in both directions, and the argument is in that block's own header.
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
import {
  getDietaryAdequacy,
  getDietaryLimitWarnings,
  getDocumentImportedNameOffers,
} from "@/lib/queries";
import { resolveNutrientKey } from "@/lib/dri";
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

// ── WHAT A RENAME DOES TO NUTRIENT RECOGNITION ───────────────────────────────
//
// lib/dri.ts resolves a nutrient by NAME SUBSTRING — `NAME_MATCHERS`, a vocabulary
// of nutrient WORDS with no code path in it. A medication's nutrient reading
// therefore follows its STORED NAME, and ANY rename moves it: type "Cholecalciferol"
// over "VITAMIN D3" in the medication form today and the vitamin-D upper-limit
// warning goes quiet, on main, with no import involved. That is the shipped
// contract.
//
// ACCEPTING AN OFFER IS ONE MORE WAY TO REACH IT, AND IS DELIBERATELY NOT SPECIAL.
// An earlier round of this PR had recognition read `source_name ?? name` so an
// adopted row went on reading off the document's label. It was reverted. `source_name`
// is written ONCE and never again, while `name` is rewritten by every ordinary
// rename — so the two diverge the moment somebody edits the row from the medication
// form, and the row's nutrient evidence would be frozen at a string the person can no
// longer change or even see. Measured on that build: a calcium warning fired naming
// "Lisinopril 10 mg", which contains no calcium, and a vitamin-D warning stayed
// silent at 12.5× the limit. Following the name is both safer and consistent with
// every other rename in the app.
//
// SO WHAT IS PINNED HERE IS THE EQUIVALENCE, not the direction. The same final name
// produces the same reading whichever path put it there, because recognition is
// keyed on the stored name and nothing else. Each case renames TWO otherwise
// identical rows — one by accepting the offer, one by a plain name UPDATE, which is
// all an ordinary rename does to this reading (`stackDriContext` maps `item.name`) —
// and asserts the two readings are equal, in BOTH the silencing and the surfacing
// direction. A future change that keyed recognition on `rxcui` would break this
// equivalence ON PURPOSE, because it would give adoption a path a typed rename does
// not have; it needs an rxcui→nutrient mapping this tree does not carry and is
// filed separately.
//
// It runs the REAL pipeline, the REAL offer read and the REAL write, because the
// question is about the join between them.

// A CCD carrying one medication, dosed. `strength` rides in the name the way a portal
// writes it, and the dose row is set after import because the CCD's own dose plumbing
// is not what is under test here.
function importedDosedMedication(
  label: string,
  documentName: string,
  amount: string
): { profileId: number; documentId: number; itemId: number } {
  const profileId = newProfile(label);
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value)
     VALUES (?, 'sex', 'female'), (?, 'birthdate', '1985-01-01')`
  ).run(profileId, profileId);
  const documentId = newDocument(profileId);
  importCcd(profileId, documentId, medsCcd(documentName));
  const itemId = medRows(profileId)[0].id;
  db.prepare("UPDATE intake_item_doses SET amount = ? WHERE item_id = ?").run(
    amount,
    itemId
  );
  return { profileId, documentId, itemId };
}

function ulReading(profileId: number): string[] {
  return getDietaryLimitWarnings(profileId).map(
    (w) => `${w.key} ${w.total}${w.unit} of ${w.ul}${w.unit}`
  );
}

function rdaReading(profileId: number): string[] {
  return getDietaryAdequacy(profileId).map((r) => `${r.key} ${r.total}`);
}

// The whole DRI reading for a profile — both questions, because a rename that moved
// only one of them would slip past an assertion on either alone.
function driReading(profileId: number): string[] {
  return [...ulReading(profileId), ...rdaReading(profileId)];
}

// What an ordinary rename does to this reading: it changes the stored name. Nothing
// else `stackDriContext` reads is derived from it.
function renameByHand(itemId: number, to: string): void {
  db.prepare("UPDATE intake_items SET name = ? WHERE id = ?").run(to, itemId);
}

describe("a rename moves nutrient recognition the same way from either path", () => {
  // [nutrient, what the document said, the dose, the RxNorm name offered, its code]
  const OVER_LIMIT: [string, string, string, string, string][] = [
    [
      "vitamin D",
      "VITAMIN D3 10000 UNIT CAP",
      "10000 IU",
      "Cholecalciferol",
      "2418",
    ],
    ["niacin", "NIACIN ER 1000 MG TAB", "1000 mg", "Nicotinamide", "1588647"],
    ["iron", "IRON SULFATE 325 MG TAB", "325 mg", "Ferrous Sulfate", "4832"],
  ];

  for (const [nutrient, documentName, amount, chosen, rxcui] of OVER_LIMIT) {
    it(`reads a renamed ${nutrient} row off the name it now carries`, () => {
      // The row is over the limit, it is on the offer card, and the name it is
      // offered is one the nutrient vocabulary cannot see. All three have to be
      // true or this test is asserting nothing.
      const adopted = importedDosedMedication(
        `adopted ${nutrient}`,
        documentName,
        amount
      );
      expect(ulReading(adopted.profileId)).toHaveLength(1);
      expect(
        getDocumentImportedNameOffers(
          adopted.profileId,
          adopted.documentId
        ).map((o) => o.id)
      ).toEqual([adopted.itemId]);
      expect(resolveNutrientKey(chosen)).toBeNull();

      // The control: the same import, renamed to the same string by hand.
      const typed = importedDosedMedication(
        `typed ${nutrient}`,
        documentName,
        amount
      );
      renameByHand(typed.itemId, chosen);

      expect(
        adoptImportedName(
          adopted.profileId,
          adopted.documentId,
          adopted.itemId,
          chosen,
          rxcui,
          [rxcui]
        )
      ).toEqual({ ok: true });
      expect(medRows(adopted.profileId)[0].name).toBe(chosen);

      expect(
        driReading(adopted.profileId),
        `accepting the offer must read exactly as typing "${chosen}" over the ` +
          `name does — recognition is name-keyed, so adoption is a rename and ` +
          `nothing more. A path that read some other string for an adopted row ` +
          `would pin this row's evidence to a name nobody can edit`
      ).toEqual(driReading(typed.profileId));

      // And say out loud where that lands for this row, so the consequence the
      // offer's copy names is on the record rather than implied: the vocabulary
      // cannot see the new name, so the warning is gone.
      expect(ulReading(adopted.profileId)).toEqual([]);
    });
  }

  it("brings a nutrient into view the same way, when the new name is one the vocabulary knows", () => {
    // The other direction, and the one an equality assertion is needed for: the
    // document said nothing about a nutrient and the chosen name does. A rename
    // can start a reading as well as end one — from either path, identically.
    const adopted = importedDosedMedication(
      "adopted new nutrient",
      "PREDNISONE 10 MG TAB",
      "60000 mg"
    );
    expect(ulReading(adopted.profileId)).toEqual([]);
    const typed = importedDosedMedication(
      "typed new nutrient",
      "PREDNISONE 10 MG TAB",
      "60000 mg"
    );
    expect(resolveNutrientKey("Calcium Prednisolone Phosphate")).toBe(
      "calcium"
    );
    renameByHand(typed.itemId, "Calcium Prednisolone Phosphate");

    expect(
      adoptImportedName(
        adopted.profileId,
        adopted.documentId,
        adopted.itemId,
        "Calcium Prednisolone Phosphate",
        "1234",
        []
      )
    ).toEqual({ ok: true });

    expect(driReading(adopted.profileId)).toEqual(driReading(typed.profileId));
    expect(
      ulReading(adopted.profileId).some((w) => w.startsWith("calcium ")),
      "a rename to a name the nutrient vocabulary knows starts a calcium " +
        "reading, whichever path made it. That is the consequence the offer's " +
        "copy tells the person about before they choose"
    ).toBe(true);
  });

  it("leaves an un-renamed row reading off its own name", () => {
    // The control for the whole feature: a row nobody renamed reads exactly as it
    // did before #3480, and `source_name` is still NULL on it. If this ever reds,
    // the offer has started changing rows nobody chose to change.
    const { profileId } = importedDosedMedication(
      "unrenamed control",
      "NIACIN ER 1000 MG TAB",
      "1000 mg"
    );
    expect(medRows(profileId)[0].source_name).toBeNull();
    expect(ulReading(profileId)).toEqual(["niacin 1000mg of 35mg"]);
  });
});

// ── THE WRITE REACHES ONLY WHAT THE CARD COULD HAVE SHOWN ────────────────────
//
// `source = 'extracted'` is PROVENANCE and says nothing about whether a row's name
// still reads as the document's label. Without the predicate re-check in
// lib/imported-name-write.ts, any valid `item_id` for an extracted row in the
// document was renamable — offered or not — so a stale tab, a replayed payload or
// any client posting an id reached rows nobody was ever shown. Not an authorization
// hole (same person, same document), but it is precisely how "no stored name changes
// without a person seeing both versions and choosing" fails.
//
// The attack row is IDENTICAL on every other predicate — same profile, same
// document, `source = 'extracted'`, non-blank name — so the re-check is the only
// thing left that can reject it.
describe("a row the card never offered", () => {
  // "IRON" is the real case, not a contrivance: the import stores it after
  // `cleanMedicationName` strips the strength, and one four-letter shouted token is
  // below every rule in lib/imported-name.ts.
  const QUIET_IMPORT = "IRON 325 MG TAB";
  const QUIET_STORED = "IRON";

  it("is not offered, and cannot be renamed", () => {
    const p = newProfile("never offered");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(QUIET_IMPORT));
    const row = medRows(p)[0];
    expect(row.name).toBe(QUIET_STORED);
    expect(row.source).toBe("extracted");
    expect(getDocumentImportedNameOffers(p, doc)).toEqual([]);

    expect(
      adoptImportedName(p, doc, row.id, "Ferrous Sulfate", "4832", ["4832"]),
      "the write reached every extracted row in the document, offered or not — " +
        "so a payload naming this id renamed a medication nobody was shown"
    ).toEqual({ ok: false, reason: "not-offered" });
    expect(medRows(p)[0]).toMatchObject({
      name: QUIET_STORED,
      source_name: null,
      rxcui: null,
    });
  });

  it("cannot even have its name read back", () => {
    // `importedMedicationName` is what the Server Action re-derives the offer term
    // from, so it carries the same scope — a caller must not be able to look up a
    // name it could not then change.
    const p = newProfile("never offered lookup");
    const doc = newDocument(p);
    importCcd(p, doc, medsCcd(QUIET_IMPORT));
    expect(importedMedicationName(p, doc, medRows(p)[0].id)).toBeNull();
  });

  it("stays renamable once it HAS been offered and accepted", () => {
    // The re-check's second clause, and the case that would break it if the rule
    // were only `isImportedDocumentName(name)`: an already-adopted row's name is by
    // definition no longer a document label, and the card deliberately keeps
    // offering it in case a better concept turns up.
    const p = newProfile("second adoption");
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
    expect(isImportedDocumentName(CLEAN_NAME)).toBe(false);
    expect(getDocumentImportedNameOffers(p, doc).map((o) => o.id)).toEqual([
      itemId,
    ]);

    expect(
      adoptImportedName(p, doc, itemId, "Calcium Carbonate", "1897", ["1897"])
    ).toEqual({ ok: true });
    const row = medRows(p)[0];
    expect(row.name).toBe("Calcium Carbonate");
    // Still what the DOCUMENT said, not the first standardized name.
    expect(row.source_name).toBe(PORTAL_NAME);
  });
});
