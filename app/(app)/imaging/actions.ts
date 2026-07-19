"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  normalizeModality,
  normalizeLaterality,
  normalizeContrast,
  parseDoseMsv,
} from "@/lib/imaging-study";
import { today } from "@/lib/db";
import {
  trackImagingFollowUpCore,
  unlinkFollowUpsForImagingStudy,
} from "@/lib/followup-write";

// Imaging-study writes (#702). Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions/procedures), so the
// per-document import delete-set never touches them; editing an imported row leaves
// its provenance columns intact. modality / laterality / contrast are normalized
// onto the DB CHECK sets through the ONE shared coercion in lib/imaging-study (the
// same one the import path uses), so a form value that isn't a valid enum can never
// trip the CHECK — it degrades to the safe default ('other' / null / non-contrast).
//
// Provider links (ordering/reading) are captured structurally but not populated
// from this manual form yet — they exist for the #701 contrast-safety consumer and
// the #708 FHIR feed. The `indication` is stored but NOT gated on: any imaging still
// satisfies its screening exactly as before (the procedure-inference path is
// untouched); the screening-vs-diagnostic decision is deferred to the owner (#703).

function revalidateImaging() {
  revalidatePath("/imaging");
  revalidatePath("/timeline");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addImagingStudy(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  // A manual row carries a NULL document_id / external_id (omitted here so they
  // default NULL) so the per-document import delete-set never touches it — the same
  // shape as a manual procedure/condition.
  db.prepare(
    `INSERT INTO imaging_studies
       (modality, body_region, laterality, contrast, contrast_agent, study_date,
        dose_msv, impression, indication, status, notes, source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    normalizeModality(formData.get("modality")),
    str(formData, "body_region"),
    normalizeLaterality(formData.get("laterality")),
    normalizeContrast(formData.get("contrast")) ? 1 : 0,
    str(formData, "contrast_agent"),
    dateOrNull(formData.get("study_date")),
    parseDoseMsv(formData.get("dose_msv")),
    str(formData, "impression"),
    str(formData, "indication"),
    str(formData, "status"),
    str(formData, "notes"),
    profile.id
  );
  revalidateImaging();
  return formOk();
}

export async function updateImagingStudy(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that study.");
  db.prepare(
    `UPDATE imaging_studies
       SET modality = ?, body_region = ?, laterality = ?, contrast = ?,
           contrast_agent = ?, study_date = ?, dose_msv = ?, impression = ?,
           indication = ?, status = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    normalizeModality(formData.get("modality")),
    str(formData, "body_region"),
    normalizeLaterality(formData.get("laterality")),
    normalizeContrast(formData.get("contrast")) ? 1 : 0,
    str(formData, "contrast_agent"),
    dateOrNull(formData.get("study_date")),
    parseDoseMsv(formData.get("dose_msv")),
    str(formData, "impression"),
    str(formData, "indication"),
    str(formData, "status"),
    str(formData, "notes"),
    id,
    profile.id
  );
  revalidateImaging();
  return formOk();
}

export async function deleteImagingStudy(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that study.");
  // Row-ops side-state (#199-#203, #700): a follow-up may link this study as its
  // SOURCE finding, or a resolution may cite it as the resolving record — both carry
  // a REFERENCES FK with no ON DELETE. NULL those links FIRST (degrading a follow-up
  // to a generic care-plan item, keeping a resolution's outcome text) so the delete
  // can't trip the care_plan_items FK.
  unlinkFollowUpsForImagingStudy(profile.id, id);
  db.prepare("DELETE FROM imaging_studies WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidateImaging();
  return formOk();
}

// Track a follow-up for an imaging study (#700): creates a linked, OPEN care-plan
// item whose planned_date is the study date + the chosen interval, so an incidental
// finding ("6 mm nodule, recommend follow-up CT in 12 months") becomes a tracked,
// legible, resolvable follow-up on Upcoming instead of falling through the cracks.
// The write core is idempotent per source study (a second click returns the existing
// one). Interval is a whole number of days (the form offers 3/6/12-month presets).
export async function trackImagingFollowUp(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const studyId = Number(formData.get("study_id"));
  const intervalDays = Number(formData.get("interval_days"));
  if (!studyId) return formError("Couldn't find that study.");
  if (!Number.isFinite(intervalDays) || intervalDays <= 0)
    return formError("Choose a follow-up interval.");
  const res = trackImagingFollowUpCore(
    profile.id,
    studyId,
    intervalDays,
    today(profile.id)
  );
  if (res.kind === "invalid") return formError("Couldn't find that study.");
  revalidateImaging();
  revalidatePath("/upcoming");
  revalidatePath("/care-plan");
  return formOk();
}
