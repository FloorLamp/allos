"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidateRoute } from "@/lib/revalidate";
import { captureDelete } from "@/lib/undo-delete-db";

// The body-metric DELETE, and only that (#4424 ruling 7). This module also carried
// `addBodyMetric` — a weight-shaped write action beside `addMeasurements`, which is the
// same submission with more fields — and its three callers (the record's add door, the
// pediatric label lookup, and the palette's `weight 82.5` reaching past it into the
// core) are the three copies that ruling deletes. They all post the measurements action
// now, so a body sitting has ONE door however small the sitting is, and every one of
// them is under `isPastWriteAccepted` and states the same optional time.

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
  revalidateRoute("/trends");
  revalidateRoute("/");
  return { undoId };
}
