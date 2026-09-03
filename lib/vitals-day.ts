// A vital reading's CLOCK TIME — PURE. The 1D intraday layer this module used to
// model (#1466) retired with #4767 (the /history day view is the one intraday
// surface); what stays is the one conversion its consumers still need: turning a
// reading's stated `occurred_at`, or the ABSOLUTE instant Health Connect stores in
// `external_id`, into the profile's wall clock, gated on landing back on the row's
// own day. No DB, no React, no clock.

import { zonedDateParts } from "./date";

// ── Reading time ─────────────────────────────────────────────────────────────

// The minimal row shape the intraday formatter reads. A structural subset of
// ClinicalObservation (and satisfiable by a synthetic {date, value_num} for the daily
// aggregates), so the section can hand this module the rows it already has.
export interface VitalReadingRow {
  id?: number;
  date: string;
  value_num: number | null;
  external_id?: string | null;
  // The stated event instant (migration 165, #2154/#2235): canonical UTC `Z`
  // shape, or null/absent for a day-grain reading. THE time source — the column
  // that MEANS "when this reading was taken". (The retired #800 notes-"HH:MM"
  // convention moved into it in migration 171, so notes are not read here at
  // all.)
  occurred_at?: string | null;
}

// The trailing ISO instant of an ingest external_id
// ("health-connect:Blood Pressure Systolic:2026-07-25T07:10:00Z"). The canonical
// name segment never contains a date, so the first date-shaped match IS the
// timestamp. LEGACY-ROW SUPPORT ONLY (#2154): every current writer states the
// instant in `occurred_at`, but a device row imported before that has it nowhere
// else — the rolling-window re-sync backfills recent rows, the older tail keeps
// only this encoding, and a backfill migration for a dedupe key's freetext was
// deliberately not written. Remove this fallback only with that decision.
const TRAILING_INSTANT = /(\d{4}-\d{2}-\d{2}T\S+)$/;

// The reading's local clock time, or null when the row is genuinely day-granular
// (an untimed manual entry, a daily aggregate) and therefore has no time to show.
//
// The row's `date` stays authoritative for WHICH day the reading belongs to. A
// derived clock is only trusted when it lands back on that same day: if it doesn't,
// the profile's timezone changed after ingest and the wall time would name a
// different day than the row it labels — better no time than a wrong one.
export function vitalReadingTime(
  row: VitalReadingRow,
  tz: string
): string | null {
  // The declared event column first: a stated `occurred_at` is the reading's own
  // answer to "when", so the legacy encoding below never overrides it. Same
  // same-day gate as the ingest instant — a statement whose wall time no longer
  // lands on the row's day (the profile's timezone changed since it was stated)
  // shows no time rather than a wrong one.
  if (row.occurred_at) {
    const at = new Date(row.occurred_at);
    if (!Number.isNaN(at.getTime())) {
      const parts = zonedDateParts(tz, at);
      if (parts.date === row.date) return parts.hhmm;
    }
  }
  const match = TRAILING_INSTANT.exec(row.external_id ?? "");
  if (!match) return null;
  const at = new Date(match[1]);
  if (Number.isNaN(at.getTime())) return null;
  const parts = zonedDateParts(tz, at);
  return parts.date === row.date ? parts.hhmm : null;
}
