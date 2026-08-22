import { db, writeTx } from "./db";
import { isCleanerName, isImportedDocumentName } from "./imported-name";
import { serializeRxcuiIngredients } from "./rxnorm";

// The WRITE half of the imported-name boundary (issue #3480) — the only path in the
// tree that changes a stored medication name because of an import.
//
// It lives in lib/ rather than inside the Server Action for the reason the medical
// pipeline does (lib/medical-pipeline.ts): the action is auth, a network lookup and
// a revalidate, none of which the DB test tier can drive, while THIS is the part
// whose behaviour matters — which rows it can touch, what it preserves, and what it
// refuses. lib/__db_tests__/imported-name-boundary.test.ts drives it over the real
// import pipeline.
//
// WHAT IT MAY TOUCH, and the scoping is the safety argument rather than a detail:
// one row, in the given profile, produced by the given document, in the extracted
// set, whose stored name is not blank. A hand-entered medication is unreachable from
// here at any profile, under any id, which is why the offer cannot become the display
// pass the doctrine rejects — there is no code path from it to a name somebody typed.
//
// IT IS EXACTLY WHAT THE OFFER LISTS, and it did not used to be. These statements
// also required `kind = 'medication'` while the read that feeds the card
// (lib/queries/imports.ts `getDocumentImportedNameOffers`) did not, so a person who
// re-saved an imported medication as a Supplement — one shipped form, one select —
// kept the offer card and lost the button behind it forever: "Couldn't rename that
// medication." `kind` is the PERSON's classification of a row and they may change it
// at any time; the row's PROVENANCE is `source = 'extracted'` plus `document_id`, and
// provenance is what this boundary is scoped on. The import writes extracted intake
// rows at one place only (lib/import-persist.ts) and always as kind 'medication', so
// dropping the clause widens the reachable set by nothing except the rows somebody
// deliberately reclassified — which are the rows the card was already offering.
//
// A BLANK STORED NAME is refused here rather than one layer up. There is no document
// label to preserve, which is the whole reason the write exists. Note what actually
// closes that path: `cleanMedicationName` (lib/prescription-parse.ts) runs a JS
// `trim()` on every extracted name before it is stored, so an all-whitespace name
// cannot reach the table. The `TRIM(name) <> ''` clause below is the SAME question
// asked at the boundary that does the writing, so the refusal does not depend on a
// caller two modules away keeping its trim; it is not a normaliser and does not claim
// to be one — SQL `TRIM` strips spaces only, and a name made of invisible characters
// (U+200B, U+2060, U+00AD, U+180E) passes both it and the JS trim. Per-field
// normalisation at the write boundary is #3472's, and closing it there closes it for
// every name column at once rather than growing a second normaliser here. Migration
// 101-recover-blank-name-prescriptions is this tree's own record that blank extracted
// names have existed.
//
// AND IT MUST BE A ROW THE CARD COULD HAVE SHOWN. `source = 'extracted'` is
// PROVENANCE; it does not say the row's name still reads as the document's label.
// Without the predicate re-check below, a valid `item_id` for any extracted row in
// the document renamed it — offered or not — so a stale tab, a replayed payload or
// any client posting an id reached rows nobody was ever shown. That is not an
// authorization hole (it is the same person's own document), but "no stored name
// changes without a person seeing both versions and choosing" is exactly the sentence
// it falsified. The re-check asks the SAME question the card's read asks
// (lib/queries/imports.ts `getDocumentImportedNameOffers`), including its second
// clause: a row whose `source_name` is set is by definition no longer carrying a
// document label — it was renamed from here already — and it stays reachable, because
// the card deliberately keeps offering it in case a better concept exists.

// Is this row one the offer card could have listed? The read half of the boundary
// (`getDocumentImportedNameOffers`) filters on exactly this expression, so the two
// cannot drift into offering what the write refuses or writing what the card never
// showed.
function wasOffered(row: {
  name: string;
  source_name: string | null;
}): boolean {
  return row.source_name != null || isImportedDocumentName(row.name);
}

// The stored name of one imported medication, under exactly the scoping the write
// below uses — the term an offer is built from. Returns null when the row is not
// one this boundary may touch, so a caller cannot look up a name it could not then
// change.
export function importedMedicationName(
  profileId: number,
  documentId: number,
  itemId: number
): string | null {
  const row = db
    .prepare(
      `SELECT name, source_name FROM intake_items
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND TRIM(name) <> ''`
    )
    .get(itemId, profileId, documentId) as
    { name: string; source_name: string | null } | undefined;
  if (!row || !wasOffered(row)) return null;
  return row.name;
}

export type AdoptResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "not-offered" | "not-cleaner" };

// Adopt `chosen` as this imported medication's name, preserving what the document
// called it.
//
// `source_name` is written with COALESCE, never assigned: it records what the
// DOCUMENT said, so a second adoption on the same row — a better concept, a month
// later — must not overwrite the portal string with the first standardized name. The
// document's own label is written once and then never again.
export function adoptImportedName(
  profileId: number,
  documentId: number,
  itemId: number,
  chosen: string,
  rxcui: string,
  ingredients: string[]
): AdoptResult {
  const row = db
    .prepare(
      `SELECT id, name, source_name FROM intake_items
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND TRIM(name) <> ''`
    )
    .get(itemId, profileId, documentId) as
    { id: number; name: string; source_name: string | null } | undefined;
  if (!row) return { ok: false, reason: "not-found" };
  // The card's own predicate, re-asked at the write — see the header.
  if (!wasOffered(row)) return { ok: false, reason: "not-offered" };
  // Somebody may have renamed this already, in another tab or on another device;
  // then there is nothing to offer and nothing to do.
  if (!isCleanerName(row.name, chosen))
    return { ok: false, reason: "not-cleaner" };

  writeTx(() => {
    db.prepare(
      `UPDATE intake_items
          SET source_name = COALESCE(source_name, name),
              name = ?,
              rxcui = ?,
              rxcui_ingredients = ?
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND TRIM(name) <> ''`
    ).run(
      chosen,
      rxcui,
      serializeRxcuiIngredients(ingredients),
      itemId,
      profileId,
      documentId
    );
  });
  return { ok: true };
}
