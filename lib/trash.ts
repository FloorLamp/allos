// The Trash read model (issue #2013) — the PURE half.
//
// `deleted_rows` has held a fully restorable capture of every destructive row delete
// since #30, and for its whole life the only affordance over it was a toast that
// disappeared in 15 seconds. This module turns one holding row into something a
// person can CHOOSE from, which is a different problem than counting them:
//
//   • `deleted_rows.label` is a deliberately generic, NON-PHI kind descriptor
//     ("activity", "body metric"). It is enough to say WHAT was deleted and nothing
//     about WHICH one, so a trash rendered from the label alone would offer five
//     identical "activity" rows and no way to pick the right one.
//   • The identifying content — title, date, note — lives in `payload`. Reading it is
//     fine on exactly the grounds it is stored at all (profile-scoped, same SQLite
//     file, same trust boundary as the row it came from), and it means the Trash
//     RENDERS PHI and belongs behind the same gates as every other (app) surface.
//
// Pure: no db, no fs. The impure list lives in lib/queries/trash.ts and the purges in
// lib/undo-delete-db.ts.
//
// RESTORE RE-INSERTS WITH NEW IDS. Nothing here presents the captured row id as
// stable or links to a pre-restore route; the only id a Trash entry carries is the
// HOLDING row's (the undo token), which is what restore/purge address.

import { BULK_CORRECTION_KIND } from "./bulk-correction";
import { dateFromCreatedAt } from "./timeline-format";
import { UNDO_KINDS, type Payload, type Row } from "./undo-delete";

// `deleted_rows` has three writers, and only two of them capture a DELETED ROW:
// captureDelete (the kind registry) and the bespoke `administration` ledger capture —
// both restored by restoreDeletedRow, which is the Trash's Restore button.
//
// The third is a bulk correction (#1603), which snapshots the INVERSE OF AN EDIT into
// the same store to reuse its purge timer. It is not a deleted row, its undo is
// `undoBulkCorrection` (a guarded per-row UPDATE that SKIPS rows changed since, and
// reports how many), and it already has its own affordance on Data → Review. Listing
// it under "Recently deleted" would misname it and offer a Restore button that cannot
// work; emptying the trash would silently destroy an undo the user can still see
// elsewhere. So every Trash read AND both by-hand purges exclude this kind.
export const TRASH_EXCLUDED_KIND = BULK_CORRECTION_KIND;

// One holding row as stored, before any derivation.
export interface TrashCapture {
  id: number;
  kind: string;
  label: string | null;
  payload: string;
  deletedAt: string; // SQLite datetime('now') — "YYYY-MM-DD HH:MM:SS", UTC
}

// One rendered Trash entry.
export interface TrashEntry {
  // The deleted_rows id — the undo token restore and purge address. NOT the deleted
  // row's id (restore mints a new one).
  id: number;
  kind: string;
  // Non-PHI kind descriptor, from the label column (falling back to the raw kind).
  label: string;
  // Identifying content read out of the payload. PHI; may be absent for a kind whose
  // root row has no human title (a body metric is a date and some numbers).
  title: string | null;
  // The capture's own CALENDAR DAY, as storage `YYYY-MM-DD` — never a display
  // string, and never a timestamp. `DATE_COLUMNS` falls through to `recorded_at`
  // and `created_at`, which SQLite stores as "YYYY-MM-DD HH:MM:SS", so the day is
  // taken off the front rather than passed on whole, and a value that is neither a
  // day nor a day-led instant is `null` rather than forwarded: see `calendarDay`.
  date: string | null;
  notes: string | null;
  // Captured rows BESIDE the root — the sets of an activity, the doses and adherence
  // logs of a medication. Rendered so "restore" visibly means the whole cascade.
  childCount: number;
  // THE PROFILE-LOCAL CALENDAR DAY THE CAPTURE WAS TAKEN ON, and the raw instant is
  // deliberately NOT here beside it (#3546).
  //
  // `deleted_rows.deleted_at` is an INSTANT. The row prints it as a DAY, and the
  // surface used to do that conversion with `deletedAt.slice(0, 10)` — the first ten
  // characters of a UTC stamp, which is the UTC calendar day and not this profile's.
  // A capture deleted at 18:00 in UTC−07:00 was stamped with TOMORROW, beside a
  // retention countdown derived from the instant and therefore correct: a row whose
  // two halves disagreed. The project rule is explicit — "preserve the distinction
  // between an instant and a profile-local day" — and truncating a string is the one
  // conversion that cannot honour it.
  //
  // SO THE ENTRY NO LONGER CARRIES THE INSTANT, which is the guard rather than a
  // tidy-up. A convention ("convert, don't truncate") is re-broken by the next author
  // who has the raw stamp in hand; a field that is not there cannot be sliced, and
  // putting it back is a deliberate act with this paragraph attached. Anything that
  // genuinely needs the instant reads `TrashCapture.deletedAt` — the storage shape,
  // where it belongs.
  //
  // Null when the stored stamp is unreadable. `trashEntry` already treats that as
  // possible (the expiry math below guards the same value for NaN), and a client
  // component handed an Invalid Date would THROW out of Intl rather than degrade —
  // so the refusal is the same one `calendarDay` makes above, for the same reason.
  deletedOnDay: string | null;
  // When the retention sweep will purge this capture, and how many whole days that
  // is from `now` (0 = today; never negative — an already-expired capture the tick
  // hasn't reached yet reads as "expires today", not "expired -3 days ago").
  expiresAt: string;
  expiresInDays: number;
}

// Captured columns that carry a human title, in priority order. Every registry kind's
// root table is covered: activities.title, medical_records/intake_items/conditions.name,
// practice_logs.practice, frequency_targets.scope_value,
// allergies/substance_daily_totals.substance, immunizations.vaccine, skin_lesions.label,
// food_daily_totals(_events).group_key. A root with none (body_metrics) renders by kind + date,
// which is what its own surfaces do.
const TITLE_COLUMNS = [
  "title",
  "name",
  "practice",
  "scope_value",
  "substance",
  // #1847's clinical roots. `vaccine` is the immunization dose's code and `label` the
  // lesion's user-given name ("mole, left shoulder") — without them a deleted shot or
  // lesion would read as a bare "immunization · 2024-05-01" in the Trash, which is
  // exactly the "five identical rows, no way to pick" problem this list exists for.
  "vaccine",
  "label",
  "group_key",
] as const;

// Captured columns that carry the deleted row's own date, in priority order. The
// clinical roots lead with their CLINICAL date (when the lesion was observed, when the
// allergy started) and fall through to created_at when it was never recorded — the same
// order their own surfaces read them in.
// Exported for the census in lib/__tests__/trash.test.ts, which walks
// UNDO_KINDS × DATE_COLUMNS: a census over the columns has to match on THE LIST, not
// on a copy of it that can fall behind.
export const DATE_COLUMNS = [
  "date",
  "observed_date",
  "onset_date",
  "recorded_at",
  "created_at",
] as const;

// THE CALENDAR DAY OF A CAPTURED DATE COLUMN, and why this is not cosmetic.
//
// `DATE_COLUMNS` leads with clinical dates (plain `YYYY-MM-DD`) and falls through to
// `recorded_at` / `created_at`, which SQLite writes as "YYYY-MM-DD HH:MM:SS" — and
// `intake_items` has no date column at all, so a supplement capture reaches that last
// fallback every time. The field is documented as a DAY, and `formatDateWithYear`
// returns a value it cannot parse UNCHANGED, so the Trash row printed
// "E2E Restore Fish Oil · 2026-08-22 14:03:55": a machine date in rendered copy,
// which is what #3492 forbids. Trimming here rather than at the surface keeps the
// boundary #3491 item 3 drew — `entry.date` is a STORAGE day, and nothing downstream
// should have to know which column it came from.
//
// ANYTHING THAT IS NOT A DAY OR A DAY-LED INSTANT IS REFUSED, and that is the half
// of this function the first cut got wrong. It passed an unrecognised value through
// untouched, on the reasoning that inventing a date is worse than forwarding one —
// true, but it leaves a THIRD option unconsidered and that option is the right one.
// `formatDateWithYear` returns what it cannot parse UNCHANGED, so "passed through" is
// not a neutral act: it is the exact path that put "2026-08-22 14:03:55" on the Trash
// row. A root that someday stores `2026/08/22` or an epoch string would reach the
// screen the same way, and a census over the spellings this schema uses today could
// never see it. So the field keeps the type its own comment gives it — a storage day
// or nothing — and a shape this function cannot vouch for degrades to no date at all,
// which every caller already handles (TrashList passes `null`, and the headline drops
// to the title or the kind label). Held by the UNDO_KINDS × DATE_COLUMNS census in
// lib/__tests__/trash.test.ts, in both directions.
//
// AND THERE IS A FOURTH OPTION, which this function does not take — say so here rather
// than leave the next reader to infer that three were all of them. The refusal is
// applied AFTER `firstString` has already picked a column, so a LEADING column holding
// a shape this cannot vouch for blanks the date instead of deferring to the sibling
// that would reduce:
//
//     root { date: "2026-08", created_at: "2026-08-22 14:03:55" }
//       this head:          null
//       pass-through:       "2026-08"      (the first cut — a machine date on screen)
//       fall-through:       "2026-08-22"
//
// Latent, not live: no column in this schema can hold a refused shape today, over every
// (root table × `DATE_COLUMNS`) pair the census in lib/__tests__/trash.test.ts walks —
// and that census sets one column at a time, so it cannot see this ordering either.
// Moving to fall-through is a behaviour change, not a tightening: it belongs to
// whoever adds the first column that needs it, with the census extended to two columns
// at once so the choice is asserted rather than assumed.
const STORAGE_DAY = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

function calendarDay(value: string | null): string | null {
  const m = value === null ? null : STORAGE_DAY.exec(value);
  return m ? m[1] : null;
}

function firstString(row: Row, columns: readonly string[]): string | null {
  for (const c of columns) {
    const v = row[c];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

// Parse a stored payload LENIENTLY. Deliberately not lib/undo-delete's parsePayload,
// which validates the kind against the registry and throws: the bespoke
// `administration` capture (#851 item 11) is a real, restorable holding row whose
// payload is not a registry payload, and a Trash that threw on it would hide a row the
// user can still restore. Anything unreadable degrades to "no derived content", never
// to an exception.
function readPayload(json: string): Payload | null {
  try {
    const parsed = JSON.parse(json) as Payload;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.rows || typeof parsed.rows !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// The entity key holding the ROOT row: the registry's first entity for a known kind,
// otherwise the payload's first entity (an off-registry capture).
function rootEntityKey(kind: string, payload: Payload): string | undefined {
  const spec = UNDO_KINDS[kind];
  if (spec) return spec.entities[0]?.entity;
  return Object.keys(payload.rows)[0];
}

// SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" in UTC with no zone
// marker, which Date.parse reads as LOCAL time on some engines. Normalize before
// doing any arithmetic on it.
export function parseSqliteUtc(stamp: string): Date {
  return new Date(`${stamp.trim().replace(" ", "T")}Z`);
}

// Format a Date back into the same "YYYY-MM-DD HH:MM:SS" UTC shape.
function formatSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// Derive one rendered Trash entry from one holding row. Pure.
//
// `timezone` is REQUIRED, not defaulted (#3546). The delete instant has to become a
// calendar day somewhere, and every caller knows whose profile it is reading — so the
// question is asked once, here, rather than left to a default that would silently
// mean "UTC" and reproduce the bug it replaced.
export function trashEntry(
  capture: TrashCapture,
  retentionDays: number,
  now: Date,
  timezone: string
): TrashEntry {
  const payload = readPayload(capture.payload);
  const rootKey = payload ? rootEntityKey(capture.kind, payload) : undefined;
  const root = payload && rootKey ? (payload.rows[rootKey]?.[0] ?? null) : null;

  let captured = 0;
  if (payload)
    for (const rows of Object.values(payload.rows))
      captured += Array.isArray(rows) ? rows.length : 0;

  const deletedAtMs = parseSqliteUtc(capture.deletedAt).getTime();
  const expiresMs = Number.isNaN(deletedAtMs)
    ? Number.NaN
    : deletedAtMs + retentionDays * 86_400_000;
  const expiresInDays = Number.isNaN(expiresMs)
    ? retentionDays
    : Math.max(0, Math.ceil((expiresMs - now.getTime()) / 86_400_000));

  return {
    id: capture.id,
    kind: capture.kind,
    label: capture.label?.trim() || capture.kind,
    title: root ? firstString(root, TITLE_COLUMNS) : null,
    date: root ? calendarDay(firstString(root, DATE_COLUMNS)) : null,
    notes: root ? firstString(root, ["notes"]) : null,
    // The root is one of the captured rows; everything else is cascade.
    childCount: Math.max(0, captured - 1),
    // The one conversion from instant to profile-local day, through the helper the
    // timeline already resolves its created-at-fallback events with — the same
    // question, so the same answer.
    deletedOnDay: dateFromCreatedAt(capture.deletedAt, timezone),
    expiresAt: Number.isNaN(expiresMs)
      ? capture.deletedAt
      : formatSqliteUtc(new Date(expiresMs)),
    expiresInDays,
  };
}

// The one-line summary a Trash row leads with: the identifying content when the
// capture has any, the non-PHI kind label when it doesn't. Pure so the surface and
// its tests agree on what an untitled capture reads as.
//
// `dateLabel` IS A PARAMETER RATHER THAN `entry.date`, AND THAT IS THE BOUNDARY
// (#3491 item 3, #3492's mechanism). `entry.date` is a STORAGE date — the raw
// `YYYY-MM-DD` the payload was captured with — and this function's output is copy.
// Reading the storage value here is what put "activity · 2026-08-19" on the screen,
// and no amount of convention stops the next author doing it again. So the display
// value is the only one in scope: a caller with no formatted date to hand cannot
// construct the day-stating headline at all, and gets the label-only one, which is
// the honest reading of "we have no date to show".
export function trashEntryHeadline(
  entry: TrashEntry,
  dateLabel: string | null
): string {
  if (entry.title && dateLabel) return `${entry.title} · ${dateLabel}`;
  if (entry.title) return entry.title;
  if (dateLabel) return `${entry.label} · ${dateLabel}`;
  return entry.label;
}

// How long a capture has left, as the row's own sentence. Lives here rather than in
// the component so the WHOLE subtitle is derivable in the pure tier — a subtitle
// half of which is assembled in TSX cannot be asked "does the kind label appear
// exactly once across these two lines?" (#3491 item 2).
export function trashExpiryLine(entry: TrashEntry): string {
  if (entry.expiresInDays === 0) return "Expires today";
  if (entry.expiresInDays === 1) return "Expires tomorrow";
  return `Expires in ${entry.expiresInDays} days`;
}

// The display strings a Trash row needs and this module refuses to invent: both
// dates, already rendered through the reader's DisplayFormatPrefs at the surface.
export interface TrashEntryDateLabels {
  /** The capture's own date. Null when the payload carried none. */
  date: string | null;
  /**
   * The PROFILE-LOCAL day the capture was taken, already formatted.
   *
   * Nullable for the same reason `date` is: `TrashEntry.deletedOnDay` refuses a
   * stored stamp it cannot read rather than forwarding a shape it cannot vouch for
   * (#3546), and a caller with no day to show must not be able to state one.
   */
  deletedOn: string | null;
}

// A Trash row's two lines.
export interface TrashEntryCopy {
  headline: string;
  subtitle: string;
}

// THE TWO LINES ARE DERIVED TOGETHER, BECAUSE THEY OVERLAP (#3491 item 2).
//
// The headline's fallback branch leads with the kind label — that is its entire
// purpose, since an untitled capture has nothing else to say. The subtitle used to
// print the label again unconditionally, so an untitled row read "activity · Aug 19,
// 2026" above "activity · Deleted Aug 20, 2026 · Expires in 25 days" and stated its
// kind twice while the fact that distinguishes it was fighting for room.
//
// Whether the headline used the label is not a fact the subtitle can guess at from
// outside; it is the headline's own branch. So one function owns both, and the rule
// is exact rather than approximate: the label appears in the subtitle if and only if
// the headline did NOT lead with it — which is if and only if the capture had a
// title.
export function trashEntryCopy(
  entry: TrashEntry,
  dates: TrashEntryDateLabels
): TrashEntryCopy {
  const parts: string[] = [];
  // The headline leads with the label exactly when there is no title (both the
  // `label · date` branch and the bare-label one), so this is its complement.
  if (entry.title) parts.push(entry.label);
  if (entry.childCount > 0)
    parts.push(
      `${entry.childCount} related ${entry.childCount === 1 ? "row" : "rows"}`
    );
  // An unreadable stamp drops the sentence rather than printing a half of one. The
  // expiry line stays: it is derived from the same stamp but degrades to the full
  // retention window on a NaN, so it is always a true statement about the row.
  if (dates.deletedOn) parts.push(`Deleted ${dates.deletedOn}`);
  parts.push(trashExpiryLine(entry));
  return {
    headline: trashEntryHeadline(entry, dates.date),
    subtitle: parts.join(" · "),
  };
}
