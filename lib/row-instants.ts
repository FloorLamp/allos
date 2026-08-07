// THE ROW-LEVEL TIME QUESTION (issue #2205, phase 3).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
//
// lib/date.ts settled the VALUE-level questions in phase 1: what shape a stored
// instant has (`utcInstant`), how to read one back (`parseUtcSql`), how to attribute
// one to a profile-local day (`localDayOf`, in lib/local-day-window.ts). What no
// module owned was the question one level up — "when did THIS ROW happen?" — so every
// surface answered it itself, and the answers diverged. `COALESCE(given_at, taken_at)`
// is hand-rolled a dozen times; food pairs `eaten_at ?? logged_at` in four more;
// practice reads a bare `time` that is not an instant at all. Two of those hand-rolls
// are what produced the wrong analyses this issue exists to prevent.
//
// The dose pairing turned out to be the more interesting one. Read as an event/record
// substitution it looked like the worst offender; the owner's ruling on #2205 settled
// that `given_at` is INFERRED from the tap and is therefore a RECORD instant, so the
// COALESCE was a fallback WITHIN one question all along and the hand-rolls had the
// right value under the wrong name. The consequence for this module was sharper, not
// softer: `intake_item_logs` had NO event column at all, so "when was this dose
// actually taken" was unanswerable for every row and the reader had to say so instead
// of handing back a tap stamp. Phase 2 wave 1 (migration 165) added the nullable
// `occurred_at`, filled only when somebody states a time — so that same question now
// answers `not-recorded` rather than `not-declared` for a row nobody timed, which is a
// different fact and a different arm of the union below. `body_metrics` and
// `medical_records` gained the column in the same migration, for the same reason.
//
// This module is that question, asked once, over the declared index in
// lib/time-columns.ts. A surface names a QUANTITY ("the event instant of this dose
// log"); it never names a column. Phase 2's renames therefore reach it through one
// registry entry, not through a second archaeology pass.
//
// ── WHY "NO EVENT INSTANT" IS A STATE AND NOT A NULL ─────────────────────────
//
// A food serving logged from the web bar has NO `eaten_at`: nobody said when they ate,
// and #2019 refuses to invent it. A quick-path practice tick has no `time`. Those rows
// do not have an unknown event instant that happens to be missing — they have no event
// instant, and the app knows it. Returning the RECORD instant there is precisely the
// substitution that makes "when did this happen" answer "when was this typed", which
// is how a distribution of eating times becomes a distribution of tapping times.
//
// So the return is a discriminated union with an explicit absent arm carrying a REASON
// — the shape METRIC_KNOWLEDGE uses for a metric with no clinical source, and
// FreshnessState uses for a reading that carries no clock. There is deliberately no
// `eventInstantOr(row, fallback)`: a caller that genuinely wants "the best instant we
// have" calls `bestKnownInstant`, which says which column it fell back to. The
// substitution stays available and stops being silent.
//
// ── WHY A TIMEZONE IS SOMETIMES REQUIRED ─────────────────────────────────────
//
// `practice_logs.time` is a profile-local HH:MM and `weather_uv_hours.hour_ts` is a
// zoneless local datetime. Neither denotes an instant on its own — you cannot know
// when a practice happened without knowing where. Rather than guessing UTC, the reader
// refuses with `needs-zone` until a caller supplies one. Where the instant IS
// reconstructed from a local wall clock the result is flagged `derived`, because such
// a value moves if the profile's timezone changes and a consumer that stores or
// compares it across zones should know.
//
// ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
//
// `date` semantics are untouched (#2205 constraint 4). A profile-local day is a
// different question from an instant, `rowLocalDay` below answers it from the STORED
// day whenever the table declares one, and it never derives a day from a record
// instant. Nothing here changes schema; phase 2 is a separate thread.
//
// PURE — no DB, no clock, no auth. Every function takes the row it was given.

import {
  parseUtcSql,
  toUtcInstant,
  utcInstant,
  zonedWallIsoToUtc,
  zonedWallTimeToUtc,
} from "./date";
import { localDayOf } from "./local-day-window";
import {
  TIME_COLUMNS,
  timeColumn,
  timeColumnsFor,
  type TemporalTable,
  type TimeColumn,
} from "./time-columns";

// Why a row has no instant for the semantic that was asked for. Each of these is a
// DIFFERENT fact, and collapsing any of them into "just use the other column" is the
// bug class #2205 exists to close.
export type InstantAbsence =
  // The table declares no column with that semantic. `substance_log` records when a
  // drink was LOGGED and nothing about when it was drunk; asking for its event
  // instant is a question the schema cannot answer, for every row, forever.
  | "not-declared"
  // The column exists and this row's value is NULL. Nobody stated an eating time; the
  // quick practice path recorded no clock. A real answer, not a gap to be filled.
  | "not-recorded"
  // The value is a profile-local wall clock and no timezone was supplied, so it does
  // not denote an instant yet.
  | "needs-zone"
  // The column is day-grained. A day is not a lesser instant (#94): `allergies
  // .onset_date` and `illness_episodes.started_at` are days despite their names, and
  // silently reading either as midnight-somewhere is a fabricated precision.
  | "day-only"
  // The declared grain is `mixed` — the column holds more than one shape, so a
  // generic reader must not pick one. The caller handles it explicitly or not at all.
  | "ambiguous"
  // A stored value that does not parse. Rare, and never silently swallowed.
  | "unreadable";

// The absent arm, shared by every reader below so one refusal shape covers instants
// and days alike.
export interface NoInstant {
  known: false;
  why: InstantAbsence;
  column: string | null;
}

export type RowInstant =
  | {
      known: true;
      // Always the canonical serialization (lib/date.ts `utcInstant`), whatever the
      // column stores. That is what makes a caller immune to phase 2's renames AND to
      // a later convention change: the reader normalizes, the surface never parses.
      at: string;
      column: string;
      // True when the instant was reconstructed from a profile-local wall clock, so it
      // is only as stable as the profile's timezone.
      derived: boolean;
    }
  | NoInstant;

const absent = (
  why: InstantAbsence,
  column: string | null = null
): NoInstant => ({
  known: false,
  why,
  column,
});

function cell(row: Record<string, unknown>, column: string): string | null {
  const v = row[column];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// Resolve ONE declared column of a row to an instant. Exported because it is the whole
// decision — the three readers below only choose which column to hand it — and because
// a grain arm that no current table reaches through `event`/`record` still has to be
// right the first time a phase-2 wave routes one here.
export function resolveInstant(
  col: TimeColumn,
  row: Record<string, unknown>,
  tz?: string,
  // The row's declared day column, needed only to place a bare HH:MM on a calendar.
  dayColumn?: string | null
): RowInstant {
  if (col.grain === "day") return absent("day-only", col.column);
  if (col.grain === "mixed") return absent("ambiguous", col.column);
  const raw = cell(row, col.column);
  if (raw === null) return absent("not-recorded", col.column);

  if (col.grain === "instant") {
    const at = toUtcInstant(raw);
    return at
      ? { known: true, at, column: col.column, derived: false }
      : absent("unreadable", col.column);
  }

  if (!tz) return absent("needs-zone", col.column);

  if (col.grain === "local-datetime") {
    const d = zonedWallIsoToUtc(tz, raw);
    return d
      ? { known: true, at: utcInstant(d), column: col.column, derived: true }
      : absent("unreadable", col.column);
  }

  // time-of-day: an HH:MM means nothing without the day it sits on, and that day is
  // the row's own `date` — not today, and not the record instant's day.
  const day = dayColumn ? cell(row, dayColumn) : null;
  if (day === null) return absent("not-recorded", dayColumn ?? col.column);
  // The shape check IS zonedWallTimeToUtc's refusal (#2245) — it reads a wall clock or
  // nothing, so this reader no longer pre-screens with a regex of its own.
  const d = zonedWallTimeToUtc(tz, day, raw);
  return d
    ? { known: true, at: utcInstant(d), column: col.column, derived: true }
    : absent("unreadable", col.column);
}

// A table may declare a CHAIN for a semantic — more than one column, in priority
// order. `intake_item_logs` is the case that forced it: the owner's #2205 ruling made
// `given_at` a RECORD instant (it is inferred from the tap, so it always was one), and
// `taken_at` is the row's insert stamp behind it, reached only by rows written before
// `given_at` existed. The `COALESCE(given_at, taken_at)` a dozen readers hand-roll is
// therefore a fallback WITHIN the record question, not a record instant standing in
// for an event one — the hand-rolls had the right value under the wrong name.
//
// A chain is legitimate only when every link answers the SAME question. `event` never
// gets one (the invariant is tested): falling from one event column to another would
// be the substitution this module exists to prevent.
function read(
  table: TemporalTable,
  semantic: "event" | "record",
  row: Record<string, unknown>,
  tz?: string
): RowInstant {
  const chain = timeColumnsFor(table, semantic);
  if (chain.length === 0) return absent("not-declared");
  const dayColumn = timeColumn(table, "day")?.column ?? null;
  let first: RowInstant | null = null;
  for (const col of chain) {
    const r = resolveInstant(col, row, tz, dayColumn);
    if (r.known) return r;
    // Report the FIRST link's refusal: "nobody stated one" is about the column the
    // caller was really asking about, not about the fallback behind it.
    first ??= r;
  }
  return first ?? absent("not-declared");
}

// WHEN DID THIS HAPPEN? The declared `event` column of `table`, normalized. Never falls
// back to anything.
export function eventInstant(
  table: TemporalTable,
  row: Record<string, unknown>,
  tz?: string
): RowInstant {
  return read(table, "event", row, tz);
}

// WHEN DID THIS ENTER THE APP? The declared `record` column, normalized. Not a proxy
// for the event instant and never presented as one.
export function recordInstant(
  table: TemporalTable,
  row: Record<string, unknown>,
  tz?: string
): RowInstant {
  return read(table, "record", row, tz);
}

export type BestInstant =
  | {
      known: true;
      at: string;
      column: string;
      // WHICH question the answer actually came from. A caller that renders "taken at
      // 4:02pm" over a `record` answer is claiming something the row does not say, and
      // this field is what lets a reviewer see that.
      semantic: "event" | "record";
      derived: boolean;
    }
  | NoInstant;

// THE EVENT INSTANT IF THERE IS ONE, ELSE THE RECORD INSTANT — the substitution given a
// name and a return value that admits what it did. Ordering a mixed timeline and
// labelling "last dose" are legitimate uses; a distribution of when things HAPPEN is
// not, and the `semantic` field is what makes the difference visible at the call site
// instead of two columns deep in SQL.
//
// Not to be confused with a record CHAIN (see `read` above): falling from `given_at` to
// `taken_at` stays inside `recordInstant`, because both answer "when did this enter the
// app". Falling from `eaten_at` to `logged_at` crosses questions, and that is the fall
// this function exists to make visible.
export function bestKnownInstant(
  table: TemporalTable,
  row: Record<string, unknown>,
  tz?: string
): BestInstant {
  const event = eventInstant(table, row, tz);
  if (event.known) return { ...event, semantic: "event" };
  const record = recordInstant(table, row, tz);
  if (record.known) return { ...record, semantic: "record" };
  // Report the EVENT's absence when the table has an event column at all: "nobody
  // stated a time" is more informative than "this table has no record column".
  return event.column !== null ? event : record;
}

export type RowDay =
  | {
      known: true;
      date: string;
      // `stored` — the row's own profile-local `date`, which is authoritative (#94) and
      // is what dose, adherence, cadence and the digest key on. `derived` — computed
      // from the event instant because the table declares no day column.
      from: "stored" | "derived";
      column: string;
    }
  | NoInstant;

// WHICH PROFILE-LOCAL DAY DOES THIS ROW COUNT FOR? The stored `date` wins whenever the
// table has one, because a user-owned day attribution is a decision the app already
// made and re-deriving it from an instant can disagree with it (a 00:30 serving
// re-dated to the previous evening still counts for the day its row says).
//
// It falls back to the EVENT instant only — never to the record instant. Deriving a day
// from when something was typed is the same substitution `bestKnownInstant` exists to
// make visible, and a day is the one place the repo has ruled it out entirely.
export function rowLocalDay(
  table: TemporalTable,
  row: Record<string, unknown>,
  tz: string
): RowDay {
  const dayCol = timeColumn(table, "day");
  if (dayCol) {
    const stored = cell(row, dayCol.column);
    if (stored !== null) {
      return {
        known: true,
        date: stored.slice(0, 10),
        from: "stored",
        column: dayCol.column,
      };
    }
    return absent("not-recorded", dayCol.column);
  }
  const event = eventInstant(table, row, tz);
  if (!event.known) return event;
  const day = localDayOf(tz, event.at);
  return day === null
    ? absent("unreadable", event.column)
    : { known: true, date: day, from: "derived", column: event.column };
}

// Every table the readers can be asked about — the registry's key set, re-exported so a
// caller does not have to import the index to name one.
export const TEMPORAL_TABLES = Object.keys(TIME_COLUMNS) as TemporalTable[];

// A stored instant re-read as a Date, for the callers that need arithmetic rather than
// a string. Kept here rather than re-derived so "parse what this reader returned" has
// one spelling too.
export function instantDate(r: RowInstant | BestInstant): Date | null {
  return r.known ? parseUtcSql(r.at) : null;
}
