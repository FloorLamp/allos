"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { formError, formOk, type FormResult } from "@/lib/types";
import { toFamilyLineage, toFamilyRelationType } from "@/lib/family-relation";

// Family-history writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?` and the INSERT carries profile_id. Manual rows
// carry a NULL source/document_id/external_id (like conditions), so the per-document
// import delete-set never touches them.

function revalidateFamilyHistory() {
  revalidatePath("/records");
  revalidatePath("/profile");
  revalidatePath("/");
}

const str = (formData: FormData, key: string): string | null =>
  String(formData.get(key) ?? "").trim() || null;

// A whole-number age in a plausible range, or null.
function ageOrNull(raw: unknown): number | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 130 ? Math.round(n) : null;
}

// A checkbox → 1 when present/"on", else 0.
function boolInt(raw: unknown): number {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "on" || v === "1" || v === "true" ? 1 : 0;
}

// The death facts (#1407), read as ONE decision so the flag and the details can never
// contradict each other: stating an age at death or a cause IS stating the death, so
// `deceased` follows either. The checkbox alone still records a death with no
// details, and nothing here invents an age or a cause the form did not post.
function deathFacts(formData: FormData): {
  deceased: number;
  ageAtDeath: number | null;
  causeOfDeath: string | null;
} {
  const ageAtDeath = ageOrNull(formData.get("age_at_death"));
  const causeOfDeath = str(formData, "cause_of_death");
  const checked = boolInt(formData.get("deceased"));
  return {
    deceased:
      checked === 1 || ageAtDeath != null || causeOfDeath != null ? 1 : 0,
    ageAtDeath,
    causeOfDeath,
  };
}

export async function addFamilyHistory(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const condition = String(formData.get("condition") ?? "").trim();
  if (!condition) return formError("Enter the condition.");
  const death = deathFacts(formData);
  db.prepare(
    `INSERT INTO family_history
       (relation, condition, code, code_system, onset_age, deceased,
        age_at_death, cause_of_death, relation_type, lineage, notes,
        source, profile_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    str(formData, "relation"),
    condition,
    str(formData, "code"),
    str(formData, "code_system"),
    ageOrNull(formData.get("onset_age")),
    death.deceased,
    death.ageAtDeath,
    death.causeOfDeath,
    // Coerced through the shared pure normalizers, so an off-vocabulary post lands
    // as NULL (unstated → hereditary-by-default) rather than failing the CHECK.
    toFamilyRelationType(formData.get("relation_type")),
    toFamilyLineage(formData.get("lineage")),
    str(formData, "notes"),
    profile.id
  );
  revalidateFamilyHistory();
  return formOk();
}

export async function updateFamilyHistory(
  formData: FormData
): Promise<FormResult> {
  // Multi-view (#1328): gate + target the ROW's own profile; single-view falls back
  // to the acting profile.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const condition = String(formData.get("condition") ?? "").trim();
  if (!id) return formError("Couldn't find that entry.");
  if (!condition) return formError("Enter the condition.");
  const death = deathFacts(formData);
  db.prepare(
    `UPDATE family_history
       SET relation = ?, condition = ?, code = ?, code_system = ?,
           onset_age = ?, deceased = ?, age_at_death = ?, cause_of_death = ?,
           relation_type = ?, lineage = ?, notes = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    str(formData, "relation"),
    condition,
    str(formData, "code"),
    str(formData, "code_system"),
    ageOrNull(formData.get("onset_age")),
    death.deceased,
    death.ageAtDeath,
    death.causeOfDeath,
    toFamilyRelationType(formData.get("relation_type")),
    toFamilyLineage(formData.get("lineage")),
    str(formData, "notes"),
    id,
    profileId
  );
  revalidateFamilyHistory();
  return formOk();
}

export async function deleteFamilyHistory(
  formData: FormData
): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that entry.");
  db.prepare("DELETE FROM family_history WHERE id = ? AND profile_id = ?").run(
    id,
    profileId
  );
  revalidateFamilyHistory();
  return formOk();
}
