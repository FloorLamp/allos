"use server";
import { requireWriteAccess } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db, writeTx } from "@/lib/db";
import { isRealIsoDate } from "@/lib/date";
import { normalizeGrowthInput } from "@/lib/growth-input";

// Manual height / head-circumference write path (kids growth trends). Height and
// head circumference have a single home in metric_samples (metrics 'height_cm' /
// 'head_circumference_cm') — the SAME place the document-extraction writers land
// them (lib/import-persist) — so a manually entered value feeds the WHO/CDC growth
// charts and the height/head-circ Body charts identically to an imported reading.
//
// A point metric uses a fixed midnight start for the date, so the natural key
// (profile_id, metric, source='manual', origin=NULL, start_time) is stable across
// re-entries: logging the same date again CORRECTS that day rather than stacking a
// second point. source='manual' also means an integration/document push (which
// carries its own source) never reads or clobbers a manual row.
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
     ON CONFLICT DO UPDATE SET
       value = excluded.value, date = excluded.date`
  ).run(profileId, metric, date, ts, ts, value);
}

export async function addGrowth(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const date = String(formData.get("date") ?? "").trim();
  if (!isRealIsoDate(date)) return;

  // Normalize + validate with the same pure guard the client form ran, so a
  // crafted request can never persist an out-of-range/garbage value.
  const normalized = normalizeGrowthInput({
    height: formData.get("height") as string | null,
    heightUnit: formData.get("height_unit") as string | null,
    headCirc: formData.get("head_circ") as string | null,
    headCircUnit: formData.get("head_circ_unit") as string | null,
  });
  if ("error" in normalized) return;

  writeTx(() => {
    for (const s of normalized.samples) {
      upsertManualSample(profile.id, s.metric, date, s.value);
    }
  });

  revalidatePath("/trends");
  revalidatePath("/");
}
