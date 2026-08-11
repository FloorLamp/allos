"use server";

import { revalidateRoute, type RevalidateTarget } from "@/lib/revalidate";
import { requireWriteAccess, requireSession } from "@/lib/auth";
import { db, writeTx } from "@/lib/db";
import {
  recordPairDecision,
  getSyncRowProvenance,
  type SyncRowLink,
} from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
} from "@/lib/import-review/detect";
import { writeActivityFold } from "@/lib/merge-activity";
import { writeImportTombstoneForRow } from "@/lib/integrations/tombstones";
import {
  clearDocumentTombstone,
  type AllowReacquisitionResult,
} from "@/lib/document-tombstones";
import { parseOverrideChoices } from "@/lib/import-review/conflicts";
import { mergeBodyMetric } from "@/lib/body-metric-extract";
import type { PairDecision } from "@/lib/import-review/detect";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  applyUnitMislabelCorrection as applyUnitMislabelCore,
  undoUnitMislabelCorrection as undoUnitMislabelCore,
  dismissUnitMislabel as dismissUnitMislabelCore,
  type ApplyUnitMislabelResult,
  type UnitMislabelUndo,
} from "@/lib/unit-mislabel-correction";

// Parse a JSON array of positive integer ids from a form field (the cluster merge's
// drop_ids). Anything malformed / non-numeric is dropped; duplicates collapsed. The
// action re-verifies every id `AND profile_id = ?` before touching a row, so this is
// only shape validation, never an auth check.
function parseIdList(raw: FormDataEntryValue | null): number[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<number>();
  for (const x of list) {
    const n = Number(x);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen];
}

// Parse a JSON array of non-empty strings (the cluster's constituent pair signatures).
function parseStringList(raw: FormDataEntryValue | null): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const x of list) if (typeof x === "string" && x.trim()) seen.add(x);
  return [...seen];
}

// The imported tables that carry a user-edit lock (`edited`, #133): the sync upserts
// leave a locked row untouched. Maps each to the surfaces that render the row, for
// revalidation after the lock is cleared. Whitelisted KEYS only ever reach the SQL
// below (never a raw client string), so the interpolated table name is one of these
// three constants.
const EDIT_LOCK_REVALIDATE: Record<string, readonly RevalidateTarget[]> = {
  activities: ["/data", "/training", "/trends", "/"],
  body_metrics: ["/data", "/trends", "/"],
  medical_records: ["/data", "/results", "/results/readings/view", "/"],
};

// Read the per-row provenance for one sync event (issue #1333): the records that sync
// inserted/updated, resolved to deep links. A pure READ, so it gates on requireSession
// (any accessible profile may inspect its own sync history) and is PROFILE-SCOPED —
// getSyncRowProvenance filters both the event and every target by the session profile,
// so an event id from another profile returns []. Called lazily by the drill-in on
// expand, mirroring the raw-payload viewer's on-open fetch.
export async function loadSyncRows(eventId: number): Promise<SyncRowLink[]> {
  const { profile } = await requireSession();
  if (!Number.isInteger(eventId)) return [];
  return getSyncRowProvenance(profile.id, eventId);
}

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
  revalidateRoute(paths);
  if (table === "activities")
    revalidateRoute("/training/rides/[id]", "page");
  return formOk();
}

// Server actions behind the Data → Review duplicate/conflict resolver (issue #10,
// Phase 2). All writes are transactional + profile-scoped, and every one records a
// durable decision (via recordPairDecision) keyed on the STABLE pair signature so
// the resolution survives the next rolling-window re-sync. We NEVER auto-merge —
// these run only from an explicit button press.

// Re-validate the surfaces a merge/dismiss changes: the Review inbox itself and the
// rollups a folded/deleted row feeds — the Training Log on /training, the /trends fitness
// chart + workout heatmap (issue #333), and the dashboard.
function revalidateActivitySurfaces() {
  revalidateRoute("/data");
  revalidateRoute("/training");
  revalidateRoute("/training/rides/[id]", "page");
  revalidateRoute("/trends");
  revalidateRoute("/");
}
function revalidateBodyMetricSurfaces() {
  revalidateRoute("/data");
  revalidateRoute("/trends");
  revalidateRoute("/");
}

// MERGE two duplicate activities into the user-chosen keeper: fold every field the
// keeper is missing from the discarded row (writeActivityFold — COALESCE(keep, drop)
// + the edited=1 lock), delete the discarded row, and record a durable 'merged'
// decision. Both ids are verified to belong to the acting profile before anything is
// touched.
//
// The delete here is a plain cascade delete — NOT undoable. Unlike the training log's
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
  // Conflict-picker overrides (issue #100/#1431): validated to real fold-field
  // names + member ids only; each overridden field takes the chosen row's re-read
  // value, never a client value. Empty for the common one-click merge. The legacy
  // pairwise array shape resolves against the single discarded row.
  const overrides = parseOverrideChoices(formData.get("overrides"), dropId);

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
    // belong to the keeper before its parent row is removed. (The N-way core takes a
    // drops[] list; a pair is the drops.length === 1 case.)
    writeActivityFold(profile.id, keepId, keep, [drop], overrides);
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

// MERGE a whole duplicate CLUSTER (issue #1081): fold N discarded rows into the
// user-chosen keeper through the SAME N-way core writeActivityFold, tombstone each
// dropped integration row, and record a `merged` decision for EVERY constituent pair
// signature (not a cluster-only key — the pairwise re-detector must still recognize a
// partially re-formed cluster). Like mergeActivityPair this Review-side merge is a
// plain cascade delete, NOT undoable. Every id is re-verified to belong to the acting
// profile before anything is touched; a 2-row cluster is the pairwise case.
export async function mergeActivityCluster(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropIds = parseIdList(formData.get("drop_ids")).filter(
    (id) => id !== keepId
  );
  const pairSignatures = parseStringList(formData.get("pair_signatures"));
  if (!keepId || dropIds.length === 0 || pairSignatures.length === 0) return;
  // Per-field member choices from the shared conflict picker (#1431) — field name +
  // member id only; values come from the re-read rows below.
  const overrides = parseOverrideChoices(formData.get("overrides"));

  const ok = writeTx(() => {
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(keepId, profile.id) as Record<string, unknown> | undefined;
    if (!keep) return false;
    const drops: Record<string, unknown>[] = [];
    for (const id of dropIds) {
      const drop = db
        .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
        .get(id, profile.id) as Record<string, unknown> | undefined;
      // A stale card (a drop already merged/deleted by a concurrent action) just
      // drops out; the rest still fold. If nothing survives, bail.
      if (drop) drops.push(drop);
    }
    if (drops.length === 0) return false;

    writeActivityFold(profile.id, keepId, keep, drops, overrides);
    for (const drop of drops) {
      db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
        drop.id as number,
        profile.id
      );
      // Re-import tombstone per dropped integration row (#507) — permanent (this
      // resolver isn't undoable), no-op for a manual absorbed row.
      writeImportTombstoneForRow(profile.id, "activities", drop);
    }
    // Record a durable 'merged' decision for EVERY constituent pair signature, so a
    // resync that reconstitutes part of the cluster stays suppressed via the pairwise
    // re-detection (#1081 — never a cluster-only key).
    for (const sig of pairSignatures)
      recordPairDecision(profile.id, ACTIVITY_DOMAIN, sig, "merged");
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
  revalidateRoute("/data");
  revalidateRoute("/");
}

// KEEP ALL / DISMISS a whole duplicate CLUSTER (issue #1081): record the decision for
// EVERY constituent pair signature (not a cluster-only key), so a re-formed sub-pair
// stays suppressed via the pairwise re-detection. `kept-both` = the members are
// genuinely distinct; `dismissed` = hide the false positive. No row change.
export async function resolveActivityCluster(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const decision = String(formData.get("decision") ?? "");
  const pairSignatures = parseStringList(formData.get("pair_signatures"));
  if (
    (decision !== "kept-both" && decision !== "dismissed") ||
    pairSignatures.length === 0
  )
    return;
  for (const sig of pairSignatures)
    recordPairDecision(
      profile.id,
      ACTIVITY_DOMAIN,
      sig,
      decision as PairDecision
    );
  revalidateRoute("/data");
  revalidateRoute("/");
}

// --- Unit-mislabel correction (issue #761) -----------------------------------
//
// A numeric lab reading whose stored unit is a probable power-of-ten mislabel of
// the canonical unit (MCHC "33 g/L" whose printed range 31–37 matches g/dL). The
// detector (lib/reference-range detectUnitMislabel) already suppresses the false
// flag pre-approval; these actions are the one-click remediation on Data → Review.
// All three are write-gated + profile-scoped; the write cores are auth-blind
// (lib/unit-mislabel-correction).

// The surfaces a unit correction changes: the Review inbox + every biomarker/trend
// surface that renders the reading's flag.
const MISLABEL_REVALIDATE: readonly RevalidateTarget[] = [
  "/data",
  "/results",
  "/results/readings/view",
  "/trends",
  "/",
];

// APPLY: correct the stored unit to the canonical unit, set the `edited` lock, and
// re-derive the flag. Re-detects server-side (never trusts a client unit). Returns
// the captured prior state so the client can offer an Undo toast.
export async function applyUnitMislabel(
  formData: FormData
): Promise<ApplyUnitMislabelResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0)
    return { ok: false, error: "Invalid record." };
  const res = applyUnitMislabelCore(profile.id, id);
  if (res.ok) revalidateRoute(MISLABEL_REVALIDATE);
  return res;
}

// UNDO: restore the prior unit, flag, and edit-lock captured by applyUnitMislabel
// (row-ops side-state — a correction is a row op, so its undo inverts every field
// it touched). Profile-scoped, so a token can't be replayed across profiles.
export async function undoUnitMislabel(
  undo: UnitMislabelUndo
): Promise<{ ok: boolean }> {
  const { profile } = await requireWriteAccess();
  if (!undo || !Number.isInteger(undo.id) || undo.id <= 0)
    return { ok: false };
  const ok = undoUnitMislabelCore(profile.id, {
    id: undo.id,
    unit: undo.unit ?? null,
    flag: undo.flag ?? null,
    edited: undo.edited ? 1 : 0,
  });
  if (ok) revalidateRoute(MISLABEL_REVALIDATE);
  return { ok };
}

// DISMISS: record the detection as a false positive (the stated range genuinely came
// from a different cohort and the unit was right) so it doesn't re-surface.
export async function dismissUnitMislabel(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id) || id <= 0) return formError("Invalid record.");
  dismissUnitMislabelCore(profile.id, id);
  revalidateRoute("/data");
  revalidateRoute("/");
  return formOk();
}

// ALLOW RE-ACQUISITION of a document the user previously deleted (#1777).
//
// The one user-facing tombstone-clearing surface in the app. Deleting a document writes
// a content-hash tombstone so an acquirer can never silently bring it back; this is how
// a person reverses that decision, and it is deliberately a TAP — the system may notice
// and suggest, but only the user's action writes.
//
// Write-access gated like any other profile write, and profile-scoped by the clear
// itself. The outcome is typed because the tombstone may already be gone: a second tab
// pressed the same button, or a human re-upload of the same bytes cleared it on the way
// in. Answering "Allowed again" either way would be confirming a write that did not
// happen.
export async function allowDocumentReacquisition(
  formData: FormData
): Promise<AllowReacquisitionResult> {
  const { profile } = await requireWriteAccess();
  const hash = String(formData.get("hash") ?? "").trim();
  if (!hash) return { status: "error", message: "Unknown document." };

  if (!clearDocumentTombstone(profile.id, hash)) {
    // Not an error — the desired state already holds. Say what is true rather than
    // failing at a user who pressed a button twice.
    return {
      status: "already-allowed",
      message: "That document was already allowed.",
    };
  }
  revalidateRoute("/data");
  return {
    status: "done",
    message: "Allowed — portal sync can bring this document back again.",
  };
}
