"use server";
import { requireSession } from "@/lib/auth";
import { gateItemProfile } from "../gate-item";

import { revalidateRoute } from "@/lib/revalidate";
import { getUnitPrefs } from "@/lib/settings";
import { submittedWeightUnit } from "@/lib/units";
import {
  insertBodyMetric,
  insertComposition,
  insertGrowth,
  insertWaistCirc,
  insertVitals,
} from "@/lib/offline/writes";
import { today } from "@/lib/db";
import { isPastWriteAccepted } from "@/lib/log-manifest";
import type { StatedTimeRefusal } from "@/lib/stated-time";
import type { SleepWindowRefusal } from "@/lib/vitals-input";
import { LOGGED_VIA_FIELD, parseWebOrigin, type StampedFormData } from "@/lib/logged-via";

// The combined "Log measurements" write path (issue #1486).
//
// The Body and Vitals tabs each carried their own quick-add (plus a third,
// growth-only form for a minor), so logging a morning's weigh-in + blood pressure
// meant two forms on two tabs. #1486 merges the TAB, and this merges its write: one
// action over the THREE existing write cores, chosen by which fields the submission
// actually carries.
//
// It adds NO write path. `insertBodyMetric` / `insertVitals` / `insertGrowth` /
// `insertWaistCirc` are the same auth-blind, profileId-first cores the offline replay
// route runs, so a value entered here is byte-for-byte the value the old per-domain
// form wrote — same tables, same canonical names, same reference-range reconcile.
// They stay SEPARATE cores because they land in different stores (body_metrics,
// medical_records + metric_samples, metric_samples); this action is the composition,
// not another writer.
//
// PARTIAL SUBMISSIONS ARE THE NORM. Every field is optional and a section whose
// fields are all blank is simply skipped, so "log only a BP" writes no body_metrics
// row and "log only a weight" writes no vitals rows. Each core independently
// rejects an invalid/empty payload (returning false), and the action revalidates
// only when at least one of them actually persisted something.

// What the submission did with the sitting's stated time (#2311, completed by
// #2363). The measurements ALWAYS land — that posture is #2296's, unchanged — so
// this is a NOTICE the form says out loud, never an error and never a reason to
// fail the write. Absent whenever nobody stated a time, the common case.
//
// It is the SITTING'S answer now, not the body half's. It used to be reported off
// `insertBodyMetric` alone because `insertVitals` answered a bare `boolean` and had
// nowhere to put a verdict, so "log only a BP with a refused Time" saved in silence
// while "log a weight AND a BP" reported — an asymmetry that turned on which fields
// the user happened to fill. Both halves resolve ONE statement through ONE gate
// (`resolveStatedOccurredAt`), so their verdicts agree by construction and taking
// whichever answered is not a choice between two opinions.
export interface MeasurementsSaveResult {
  statedTimeRefused?: StatedTimeRefusal;
  // Why the night's bed/wake clocks did not survive the write (#1851) — a NOTICE
  // on a successful save, exactly like the one above.
  sleepWindowRefused?: SleepWindowRefusal;
  // THE ONE FIELD HERE THAT IS A REFUSAL RATHER THAN A NOTICE (#4425). Nothing was
  // written and the form must say so: without it this action answers a refused day
  // with `{}`, which is byte-identical to a clean save that stated no time, and the
  // form toasts "Measurements saved" over an empty table.
  dateRefused?: true;
}

export async function addMeasurements(
  formData: StampedFormData
): Promise<MeasurementsSaveResult> {
  // #4932: the quick-log sheet's subject chip mounts this SAME form cross-profile,
  // so the write follows `gateItemProfile` like every other sheet body — posted
  // `profile_id` → requireProfileWriteAccess, absent → acting profile. `login` is
  // resolved separately because unit prefs are login-scoped, not profile-scoped, and
  // must not gate on a subject that might not be the acting profile.
  const { login } = await requireSession();
  const profileId = await gateItemProfile(formData);
  const profile = { id: profileId };
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

  // THE DAY IS JUDGED AT THIS DOOR, ONCE, for the reason `insertVitals` judges it at
  // its own: the five cores below each hold the shared invariant, so asking after the
  // fan-out could only tell us that SOMETHING refused — indistinguishable from a
  // submission with no fields filled, which is also `wrote: false` and is not an error.
  // Asked here, the refusal has a name and the form can say it. The predicate is the
  // exported one the cores run, so this cannot drift into a second policy.
  if (!isPastWriteAccepted(today(profile.id), date))
    return { dateRefused: true };

  let wrote = false;
  let statedTimeRefused: StatedTimeRefusal | undefined;
  let sleepWindowRefused: SleepWindowRefusal | undefined;

  // ONE SUBMISSION, ONE SURFACE (#3087). This form is mounted on the Trends
  // measurements panel, on a metric detail page and in the quick-log sheet, so the
  // surface is the client's to declare and `page` is this action's own home. Read
  // ONCE and handed to both write cores below: the body half and the vitals half are
  // two cores serving one form, and they used to disagree — the body half stamped
  // `page` while the vitals half spelled `offline-replay` twenty-seven lines later.
  const loggedVia = parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page");

  // 1. Body composition (body_metrics). Each nullable measurement can be recorded
  //    independently; this matters on a metric detail page whose form contains
  //    exactly one field rather than the whole body-composition trio.
  if (filled("weight") || filled("body_fat_pct") || filled("resting_hr")) {
    // The sitting's stated time (#2235): the form always posts the field, so an
    // empty value is the user's explicit "no time" (clears a stated one on a
    // resubmission), while a submission with no field at all — a stale pre-#2235
    // client — makes no statement and leaves any stored time alone. The core runs
    // the acceptance gate; nothing is trusted here.
    const occurredAtRaw = formData.get("occurred_at");
    const body = insertBodyMetric(profile.id, {
      date,
      weight: String(formData.get("weight") ?? ""),
      weightUnit: submittedWeightUnit(
        formData.get("weight_unit"),
        prefs.weightUnit
      ),
      bodyFatPct: str("body_fat_pct"),
      restingHr: str("resting_hr"),
      notes: str("notes"),
      occurredAt:
        occurredAtRaw === null
          ? undefined
          : String(occurredAtRaw).trim() || null,
      // The surface the sitting was entered on, declared by the mounting.
      loggedVia,
    });
    wrote = body.wrote || wrote;
    // The gate's verdict, threaded out rather than re-derived (#2311): the core
    // already asked, against the server's clock and the profile's zone.
    if (body.wrote) statedTimeRefused = body.statedTimeRefused;
  }

  // 2. Vitals (medical_records + the sleep/HRV metric samples).
  const anyVital = [
    "systolic",
    "diastolic",
    "glucose",
    "spo2",
    "temperature",
    "sleep_hours",
    "bed_time",
    "wake_time",
    "hrv",
    "respiratory_rate",
    "peak_flow",
  ].some(filled);
  if (anyVital) {
    // The sitting's stated time (#2154), same wire trichotomy as the body half
    // above: the form always posts `occurred_at`, so an empty value is the user's
    // explicit "no time", while a submission with no field at all (a stale
    // pre-#2235 client) makes no statement. The core runs the acceptance gate;
    // nothing is trusted here. An observation row is always a fresh insert, so
    // "no statement" and "no time" both land as honest NULL on it.
    const occurredAtRaw = formData.get("occurred_at");
    const vitals = insertVitals(
      profile.id,
      date,
      {
        systolic: str("systolic"),
        diastolic: str("diastolic"),
        glucose: str("glucose"),
        glucoseUnit: str("glucose_unit"),
        spo2: str("spo2"),
        temperature: str("temperature"),
        tempUnit: str("temp_unit"),
        sleepHours: str("sleep_hours"),
        // The night's bed/wake pair (#1851) — profile-local clocks the core
        // resolves against this profile's zone, never here.
        bedTime: str("bed_time"),
        wakeTime: str("wake_time"),
        hrv: str("hrv"),
        // Respiratory rate (#1851) — a vital like the rest, carried by the same
        // form and the same core onto the same canonical name.
        respiratoryRate: str("respiratory_rate"),
        // Peak expiratory flow (#1850) — a vital like the rest, carried by the
        // same form and the same core. Its clock time is the sitting statement
        // below, so a second blow the same day lands as a second reading.
        peakFlow: str("peak_flow"),
        // LEGACY (#2154 fold): the live form no longer renders per-measure time
        // inputs, but a stale pre-fold tab still posts these — passing them
        // through keeps its stated times instead of silently dropping them.
        temperatureTime: str("temp_time"),
        peakFlowTime: str("peak_flow_time"),
        // The three #158 functional-fitness markers (grip / chair stand /
        // single-leg balance) are DELIBERATELY absent: they are
        // assessment-cadence measures and moved to the guided Fitness check on
        // /training (#1275). Their canonical storage is unchanged — the same
        // medical_records vitals rows under the same canonical names — only the
        // entry surface moved, so nothing here needs to know about them.
      },
      loggedVia,
      occurredAtRaw === null ? undefined : String(occurredAtRaw).trim() || null
    );
    wrote = vitals.wrote || wrote;
    // The sitting's verdict, from whichever half was submitted (#2363). The body
    // half above set it from the same one statement, so this cannot contradict it;
    // a vitals-only sitting is the case that used to have no voice at all.
    if (vitals.wrote && vitals.statedTimeRefused) {
      statedTimeRefused = vitals.statedTimeRefused;
    }
    // The night's clocks, when the core could not keep them (#1851). Only the
    // vitals half writes sleep, so unlike the stated time there is one producer.
    if (vitals.wrote) sleepWindowRefused = vitals.sleepWindowRefused;
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

  // 4. Waist circumference (metric_samples) — ungated: a tape reading applies at
  //    every life stage, so unlike the growth pair above it is always rendered and
  //    always accepted (#2322).
  if (filled("waist_circ")) {
    wrote =
      insertWaistCirc(profile.id, date, {
        waistCirc: str("waist_circ"),
        waistCircUnit: str("waist_circ_unit"),
      }) || wrote;
  }

  // 5. Lean mass / bone mass / hydration (metric_samples). The day's water is ungated
  //    like the waist tape above; lean and bone mass are NOT, since #4147 — they are
  //    body composition off the same DEXA reading as the body-fat figure, and the form
  //    gates all three off a growth-tracked profile as one class. Gated in the FORM
  //    only, exactly as body fat has been since #493.
  if (filled("lean_mass") || filled("bone_mass") || filled("hydration")) {
    wrote =
      insertComposition(profile.id, date, {
        leanMass: str("lean_mass"),
        leanMassUnit: str("lean_mass_unit"),
        boneMass: str("bone_mass"),
        boneMassUnit: str("bone_mass_unit"),
        hydration: str("hydration"),
      }) || wrote;
  }

  if (!wrote) return {};
  revalidateRoute("/trends");
  revalidateRoute("/results");
  revalidateRoute("/sleep");
  revalidateRoute("/");
  return {
    ...(statedTimeRefused ? { statedTimeRefused } : {}),
    ...(sleepWindowRefused ? { sleepWindowRefused } : {}),
  };
}
