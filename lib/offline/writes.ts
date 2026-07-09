// Server-side write cores for the three offline-queueable quick-log flows (issue
// #28). These are the SINGLE implementation of each write: both the online Server
// Action (app/(app)/trends/body-actions.ts, vitals-actions.ts, medicine/actions.ts)
// and the offline replay route (app/api/offline-replay) call them, so a replayed
// write runs byte-for-byte the same validation + persistence the live form does —
// there is no second, drift-prone copy of the rules. Callers own their own
// requireWriteAccess()/session gate and revalidatePath(); these functions take a
// resolved profileId and just do the profile-scoped write.
//
// Every statement here filters by profile_id (child tables reach it via their
// parent), per the repo scoping rule.

import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { toKg } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";
import { normalizeVitalsInput, type VitalsRawInput } from "@/lib/vitals-input";
import {
  decrementSupply,
  addCanonicalNames,
  reconcileFlags,
} from "@/lib/queries";
import type {
  FlowKind,
  QueuedIntent,
  DosePayload,
  BodyMetricPayload,
  VitalsPayload,
} from "@/lib/offline/queue";

// ── dose confirm ──────────────────────────────────────────────────────────────

// Set-to-taken for one dose on one date. Idempotent: inserts the per-(dose,date)
// log only when absent (the UNIQUE(dose_id,date) natural key), and decrements
// on-hand supply ONLY on a real insert — so replaying the same confirm never
// double-logs or double-decrements. Verifies the dose belongs to a supplement the
// profile owns (the id is untrusted), using the row's own supplement_id. Returns
// {ok:false} when the dose isn't owned or the date is malformed (a permanent
// rejection); {ok:true, inserted} otherwise.
export function confirmDoseTaken(
  profileId: number,
  doseId: number,
  date: string
): { ok: boolean; inserted: boolean } {
  if (!Number.isInteger(doseId) || doseId <= 0 || !isRealIsoDate(date)) {
    return { ok: false, inserted: false };
  }
  const dose = db
    .prepare(
      `SELECT supplement_id FROM intake_item_doses
       WHERE id = ? AND supplement_id IN (SELECT id FROM intake_items WHERE profile_id = ?)`
    )
    .get(doseId, profileId) as { supplement_id: number } | undefined;
  if (!dose) return { ok: false, inserted: false };
  const existing = db
    .prepare("SELECT id FROM intake_item_logs WHERE dose_id = ? AND date = ?")
    .get(doseId, date);
  if (existing) return { ok: true, inserted: false };
  db.prepare(
    "INSERT INTO intake_item_logs (dose_id, supplement_id, date) VALUES (?,?,?)"
  ).run(doseId, dose.supplement_id, date);
  decrementSupply(profileId, dose.supplement_id);
  return { ok: true, inserted: true };
}

// ── body-metric quick-add ───────────────────────────────────────────────────────

export interface BodyMetricWrite {
  date: string;
  weight: string; // raw, in `weightUnit`
  weightUnit: WeightUnit;
  bodyFatPct: string | null;
  restingHr: string | null;
  notes: string | null;
}

function numOrNull(v: string | null): number | null {
  if (v === null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Persist one body-metrics row. Mirrors the addBodyMetric action's guards exactly:
// reject a non-ISO date or a missing/non-finite weight (never write a NaN weight_kg
// or an impossible date), skip non-finite optional numbers rather than storing NaN,
// and convert the raw weight to canonical kg via the captured unit. Returns false on
// a rejected input, true on a successful insert.
export function insertBodyMetric(
  profileId: number,
  w: BodyMetricWrite
): boolean {
  if (!isRealIsoDate(w.date) || String(w.weight).trim() === "") return false;
  const weight = Number(w.weight);
  if (!Number.isFinite(weight)) return false;
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, notes, profile_id)
     VALUES (?,?,?,?,?,?)`
  ).run(
    w.date,
    toKg(weight, w.weightUnit),
    numOrNull(w.bodyFatPct),
    numOrNull(w.restingHr),
    w.notes && w.notes.trim() ? w.notes.trim() : null,
    profileId
  );
  return true;
}

// ── vitals quick-add ────────────────────────────────────────────────────────────

// Insert-or-update a manual daily metric sample (sleep/HRV) — one row per date so a
// re-entry corrects rather than duplicates. Identical to the vitals action's upsert:
// source='manual' with a fixed midnight window makes the natural key stable, and the
// `source` in the UNIQUE key keeps a Health Connect push from ever touching it.
function upsertManualSample(
  profileId: number,
  metric: string,
  date: string,
  value: number
): void {
  const ts = `${date}T00:00:00`;
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'manual', ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id, metric, source, start_time, end_time) DO UPDATE SET
       value = excluded.value, date = excluded.date`
  ).run(profileId, metric, date, ts, ts, value);
}

// Persist a manual vitals entry. Runs the SAME pure normalizeVitalsInput guard the
// online action and client form use, so a crafted/replayed request can never store a
// partial/out-of-range set. Writes medical_records (external_id NULL, so a
// same-window Health Connect push never matches it) + the sleep/HRV samples, then
// registers canonical names and re-derives reference-range flags. Returns false on a
// rejected/empty input, true on a successful write.
export function insertVitals(
  profileId: number,
  date: string,
  raw: VitalsRawInput
): boolean {
  if (!isRealIsoDate(date)) return false;
  const normalized = normalizeVitalsInput(raw);
  if ("error" in normalized) return false;
  const { medical, samples } = normalized;
  if (medical.length === 0 && samples.length === 0) return false;

  const insertMedical = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL)`
  );
  const ids: number[] = [];
  for (const m of medical) {
    const info = insertMedical.run(
      profileId,
      date,
      m.category,
      m.canonical,
      String(m.value_num),
      m.value_num,
      m.unit,
      m.canonical
    );
    ids.push(Number(info.lastInsertRowid));
  }
  for (const s of samples) {
    upsertManualSample(profileId, s.metric, date, s.value);
  }
  if (ids.length) {
    addCanonicalNames(medical.map((m) => m.canonical));
    reconcileFlags(profileId, ids);
  }
  return true;
}

// ── idempotency ledger ──────────────────────────────────────────────────────────

// Has this idempotency key already been applied for this profile? Consulted before
// a replayed write so a duplicate flush is a no-op (issue #28 exactly-once).
export function alreadyReplayed(profileId: number, key: string): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM replayed_keys WHERE client_key = ? AND profile_id = ?"
    )
    .get(key, profileId);
}

function recordReplayKey(profileId: number, key: string, flow: FlowKind): void {
  db.prepare(
    "INSERT OR IGNORE INTO replayed_keys (client_key, profile_id, flow) VALUES (?,?,?)"
  ).run(key, profileId, flow);
}

// ── replay dispatch ─────────────────────────────────────────────────────────────

// The terminal outcome of applying one queued intent: "done" (written now),
// "duplicate" (key already applied — no-op), or "rejected" (payload permanently
// invalid). A transient failure is NOT represented here — the underlying write /
// transaction throws, and the route maps that to a retryable "error".
export type ReplayApplied = "done" | "duplicate" | "rejected";

// Apply one queued intent for `profileId`, exactly once. The idempotency-key check
// and the write run in ONE transaction: a key already present short-circuits to
// "duplicate"; a rejected payload commits nothing and records no key; a successful
// write records the key so any later flush of the same key is a no-op. Real DB
// errors propagate (the caller treats them as retryable).
export function applyIntent(
  profileId: number,
  intent: QueuedIntent
): ReplayApplied {
  let outcome: ReplayApplied = "rejected";
  const tx = db.transaction(() => {
    if (alreadyReplayed(profileId, intent.key)) {
      outcome = "duplicate";
      return;
    }
    let ok = false;
    if (intent.flow === "dose") {
      const p = intent.payload as DosePayload;
      ok = confirmDoseTaken(profileId, p.doseId, intent.date).ok;
    } else if (intent.flow === "body-metric") {
      const p = intent.payload as BodyMetricPayload;
      ok = insertBodyMetric(profileId, {
        date: intent.date,
        weight: p.weight,
        weightUnit: p.weightUnit,
        bodyFatPct: p.bodyFatPct,
        restingHr: p.restingHr,
        notes: p.notes,
      });
    } else if (intent.flow === "vitals") {
      const p = intent.payload as VitalsPayload;
      ok = insertVitals(profileId, intent.date, {
        systolic: p.systolic,
        diastolic: p.diastolic,
        glucose: p.glucose,
        glucoseUnit: p.glucoseUnit,
        spo2: p.spo2,
        temperature: p.temperature,
        tempUnit: p.tempUnit,
        sleepHours: p.sleepHours,
        hrv: p.hrv,
      });
    } else {
      // Unknown flow — treat as a permanent rejection (client drops it).
      outcome = "rejected";
      return;
    }
    if (!ok) {
      outcome = "rejected";
      return;
    }
    recordReplayKey(profileId, intent.key, intent.flow);
    outcome = "done";
  });
  tx();
  return outcome;
}
