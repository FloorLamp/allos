"use server";

import { requireProfileWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { deletedRowProfile, restoreDeletedRow } from "@/lib/undo-delete-db";

// Restore a previously-deleted row from its undo token (a deleted_rows id), issued
// by the delete actions and offered as an "Undo" toast (issue #30) — and, since
// #2013, as the Restore button on Data → Trash, which calls THIS action rather than
// growing a second restore path.
//
// THE GATE IS ON THE CAPTURE'S OWN PROFILE (#2104). The multi-view delete actions
// stamp the ROW's profile onto the capture (gateItemProfile gates and writes the
// row's subject, not the acting profile), so the restore must resolve that same
// profile FROM THE HOLDING ROW — deletedRowProfile, the portalIdentityProfile shape
// (#1747) — and gate it with requireProfileWriteAccess. Gating the ACTING profile
// (the old requireWriteAccess) both killed every legitimate cross-profile undo (the
// capture said Mia, the restore filtered by Dad, the toast failed, the capture
// purged in the retention sweep) and authorized nothing about the profile actually
// being written. restoreDeletedRow keeps its `profile_id = ?` filter as the
// anti-replay compare: the id just gated is the id the restore is scoped by.
export async function undoDelete(undoId: number): Promise<{ ok: boolean }> {
  if (!Number.isInteger(undoId) || undoId <= 0) return { ok: false };
  // Token gone (already restored, purged by hand, or swept past retention) — the same
  // pre-gate "already gone" answer the portal identity actions give (#1747): there is
  // no profile left to authorize against, and the caller's toast reports it expired.
  const owner = deletedRowProfile(undoId);
  if (owner === null) return { ok: false };
  await requireProfileWriteAccess(owner);
  // Parity with the batch path (#202): restoreDeletedRow reconciles the captured
  // external-FK links it knows about, but any other integrity surprise inside its
  // transaction would otherwise surface as an unhandled server-action error. Catch it
  // and report ok=false (the toast simply reports the undo didn't take) rather than
  // throwing an unhandled error at the caller.
  let ok = false;
  try {
    ok = restoreDeletedRow(owner, undoId);
  } catch (err) {
    console.error(`undoDelete: token ${undoId} failed to restore`, err);
    return { ok: false };
  }
  // The restore re-inserts with NEW ids, so a broad layout revalidate refreshes
  // wherever the row now belongs.
  if (ok) revalidateRoute("/", "layout");
  return { ok };
}

// Restore a whole batch of deleted rows from their undo tokens — the single
// "Deleted N · Undo" toast a bulk table delete offers (issue #29). Each token is
// restored independently in its OWN transaction, and the layout is revalidated
// once. Returns how many were actually restored.
//
// Each token's owning profile is resolved from its capture and every DISTINCT owner
// is gated up front (#2104) — an authorization refusal is not a per-token "integrity
// surprise" to isolate, it aborts the whole batch with nothing restored, so a forged
// token cannot ride in on a legitimate batch. (A legitimate batch only ever carries
// tokens its own delete just gated, so the gates re-pass by construction.)
//
// Per-token isolation (#202) still applies to the restore itself: a token whose
// restore THROWS — despite the external-FK reconciliation in restoreDeletedRow, some
// other integrity surprise could still abort one token's transaction — must not
// abort the whole batch and leave it partially restored. Each token is wrapped so a
// failing one is skipped and the rest still restore. A token already swept/restored
// just no-ops (returns false).
export async function undoDeletes(
  undoIds: number[]
): Promise<{ restored: number }> {
  const ids = (Array.isArray(undoIds) ? undoIds : []).filter(
    (n) => Number.isInteger(n) && n > 0
  );
  const owned: [number, number][] = [];
  for (const id of ids) {
    const owner = deletedRowProfile(id);
    if (owner !== null) owned.push([id, owner]);
  }
  for (const profileId of new Set(owned.map(([, owner]) => owner))) {
    await requireProfileWriteAccess(profileId);
  }
  let restored = 0;
  for (const [id, owner] of owned) {
    try {
      if (restoreDeletedRow(owner, id)) restored += 1;
    } catch (err) {
      // Isolate the failure to this token; the remaining tokens still restore.
      console.error(`undoDeletes: token ${id} failed to restore`, err);
    }
  }
  if (restored > 0) revalidateRoute("/", "layout");
  return { restored };
}
