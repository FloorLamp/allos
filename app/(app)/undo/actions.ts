"use server";

import { requireWriteAccess } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { restoreDeletedRow } from "@/lib/undo-delete-db";

// Restore a previously-deleted row from its undo token (a deleted_rows id), issued
// by the delete actions and offered as an "Undo" toast (issue #30). Scoped to the
// acting profile: restoreDeletedRow only touches a holding row whose profile_id
// matches, so a token can't be replayed across profiles. Returns ok=false when the
// token is gone (already restored, swept after 24h, or another profile's). The
// restore re-inserts with NEW ids, so a broad layout revalidate refreshes wherever
// the row now belongs.
export async function undoDelete(undoId: number): Promise<{ ok: boolean }> {
  const { profile } = requireWriteAccess();
  if (!Number.isInteger(undoId) || undoId <= 0) return { ok: false };
  const ok = restoreDeletedRow(profile.id, undoId);
  if (ok) revalidatePath("/", "layout");
  return { ok };
}

// Restore a whole batch of deleted rows from their undo tokens — the single
// "Deleted N · Undo" toast a bulk table delete offers (issue #29). Each token is
// restored independently (a token already swept/restored just no-ops), and the
// layout is revalidated once. Returns how many were actually restored.
export async function undoDeletes(
  undoIds: number[]
): Promise<{ restored: number }> {
  const { profile } = requireWriteAccess();
  const ids = (Array.isArray(undoIds) ? undoIds : []).filter(
    (n) => Number.isInteger(n) && n > 0
  );
  let restored = 0;
  for (const id of ids) if (restoreDeletedRow(profile.id, id)) restored += 1;
  if (restored > 0) revalidatePath("/", "layout");
  return { restored };
}
