"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import {
  normalizeVaccineName,
  slugifyVaccine,
} from "@/lib/immunization-catalog";
import { sweepImmunizationDismissals } from "@/lib/queries";
import { resolveProviderIdByName } from "@/lib/providers-db";

// Immunization writes. Mirrors app/(app)/trends/body-actions.ts: session-scoped,
// every mutation is `WHERE id = ? AND profile_id = ?`, and the user-entered
// vaccine name is normalized to a catalog/combo code on write (slug fallback
// for an unrecognized name — never dropped), the same path the extractor uses.

function revalidateImmunizations() {
  revalidatePath("/immunizations");
  // Every per-vaccine detail page too: a dose (esp. a combination shot) credits
  // multiple vaccines, and edit/delete now runs from the detail view, so the
  // list-only revalidate above wouldn't refresh the page the user is on.
  revalidatePath("/immunizations/[vaccine]", "page");
  revalidatePath("/");
}

function codeFor(raw: string): string {
  return normalizeVaccineName(raw) ?? slugifyVaccine(raw);
}

export async function addImmunization(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  const vaccineRaw = String(formData.get("vaccine") ?? "").trim();
  if (!isRealIsoDate(date) || !vaccineRaw) return;
  const doseLabel = String(formData.get("dose_label") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Administering provider: resolve the typed name into the shared
  // GLOBAL registry (create-on-type), or NULL when left blank.
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  db.prepare(
    `INSERT INTO immunizations (date, vaccine, dose_label, notes, source, provider_id, profile_id)
     VALUES (?,?,?,?,?,?,?)`
  ).run(
    date,
    codeFor(vaccineRaw),
    doseLabel,
    notes,
    null,
    providerId,
    profile.id
  );
  revalidateImmunizations();
}

export async function updateImmunization(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  const date = String(formData.get("date") ?? "").trim();
  const vaccineRaw = String(formData.get("vaccine") ?? "").trim();
  if (!id || !isRealIsoDate(date) || !vaccineRaw) return;
  const doseLabel = String(formData.get("dose_label") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const providerId = resolveProviderIdByName(
    String(formData.get("provider") ?? "")
  );
  // Read the prior code before rewriting it: re-coding a dose un-backs the old
  // code exactly as a delete would, so a stale `immunization:<old code>` dismissal
  // would otherwise silence the due-nudge forever after the old vaccine is re-added
  // (issue #376/#203). Captured before the UPDATE so the row still holds the old code.
  const prev = db
    .prepare(
      "SELECT vaccine FROM immunizations WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as { vaccine: string } | undefined;
  db.prepare(
    `UPDATE immunizations SET date = ?, vaccine = ?, dose_label = ?, notes = ?, provider_id = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    date,
    codeFor(vaccineRaw),
    doseLabel,
    notes,
    providerId,
    id,
    profile.id
  );
  // Clear the dismissals of any component code the re-code left un-backed. The
  // sweep reads the post-update remaining doses, so an unchanged code (or one still
  // credited by a sibling dose) is a no-op.
  if (prev) sweepImmunizationDismissals(profile.id, [prev.vaccine]);
  revalidateImmunizations();
}

export async function deleteImmunization(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  // Read the dose's vaccine before deleting so we can tell which component codes
  // it credited (a combo dose credits several).
  const row = db
    .prepare(
      "SELECT vaccine FROM immunizations WHERE id = ? AND profile_id = ?"
    )
    .get(id, profile.id) as { vaccine: string } | undefined;
  db.prepare("DELETE FROM immunizations WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  // If this was the last dose backing a vaccine code, clear that code's due-nudge
  // dismissal — the key is the reusable vaccine code, so a stale row would silence
  // the nudge again after the immunization is re-added later (issue #203). The sweep
  // is scoped to the codes this dose actually un-backed, so a never-recorded
  // vaccine's dismissal (no backing dose ever) is left intact.
  if (row) sweepImmunizationDismissals(profile.id, [row.vaccine]);
  revalidateImmunizations();
}

// ---- Per-vaccine status overrides ----
// Set from the per-vaccine detail view, active profile only. `immune` counts the
// series complete despite missing doses; `declined` drops it from
// needs-attention. Upsert on (profile_id, vaccine) so re-setting flips the kind.

export async function setImmunizationOverride(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const vaccine = String(formData.get("vaccine") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  if (!vaccine || (kind !== "immune" && kind !== "declined")) return;
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  db.prepare(
    `INSERT INTO immunization_overrides (profile_id, vaccine, kind, reason, note)
     VALUES (?,?,?,?,?)
     ON CONFLICT(profile_id, vaccine) DO UPDATE SET
       kind = excluded.kind,
       reason = excluded.reason,
       note = excluded.note,
       created_at = datetime('now')`
  ).run(profile.id, vaccine, kind, reason, note);
  revalidateImmunizations();
  revalidatePath(`/immunizations/${vaccine}`);
}

export async function clearImmunizationOverride(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const vaccine = String(formData.get("vaccine") ?? "").trim();
  if (!vaccine) return;
  db.prepare(
    "DELETE FROM immunization_overrides WHERE profile_id = ? AND vaccine = ?"
  ).run(profile.id, vaccine);
  revalidateImmunizations();
  revalidatePath(`/immunizations/${vaccine}`);
}
