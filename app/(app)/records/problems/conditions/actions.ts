"use server";
import { requireWriteAccess } from "@/lib/auth";
import { gateItemProfile } from "@/app/(app)/gate-item";
import { revalidatePath } from "next/cache";
import { db, writeTx } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import type { ConditionStatus } from "@/lib/types";
import { addSuggestedConditionCore } from "@/lib/condition-suggestion-write";
import {
  toConditionLaterality,
  toConditionSeverity,
  toConditionStage,
} from "@/lib/condition-attributes";

// Condition / problem-list writes. Session-scoped; every mutation is
// `WHERE id = ? AND profile_id = ?`. Manual rows carry a NULL source/document_id.

function revalidateConditions() {
  revalidatePath("/records");
  revalidatePath("/profile");
  revalidatePath("/");
}

function statusOf(raw: unknown): ConditionStatus {
  const v = String(raw ?? "").trim();
  return v === "inactive" || v === "resolved" ? v : "active";
}

function dateOrNull(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return isRealIsoDate(v) ? v : null;
}

export async function addCondition(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Enter the condition name.");
  const code = String(formData.get("code") ?? "").trim() || null;
  const codeSystem = String(formData.get("code_system") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onset = dateOrNull(formData.get("onset_date"));
  const resolved =
    status === "resolved" ? dateOrNull(formData.get("resolved_date")) : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Side / grade / stage (#1403). Coerced through the shared pure normalizers, so a
  // posted value outside the CHECK sets lands as NULL (unstated) rather than failing
  // the insert; `stage` is free text by design.
  const laterality = toConditionLaterality(formData.get("laterality"));
  const severity = toConditionSeverity(formData.get("severity"));
  const stage = toConditionStage(formData.get("stage"));
  // created_at from the CLOCK SEAM (sqlNow, #1534): with no explicit date this
  // stamp IS the record's Timeline day (`substr(created_at, 1, 10)` /
  // dateFromCreatedAt), compared against `today()`-derived bounds.
  db.prepare(
    `INSERT INTO conditions
       (name, code, code_system, status, laterality, severity, stage,
        onset_date, resolved_date, notes, source, profile_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)`
  ).run(
    name,
    code,
    codeSystem,
    status,
    laterality,
    severity,
    stage,
    onset,
    resolved,
    notes,
    profile.id,
    sqlNow()
  );
  revalidateConditions();
  return formOk();
}

export async function updateCondition(formData: FormData): Promise<FormResult> {
  // Multi-view (#1328): gate + target the ROW's own profile (gateItemProfile), so an
  // edit on a non-acting member's row lands on that member; single-view falls back to
  // the acting profile.
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!id) return formError("Couldn't find that condition.");
  if (!name) return formError("Enter the condition name.");
  const code = String(formData.get("code") ?? "").trim() || null;
  const codeSystem = String(formData.get("code_system") ?? "").trim() || null;
  const status = statusOf(formData.get("status"));
  const onset = dateOrNull(formData.get("onset_date"));
  const resolved =
    status === "resolved" ? dateOrNull(formData.get("resolved_date")) : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const laterality = toConditionLaterality(formData.get("laterality"));
  const severity = toConditionSeverity(formData.get("severity"));
  const stage = toConditionStage(formData.get("stage"));
  // `edited = 1` is the #133 user-edit lock, extended to conditions by #2137
  // (migration 161): a hand-save through this form is a manual correction, and for
  // an episode-promoted row (source = 'episode') it must WIN over the derivation —
  // syncPromotedCondition consults the flag through isEditLocked and holds out
  // entirely on the next episode transition instead of silently reverting the
  // correction. Stamped on every manual save (the substrate's "hand-edited in the
  // app" meaning); on a manual or imported row the flag simply records that, since
  // no sync rewrites those values today.
  db.prepare(
    `UPDATE conditions
       SET name = ?, code = ?, code_system = ?, status = ?,
           laterality = ?, severity = ?, stage = ?,
           onset_date = ?, resolved_date = ?, notes = ?, edited = 1
     WHERE id = ? AND profile_id = ?`
  ).run(
    name,
    code,
    codeSystem,
    status,
    laterality,
    severity,
    stage,
    onset,
    resolved,
    notes,
    id,
    profileId
  );
  revalidateConditions();
  return formOk();
}

// Confirm a condition SUGGESTION (issue #685) into a problem-list Condition. The
// suggest-only bridge (#560): the Upcoming/hero review item posts the suggested
// name/code here on an explicit user confirm — the app never silently inserts. The
// write core is idempotent (external_id keyed), so a double-tap is a no-op. Once
// added, the concept collapses onto the new condition and the suggestion self-clears.
export async function confirmConditionSuggestion(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return formError("Couldn't read that suggestion.");
  const code = String(formData.get("code") ?? "").trim() || null;
  const outcome = addSuggestedConditionCore(profile.id, { name, code });
  if (outcome.kind === "invalid")
    return formError("Couldn't add the condition.");
  revalidateConditions();
  revalidatePath("/upcoming");
  return formOk();
}

export async function deleteCondition(formData: FormData): Promise<FormResult> {
  const profileId = await gateItemProfile(formData);
  const id = Number(formData.get("id"));
  if (!id) return formError("Couldn't find that condition.");
  writeTx(() => {
    // A medication may link this condition as its indication (#1052) — a REFERENCES
    // FK with no ON DELETE. NULL that back-link FIRST so the delete can't trip the
    // FK (the row-ops convention: deleting the condition NULLs the med's "For:" link).
    db.prepare(
      `UPDATE intake_items SET indication_condition_id = NULL
        WHERE indication_condition_id = ? AND profile_id = ?`
    ).run(id, profileId);
    db.prepare("DELETE FROM conditions WHERE id = ? AND profile_id = ?").run(
      id,
      profileId
    );
  });
  revalidateConditions();
  return formOk();
}
