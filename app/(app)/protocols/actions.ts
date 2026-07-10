"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, today } from "@/lib/db";
import { requireWriteAccess } from "@/lib/auth";
import { getActiveSituations, setActiveSituations } from "@/lib/settings";
import { isRealIsoDate } from "@/lib/date";
import { normalizeOutcomeKeys } from "@/lib/protocol-metrics";
import { getProtocol, situationUsedByOtherProtocol } from "@/lib/queries";

function revalidateProtocols(id?: number) {
  revalidatePath("/protocols");
  if (id) revalidatePath(`/protocols/${id}`);
  revalidatePath("/timeline");
  revalidatePath("/");
}

function str(formData: FormData, key: string): string | null {
  return String(formData.get(key) ?? "").trim() || null;
}

// Add a situation label to the profile's active set (idempotent), reusing the
// existing situations wiring so a started protocol surfaces its situational
// supplements exactly like a manual toggle.
function activateSituation(profileId: number, situation: string) {
  const next = new Set(getActiveSituations(profileId));
  next.add(situation);
  setActiveSituations(profileId, [...next]);
}

// Remove a situation label from the active set UNLESS another still-ongoing
// protocol declares it (row-side-state rule: a protocol's end/delete inverts the
// activation it caused, but must not clobber a situation a sibling protocol needs).
function deactivateSituation(
  profileId: number,
  situation: string,
  exceptProtocolId: number
) {
  if (situationUsedByOtherProtocol(profileId, situation, exceptProtocolId))
    return;
  const next = new Set(getActiveSituations(profileId));
  if (next.delete(situation)) setActiveSituations(profileId, [...next]);
}

export async function createProtocol(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const startRaw = str(formData, "start_date");
  const start =
    startRaw && isRealIsoDate(startRaw) ? startRaw : today(profile.id);
  const endRaw = str(formData, "end_date");
  const end = endRaw && isRealIsoDate(endRaw) ? endRaw : null;
  const notes = str(formData, "notes");
  const situation = str(formData, "situation");
  const outcomeKeys = normalizeOutcomeKeys(
    formData.getAll("outcome_keys").map((v) => String(v))
  );

  const info = db
    .prepare(
      `INSERT INTO protocols
        (profile_id, name, start_date, end_date, notes, outcome_keys, situation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      profile.id,
      name,
      start,
      end,
      notes,
      JSON.stringify(outcomeKeys),
      situation
    );

  // Starting an ongoing protocol activates its situation (if any).
  if (situation && !end) activateSituation(profile.id, situation);

  revalidateProtocols();
  redirect(`/protocols/${info.lastInsertRowid}`);
}

export async function updateProtocol(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const existing = getProtocol(profile.id, id);
  if (!existing) return;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const startRaw = str(formData, "start_date");
  const start =
    startRaw && isRealIsoDate(startRaw) ? startRaw : existing.start_date;
  const endRaw = str(formData, "end_date");
  const end = endRaw && isRealIsoDate(endRaw) ? endRaw : null;
  const notes = str(formData, "notes");
  const situation = str(formData, "situation");
  const outcomeKeys = normalizeOutcomeKeys(
    formData.getAll("outcome_keys").map((v) => String(v))
  );

  db.prepare(
    `UPDATE protocols
       SET name = ?, start_date = ?, end_date = ?, notes = ?,
           outcome_keys = ?, situation = ?
     WHERE id = ? AND profile_id = ?`
  ).run(
    name,
    start,
    end,
    notes,
    JSON.stringify(outcomeKeys),
    situation,
    id,
    profile.id
  );

  // Reconcile the situation activation with the edit: a removed/renamed situation
  // on an ongoing protocol is deactivated (unless a sibling needs it); a newly-set
  // situation on an ongoing protocol is activated.
  const wasOngoing = existing.end_date == null;
  if (existing.situation && existing.situation !== situation && wasOngoing) {
    deactivateSituation(profile.id, existing.situation, id);
  }
  if (situation && end == null) activateSituation(profile.id, situation);

  revalidateProtocols(id);
}

export async function endProtocol(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const existing = getProtocol(profile.id, id);
  if (!existing || existing.end_date != null) return;
  const end = today(profile.id);
  db.prepare(
    "UPDATE protocols SET end_date = ? WHERE id = ? AND profile_id = ?"
  ).run(end, id, profile.id);
  // Ending the protocol inverts its situation activation.
  if (existing.situation)
    deactivateSituation(profile.id, existing.situation, id);
  revalidateProtocols(id);
}

export async function deleteProtocol(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return;
  const existing = getProtocol(profile.id, id);
  if (!existing) return;
  db.prepare("DELETE FROM protocols WHERE id = ? AND profile_id = ?").run(
    id,
    profile.id
  );
  // Delete carries its side-state: an ongoing protocol's situation activation is
  // reversed (unless a sibling protocol still needs it).
  if (existing.situation && existing.end_date == null)
    deactivateSituation(profile.id, existing.situation, id);
  revalidateProtocols();
  redirect("/protocols");
}
