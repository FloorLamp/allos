"use server";
import { requireSession } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { addCanonicalNames, reconcileFlags } from "@/lib/queries";
import { normalizeVitalsInput } from "@/lib/vitals-input";

// Manual vitals write path (issue #16). Manual entry previously covered only the
// three body_metrics measures (weight/body-fat/resting-HR); blood pressure,
// glucose, SpO2, temperature, sleep, and HRV could ONLY arrive via the Health
// Connect exporter. This writes those same six to the SAME tables / metric keys /
// canonical names the integration uses (see lib/vitals-input.ts), tagged
// source='manual', so they share the integration's charts + reference-range flags
// and feed the recovery coach (getSleepSignal reads metric_samples 'sleep_min').
//
// NEVER CLOBBERED BY INGEST:
//   • medical_records rows (BP/glucose/SpO2/temp) are written with external_id NULL.
//     upsertVitals dedups strictly on external_id ('health-connect:<canonical>:<t>')
//     — a NULL-external_id manual row can never match, so a same-window HC push
//     inserts its own row and never reads/updates the manual one.
//   • metric_samples rows (sleep/HRV) are written with source='manual'. The unique
//     key (and upsertMetricSamples' find) includes `source` (#128), so a
//     'health-connect'-sourced push touches only its own rows, never the manual ones.

// Insert-or-update a manual daily metric sample (one row per date, so re-entering
// a day's sleep/HRV corrects it rather than duplicating). Mirrors the integration's
// upsert key but with source='manual' — a fixed midnight window makes the natural
// key (profile_id, metric, 'manual', start, end) stable across re-entries.
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

export async function addVitals(formData: FormData) {
  const { profile } = requireSession();
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date)) return;

  // Normalize + validate with the same pure guard the client form ran, so a
  // crafted request can never persist a partial/out-of-range set.
  const normalized = normalizeVitalsInput({
    systolic: formData.get("systolic") as string | null,
    diastolic: formData.get("diastolic") as string | null,
    glucose: formData.get("glucose") as string | null,
    glucoseUnit: formData.get("glucose_unit") as string | null,
    spo2: formData.get("spo2") as string | null,
    temperature: formData.get("temperature") as string | null,
    tempUnit: formData.get("temp_unit") as string | null,
    sleepHours: formData.get("sleep_hours") as string | null,
    hrv: formData.get("hrv") as string | null,
  });
  if ("error" in normalized) return;
  const { medical, samples } = normalized;
  if (medical.length === 0 && samples.length === 0) return;

  const insertMedical = db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', NULL)`
  );

  const ids: number[] = [];
  const run = db.transaction(() => {
    for (const m of medical) {
      const info = insertMedical.run(
        profile.id,
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
      upsertManualSample(profile.id, s.metric, date, s.value);
    }
  });
  run();

  // Register canonical names + (re)derive out-of-range flags for the just-inserted
  // vitals against their canonical reference/optimal ranges — the same follow-ups
  // the HC ingest runs after upsertVitals.
  if (ids.length) {
    addCanonicalNames(medical.map((m) => m.canonical));
    reconcileFlags(profile.id, ids);
  }

  revalidatePath("/trends");
  revalidatePath("/biomarkers");
  revalidatePath("/");
}
