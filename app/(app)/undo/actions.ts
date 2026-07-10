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
  const { profile } = await requireWriteAccess();
  if (!Number.isInteger(undoId) || undoId <= 0) return { ok: false };
  const ok = restoreDeletedRow(profile.id, undoId);
  if (ok) revalidatePath("/", "layout");
  return { ok };
}

// Restore a whole batch of deleted rows from their undo tokens — the single
// "Deleted N · Undo" toast a bulk table delete offers (issue #29). Each token is
// restored independently in its OWN transaction, and the layout is revalidated
// once. Returns how many were actually restored.
//
// Per-token isolation (#202): a token whose restore THROWS — despite the external-FK
// reconciliation in restoreDeletedRow, some other integrity surprise could still
// abort one token's transaction — must not abort the whole batch and leave it
// partially restored. Each token is wrapped so a failing one is skipped and the
// rest still restore. A token already swept/restored just no-ops (returns false).
export async function undoDeletes(
  undoIds: number[]
): Promise<{ restored: number }> {
  const { profile } = await requireWriteAccess();
  const ids = (Array.isArray(undoIds) ? undoIds : []).filter(
    (n) => Number.isInteger(n) && n > 0
  );
  let restored = 0;
  for (const id of ids) {
    try {
      if (restoreDeletedRow(profile.id, id)) restored += 1;
    } catch (err) {
      // Isolate the failure to this token; the remaining tokens still restore.
      console.error(`undoDeletes: token ${id} failed to restore`, err);
    }
  }
  if (restored > 0) revalidatePath("/", "layout");
  return { restored };
}
