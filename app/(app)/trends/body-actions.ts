"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { getUnitPrefs } from "@/lib/settings";
import { toKg } from "@/lib/units";

// Body-metrics write path. Moved here from the former standalone /body-metrics
// page when Body Metrics was absorbed into the Trends "Body" tab (sidebar
// consolidation) — the logic (canonical-kg conversion, input rejection,
// profile-scoped writes) is unchanged; only the revalidate target moved to
// /trends, where the data is now surfaced.

// Parse an optional numeric form field: null when absent/blank, and null (not
// NaN) when present but non-numeric — so a garbage value is skipped, never
// persisted as NaN.
function optionalNumber(raw: FormDataEntryValue | null): number | null {
  if (raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function addBodyMetric(formData: FormData) {
  const { login, profile } = requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  const weightRaw = formData.get("weight"); // in user's preferred weight unit
  // Reject a non-ISO date or a missing/non-finite weight rather than writing a
  // bad row (a NaN weight_kg or an impossible date).
  if (
    !isRealIsoDate(date) ||
    weightRaw === null ||
    String(weightRaw).trim() === ""
  )
    return;
  const weight = Number(weightRaw);
  if (!Number.isFinite(weight)) return;
  const prefs = getUnitPrefs(login.id);
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, notes, profile_id)
     VALUES (?,?,?,?,?,?)`
  ).run(
    date,
    toKg(weight, prefs.weightUnit),
    optionalNumber(formData.get("body_fat_pct")),
    optionalNumber(formData.get("resting_hr")),
    (formData.get("notes") as string)?.trim() || null,
    profile.id
  );
  revalidatePath("/trends");
  revalidatePath("/");
}

// Note: document-sourced rows (source 'document:<id>') are a projection of
// that document's extraction — reprocessing the document re-creates them.
// Deleting the document removes them permanently.
export async function deleteBodyMetric(formData: FormData) {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  db.prepare("DELETE FROM body_metrics WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  revalidatePath("/trends");
  revalidatePath("/");
}
