// Read layer for the daily wellbeing check (issue #992). Every statement filters
// by profile_id (mood_logs is profile-owned). Reads only — the ONE write core is
// upsertMoodLog in lib/offline/writes.ts, shared by the server action, the
// offline-queue replay, and the Telegram check-in button.
//
// DELIBERATELY no flag/retest plumbing: mood is a subjective self-rating, never a
// lab — this module must never import the reference-range/flag engine or feed the
// retest machinery (pinned by lib/__tests__/mood-guardrails.test.ts).

import { db } from "../db";
import { parseMoodFactors } from "../mood";

export interface MoodLog {
  id: number;
  date: string;
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string[];
  notes: string | null;
}

interface MoodLogRow {
  id: number;
  date: string;
  valence: number;
  energy: number | null;
  anxiety: number | null;
  factors: string | null;
  notes: string | null;
}

function toMoodLog(r: MoodLogRow): MoodLog {
  return {
    id: r.id,
    date: r.date,
    valence: r.valence,
    energy: r.energy,
    anxiety: r.anxiety,
    factors: parseMoodFactors(r.factors),
    notes: r.notes,
  };
}

// All mood check-ins on/after `since` (or all history when omitted), ascending by
// date — one row per day by the table's UNIQUE(profile_id, date) key.
export function getMoodLogs(profileId: number, since?: string): MoodLog[] {
  const rows = (
    since
      ? db
          .prepare(
            `SELECT id, date, valence, energy, anxiety, factors, notes
               FROM mood_logs WHERE profile_id = ? AND date >= ?
              ORDER BY date`
          )
          .all(profileId, since)
      : db
          .prepare(
            `SELECT id, date, valence, energy, anxiety, factors, notes
               FROM mood_logs WHERE profile_id = ?
              ORDER BY date`
          )
          .all(profileId)
  ) as MoodLogRow[];
  return rows.map(toMoodLog);
}

// The day's check-in, or null when the day is unlogged.
export function getMoodOnDate(profileId: number, date: string): MoodLog | null {
  const row = db
    .prepare(
      `SELECT id, date, valence, energy, anxiety, factors, notes
         FROM mood_logs WHERE profile_id = ? AND date = ?`
    )
    .get(profileId, date) as MoodLogRow | undefined;
  return row ? toMoodLog(row) : null;
}

// Whether the profile has EVER logged an anxiety rating — the "prior use" signal of
// the check-in Calm-scale relevance gate (issue #1313, signal 1: continuity trumps
// inference, so a profile that's used the scale keeps it). Kept here in the mood
// store's read layer (not the gate resolver) so the mood_logs table stays store-
// private — a plain read, never a flag/retest/streak engine (the #992 contract).
export function hasPriorAnxietyLog(profileId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM mood_logs WHERE profile_id = ? AND anxiety IS NOT NULL LIMIT 1`
      )
      .get(profileId) != null
  );
}
