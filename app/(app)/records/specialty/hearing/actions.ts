"use server";
import { requireWriteAccess } from "@/lib/auth";
import { revalidateRoute } from "@/lib/revalidate";
import { isRealIsoDate } from "@/lib/date";
import { formError, formOk, type FormResult } from "@/lib/types";
import {
  AUDIOGRAM_EARS,
  AUDIOGRAM_FREQUENCIES_HZ,
  audiogramFieldName,
} from "@/lib/audiogram";
import {
  deleteAudiogram,
  recordAudiogram,
  type AudiogramThresholdInput,
} from "@/lib/audiogram-records";

// Hearing / audiogram writes (issue #1600). The request boundary: authorization,
// validation, and revalidation live here; the write itself is the auth-blind,
// profileId-first core in lib/audiogram-records.ts, which stores each threshold as a
// canonical `vitals` medical_records row (the store decision is argued at the top of
// lib/audiogram.ts). Nothing here builds SQL.

function revalidateHearing() {
  revalidateRoute("/records");
  // The thresholds ARE biomarker readings, so every surface that reads them must
  // refresh with them: the Results catalog + per-analyte views, the dashboard's
  // recent/needs-attention summaries, and the medication safety strips + Upcoming,
  // whose ototoxic note now cites this baseline.
  revalidateRoute("/results");
  revalidateRoute("/results/readings/view", "page");
  revalidateRoute("/medications");
  revalidateRoute("/upcoming");
  revalidateRoute("/");
}

// An audiometer reads roughly −10 dB HL (better than "normal") to 120 dB HL (the
// output limit). Anything outside that is a typo, not a measurement, so it is dropped
// rather than stored — a 400 dB HL threshold would poison the series and the shift
// math. A blank field means "not tested", which is a real and common answer.
const MIN_DB_HL = -10;
const MAX_DB_HL = 120;

function parseThresholds(formData: FormData): AudiogramThresholdInput[] {
  const out: AudiogramThresholdInput[] = [];
  for (const ear of AUDIOGRAM_EARS) {
    for (const hz of AUDIOGRAM_FREQUENCIES_HZ) {
      const raw = String(
        formData.get(audiogramFieldName(ear, hz)) ?? ""
      ).trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < MIN_DB_HL || n > MAX_DB_HL) continue;
      // Audiometry is measured in 5 dB steps; store whole decibels so a stray
      // decimal can't imply precision the test doesn't have.
      out.push({ ear, hz, dbHl: Math.round(n) });
    }
  }
  return out;
}

export async function addAudiogram(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date)) return formError("Enter the date of the test.");
  const thresholds = parseThresholds(formData);
  const outcome = recordAudiogram(profile.id, {
    date,
    thresholds,
    notes: String(formData.get("notes") ?? ""),
  });
  // Typed outcome, rendered rather than assumed: an all-blank submit stored nothing,
  // and saying "saved" would be a lie the list would immediately contradict.
  if (outcome.kind === "no-thresholds")
    return formError("Enter at least one threshold, in dB HL.");
  revalidateHearing();
  return formOk();
}

export async function removeAudiogram(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date))
    return formError("Couldn't find that hearing test.");
  const outcome = deleteAudiogram(profile.id, date);
  if (outcome.kind === "not-found")
    return formError("Couldn't find that hearing test.");
  revalidateHearing();
  return formOk();
}
