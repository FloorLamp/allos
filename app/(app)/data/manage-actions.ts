"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  getDataset,
  DELETE_POLICY,
  type DatasetDeletePolicy,
} from "@/lib/export";
import { cleanupOrphanStars } from "@/lib/queries";
import { undoKindForDataset } from "@/lib/dataset-undo";
import { captureDelete } from "@/lib/undo-delete-db";

// The per-dataset deletion policy (which pages to revalidate, whether to clean up
// orphaned biomarker stars) lives beside DATASETS in lib/export as pure data —
// this "use server" module may only export async functions, and co-locating it
// there lets a test assert the delete-button UI and the policy stay in sync.
// Child rows are removed by the schema's ON DELETE CASCADE (exercise_sets,
// supplement doses/logs/pairs). A path containing "[" is revalidated as a dynamic
// page (revalidatePath type).

// Resolve a dataset key to its table + policy, guarding against unknown keys.
function resolve(key: string) {
  const ds = getDataset(key);
  const policy = DELETE_POLICY[key];
  if (!ds || !policy) return null;
  return { table: ds.table, policy };
}

function afterDelete(
  key: string,
  policy: DatasetDeletePolicy,
  profileId: number
) {
  if (policy.cleanupStars) cleanupOrphanStars(profileId);
  // Always refresh the Data page (the management table lives there).
  revalidatePath("/data");
  // A "[param]" path is a dynamic route and must be revalidated with the "page"
  // type; plain paths use the default.
  for (const p of policy.revalidate)
    p.includes("[") ? revalidatePath(p, "page") : revalidatePath(p);
}

// Delete the selected rows (by id) from a dataset's table. Ids are coerced to
// positive integers and parameterized, and the table name comes from the
// whitelisted dataset — never from the client — so this can't touch other
// tables. Returns the number of rows removed.
export async function deleteDatasetRows(
  key: string,
  ids: number[]
): Promise<
  | { ok: true; deleted: number; undoIds: number[] }
  | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const resolved = resolve(key);
  if (!resolved) return { ok: false, error: "Unknown dataset." };

  const clean = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0)
    ),
  ];
  if (clean.length === 0) return { ok: false, error: "No rows selected." };

  // Datasets whose table is an undoable root (activities, body metrics, biomarker
  // records, supplements/meds) capture EACH row into the undo holding table so the
  // whole batch is restorable from one "Deleted N · Undo" toast (issue #29/#30).
  // captureDelete already scopes to this profile and cascades children; a row that
  // isn't this profile's returns null and is skipped.
  const kind = undoKindForDataset(key);
  if (kind) {
    const undoIds: number[] = [];
    for (const id of clean) {
      const token = captureDelete(kind, profile.id, id);
      if (token != null) undoIds.push(token);
    }
    afterDelete(key, resolved.policy, profile.id);
    return { ok: true, deleted: undoIds.length, undoIds };
  }

  const placeholders = clean.map(() => "?").join(",");
  // Scope the delete to this profile's rows — the whitelisted tables are all
  // profile-owned, so an id belonging to another profile must not be touched.
  const info = db
    .prepare(
      `DELETE FROM ${resolved.table} WHERE id IN (${placeholders}) AND profile_id = ?`
    )
    .run(...clean, profile.id);

  afterDelete(key, resolved.policy, profile.id);
  return { ok: true, deleted: info.changes, undoIds: [] };
}

// Delete every row in a dataset's table (the "delete all" action). Same table
// whitelisting as above.
export async function deleteAllDatasetRows(
  key: string
): Promise<
  | { ok: true; deleted: number; undoIds: number[] }
  | { ok: false; error: string }
> {
  const { profile } = await requireWriteAccess();
  const resolved = resolve(key);
  if (!resolved) return { ok: false, error: "Unknown dataset." };

  // "Delete all" is still scoped to this profile — never wipe another profile's
  // rows from the shared table. It is intentionally NOT undoable (the confirm
  // says so): capturing an entire table into the holding store could be huge.
  const info = db
    .prepare(`DELETE FROM ${resolved.table} WHERE profile_id = ?`)
    .run(profile.id);

  afterDelete(key, resolved.policy, profile.id);
  return { ok: true, deleted: info.changes, undoIds: [] };
}
