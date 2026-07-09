"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { captureDelete } from "@/lib/undo-delete-db";
import { writeActivityFold } from "@/lib/merge-activity";
import { recordPairDecision } from "@/lib/queries";
import {
  ACTIVITY_DOMAIN,
  activityToken,
  pairSignature,
} from "@/lib/import-review/detect";
import type { ActivityType } from "@/lib/types";
import { getUnitPrefs } from "@/lib/settings";
import { toKg, toKm } from "@/lib/units";
import { minutesBetween } from "@/lib/activity-meta";
import { isRealIsoDate } from "@/lib/date";

interface SetInput {
  exercise: string;
  // Weight is submitted in the user's preferred unit; converted to kg here.
  weight: number | null;
  reps: number | null;
  // Right-side load for per-side (asymmetric) sets; null for bilateral sets.
  weightRight: number | null;
  repsRight: number | null;
  // Hold time (seconds) for timed exercises; null for rep-based sets.
  durationSec: number | null;
  durationSecRight: number | null;
  // User-defined implement for this set (Equipment.id), or null. Manual entry
  // treats the weight as TOTAL load, so no bar weight is added here.
  equipmentId: number | null;
  // Declared intent: planned rep count, or "to failure" (AMRAP). Optional —
  // older clients and integrations don't send them.
  targetReps?: number | null;
  toFailure?: boolean;
}

function writeSets(
  activityId: number,
  formData: FormData,
  weightUnit: "kg" | "lb"
) {
  const raw = formData.get("sets");
  if (!raw) return;
  let sets: SetInput[] = [];
  try {
    sets = JSON.parse(String(raw));
  } catch {
    sets = [];
  }
  const setStmt = db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, weight_kg_right, reps_right,
        duration_sec, duration_sec_right, equipment_id, target_reps, to_failure)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const counters: Record<string, number> = {};
  for (const s of sets) {
    if (!s.exercise?.trim()) continue;
    const ex = s.exercise.trim();
    counters[ex] = (counters[ex] ?? 0) + 1;
    setStmt.run(
      activityId,
      ex,
      counters[ex],
      s.weight != null ? toKg(s.weight, weightUnit) : null,
      s.reps ?? null,
      s.weightRight != null ? toKg(s.weightRight, weightUnit) : null,
      s.repsRight ?? null,
      s.durationSec ?? null,
      s.durationSecRight ?? null,
      s.equipmentId ?? null,
      // Canonicalize intent at the write boundary (like toKg above): a target
      // must be a positive integer, and an AMRAP set carries no target —
      // otherwise a stray 0 would make every session judge as "hit target".
      !s.toFailure && Number.isInteger(s.targetReps) && s.targetReps! > 0
        ? s.targetReps
        : null,
      s.toFailure ? 1 : null
    );
  }
}

// Create a new activity, or update an existing one when `id` is present.
export async function saveActivity(formData: FormData) {
  const { login, profile } = requireWriteAccess();
  const id = formData.get("id") ? Number(formData.get("id")) : null;
  const type = String(formData.get("type")) as ActivityType;
  const title = String(formData.get("title") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  // Reject non-ISO dates server-side too: the client gates on this, but the
  // action must not persist "2026-07" / "Friday" if a bad value slips through.
  if (!title || !isRealIsoDate(date)) return;

  const prefs = getUnitPrefs(login.id);
  const notes = (formData.get("notes") as string)?.trim() || null;
  const intensity = (formData.get("intensity") as string)?.trim() || null;
  const startTime = (formData.get("start_time") as string)?.trim() || null;
  const endTime = (formData.get("end_time") as string)?.trim() || null;

  // Components: [{ name, type, distance (user unit) | null, duration_min | null }]
  let rawComponents: {
    name: string;
    type: ActivityType;
    distance: number | null;
    duration_min: number | null;
  }[] = [];
  try {
    rawComponents = JSON.parse(String(formData.get("components") ?? "[]"));
  } catch {
    rawComponents = [];
  }
  // Numeric fields arrive from parsed JSON and may be strings ("5") — coerce with
  // Number + a finiteness guard so a string can't concatenate in the reduces below
  // or persist as a string, and a garbage value becomes null rather than NaN.
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const components = rawComponents
    .filter((c) => c.name?.trim())
    .map((c) => {
      const distance = num(c.distance);
      return {
        name: c.name.trim(),
        type: c.type,
        distance_km:
          distance != null ? toKm(distance, prefs.distanceUnit) : null,
        duration_min: num(c.duration_min),
      };
    });
  const componentsJson = components.length ? JSON.stringify(components) : null;

  const hasStrength = components.some((c) => c.type === "strength");
  const totalDistanceKm = components.reduce(
    (s, c) => s + (c.distance_km ?? 0),
    0
  );
  const distanceKm = totalDistanceKm > 0 ? totalDistanceKm : null;
  // Overall duration: from clock times when present, else the sum of parts.
  const fromTimes =
    startTime && endTime ? minutesBetween(startTime, endTime) : null;
  const partsDuration = components.reduce(
    (s, c) => s + (c.duration_min ?? 0),
    0
  );
  const durationMin = fromTimes ?? (partsDuration > 0 ? partsDuration : null);

  const tx = db.transaction((): number | null => {
    let activityId: number;
    if (id) {
      // Verify the activity belongs to this profile before touching it or its
      // sets — the form id is untrusted. Bail (no-op) when it isn't owned.
      const owned = db
        .prepare("SELECT 1 FROM activities WHERE id = ? AND profile_id = ?")
        .get(id, profile.id);
      if (!owned) return null;
      db.prepare(
        `UPDATE activities
         SET date = ?, type = ?, title = ?, notes = ?, duration_min = ?, distance_km = ?,
             intensity = ?, start_time = ?, end_time = ?, components = ?,
             -- Stamp last-edited (UTC, same form as created_at) so the Journal can
             -- show "edited …" alongside "added …" (issue #11).
             updated_at = datetime('now'),
             -- Mark integration-owned rows as hand-edited so re-ingest won't
             -- clobber this edit (no-op for manual rows: source/external_id null).
             edited = CASE WHEN source IS NOT NULL OR external_id IS NOT NULL
                           THEN 1 ELSE edited END
         WHERE id = ? AND profile_id = ?`
      ).run(
        date,
        type,
        title,
        notes,
        durationMin,
        distanceKm,
        intensity,
        startTime,
        endTime,
        componentsJson,
        id,
        profile.id
      );
      activityId = id;
      // Replace sets wholesale (parent ownership verified above).
      db.prepare("DELETE FROM exercise_sets WHERE activity_id = ?").run(id);
    } else {
      const res = db
        .prepare(
          `INSERT INTO activities
             (date, type, title, notes, duration_min, distance_km, intensity, start_time, end_time, components, profile_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          date,
          type,
          title,
          notes,
          durationMin,
          distanceKm,
          intensity,
          startTime,
          endTime,
          componentsJson,
          profile.id
        );
      activityId = Number(res.lastInsertRowid);
    }
    if (hasStrength) writeSets(activityId, formData, prefs.weightUnit);
    return activityId;
  });
  const activityId = tx();
  if (activityId == null) return;

  revalidatePath("/training");
  revalidatePath("/");
  // Return the row id so the auto-saving form can switch from create to update.
  return { id: activityId };
}

// Record the user's bodyweight (entered in their preferred unit) as a body-metrics
// entry, so bodyweight lifts can fold it into volume / strength stats. Called from
// the activity form when a bodyweight exercise is logged with no weight on record.
export async function logBodyweight(weight: number, date: string) {
  const { login, profile } = requireWriteAccess();
  const d = date.trim();
  if (!Number.isFinite(weight) || weight <= 0 || !d) return;
  const prefs = getUnitPrefs(login.id);
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, source, profile_id) VALUES (?,?,?,?)`
  ).run(d, toKg(weight, prefs.weightUnit), "manual", profile.id);
  revalidatePath("/training");
  revalidatePath("/trends");
  revalidatePath("/");
}

// MANUAL pair-merge from the Journal (issue #64): the user picks two activities of
// the SAME day and explicitly merges them — the escape hatch for duplicates no
// heuristic catches (e.g. rows with no clock windows). Reuses the SAME machinery as
// the Data → Review resolver: fold the discarded row's gap-filling fields into the
// keeper (writeActivityFold, keeper edited=1), record a durable 'merged' decision
// keyed on the stable pair signature, then delete the discarded row.
//
// The keeper is the card the user acted on; the picked sibling is absorbed + removed.
// UNLIKE the review resolver, the delete routes through captureDelete so the merge is
// UNDOABLE from a toast (issue #30): undo re-inserts the discarded row (with its
// sets). Note undo does NOT unwind the keeper's gap-fills or the recorded decision —
// it restores the row, matching the capture-based undo model; after an undo you get
// both rows back (the keeper simply retains any fields it had absorbed).
//
// Same-profile + same-day are enforced server-side (the untrusted form ids), even
// though the UI only ever offers same-day siblings.
export async function mergeActivities(
  formData: FormData
): Promise<{ undoId: number | null }> {
  // Merging edits the keeper and deletes the discarded row — a write (issue #33).
  const { profile } = requireWriteAccess();
  const keepId = Number(formData.get("keep_id"));
  const dropId = Number(formData.get("drop_id"));
  if (!keepId || !dropId || keepId === dropId) return { undoId: null };

  let undoId: number | null = null;
  const tx = db.transaction((): boolean => {
    const keep = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(keepId, profile.id) as Record<string, unknown> | undefined;
    const drop = db
      .prepare("SELECT * FROM activities WHERE id = ? AND profile_id = ?")
      .get(dropId, profile.id) as Record<string, unknown> | undefined;
    // Both must be the acting profile's and share a day — a manual merge only makes
    // sense within one day (the detector buckets by day too).
    if (!keep || !drop || keep.date !== drop.date) return false;

    writeActivityFold(profile.id, keepId, keep, drop);
    const signature = pairSignature(
      activityToken(keep as { id: number; external_id: string | null }),
      activityToken(drop as { id: number; external_id: string | null })
    );
    recordPairDecision(profile.id, ACTIVITY_DOMAIN, signature, "merged");
    // Capture-and-delete the discarded row (its sets cascade into the undo payload).
    undoId = captureDelete("activity", profile.id, dropId);
    return true;
  });
  if (!tx()) return { undoId: null };

  // The Journal feed lives on /training (the "Log" tab); revalidate it plus the
  // dashboard rollups the folded/deleted row feeds — same surfaces deleteActivity
  // refreshes.
  revalidatePath("/training");
  revalidatePath("/");
  return { undoId };
}

export async function deleteActivity(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const { profile } = requireWriteAccess();
  const id = Number(formData.get("id"));
  if (!id) return { undoId: null };
  // Capture the activity + its exercise_sets into the undo holding table and
  // delete it in one transaction (issue #30), so a mis-tap can be undone from the
  // toast. children cascade; captureDelete returns the undo token.
  const undoId = captureDelete("activity", profile.id, id);
  revalidatePath("/training");
  revalidatePath("/");
  return { undoId };
}
