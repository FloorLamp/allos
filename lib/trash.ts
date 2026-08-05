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
  date: string | null;
  notes: string | null;
  // Captured rows BESIDE the root — the sets of an activity, the doses and adherence
  // logs of a medication. Rendered so "restore" visibly means the whole cascade.
  childCount: number;
  deletedAt: string;
  // When the retention sweep will purge this capture, and how many whole days that
  // is from `now` (0 = today; never negative — an already-expired capture the tick
  // hasn't reached yet reads as "expires today", not "expired -3 days ago").
  expiresAt: string;
  expiresInDays: number;
}

// Captured columns that carry a human title, in priority order. Every registry kind's
// root table is covered: activities.title, medical_records/intake_items.name,
// practice_logs.practice, frequency_targets.scope_value, substance_log.substance,
// food_log(_events).group_key. A root with none (body_metrics) renders by kind + date,
// which is what its own surfaces do.
const TITLE_COLUMNS = [
  "title",
  "name",
  "practice",
  "scope_value",
  "substance",
  "group_key",
] as const;

// Captured columns that carry the deleted row's own date, in priority order.
const DATE_COLUMNS = ["date", "logged_at", "created_at"] as const;

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
export function trashEntry(
  capture: TrashCapture,
  retentionDays: number,
  now: Date
): TrashEntry {
  const payload = readPayload(capture.payload);
  const rootKey = payload ? rootEntityKey(capture.kind, payload) : undefined;
  const root =
    payload && rootKey ? (payload.rows[rootKey]?.[0] ?? null) : null;

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
    date: root ? firstString(root, DATE_COLUMNS) : null,
    notes: root ? firstString(root, ["notes"]) : null,
    // The root is one of the captured rows; everything else is cascade.
    childCount: Math.max(0, captured - 1),
    deletedAt: capture.deletedAt,
    expiresAt: Number.isNaN(expiresMs)
      ? capture.deletedAt
      : formatSqliteUtc(new Date(expiresMs)),
    expiresInDays,
  };
}

// The one-line summary a Trash row leads with: the identifying content when the
// capture has any, the non-PHI kind label when it doesn't. Pure so the surface and
// its tests agree on what an untitled capture reads as.
export function trashEntryHeadline(entry: TrashEntry): string {
  if (entry.title && entry.date) return `${entry.title} · ${entry.date}`;
  if (entry.title) return entry.title;
  if (entry.date) return `${entry.label} · ${entry.date}`;
  return entry.label;
}
