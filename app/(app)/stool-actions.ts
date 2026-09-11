"use server";

import { today } from "@/lib/db";
import { revalidateRoute } from "@/lib/revalidate";
import { logBristolStool } from "@/lib/offline/writes";
import {
  getBristolReadings,
  getBristolRows,
  type BristolRow,
} from "@/lib/queries/bristol-stool";
import { BRISTOL_STOOL_METRIC, parseBristolType } from "@/lib/bristol-stool";
import { deleteMetricRow, updateMetricRow } from "@/lib/metric-readings";
import { isRealIsoDate } from "@/lib/date";
import type { StatedTimeRefusal } from "@/lib/stated-time";
import { gateItemProfile } from "./gate-item";

// The Bristol stool-form tap (issue #2785). Authorization at the request boundary, the
// write core auth-blind and profileId-first — the house rule, and the same shape every
// other quick-log action here takes.
//
// The action decides NOTHING about the scale: `parseBristolType` is the one guard, and
// it is the same call the write core makes, so a crafted post cannot store an 8 by
// going around the form. Checking here as well is not the redundant assertion the
// repo's rules forbid — it is what lets the surface answer "that isn't a type" instead
// of the core's silent `false`.
//
// It answers with the COUNT ON THE DAY IT WROTE TO, never an average: several movements
// a day is ordinary, and the count is what the picker shows beside the buttons so a
// second tap is informed rather than accidental. On a backfill that day is not today,
// which is why the field is not called one.
//
// Since #5663 it also answers with THE DAY'S READINGS and with which of them this tap
// landed on. The sheet lists each of today's entries as its own receipt row (the
// owner's 2026-09-11 ruling), so the write's answer is the list itself rather than a
// number to patch a client copy with — one round trip, and no arithmetic that can
// disagree with the store. `landedReading` below says why the row this tap touched is
// identified by difference rather than re-derived.

// A REFUSED STATED TIME IS A NOTICE, NOT A FAILURE (#4425, the body-metric contract):
// the observation lands and `statedTimeRefused` says the minute did not, so the picker
// can finish the sentence itself. It has to: `STATED_TIME_REFUSAL_NOTE` is deliberately
// the vocabulary for a surface that TIMESTAMPED the statement off a device clock, and
// here the user TYPED it — telling them their clock is ahead would diagnose the wrong
// machine (lib/stated-time.ts says so in those words).
export type LogStoolFormOutcome =
  | {
      ok: true;
      type: number;
      dayCount: number;
      statedTimeRefused?: StatedTimeRefusal;
      /**
       * THE READING THIS TAP LANDED ON (#5663), so the newest row's Undo has an
       * address and knows which inverse it is. Absent when the write changed nothing
       * the day's rows can show — a re-tap of the type already at that instant —
       * which is honest: there is a reading, but this tap did not make it and has
       * nothing to take back.
       */
      reading?: StoolReadingReceipt;
      /** The day's readings after the write, newest first — the sheet's receipt rows. */
      readings: StoolDayReading[];
    }
  | { ok: false; error: string };

/** One of the day's readings, as a receipt row addresses it. */
export interface StoolDayReading {
  /** The `metric_samples` row id. */
  id: number;
  /** 1-7 — the type the row states, and the label and sentence it is built from. */
  type: number;
  /**
   * The reading's profile-local "HH:MM", off the instant the write core chose — the
   * stated minute when it accepted one, the tap instant when it did not. Read back
   * from the stored row rather than echoed from a request, so a refused statement
   * cannot leave a row naming a minute nothing carries.
   */
  hhmm: string;
}

/** The reading a tap landed on — what the newest row's Undo addresses. */
export interface StoolReadingReceipt {
  /** The `metric_samples` row id. */
  id: number;
  /**
   * The type this write REPLACED, when it corrected the reading already at that
   * instant instead of adding one. Absent for a new reading.
   *
   * The distinction decides the INVERSE. The row's natural key is its instant, so
   * restating a minute corrects the reading the first tap wrote (#3273 rule 4) — and
   * a delete is then the wrong undo, because it would take away a reading this tap
   * did not create. With a previous type in hand the inverse is the correction back
   * to it, which is complete and local under the #2642 contract.
   */
  replacedType?: number;
}

// HOW MANY OF A DAY'S READINGS THE RECEIPT LOOKS AT. The rows come back newest first,
// so this bounds the WORK, not the answer: a row present after the write and absent
// from the window read before it can only be the one just written, because an insert
// never makes an older row newer. The only thing the bound can cost is the receipt
// itself, and only on a day already holding this many readings that are NEWER than the
// one just logged — at which point the row has bigger things to say.
const RECEIPT_WINDOW = 64;

/**
 * Which reading a write landed on, by DIFFERENCE rather than by re-deriving the core's
 * judgement.
 *
 * `logBristolStool` decides the instant — it judges a stated minute against the clock
 * seam (#4425) and falls back to the tap — and asking that same question a second time
 * here would be a second copy of the decision, which is the drift lib/offline/writes.ts
 * exists to prevent. So the day's rows are read either side of the write and compared.
 *
 * Sound because nothing can interleave: both reads and the write are synchronous
 * better-sqlite3 calls with no await between them.
 */
function landedReading(
  before: Map<number, number>,
  after: readonly BristolRow[]
): StoolReadingReceipt | null {
  const added = after.find((row) => !before.has(row.id));
  if (added) return { id: added.id };
  for (const row of after) {
    const was = before.get(row.id);
    if (was !== undefined && was !== row.type)
      return { id: row.id, replacedType: was };
  }
  return null;
}

/** The day's readings as the sheet's rows address them, newest first. */
function dayReadings(rows: readonly BristolRow[]): StoolDayReading[] {
  return rows.map((row) => ({ id: row.id, type: row.type, hhmm: row.hhmm }));
}

export async function logStoolForm(
  formData: FormData
): Promise<LogStoolFormOutcome> {
  // #4932: the quick-log sheet's subject chip mounts this SAME control cross-profile,
  // so the tap follows `gateItemProfile` like every other sheet body — posted
  // `profile_id` → requireProfileWriteAccess, absent → acting profile (every other
  // mount today).
  const profileId = await gateItemProfile(formData);
  const type = parseBristolType(formData.get("type"));
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };

  // THE DAY THE MOUNT IS STANDING ON (#4424's date context), not a re-derived today.
  // Absent — the quick sheet's tap, and the overwhelming majority — is this profile's
  // today, so the fast path posts exactly the body it always posted. The bound is the
  // write core's shared invariant (`isPastWriteAccepted`): any real past day, never the
  // future. Nothing is re-checked here, because the core refuses what it refuses.
  const posted = String(formData.get("date") ?? "").trim();
  const date = posted && isRealIsoDate(posted) ? posted : today(profileId);
  // The optional STATED wall time (#3273's "Happened earlier?"), profile-local
  // "HH:MM". Absent — the one-tap path, and the overwhelming majority — is `null`,
  // which the write core reads as "the moment IS now" exactly as it did when the
  // form had no time affordance at all. The shape is re-asked in the core, and since
  // #4425 the core also JUDGES it, so a crafted or mistyped stamp cannot smuggle a
  // future instant onto a row whose natural key IS that instant.
  const at = String(formData.get("at") ?? "").trim() || null;
  const before = new Map(
    getBristolRows(profileId, date, date, RECEIPT_WINDOW).map((row) => [
      row.id,
      row.type,
    ])
  );
  const written = logBristolStool(profileId, date, type, at);
  // The type parsed and the date is a real day, so the core's only remaining refusal is
  // the shared never-the-future bound — said in those words rather than as a retry.
  if (!written.wrote) {
    return { ok: false, error: "That day hasn't happened yet." };
  }
  const after = getBristolRows(profileId, date, date, RECEIPT_WINDOW);
  const reading = landedReading(before, after);

  revalidateStool();
  return {
    ok: true,
    type,
    dayCount: getBristolReadings(profileId, date, date).length,
    readings: dayReadings(after),
    ...(reading ? { reading } : {}),
    ...(written.statedTimeRefused
      ? { statedTimeRefused: written.statedTimeRefused }
      : {}),
  };
}

/**
 * THE DAY'S READINGS FOR THE SHEET'S ROWS (#5663).
 *
 * The quick-log sheet's props are gathered when it OPENS (`loadQuickEntry`), and that
 * gather answers with a count — which was all the row needed while the row was a
 * count. A sheet that lists the day's entries needs the entries, and it needs them
 * again after an Undo and after a movement removed from the record behind it: the same
 * argument `QuickPracticeList` makes for re-reading its rows rather than holding a copy
 * that can disagree with the store.
 *
 * A READ, gated exactly like the writes here: the sheet mounts this control
 * cross-profile (#4932), so the subject is posted and re-gated rather than assumed, and
 * every row it answers with is that gated profile's. There is no shape here through
 * which another profile's reading could arrive.
 */
export async function loadStoolDay(
  formData: FormData
): Promise<{ readings: StoolDayReading[]; dayCount: number }> {
  const profileId = await gateItemProfile(formData);
  const posted = String(formData.get("date") ?? "").trim();
  const date = posted && isRealIsoDate(posted) ? posted : today(profileId);
  return {
    readings: dayReadings(
      getBristolRows(profileId, date, date, RECEIPT_WINDOW)
    ),
    dayCount: getBristolReadings(profileId, date, date).length,
  };
}

// THE RECORD'S TWO ROW WRITES (#4433). A logged movement is a `metric_samples` row, so
// its correction and its delete are the SHARED reading contract's — `updateMetricRow`
// and `deleteMetricRow` over a `{ store, id, metric }` target, which is where the #133
// edit lock and the #507/#508 tombstone already live, and where `captureDelete` makes
// the delete undoable under the #2642 contract. No stool-shaped write core is added.
//
// THE TARGET NAMES THE METRIC, so a crafted token carrying another row's id cannot
// reach it: `deleteReadingAt` probes (id, profile_id, metric) before it captures, and
// `updateReadingAt` carries the metric in its WHERE clause.
//
// NOT `deleteMetricReading` in trends/reading-actions.ts, whose `kind` field is a
// `TrendMetricSlug`: Bristol deliberately is not one (lib/bristol-stool.ts argues why —
// no canonical identity, no knowledge entry, and never a mean), and inventing a slug so
// a shared action would accept it would put stool on the metric registry to buy a
// revalidate list.
function stoolTarget(formData: FormData) {
  const id = Number(String(formData.get("id") ?? "").trim());
  return Number.isInteger(id) && id > 0
    ? ({ store: "metric_samples", id, metric: BRISTOL_STOOL_METRIC } as const)
    : null;
}

/**
 * Correct one logged movement's TYPE — the mis-tap #4433 names ("type 3, meant 4").
 *
 * And the INVERSE the quick-log row offers when a tap corrected a reading rather than
 * adding one (#5663): the same write, run back to the type the row carried before.
 */
export async function correctStoolReading(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  // THE ROW'S PROFILE, NOT THE ACTING ONE (#4009 item 1 / #2106): the record's
  // `?view=everyone` posts the row's own `profile_id` and `gateItemProfile` gates it,
  // falling back to the acting-profile gate when no subject is posted.
  const profileId = await gateItemProfile(formData);
  const target = stoolTarget(formData);
  const type = parseBristolType(formData.get("type"));
  if (!target) return { ok: false, error: "Couldn't find that reading." };
  if (type === null) return { ok: false, error: "Pick a type from 1 to 7." };
  const outcome = updateMetricRow(profileId, target, type);
  if (!outcome.ok) return { ok: false, error: "Couldn't find that reading." };
  revalidateStool();
  return { ok: true };
}

/**
 * Remove one logged movement, in the shape `useUndoableDelete` reads (#2642).
 *
 * Also the quick-log row's Undo since #5663, addressed by the id `logStoolForm`
 * answered with. Nothing was added for that caller: the target is re-derived here
 * against (id, profile_id, metric), so a stale offer refuses rather than reaching a
 * row it was never about.
 */
export async function deleteStoolReading(
  formData: FormData
): Promise<{ undoId: number | null }> {
  const profileId = await gateItemProfile(formData);
  const target = stoolTarget(formData);
  if (!target) return { undoId: null };
  const outcome = deleteMetricRow(profileId, target);
  if (!outcome.ok) return { undoId: null };
  revalidateStool();
  return { undoId: outcome.undoId };
}

// Every surface a movement shows on: the record, the Trends panel that charts it, and
// the dashboard the sheet is opened from.
function revalidateStool(): void {
  revalidateRoute("/history");
  revalidateRoute("/trends");
  revalidateRoute("/");
}
