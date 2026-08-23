"use server";
// The IMPORT-BOUNDARY NAME ADOPTION (issue #3480) — the Server Action behind the
// offer on the import review page.
//
// A portal-imported medication lands under the document's own label ("Calcium
// Carb-Cholecalciferol (CALCIUM 500 + D OR)"). The review page offers the RxNorm
// preferred name for that string; this action is what happens when the person picks
// one. It is the only path in the tree that changes a stored medication name in
// response to an import, and it runs exactly once per acceptance — never on render,
// never on a re-import, never on its own.
//
// Thin by design: auth, a shape check, the RxNorm re-check, then
// lib/imported-name-write.ts, which owns the row scoping and the preservation and is
// where the DB tier drives it.
//
// THE RE-CHECK IS THE PART THAT MAKES THE WRITE TRUSTWORTHY rather than merely
// authenticated. The form could carry any name beside any code; before a medication
// is renamed we ask RxNorm whether that code really does answer to that name for
// this string, so a stale tab or a forged payload cannot rename a medicine to
// something nobody was shown. An unreachable lookup REFUSES — "the network was down"
// is not a reason to accept an unverified name onto a medicine. (Everywhere else in
// this feature an absent lookup degrades silently, because everywhere else it costs
// only a missing code; here it would cost a wrong name.)
//
// The RxNorm side is the existing shared lookup (lib/rxnorm.ts, #144/#279/#846) —
// there is no second resolver here. The confirmed product code and its ingredient
// decomposition ride along, because a name somebody standardized is exactly the
// moment the safety matchers can start keying on a code instead of a string.
import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { lookupRxNormCandidates, lookupRxNormIngredients } from "@/lib/rxnorm";
import {
  adoptImportedName,
  importedMedicationName,
} from "@/lib/imported-name-write";
import { formError, formOk, type FormResult } from "@/lib/types/forms";

// A stored RxCUI is a short numeric string — the same shape lib/rxnorm.ts enforces
// on everything it parses. Checked here too because this value arrives from a form.
const RXCUI_SHAPE = /^\d{1,10}$/;

// Adopt the RxNorm preferred name for one imported medication.
//
// `item_id` — the extracted intake_items row under review.
// `document_id` — the document whose review page offered this; the row must belong
//   to it, so an offer from one document can never rename another's row.
// `rxcui` — the concept the person picked.
// `name` — that concept's name, as it was rendered to them.
export async function adoptImportedMedicationName(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const itemId = Number(formData.get("item_id"));
  const documentId = Number(formData.get("document_id"));
  const rxcui = String(formData.get("rxcui") ?? "").trim();
  const chosen = String(formData.get("name") ?? "").trim();
  if (
    !Number.isInteger(itemId) ||
    itemId <= 0 ||
    !Number.isInteger(documentId) ||
    documentId <= 0 ||
    !RXCUI_SHAPE.test(rxcui) ||
    !chosen
  )
    return formError("Couldn't rename that medication.");

  // The stored name is the term the offer was built from, so re-derive it here
  // rather than trusting the form to say what it was.
  const stored = importedMedicationName(profile.id, documentId, itemId);
  if (!stored) return formError("Couldn't rename that medication.");

  const candidates = await lookupRxNormCandidates(stored);
  if (!candidates.some((c) => c.rxcui === rxcui && c.name.trim() === chosen))
    return formError(
      "Couldn't confirm that name with RxNorm just now. Try again."
    );

  // The concept's active ingredients (#279) — resolved here so the whole adoption is
  // one round trip. Absent on any timeout: a product code with no ingredients is an
  // honest state (lib/rxnorm.ts), not a failure.
  const ingredients = await lookupRxNormIngredients(rxcui);

  const res = adoptImportedName(
    profile.id,
    documentId,
    itemId,
    chosen,
    rxcui,
    ingredients
  );
  if (!res.ok)
    return formError(
      res.reason === "not-cleaner"
        ? "That name is already the one stored."
        : "Couldn't rename that medication."
    );

  revalidateRoute("/import/[id]", "page");
  revalidateRoute("/medications");
  return formOk();
}
