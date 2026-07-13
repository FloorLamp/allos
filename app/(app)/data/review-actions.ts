"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import { recordPairDecision } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
} from "@/lib/import-review/detect";
import { writeActivityFold } from "@/lib/merge-activity";
import { writeImportTombstoneForRow } from "@/lib/integrations/tombstones";
import { parseOverrideFields } from "@/lib/import-review/conflicts";
import { mergeBodyMetric } from "@/lib/body-metric-extract";
import type { PairDecision } from "@/lib/import-review/detect";
import { formError, formOk, type FormResult } from "@/lib/types";

// The imported tables that carry a user-edit lock (`edited`, #133): the sync upserts
// leave a locked row untouched. Maps each to the surfaces that render the row, for
// revalidation after the lock is cleared. Whitelisted KEYS only ever reach the SQL
// below (never a raw client string), so the interpolated table name is one of these
// three constants.
const EDIT_LOCK_REVALIDATE: Record<string, string[]> = {
  activities: ["/data", "/training", "/journal", "/trends", "/"],
  body_metrics: ["/data", "/trends", "/"],
  medical_records: ["/data", "/biomarkers", "/biomarkers/view", "/"],
};

// Clear the user-edit lock on one imported row so the next sync resumes updating it
// (issue #659 — the undo-inverts-side-state convention applied to the lock). This is
// the ONLY app path that writes `edited = 0` on a real row; it warns in the UI that
// the next sync may overwrite the hand-fix. Profile-scoped + write-gated: a member
// without write access, or an id from another profile, changes nothing.
export async function clearEditLock(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const table = String(formData.get("table") ?? "");
  const id = Number(formData.get("id"));
  const paths = EDIT_LOCK_REVALIDATE[table];
  if (!paths) return formError("Unknown record type.");
  if (!Number.isInteger(id) || id <= 0) return formError("Invalid record.");
  const info = db
    .prepare(`UPDATE ${table} SET edited = 0 WHERE id = ? AND profile_id = ?`)
    .run(id, profile.id);
  if (info.changes === 0) return formError("Record not found.");
  for (const p of paths) revalidatePath(p);
  return formOk();
}

// Server actions behind the Data → Review duplicate/conflict resolver (issue #10,
// Phase 2). All writes are transactional + profile-scoped, and every one records a
// durable decision (via recordPairDecision) keyed on the STABLE pair signature so
// the resolution survives the next rolling-window re-sync. We NEVER auto-merge —
// these run only from an explicit button press.

// Re-validate the surfaces a merge/dismiss changes: the Review inbox itself and the
// rollups a folded/deleted row feeds — the Journal on /training, the /trends fitness
// chart + workout heatmap (issue #333), and the dashboard.
function revalidateActivitySurfaces() {
  revalidatePath("/data");
  revalidatePath("/training");
  revalidatePath("/trends");
  revalidatePath("/");
}
function revalidateBodyMetricSurfaces() {
  revalidatePath("/data");
  revalidatePath("/trends");
  revalidatePath("/");
}

// MERGE two duplicate activities into the user-chosen keeper: fold every field the
// keeper is missing from the discarded row (writeActivityFold — COALESCE(keep, drop)
// + the edited=1 lock), delete the discarded row, and record a durable 'merged'
// decision. Both ids are verified to belong to the acting profile before anything is
// touched.
//
// The delete here is a plain cascade delete — NOT undoable. Unlike the journal's
// manual merge (which routes its delete through captureDelete for an Undo toast),
// this resolver's controls are plain server-action <form>s in a server component;
// making it undoable would mean converting DuplicateReview to a client component
// wired to useUndoableDelete — not a one-line change, so it is left out of #64.
export async function mergeActivityPair(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropId = Number(formData.get("drop_id"));
  const signature = String(formData.get("signature") ?? "").trim();
  if (!keepId || !dropId || keepId === dropId || !signature) return;
  // Conflict-preview overrides (issue #100): validated to real fold-field names
  // only; each overridden field takes the discarded row's re-read value, never a
  // client value. Empty for the common one-click merge.
  const overrideFields = parseOverrideFields(formData.get("overrides"));

  const ok = writeTx(() => {
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(keepId, profile.id) as Record<string, unknown> | undefined;
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(dropId, profile.id) as Record<string, unknown> | undefined;
    if (!keep || !drop) return false;

    // writeActivityFold both folds the gap-filling fields AND re-parents the
    // discarded row's exercise_sets onto the keeper (#199), so the plain cascade
    // delete below can no longer take typed-in sets down with it — the sets now
    // belong to the keeper before its parent row is removed.
    writeActivityFold(profile.id, keepId, keep, drop, overrideFields);
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      dropId,
      profile.id
    );
    // Re-import tombstone (#507): if the absorbed row is source-owned, record its
    // external_id so the trailing-window resync can't re-insert it as a fresh unmerged
    // row. This resolver's merge is not undoable, so the tombstone is permanent — the
    // merged-away duplicate stays gone. No-op for a manual absorbed row.
    writeImportTombstoneForRow(profile.id, "activities", drop);
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, signature, "merged");
    return true;
  });
  if (!ok) return;
  revalidateActivitySurfaces();
}

// MERGE two conflicting body-metric rows: the keeper's values win, the discarded
// row only fills gaps (mergeBodyMetric with the keeper as `incoming`), then delete
// the discarded row. Profile-scoped + transactional.
export async function mergeBodyMetricPair(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropId = Number(formData.get("drop_id"));
  const signature = String(formData.get("signature") ?? "").trim();
  if (!keepId || !dropId || keepId === dropId || !signature) return;

  const ok = writeTx(() => {
    const keep = db
      .prepare(
        "SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE id = ? AND profile_id = ?"
      )
      .get(keepId, profile.id) as
      | {
          weight_kg: number | null;
          body_fat_pct: number | null;
          resting_hr: number | null;
        }
      | undefined;
    const drop = db
      .prepare(
        "SELECT weight_kg, body_fat_pct, resting_hr, date, source FROM body_metrics WHERE id = ? AND profile_id = ?"
      )
      .get(dropId, profile.id) as
      | {
          weight_kg: number | null;
          body_fat_pct: number | null;
          resting_hr: number | null;
          date: string;
          source: string | null;
        }
      | undefined;
    if (!keep || !drop) return false;

    // mergeBodyMetric gives `incoming` precedence — pass the keeper as incoming so
    // the keeper's values win and the discarded row only fills a gap.
    const merged = mergeBodyMetric(drop, keep);
    db.prepare(
      `UPDATE body_metrics
          SET weight_kg = ?, body_fat_pct = ?, resting_hr = ?,
              -- Lock a source-owned keeper (integration/document row) against
              -- re-ingest so this merged correction isn't reverted by the next
              -- rolling window (issue #133). No-op for a manual keeper (source NULL).
              edited = CASE WHEN source IS NOT NULL THEN 1 ELSE edited END
        WHERE id = ? AND profile_id = ?`
    ).run(
      merged.weight_kg,
      merged.body_fat_pct,
      merged.resting_hr,
      keepId,
      profile.id
    );
    db.prepare("DELETE FROM body_metrics WHERE id = ? AND profile_id = ?").run(
      dropId,
      profile.id
    );
    // Re-import tombstone (#507): a source-owned absorbed row keyed on (date, source)
    // must not be re-inserted by the next `ON CONFLICT(profile_id, date, source)`
    // push. Not undoable here, so it's permanent. No-op for a manual (source NULL) row.
    writeImportTombstoneForRow(profile.id, "body_metrics", drop);
    recordPairDecision(profile.id, BODY_METRIC_DOMAIN, signature, "merged");
    return true;
  });
  if (!ok) return;
  revalidateBodyMetricSurfaces();
}

// KEEP BOTH / DISMISS a detected pair: no row change, just a durable decision that
// suppresses this pair from the inbox (and survives re-sync). `kept-both` means the
// two rows are genuinely distinct; `dismissed` hides a false positive. Generic over
// domain since neither has a side effect beyond the recorded decision.
export async function resolvePair(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const domain = String(formData.get("domain") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const signature = String(formData.get("signature") ?? "").trim();
  if (
    (domain !== ACTIVITY_DOMAIN && domain !== BODY_METRIC_DOMAIN) ||
    (decision !== "kept-both" && decision !== "dismissed") ||
    !signature
  )
    return;
  recordPairDecision(
    profile.id,
    domain,
    signature,
    decision as PairDecision
  );
  revalidatePath("/data");
  revalidatePath("/");
}
