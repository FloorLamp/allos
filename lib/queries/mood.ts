// Read layer for the daily wellbeing check (issue #992). Every statement filters
// by profile_id (mood_logs is profile-owned). Reads only — the ONE write core is
// upsertMoodLog in lib/offline/writes.ts, shared by the server action, the
// offline-queue replay, and the Telegram check-in button.
//
// DELIBERATELY no flag/retest plumbing: mood is a subjective self-rating, never a
// lab — this module must never import the reference-range/flag engine or feed the
// retest machinery (pinned by lib/__tests__/mood-guardrails.test.ts).

import { db } from "../db";
import { parseMoodFactors, type MoodRatingColumn } from "../mood";

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

// The mood readings a metric detail page's table lists (issue #1488), newest first.
// A plain profile-scoped read of the same rows the trend draws — kept HERE, in the
// mood store's read layer, so the mood_logs table stays store-private (#992): the
// detail page and its row-CRUD talk to this module rather than naming the table.
//
// `column` picks WHICH of the row's three 1–5 ratings the table lists (#1408): energy
// and the Calm scale got trends and detail pages of their own, and each lists only the
// days that actually carry that rating — an unanswered scale is an absent reading, not
// a zero. Values come out in STORED semantics; the anxiety→calm relabel is the
// caller's display boundary, the same place weight's unit conversion happens.
export function getMoodReadings(
  profileId: number,
  limit: number,
  column: MoodRatingColumn = "valence"
): { id: number; date: string; value: number; notes: string | null }[] {
  return moodReadingSelect(column).all(profileId, limit) as {
    id: number;
    date: string;
    value: number;
    notes: string | null;
  }[];
}

// Three literal statements rather than one interpolated column, for the same reason
// `bodyMetricSelect` in lib/metric-readings.ts has several: the profile-scoping
// scanner verifies `profile_id` in LITERAL prepare() text, so a scannable statement
// beats a clever one in the layer that decides whose rows you see.
function moodReadingSelect(column: MoodRatingColumn) {
  switch (column) {
    case "valence":
      return db.prepare(
        `SELECT id, date, valence AS value, notes
           FROM mood_logs WHERE profile_id = ?
          ORDER BY date DESC, id DESC LIMIT ?`
      );
    case "energy":
      return db.prepare(
        `SELECT id, date, energy AS value, notes
           FROM mood_logs WHERE profile_id = ? AND energy IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT ?`
      );
    case "anxiety":
      return db.prepare(
        `SELECT id, date, anxiety AS value, notes
           FROM mood_logs WHERE profile_id = ? AND anxiety IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT ?`
      );
  }
}
