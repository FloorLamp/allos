// The Trends → Vitals tab's TODAY layer (issue #1466) — PURE model.
//
// Two questions live here, and both are FORMATTERS over series the section already
// reads (#221 "one question, one computation" — no second data path is opened):
//
//   A. "What are my vitals right now?" — the latest reading of each vital on the
//      profile's today, with its clock time, for the Today strip.
//   B. "What did today actually look like?" — the 1D (intraday) swap: readings
//      positioned on a fixed 5-minute slot grid spanning 00:00–24:00.
//
// WHY A SLOT GRID (and not the #402 epoch axis). recharts treats a string dataKey
// as a CATEGORY axis, where x-position is the array INDEX — which is exactly the
// distortion #402 fixes for a SPARSE daily series (the categories are the readings
// themselves, so a 4-year gap renders as wide as a day). Here the categories are
// the DAY'S OWN uniform 5-minute slots, present whether or not a reading landed in
// them, so index IS proportional to time by construction and a wear gap is a run of
// nulls with real width. Same honesty as the numeric time axis, without a second
// chart component.
//
// No DB, no React, no clock: every input is already profile-local (medical_records
// `date` is day-granular by contract, hr_minutes.ts is a local stamp by design —
// #94). The one conversion this module does is turning an ingested ABSOLUTE instant
// (Health Connect stores the reading's timestamp in `external_id`) into the
// profile's wall clock, and it is gated on landing back on the row's own day.

import { zonedDateParts } from "./date";
import {
  clockMinute,
  downsampleHr,
  INTRADAY_BUCKET_MINUTES,
  MINUTES_IN_DAY,
  type IntradayHrBucket,
} from "./intraday";

// ── Reading time ─────────────────────────────────────────────────────────────

// The minimal row shape both layers read. Deliberately a structural subset of
// MedicalRecord (and satisfiable by a synthetic {date, value_num} for the daily
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

// ── A. The Today strip ───────────────────────────────────────────────────────

export interface VitalReading {
  value: number;
  // Local "HH:MM", or null for a day-granular reading.
  time: string | null;
}

// The latest numeric reading of ONE vital on `date`, or null when the day carries
// none. "Latest" is by clock time where the rows have one, falling back to insert
// order (id) — the same tie-break the series queries use (date, then id).
export function latestVitalOn(
  rows: VitalReadingRow[],
  date: string,
  tz: string
): VitalReading | null {
  let best: VitalReading | null = null;
  let bestMinute = -1;
  let bestId = -1;
  for (const row of rows) {
    if (row.date !== date) continue;
    const value = row.value_num;
    if (value == null || !Number.isFinite(value)) continue;
    const time = vitalReadingTime(row, tz);
    const minute = time != null ? (clockMinute(time) ?? -1) : -1;
    const id = row.id ?? 0;
    if (
      best != null &&
      (minute < bestMinute || (minute === bestMinute && id < bestId))
    ) {
      continue;
    }
    best = { value, time };
    bestMinute = minute;
    bestId = id;
  }
  return best;
}

// One vital's entry in the strip spec. `pairRows` exists for blood pressure, which
// is TWO stored analytes but ONE reading a person recognizes — it renders as a
// single "118/76" cell rather than two half-answers.
export interface TodayVitalSpec {
  key: string;
  label: string;
  unit: string;
  rows: VitalReadingRow[];
  pairRows?: VitalReadingRow[];
  decimals?: number;
  // Cumulative quantities such as steps are easier to scan with digit grouping.
  groupThousands?: boolean;
}

export interface TodayVitalRow {
  key: string;
  label: string;
  value: string;
  unit: string;
  time: string | null;
}

function formatValue(value: number, decimals = 0): string {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return String(rounded);
}

// The Today strip's rows: the latest reading of each spec'd vital on `date`, in the
// spec's order, with vitals that have nothing today DROPPED. An empty day therefore
// returns [] and the caller renders no strip at all — never an empty frame.
export function buildTodayVitalsStrip(
  specs: TodayVitalSpec[],
  date: string,
  tz: string
): TodayVitalRow[] {
  const out: TodayVitalRow[] = [];
  for (const spec of specs) {
    const primary = latestVitalOn(spec.rows, date, tz);
    if (!primary) continue;
    const decimals = spec.decimals ?? 0;
    let value = spec.groupThousands
      ? Math.round(primary.value).toLocaleString("en-US")
      : formatValue(primary.value, decimals);
    if (spec.pairRows) {
      const secondary = latestVitalOn(spec.pairRows, date, tz);
      if (secondary)
        value = `${value}/${formatValue(secondary.value, decimals)}`;
    }
    out.push({
      key: spec.key,
      label: spec.label,
      value,
      unit: spec.unit,
      time: primary.time,
    });
  }
  return out;
}

// ── B. The 1D intraday swap ──────────────────────────────────────────────────

// The slot width of the intraday grid — the SAME bucket the #1068 panel
// downsamples HR to, so the two surfaces resolve the day identically.
export const VITALS_SLOT_MINUTES = INTRADAY_BUCKET_MINUTES;

export interface IntradayVitalPoint {
  minute: number;
  value: number;
  time: string;
}

// A day's TIMED readings of one vital, ascending. Rows with no resolvable clock
// time are excluded on purpose: an untimed reading cannot be positioned honestly on
// a clock axis, so it stays in the Today strip instead of being pinned to a lie.
export function intradayVitalPoints(
  rows: VitalReadingRow[],
  date: string,
  tz: string
): IntradayVitalPoint[] {
  const out: IntradayVitalPoint[] = [];
  for (const row of rows) {
    if (row.date !== date) continue;
    const value = row.value_num;
    if (value == null || !Number.isFinite(value)) continue;
    const time = vitalReadingTime(row, tz);
    if (time == null) continue;
    const minute = clockMinute(time);
    if (minute == null) continue;
    out.push({ minute, value, time });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

// "HH:MM" for a minute past local midnight (the slot grid's category labels).
export function slotLabel(minute: number): string {
  const m = Math.max(0, Math.trunc(minute));
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// The chart series: one entry per slot across the whole local day, value null where
// nothing was measured. The full-day grid is the point — it is what makes x
// proportional to time, and what lets a wear gap render as a break (the caller
// passes connectNulls={false}) instead of a straight line implying a measured flat.
export function toIntradaySlotSeries(
  points: { minute: number; value: number }[],
  slotMinutes = VITALS_SLOT_MINUTES
): { date: string; value: number | null }[] {
  const width = Math.max(1, Math.trunc(slotMinutes));
  const slots = Math.ceil(MINUTES_IN_DAY / width);
  const values = new Array<number | null>(slots).fill(null);
  const filledAt = new Array<number>(slots).fill(-1);
  for (const p of points) {
    if (!Number.isFinite(p.minute) || !Number.isFinite(p.value)) continue;
    if (p.minute < 0 || p.minute >= MINUTES_IN_DAY) continue;
    const slot = Math.floor(p.minute / width);
    // Later minute wins within a slot, so the label reads as "the reading at
    // (about) this time" rather than whichever row happened to be enumerated last.
    if (p.minute < filledAt[slot]) continue;
    values[slot] = p.value;
    filledAt[slot] = p.minute;
  }
  return values.map((value, slot) => ({
    date: slotLabel(slot * width),
    value,
  }));
}

// The day's HR line, on the same slot grid — over the SAME downsampleHr the #1068
// intraday panel uses (one computation; this surface is another formatter of it).
export function hrSlotSeries(
  date: string,
  buckets: IntradayHrBucket[]
): { date: string; value: number | null }[] {
  const points = downsampleHr(date, buckets, VITALS_SLOT_MINUTES).map((p) => ({
    minute: p.minute,
    value: p.bpm,
  }));
  if (points.length === 0) return [];
  return toIntradaySlotSeries(points);
}
