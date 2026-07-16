// Read layer for the symptom log (issue #799). Profile-scoped reads over the owned
// symptom_logs table (every statement names profile_id — the scoping rule). Pure display
// mapping (labels, custom-vs-curated) lives in lib/symptoms; this module only fetches.

import { db, today } from "../db";
import { isCustomSymptomKey, symptomSlugs } from "../symptoms";
import { rankByRecentFrequency } from "../rank-by-frequency";
import { recentWindowStart } from "./training/common";

export interface SymptomDayEntry {
  symptom: string; // stored key (curated slug or custom name)
  severity: number; // 1–4
  note: string | null;
}

// The symptoms logged on a specific day, worst-first then alphabetical — the dashboard
// card / timeline day view render these.
export function getSymptomsOnDate(
  profileId: number,
  date: string
): SymptomDayEntry[] {
  return db
    .prepare(
      `SELECT symptom, severity, note FROM symptom_logs
        WHERE profile_id = ? AND date = ?
        ORDER BY severity DESC, symptom COLLATE NOCASE`
    )
    .all(profileId, date) as SymptomDayEntry[];
}

// The severities logged on a day as a keyed record (symptom key → severity) — the shape
// the one-tap bar seeds its optimistic state from.
export function getSymptomSeveritiesOnDate(
  profileId: number,
  date: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of getSymptomsOnDate(profileId, date))
    out[r.symptom] = r.severity;
  return out;
}

// The distinct CUSTOM symptom names this profile has ever logged (not the curated
// catalog) — the vocabulary the #203 rename/delete management UI operates on and that the
// bar shows as extra chips. Newest-used first.
export function getCustomSymptomNames(profileId: number): string[] {
  const rows = db
    .prepare(
      `SELECT symptom, MAX(date) AS last_date FROM symptom_logs
        WHERE profile_id = ?
        GROUP BY symptom
        ORDER BY last_date DESC, symptom COLLATE NOCASE`
    )
    .all(profileId) as { symptom: string; last_date: string }[];
  return rows.map((r) => r.symptom).filter((s) => isCustomSymptomKey(s));
}

// The notes logged on a specific day as a keyed record (symptom key → note) — the shape
// the one-tap bar seeds its per-symptom note affordance from (#857). Only symptom-days
// that actually carry a note appear.
export function getSymptomNotesOnDate(
  profileId: number,
  date: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of getSymptomsOnDate(profileId, date))
    if (r.note) out[r.symptom] = r.note;
  return out;
}

// The picker order for the symptom-log bar (#857): the curated catalog + any custom
// names this profile has logged, ranked so the family's recurring symptoms lead —
// recency-decayed frequency over the recent window, the SAME `rankByRecentFrequency`
// computation the food-log bar uses (#591). Each symptom-day counts once (severity does
// not weight the picker — a mild recurring symptom is still a usual suspect). Returns
// stored keys (curated slugs + custom names); catalog order breaks ties and is the whole
// order for a fresh profile. Profile-scoped via the symptom_logs filter.
export function getSymptomLogOrder(profileId: number): string[] {
  const rows = db
    .prepare(
      `SELECT symptom AS name, date FROM symptom_logs
        WHERE profile_id = ? AND date >= ?`
    )
    .all(profileId, recentWindowStart(profileId)) as {
    name: string;
    date: string;
  }[];
  return rankByRecentFrequency(symptomSlugs(), rows, today(profileId));
}

export interface SymptomDayRollup {
  date: string;
  count: number;
  maxSeverity: number;
  symptoms: SymptomDayEntry[];
}

// Symptom-days in a window, newest-first, each rolled up (count + worst severity + the
// per-symptom entries) — the timeline groups one event per day from this.
export function getSymptomDaysInRange(
  profileId: number,
  from: string | undefined,
  to: string | undefined,
  limit = 250
): SymptomDayRollup[] {
  const parts: string[] = [];
  const params: (string | number)[] = [profileId];
  if (from) {
    parts.push("date >= ?");
    params.push(from);
  }
  if (to) {
    parts.push("date <= ?");
    params.push(to);
  }
  const where = parts.length ? ` AND ${parts.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT date, symptom, severity, note FROM symptom_logs
        WHERE profile_id = ?${where}
        ORDER BY date DESC, severity DESC, symptom COLLATE NOCASE`
    )
    .all(...params) as (SymptomDayEntry & { date: string })[];
  const byDay = new Map<string, SymptomDayRollup>();
  for (const r of rows) {
    let day = byDay.get(r.date);
    if (!day) {
      day = { date: r.date, count: 0, maxSeverity: 0, symptoms: [] };
      byDay.set(r.date, day);
    }
    day.count += 1;
    day.maxSeverity = Math.max(day.maxSeverity, r.severity);
    day.symptoms.push({
      symptom: r.symptom,
      severity: r.severity,
      note: r.note,
    });
  }
  return Array.from(byDay.values()).slice(0, limit);
}
