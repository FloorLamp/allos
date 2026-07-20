"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { captureDelete } from "@/lib/undo-delete-db";
import { getUnitPrefs } from "@/lib/settings";
import { insertBodyMetric } from "@/lib/offline/writes";
import { submittedWeightUnit } from "@/lib/units";

// Body-metrics write path. Moved here from the former standalone /body-metrics
// page when Body Metrics was absorbed into the Trends "Body" tab (sidebar
// consolidation). The insert (canonical-kg conversion, input rejection,
// profile-scoped write) now lives in lib/offline/writes.ts::insertBodyMetric so the
// offline replay route (issue #28) runs the SAME validation; this action just
// resolves the session, converts using the login's unit pref, and revalidates.
function strOrNull(raw: FormDataEntryValue | null): string | null {
  return raw === null ? null : String(raw);
}

export async function addBodyMetric(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const prefs = getUnitPrefs(login.id);
  const wrote = insertBodyMetric(profile.id, {
    date: String(formData.get("date") ?? "").trim(),
    weight: String(formData.get("weight") ?? ""), // in the login's weight unit
    weightUnit: submittedWeightUnit(
      formData.get("weight_unit"),
      prefs.weightUnit
    ),
    bodyFatPct: strOrNull(formData.get("body_fat_pct")),
    restingHr: strOrNull(formData.get("resting_hr")),
    notes: strOrNull(formData.get("notes")),
  });
  // Only revalidate when a row actually landed — a rejected input is a no-op.
  if (!wrote) return;
  revalidatePath("/trends");
  revalidatePath("/");
}

// Note: document-sourced rows (source 'document:<id>') are a projection of
// that document's extraction — reprocessing the document re-creates them.
// Deleting the document removes them permanently.
export async function deleteBodyMetric(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Capture into the undo holding table and delete in one transaction (issue #30)
  // so the entry can be restored from the toast.
  const undoId = captureDelete("body-metric", profile.id, id);
  revalidatePath("/trends");
  revalidatePath("/");
  return { undoId };
}
