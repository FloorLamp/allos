"use server";

import { revalidatePath } from "next/cache";
import { requireWriteAccess } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordPairDecision } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  BODY_METRIC_DOMAIN,
} from "@/lib/import-review/detect";
import { writeActivityFold } from "@/lib/merge-activity";
import { mergeBodyMetric } from "@/lib/body-metric-extract";
import type { PairDecision } from "@/lib/import-review/detect";

// Server actions behind the Data → Review duplicate/conflict resolver (issue #10,
// Phase 2). All writes are transactional + profile-scoped, and every one records a
// durable decision (via recordPairDecision) keyed on the STABLE pair signature so
// the resolution survives the next rolling-window re-sync. We NEVER auto-merge —
// these run only from an explicit button press.

// Re-validate the surfaces a merge/dismiss changes: the Review inbox itself and the
// rollups a folded/deleted row feeds.
function revalidateActivitySurfaces() {
  revalidatePath("/data");
  revalidatePath("/training");
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
  const { profile } = requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropId = Number(formData.get("drop_id"));
  const signature = String(formData.get("signature") ?? "").trim();
  if (!keepId || !dropId || keepId === dropId || !signature) return;

  const tx = db.transaction(() => {
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(keepId, profile.id) as Record<string, unknown> | undefined;
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(dropId, profile.id) as Record<string, unknown> | undefined;
    if (!keep || !drop) return false;

    writeActivityFold(profile.id, keepId, keep, drop);
    // Sets live on the kept row via activity_id; the discarded row's sets are
    // removed by the FK ON DELETE CASCADE when its row goes.
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      dropId,
      profile.id
    );
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, signature, "merged");
    return true;
  });
  if (!tx()) return;
  revalidateActivitySurfaces();
}

// MERGE two conflicting body-metric rows: the keeper's values win, the discarded
// row only fills gaps (mergeBodyMetric with the keeper as `incoming`), then delete
// the discarded row. Profile-scoped + transactional.
export async function mergeBodyMetricPair(formData: FormData) {
  const { profile } = requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropId = Number(formData.get("drop_id"));
  const signature = String(formData.get("signature") ?? "").trim();
  if (!keepId || !dropId || keepId === dropId || !signature) return;

  const tx = db.transaction(() => {
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
        "SELECT weight_kg, body_fat_pct, resting_hr FROM body_metrics WHERE id = ? AND profile_id = ?"
      )
      .get(dropId, profile.id) as
      | {
          weight_kg: number | null;
          body_fat_pct: number | null;
          resting_hr: number | null;
        }
      | undefined;
    if (!keep || !drop) return false;

    // mergeBodyMetric gives `incoming` precedence — pass the keeper as incoming so
    // the keeper's values win and the discarded row only fills a gap.
    const merged = mergeBodyMetric(drop, keep);
    db.prepare(
      `UPDATE body_metrics
          SET weight_kg = ?, body_fat_pct = ?, resting_hr = ?
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
    recordPairDecision(profile.id, BODY_METRIC_DOMAIN, signature, "merged");
    return true;
  });
  if (!tx()) return;
  revalidateBodyMetricSurfaces();
}

// KEEP BOTH / DISMISS a detected pair: no row change, just a durable decision that
// suppresses this pair from the inbox (and survives re-sync). `kept-both` means the
// two rows are genuinely distinct; `dismissed` hides a false positive. Generic over
// domain since neither has a side effect beyond the recorded decision.
export async function resolvePair(formData: FormData) {
  const { profile } = requireWriteAccess();
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
