"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { getUnitPrefs } from "@/lib/settings";
import { submittedWeightUnit } from "@/lib/units";
import {
  insertBodyMetric,
  insertGrowth,
  insertVitals,
} from "@/lib/offline/writes";

// The combined "Log measurements" write path (issue #1486).
//
// The Body and Vitals tabs each carried their own quick-add (plus a third,
// growth-only form for a minor), so logging a morning's weigh-in + blood pressure
// meant two forms on two tabs. #1486 merges the TAB, and this merges its write: one
// action over the THREE existing write cores, chosen by which fields the submission
// actually carries.
//
// It adds NO write path. `insertBodyMetric` / `insertVitals` / `insertGrowth` are
// the same auth-blind, profileId-first cores the offline replay route runs, so a
// value entered here is byte-for-byte the value the old per-domain form wrote — same
// tables, same canonical names, same reference-range reconcile. The three stay
// SEPARATE cores because they land in three different stores (body_metrics,
// medical_records + metric_samples, metric_samples); this action is the composition,
// not a fourth writer.
//
// PARTIAL SUBMISSIONS ARE THE NORM. Every field is optional and a section whose
// fields are all blank is simply skipped, so "log only a BP" writes no body_metrics
// row and "log only a weight" writes no vitals rows. Each core independently
// rejects an invalid/empty payload (returning false), and the action revalidates
// only when at least one of them actually persisted something.
export async function addMeasurements(formData: FormData) {
  const { login, profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  const prefs = getUnitPrefs(login.id);

  const str = (k: string): string | null => {
    const v = formData.get(k);
    return v === null ? null : String(v);
  };
  const filled = (k: string): boolean => {
    const v = formData.get(k);
    return v !== null && String(v).trim() !== "";
  };

  let wrote = false;

  // 1. Body composition (body_metrics). Each nullable measurement can be recorded
  //    independently; this matters on a metric detail page whose form contains
  //    exactly one field rather than the whole body-composition trio.
  if (filled("weight") || filled("body_fat_pct") || filled("resting_hr")) {
    wrote =
      insertBodyMetric(profile.id, {
        date,
        weight: String(formData.get("weight") ?? ""),
        weightUnit: submittedWeightUnit(
          formData.get("weight_unit"),
          prefs.weightUnit
        ),
        bodyFatPct: str("body_fat_pct"),
        restingHr: str("resting_hr"),
        notes: str("notes"),
      }) || wrote;
  }

  // 2. Vitals (medical_records + the sleep/HRV metric samples).
  const anyVital = [
    "systolic",
    "diastolic",
    "glucose",
    "spo2",
    "temperature",
    "sleep_hours",
    "hrv",
    "peak_flow",
  ].some(filled);
  if (anyVital) {
    wrote =
      insertVitals(profile.id, date, {
        systolic: str("systolic"),
        diastolic: str("diastolic"),
        glucose: str("glucose"),
        glucoseUnit: str("glucose_unit"),
        spo2: str("spo2"),
        temperature: str("temperature"),
        tempUnit: str("temp_unit"),
        temperatureTime: str("temp_time"),
        sleepHours: str("sleep_hours"),
        hrv: str("hrv"),
        // Peak expiratory flow (#1850) — a vital like the rest, carried by the same
        // form and the same core. Its optional clock time rides along so a second
        // blow the same day lands as a second reading.
        peakFlow: str("peak_flow"),
        peakFlowTime: str("peak_flow_time"),
        // The three #158 functional-fitness markers (grip / chair stand /
        // single-leg balance) are DELIBERATELY absent: they are
        // assessment-cadence measures and moved to the guided Fitness check on
        // /training (#1275). Their canonical storage is unchanged — the same
        // medical_records vitals rows under the same canonical names — only the
        // entry surface moved, so nothing here needs to know about them.
      }) || wrote;
  }

  // 3. Growth (metric_samples), life-stage-gated in the form: only a minor's form
  //    renders these fields, so an adult submission never carries them.
  if (filled("height") || filled("head_circ")) {
    wrote =
      insertGrowth(profile.id, date, {
        height: str("height"),
        heightUnit: str("height_unit"),
        headCirc: str("head_circ"),
        headCircUnit: str("head_circ_unit"),
      }) || wrote;
  }

  if (!wrote) return;
  revalidatePath("/trends");
  revalidatePath("/results");
  revalidatePath("/sleep");
  revalidatePath("/");
}
