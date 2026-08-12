"use server";
// Clinical-observation CRUD server actions (issue #318). The document upload/extract/
// reprocess/reassign/delete PIPELINE lives in the sibling document-actions.ts (two
// "use server" files coexist per route) — split apart so the pipeline's churn no
// longer collides with the result form. This file holds only the manual
// clinical-result write path: addResult / updateResult / deleteResult.
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";

import { revalidateRoute } from "@/lib/revalidate";
import { db, writeTx } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import { isRealIsoDate } from "@/lib/date";
import {
  MEDICAL_CATEGORIES,
  RESULTS_CATALOG_CATEGORIES,
  MEDICAL_FLAGS,
} from "@/lib/medical-categories";
import {
  reconcileFlags,
  cleanupOrphanBiomarkerKeyedState,
  migrateRenamedBiomarker,
} from "@/lib/queries";
import { resolveProviderOnEdit } from "@/lib/providers-db";
import {
  normalizeResultStatus,
  parseFasting,
  sanitizeSpecimen,
} from "@/lib/lab-result-lifecycle";
import { formError, formOk, type FormResult } from "@/lib/types";

// Revalidate the import document pages plus the reading surfaces after an
// observation mutation, so edits made on /import/[id] also reflect in the
// readings browser and detail pages, and vice versa.
function revalidateResults() {
  revalidateRoute("/data");
  revalidateRoute("/import/[id]", "page");
  revalidateRoute("/results");
  revalidateRoute("/results/readings");
  revalidateRoute("/results/readings/view", "page");
  revalidateRoute("/records");
  // The dashboard derives Recent labs and Needs attention from these records, so
  // a new/edited/deleted reading must refresh its summaries too.
  revalidateRoute("/");
}

// Light sanitation for a user-entered canonical name: trim, collapse internal
// whitespace, and cap length. Intentionally not hard-validated — legitimate
// biomarker names are diverse. Returns null when blank.
function sanitizeCanonical(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return v || null;
}

export async function addResult(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  // Validate the category server-side, exactly as updateResult does — an absent
  // field (String(null) === "null") or a crafted/stale POST would otherwise flow
  // straight into the CHECK (category IN (...)) and 500 (#385, the #323 class:
  // a state writable in TS but forbidden by the CHECK). The add form only offers
  // RESULTS_CATALOG_CATEGORIES (no 'prescription' — meds live on the document view /
  // Supplements & Meds), so enforce that same set here and fall back to 'lab',
  // closing the client-only prescription gate the page's option list can't.
  const categoryRaw = String(formData.get("category") ?? "");
  const category = (RESULTS_CATALOG_CATEGORIES as readonly string[]).includes(
    categoryRaw
  )
    ? categoryRaw
    : "lab";
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date)) return formError("Enter a valid date.");
  if (!name) return formError("Enter a name.");
  const value = (formData.get("value") as string)?.trim() || null;
  // Derive value_num from a purely-numeric value so manual readings chart.
  const valueNum =
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  // Default the canonical name to the observation's own name (its own group until
  // backfilled or edited). Manual entry never writes to canonical_biomarkers.
  const canonical =
    sanitizeCanonical(formData.get("canonical_name") as string) ?? name;
  // Insert the observation and reconcile its flag in one transaction, so a throw in
  // reconcileFlags can't leave a half-written result (matches persistDocumentImport).
  writeTx(() => {
    const info = db
      .prepare(
        `INSERT INTO medical_records
           (date, category, name, value, value_num, unit, reference_range, notes, canonical_name, profile_id,
            result_status, fasting, specimen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        date,
        category,
        name,
        value,
        valueNum,
        (formData.get("unit") as string)?.trim() || null,
        (formData.get("reference_range") as string)?.trim() || null,
        (formData.get("notes") as string)?.trim() || null,
        canonical,
        profile.id,
        // Collection attributes (#1404). Validated server-side through the SAME pure
        // helpers the importer uses: an unknown status word or fasting value becomes
        // NULL ("unstated") rather than reaching the column's CHECK and 500ing (the
        // #385/#323 class — a state writable in TS but forbidden by the CHECK).
        normalizeResultStatus(formData.get("result_status") as string | null),
        parseFasting(formData.get("fasting")),
        sanitizeSpecimen(formData.get("specimen") as string | null)
      );
    // Auto-flag the new reading non-optimal if it falls outside the optimal band.
    reconcileFlags(profile.id, [Number(info.lastInsertRowid)]);
  });
  revalidateResults();
  return formOk();
}

// Edit a single extracted/manual observation (used on the document subpage + the
// Readings table). Multi-view (#1331): gate + target the ROW's own profile via
// gateItemProfile — the Readings table posts each row's profile_id, so an edit on
// a non-acting member's reading writes to that member (bouncing a read-only /
// ungranted grant). With no profile_id (single view / the document subpage form) it
// falls back to the acting-profile requireWriteAccess gate — byte-identical.
export async function updateResult(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that result.");
  const date = String(formData.get("date") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  // Reject a non-ISO / impossible date so it can't land in a YYYY-MM-DD column.
  if (!isRealIsoDate(date)) return formError("Enter a valid date.");
  if (!name) return formError("Enter a name.");

  const str = (k: string) => {
    const v = (formData.get(k) as string | null)?.trim();
    return v ? v : null;
  };
  const categoryRaw = String(formData.get("category") ?? "");
  const category = (MEDICAL_CATEGORIES as readonly string[]).includes(
    categoryRaw
  )
    ? categoryRaw
    : "lab";
  const flagRaw = str("flag");
  const flag =
    flagRaw && (MEDICAL_FLAGS as readonly string[]).includes(flagRaw)
      ? flagRaw
      : null;
  const value = str("value");
  // Keep value_num in sync so charts/aggregates stay correct.
  const valueNum =
    value !== null && value !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  // Canonical name: sanitized, defaulting to the observation's name when blank so a
  // cleared field re-groups the observation under itself (editable + reversible).
  const canonical = sanitizeCanonical(str("canonical_name")) ?? name;
  // Performing provider: keep the loaded link unless the field was actually changed
  // (#601), so editing an unrelated field can't relink an ambiguous name; a genuine
  // change re-resolves into the shared GLOBAL registry (create-on-type), NULL when blank.
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? "")
  );
  // The ORDERING clinician (#1404) — a separate link from the performing lab above,
  // resolved the same unchanged-field-preserving way (#601). Individual-typed: the
  // orderer is a person, where the performer is usually the lab organization.
  const orderingProviderId = resolveProviderOnEdit(
    Number(formData.get("ordering_provider_id")) || null,
    String(formData.get("ordering_provider_loaded") ?? ""),
    String(formData.get("ordering_provider") ?? ""),
    "individual"
  );

  // Read the reading's PRIOR canonical grouping before overwriting it, so a
  // canonical rename can carry its star + retest dismissal to the new name rather
  // than orphaning them under the old (issue #203). The effective group name
  // mirrors the retest nudge / star derivation: canonical_name, falling back to
  // the raw name.
  const prev = db
    .prepare(
      "SELECT canonical_name, name FROM medical_records WHERE id = ? AND profile_id = ?"
    )
    .get(id, profileId) as
    { canonical_name: string | null; name: string } | undefined;
  const oldCanonical = prev ? prev.canonical_name?.trim() || prev.name : null;

  db.prepare(
    `UPDATE medical_records
       SET date = ?, category = ?, name = ?, value = ?, value_num = ?, unit = ?,
           reference_range = ?, flag = ?, panel = ?, notes = ?, canonical_name = ?,
           provider_id = ?, ordering_provider_id = ?,
           result_status = ?, fasting = ?, specimen = ?,
           -- THE record editor's #133 lock, armed unconditionally (#2364). It used
           -- to read CASE WHEN external_id IS NOT NULL, which locked an
           -- integration row against the next rolling window and did NOTHING for a
           -- document-extracted one — and external_id is NULL for every AI-extracted
           -- row by construction, i.e. for the majority of readings in the app. So
           -- this, the main path by which a person corrects an extracted lab, could
           -- not set the lock at all, while the likeliest overwrite of that reading
           -- is the document's own reprocess. The question is "did a human change a
           -- value this app derived", not "which import path produced it".
           edited = 1
     WHERE id = ? AND profile_id = ?`
  ).run(
    date,
    category,
    name,
    value,
    valueNum,
    str("unit"),
    str("reference_range"),
    flag,
    str("panel"),
    str("notes"),
    canonical,
    providerId,
    orderingProviderId,
    // Same server-side normalization as addResult: unknown values land as NULL
    // ("unstated"), never in a column the CHECK would reject.
    normalizeResultStatus(str("result_status")),
    parseFasting(formData.get("fasting")),
    sanitizeSpecimen(str("specimen")),
    id,
    profileId
  );
  // Re-derive the non-optimal flag for this row (the editor sets only clinical
  // flags; non-optimal follows the value vs the canonical optimal band).
  reconcileFlags(profileId, [id]);
  // A canonical rename re-keys this reading's group: migrate any star + retest
  // dismissal to the new name (the delete path already sweeps stars — the edit
  // path didn't), then sweep whatever the rename orphaned (a name-collision under
  // the new name leaves the old row for the sweep to drop). Guarded on an actual
  // name change so a plain value/date edit stays a no-op.
  if (oldCanonical && oldCanonical.toLowerCase() !== canonical.toLowerCase()) {
    migrateRenamedBiomarker(profileId, oldCanonical, canonical);
    cleanupOrphanBiomarkerKeyedState(profileId);
  }
  revalidateResults();
  return formOk();
}

export async function deleteResult(
  formData: FormData
): Promise<{ undoId: number | null }> {
  // Multi-view (#1331): the Readings table posts the row's profile_id, so a delete
  // on a non-acting member's reading targets that member (gateItemProfile bounces a
  // read-only / ungranted grant); no profile_id falls back to the acting-profile gate.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Capture into the undo holding table and delete in one transaction (issue #30)
  // so the observation can be restored from the toast.
  // Compatibility: `biomarker-record` is a persisted undo payload kind, not the
  // public model name. Changing it would strand pending undo entries.
  const undoId = captureDelete("biomarker-record", profileId, id);
  // Deleting the last reading for a starred biomarker would leave the star
  // pointing at nothing (an empty pinned tile), and its `biomarker:<name>` retest
  // snooze pointing at a gone reading — sweep BOTH name-keyed side-stores so
  // re-adding that marker later re-nudges/re-pins instead of being silenced by a
  // stale row (issues #203/#327).
  // NOTE (consciously scoped out of undo): a star/dismissal orphan-cleaned here is
  // NOT re-created on Undo — the reading returns but the pinned-tile star stays gone.
  cleanupOrphanBiomarkerKeyedState(profileId);
  revalidateResults();
  return { undoId };
}
