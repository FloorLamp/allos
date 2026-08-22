import { db, writeTx } from "./db";
import { isCleanerName } from "./imported-name";
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
// A BLANK STORED NAME is refused here rather than one layer up. `COALESCE` preserves
// what the document said forever, so adopting over an empty name would write an empty
// `source_name` that nothing can ever correct; and there is no document label to
// preserve, which is the whole reason the write exists. Migration
// 101-recover-blank-name-prescriptions is this tree's own record that blank extracted
// names have existed.

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
      `SELECT name FROM intake_items
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND TRIM(name) <> ''`
    )
    .get(itemId, profileId, documentId) as { name: string } | undefined;
  return row?.name ?? null;
}

export type AdoptResult =
  { ok: true } | { ok: false; reason: "not-found" | "not-cleaner" };

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
      `SELECT id, name FROM intake_items
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND TRIM(name) <> ''`
    )
    .get(itemId, profileId, documentId) as
    { id: number; name: string } | undefined;
  if (!row) return { ok: false, reason: "not-found" };
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
