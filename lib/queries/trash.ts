// The Trash list query (issue #2013) — the impure half of the read model.
//
// One SELECT over the acting profile's holding rows, mapped through the pure
// derivation in lib/trash.ts. Newest delete first: a trash is read as "what did I just
// lose", not as an archive.
//
// PROFILE-SCOPED, always. `deleted_rows` is a profile-owned table and the payload is
// the deleted row's content, so this reads exactly one profile's captures — unlike the
// expiry sweep next door, which is deliberately global instance maintenance.

import { db } from "../db";
import {
  TRASH_EXCLUDED_KIND,
  trashEntry,
  type TrashCapture,
  type TrashEntry,
} from "../trash";

export function listTrash(
  profileId: number,
  retentionDays: number,
  now: Date = new Date()
): TrashEntry[] {
  const rows = db
    .prepare(
      `SELECT id, kind, label, payload, deleted_at AS deletedAt
         FROM deleted_rows
        WHERE profile_id = ? AND kind <> ?
        ORDER BY deleted_at DESC, id DESC`
    )
    .all(profileId, TRASH_EXCLUDED_KIND) as TrashCapture[];
  return rows.map((r) => trashEntry(r, retentionDays, now));
}

// How many captures the acting profile currently holds. Cheap enough for a tab badge;
// kept separate so a surface that only needs the count never serializes payloads.
export function countTrash(profileId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM deleted_rows
        WHERE profile_id = ? AND kind <> ?`
    )
    .get(profileId, TRASH_EXCLUDED_KIND) as { c: number };
  return row.c;
}
