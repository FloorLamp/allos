"use server";
// The IMPORT-BOUNDARY NAME ADOPTION (issue #3480) — the one write behind the offer
// on the import review page.
//
// A portal-imported medication lands under the document's own label ("Calcium
// Carb-Cholecalciferol (CALCIUM 500 + D OR)"). The review page offers the RxNorm
// preferred name for that string; this action is what happens when the person picks
// one. It is the ONLY path in the tree that changes a stored medication name in
// response to an import, and it runs exactly once per acceptance — never on render,
// never on a re-import, never on its own.
//
// Three things make it safe to point at medication data:
//   • it writes only rows the import created (`source = 'extracted'`, `document_id`
//     matching the document under review) and only in the acting profile;
//   • the previous name is preserved on the row (`source_name`) rather than
//     discarded, so what the pharmacy label says stays findable;
//   • the new name is one the person SAW and CHOSE — the candidate list is rendered
//     before anything is written, and this action re-checks that the name it was
//     handed genuinely belongs to the RxCUI it was handed with, so a stale or forged
//     payload cannot rename a medication to something nobody was shown.
//
// The RxNorm side is the existing shared lookup (lib/rxnorm.ts, #144/#279/#846) —
// there is no second resolver here. The confirmed product code and its ingredient
// decomposition ride along, because a name the person standardized is exactly the
// moment the safety matchers can start keying on a code instead of a string.
import { requireWriteAccess } from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import { revalidateRoute } from "@/lib/revalidate";
import {
  lookupRxNormCandidates,
  lookupRxNormIngredients,
  serializeRxcuiIngredients,
} from "@/lib/rxnorm";
import { isCleanerName } from "@/lib/imported-name";
import { formError, formOk, type FormResult } from "@/lib/types/forms";

// A stored RxCUI is a short numeric string (the same shape lib/rxnorm.ts enforces on
// everything it parses). Checked here too because this value arrives from a form.
const RXCUI_SHAPE = /^\d{1,10}$/;

// Adopt the RxNorm preferred name for one imported medication.
//
// `item_id` — the extracted intake_items row under review.
// `document_id` — the document whose review page offered this; the row must belong
//   to it, so an offer from one document can never rename another's row.
// `rxcui` — the concept the person picked.
// `name` — the concept's name, as it was rendered to them.
export async function adoptImportedMedicationName(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const itemId = Number(formData.get("item_id"));
  const documentId = Number(formData.get("document_id"));
  const rxcui = String(formData.get("rxcui") ?? "").trim();
  const chosen = String(formData.get("name") ?? "").trim();
  if (!Number.isInteger(itemId) || itemId <= 0)
    return formError("Couldn't rename that medication.");
  if (!Number.isInteger(documentId) || documentId <= 0)
    return formError("Couldn't rename that medication.");
  if (!RXCUI_SHAPE.test(rxcui) || !chosen)
    return formError("Couldn't rename that medication.");

  // The row, scoped three ways: this profile, this document, and the extracted set.
  // A manual row is not reachable from here at all — the doctrine's scope gate.
  const row = db
    .prepare(
      `SELECT id, name FROM intake_items
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND kind = 'medication'`
    )
    .get(itemId, profile.id, documentId) as
    | { id: number; name: string }
    | undefined;
  if (!row) return formError("Couldn't rename that medication.");

  // Is the chosen name still an improvement on what is stored? A second person (or a
  // second tab) may have renamed it already, in which case there is nothing to offer
  // and nothing to do.
  if (!isCleanerName(row.name, chosen))
    return formError("That name is already the one stored.");

  // RE-CHECK THE PAIR AGAINST RxNorm, and this is the part that makes the write
  // trustworthy rather than merely authenticated. The form could carry any name
  // beside any code; before a medication is renamed we ask the source whether that
  // code really does answer to that name for this string. An unreachable lookup
  // REFUSES — the person can try again — because "the network was down" is not a
  // reason to accept an unverified name onto a medicine.
  const candidates = await lookupRxNormCandidates(row.name);
  const match = candidates.find(
    (c) => c.rxcui === rxcui && c.name.trim() === chosen
  );
  if (!match)
    return formError(
      "Couldn't confirm that name with RxNorm just now. Try again."
    );

  // The concept's active ingredients (#279) — resolved here rather than client-side
  // so the whole adoption is one server round trip. Absent on any timeout: a product
  // code with no ingredients is an honest state (lib/rxnorm.ts), not a failure.
  const ingredients = await lookupRxNormIngredients(rxcui);

  writeTx(() => {
    db.prepare(
      `UPDATE intake_items
          SET source_name = COALESCE(source_name, name),
              name = ?,
              rxcui = ?,
              rxcui_ingredients = ?
        WHERE id = ? AND profile_id = ? AND document_id = ?
          AND source = 'extracted' AND kind = 'medication'`
    ).run(
      chosen,
      rxcui,
      serializeRxcuiIngredients(ingredients),
      itemId,
      profile.id,
      documentId
    );
  });

  // COALESCE above, not a plain assignment: `source_name` records what the DOCUMENT
  // said, so a second adoption on the same row (a better candidate, a month later)
  // must not overwrite the portal string with the first standardized name. The
  // document's own label is written once and then never again.

  revalidateRoute("/import/[id]", "page");
  revalidateRoute("/medications");
  return formOk();
}
