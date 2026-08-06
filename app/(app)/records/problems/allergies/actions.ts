"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { isRealIsoDate } from "@/lib/date";
import { setAllergyReactions } from "@/lib/allergy-write";
import { normalizeAllergenSubstance } from "@/lib/allergen-vocabulary";
import { encounterIdForProfile } from "@/lib/queries";
import { captureDelete } from "@/lib/undo-delete-db";
import {
  resolveProviderIdByName,
  resolveProviderOnEdit,
} from "@/lib/providers-db";
import {
  ALLERGY_CRITICALITIES,
  ALLERGY_VERIFICATION_STATUSES,
  formError,
  formOk,
  type AllergyCriticality,
  type AllergyStatus,
  type AllergyVerificationStatus,
  type FormResult,
} from "@/lib/types";

// Allergy writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?`. Manual rows carry a NULL source/document_id
// so the per-document import delete-set never touches them.

function revalidateAllergies() {
  revalidatePath("/records");
  revalidatePath("/profile");
  revalidatePath("/");
}

function statusOf(raw: unknown): AllergyStatus {
  const v = String(raw ?? "").trim();
  return v === "inactive" || v === "resolved" ? v : "active";
}

// Safety vocabularies (#1405), both CHECK-pinned in the schema. An unrecognized or
// blank value lands as NULL — "unstated" is a real answer, and a value the CHECK
// forbids must never reach it (#385/#323).
function criticalityOf(raw: unknown): AllergyCriticality | null {
  const v = String(raw ?? "").trim();
  return (ALLERGY_CRITICALITIES as readonly string[]).includes(v)
    ? (v as AllergyCriticality)
    : null;
}

function verificationOf(raw: unknown): AllergyVerificationStatus | null {
  const v = String(raw ?? "").trim();
  return (ALLERGY_VERIFICATION_STATUSES as readonly string[]).includes(v)
    ? (v as AllergyVerificationStatus)
    : null;
}

// The posted manifestation list: parallel `reaction_manifestation[]` /
// `reaction_severity[]` fields from the form's repeatable rows. Returns null when the
// form posted no manifestation fields at all (an older/partial POST), which the
// callers treat as "don't touch the reaction list" rather than "clear it".
function postedReactions(
  formData: FormData
): { manifestation: string; severity: string | null }[] | null {
  if (!formData.has("reaction_manifestation")) return null;
  const names = formData.getAll("reaction_manifestation").map(String);
  const severities = formData.getAll("reaction_severity").map(String);
  return names.map((manifestation, i) => ({
    manifestation,
    severity: severities[i] ?? null,
  }));
}

export async function addAllergy(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  // Canonicalize a RECOGNIZED allergen spelling on write (#1676): the drug-allergy
  // cross-check and the cross-reactivity matcher both key on this string, so storing
  // "soy" rather than the vocabulary's "Soybean" silently costs the profile a check.
  // An unrecognized substance is stored exactly as typed — the field is free text.
  const substance = normalizeAllergenSubstance(
    String(formData.get("substance") ?? "")
  );
  if (!substance) return formError("Enter the substance you're allergic to.");
  const reactions = postedReactions(formData);
  // The parent's reaction/severity are the CACHED first manifestation (see
  // lib/allergy-reactions); when the form posts a list, row 0 seeds them and
  // setAllergyReactions below writes the full list.
  const first = reactions?.find((r) => r.manifestation.trim());
  const reaction =
    (first
      ? first.manifestation
      : String(formData.get("reaction") ?? "")
    ).trim() || null;
  const severity =
    (first
      ? (first.severity ?? "")
      : String(formData.get("severity") ?? "")
    ).trim() || null;
  const status = statusOf(formData.get("status"));
  const criticality = criticalityOf(formData.get("criticality"));
  const verification = verificationOf(formData.get("verification_status"));
  const onsetRaw = String(formData.get("onset_date") ?? "").trim();
  const onset = isRealIsoDate(onsetRaw) ? onsetRaw : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Attribution (#1526): the clinician who documented it, resolved through the shared
  // GLOBAL registry via a create-on-type name, and the visit it was recorded at —
  // validated against THIS profile, so a blank or forged id stores as "no link".
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? ""),
    "individual"
  );
  const encounterId = encounterIdForProfile(
    profile.id,
    formData.get("encounter_id")
  );
  // created_at from the CLOCK SEAM (sqlNow, #1534): with no explicit date this
  // stamp IS the record's Timeline day (`substr(created_at, 1, 10)` /
  // dateFromCreatedAt), compared against `today()`-derived bounds.
  const info = db
    .prepare(
      `INSERT INTO allergies
       (substance, reaction, severity, status, criticality, verification_status,
        onset_date, notes, provider_id, encounter_id, source, profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`
    )
    .run(
      substance,
      reaction,
      severity,
      status,
      criticality,
      verification,
      onset,
      notes,
      providerId,
      encounterId,
      profile.id,
      sqlNow()
    );
  if (reactions)
    setAllergyReactions(profile.id, Number(info.lastInsertRowid), reactions);
  revalidateAllergies();
  return formOk();
}

export async function updateAllergy(formData: FormData): Promise<FormResult> {
  // Multi-view (#1328): gate + target the ROW's own profile; single-view falls back
  // to the acting profile.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const substance = normalizeAllergenSubstance(
    String(formData.get("substance") ?? "")
  );
  if (!id) return formError("Couldn't find that allergy.");
  if (!substance) return formError("Enter the substance you're allergic to.");
  const reactions = postedReactions(formData);
  const first = reactions?.find((r) => r.manifestation.trim());
  const reaction =
    (first
      ? first.manifestation
      : String(formData.get("reaction") ?? "")
    ).trim() || null;
  const severity =
    (first
      ? (first.severity ?? "")
      : String(formData.get("severity") ?? "")
    ).trim() || null;
  const status = statusOf(formData.get("status"));
  const criticality = criticalityOf(formData.get("criticality"));
  const verification = verificationOf(formData.get("verification_status"));
  const onsetRaw = String(formData.get("onset_date") ?? "").trim();
  const onset = isRealIsoDate(onsetRaw) ? onsetRaw : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Attribution (#1526). The provider resolves against what the form LOADED, so an
  // untouched name never re-resolves (and never coins a duplicate registry row); the
  // visit id is validated against the ROW's profile, so an edit on a member's allergy
  // can only link that member's visits.
  const providerId = resolveProviderOnEdit(
    Number(formData.get("provider_id")) || null,
    String(formData.get("provider_loaded") ?? ""),
    String(formData.get("provider") ?? ""),
    "individual"
  );
  const encounterId = encounterIdForProfile(
    profileId,
    formData.get("encounter_id")
  );
  const info = db
    .prepare(
      `UPDATE allergies
       SET substance = ?, reaction = ?, severity = ?, status = ?,
           criticality = ?, verification_status = ?,
           onset_date = ?, notes = ?, provider_id = ?, encounter_id = ?
     WHERE id = ? AND profile_id = ?`
    )
    .run(
      substance,
      reaction,
      severity,
      status,
      criticality,
      verification,
      onset,
      notes,
      providerId,
      encounterId,
      id,
      profileId
    );
  // Typed refusal, not a silent no-op: an id that isn't this profile's allergy
  // matched no row, and the caller must not be told the edit landed.
  if (info.changes === 0) return formError("Couldn't find that allergy.");
  if (reactions) setAllergyReactions(profileId, id, reactions);
  revalidateAllergies();
  return formOk();
}

// Undoable since #1847 — the highest-value delete in the passport. An allergy GATES
// the drug-safety matcher and prints on the emergency card, so a mis-tap here removed
// a safety interlock permanently; the delete now captures the row AND its
// `allergy_reactions` cascade and answers in the useUndoableDelete contract
// ({ undoId, error? }), so the surface offers the standard Undo toast and Data → Trash
// keeps it restorable for the whole retention window.
export async function deleteAllergy(
  formData: FormData
): Promise<{ undoId: number | null; error?: string }> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null, error: "Couldn't find that allergy." };
  const undoId = captureDelete("allergy", profileId, id);
  // Typed refusal, not a silent no-op: an id that isn't this profile's allergy
  // captured nothing, and the caller must not be told the delete landed.
  if (undoId == null)
    return { undoId: null, error: "Couldn't find that allergy." };
  revalidateAllergies();
  return { undoId };
}
