// THE DAY LEDGER (#3987 phase 1) — one meal-grouped statement of a day's intake.
//
// The Nutrition page used to render the same day three times: the Meals cards, the
// LOGGED TODAY list and the Supplements tab's daily schedule. This module is the ONE
// model behind their replacement — food servings and doses interleaved in the profile's
// own time buckets, each fact stated exactly once.
//
// PURE. No DB, no clock, no React: the callers hand it already-gathered rows and the
// profile-local clock strings they resolved. That is what lets the grouping, the
// composed collapse and the ordering be asserted at the unit tier over hand-written
// rows instead of through a rendered page.
//
// WHAT IT DOES NOT DECIDE. Dueness (`pendingDayDoses`), the bucket a dose occupied on a
// past day (`doseBucketOn`), and the window a serving files under (`foodEventWindow`)
// are all settled before a row reaches here. This module never re-asks a question the
// schedule engine already answered.

import { TIME_BUCKETS, type TimeBucket } from "./intake-schedule";
import type { PendingDayDose } from "./queries/usual-routine";

/** A serving or a dose as it reads on one line, with the clock already resolved. */
interface LedgerRowBase {
  /** `${kind}:${rowId}` — unique across kinds, and the ordering's final tie-break. */
  id: string;
  bucket: TimeBucket;
  /**
   * The row's clock, profile-local "HH:MM". `stated` is an eating/administration time
   * somebody named; `logged` is the filing-time fallback, which #3958's grammar renders
   * as "logged 8:06pm" and which sinks below every stated row.
   */
  hhmm: string;
  clockKind: "stated" | "logged";
}

export interface LedgerServing extends LedgerRowBase {
  kind: "serving";
  eventId: number;
  /** The food group's slug — the row's glyph. */
  slug: string;
  name: string;
}

export interface LedgerDose extends LedgerRowBase {
  kind: "dose";
  logId: number;
  doseId: number;
  itemId: number;
  name: string;
  /** Amount / product, already formatted by the domain. */
  detail: string;
  /** The item's stack label (#3098) — the routine a composed write is keyed on. */
  stack: string | null;
  status: "taken" | "skipped";
  /** The stored reason a skip carries. A skip is a recorded event, never hidden. */
  skipReason: string | null;
  /** The write instant truncated to the minute — the composed tap's identity. */
  writeMinute: string;
}

/**
 * ONE COMPOSED WRITE, collapsed (#2458's bundle, read back).
 *
 * Keyed on (bucket, stack, write minute) — the composed tap's own identity — and NEVER
 * on the bucket alone: two doses of one stack taken hours apart did not share a tap and
 * must not share a timestamp. A stack with unresolved members states "4 of 6"; a single
 * check over a partial stack is a claim the day does not support.
 */
export interface LedgerStack {
  kind: "stack";
  id: string;
  bucket: TimeBucket;
  stack: string;
  hhmm: string;
  clockKind: "stated" | "logged";
  /** The doses this tap actually wrote, in the ledger's own order. */
  written: LedgerDose[];
  /**
   * The same stack's doses this day still owes in this bucket. They live HERE rather
   * than in the bucket's due row so the day is stated once: a dose is on exactly one
   * row of the ledger.
   */
  open: PendingDayDose[];
}

/**
 * THE BUCKET'S STILL-DUE DOSES, as one row with a bulk Take-all.
 *
 * The row NAMES every dose it will write and the core (`resolveDayDoses`) re-derives
 * the pending set and writes only the listed-and-still-unresolved intersection — so a
 * stale tap refuses rather than double-logging (#3936). Doses already claimed by a
 * partial stack row are not here.
 */
export interface LedgerDue {
  kind: "due";
  id: string;
  bucket: TimeBucket;
  doses: PendingDayDose[];
}

export type LedgerRow = LedgerServing | LedgerDose | LedgerStack | LedgerDue;

export interface LedgerGroup {
  bucket: TimeBucket;
  rows: LedgerRow[];
  servings: number;
  doses: number;
}

/** A stack row states its resolution honestly: "6 doses" whole, "4 of 6" partial. */
export function stackLabel(row: LedgerStack): string {
  const total = row.written.length + row.open.length;
  return row.open.length === 0
    ? `${total} ${total === 1 ? "dose" : "doses"}`
    : `${row.written.length} of ${total}`;
}

/** The day header's census — each kind counted once, in a fixed order. */
export function dayCountsLabel(servings: number, doses: number): string {
  return [
    servings > 0 ? `${servings} ${servings === 1 ? "serving" : "servings"}` : "",
    doses > 0 ? `${doses} ${doses === 1 ? "dose" : "doses"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// A stated row sorts above every filing-time row; within each half the clock decides,
// and the id is the total-order tie-break (code units, never localeCompare — the
// #3958/#4016 argument: a collation that answers 0 for two distinct ids leaves the sort
// unstable). A due row is the least-timed thing on the surface and closes its group.
const KEY_SEP = "\u001f";

const RANK = { stated: "0", logged: "1", due: "2" } as const;

function sortKey(row: LedgerRow): string {
  if (row.kind === "due") return RANK.due;
  return `${RANK[row.clockKind]}${row.hhmm}${row.id}`;
}

function compareRows(a: LedgerRow, b: LedgerRow): number {
  const x = sortKey(a);
  const y = sortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * BUILD THE DAY. Servings and doses interleave in one group system; composed writes
 * collapse; the bucket's remaining due doses close the group.
 *
 * `pending` is the day's unresolved doses as the schedule engine reports them; every
 * one of them lands on exactly one row — its stack's, when that stack has a composed
 * write in the same bucket today, and the bucket's due row otherwise.
 */
export function buildDayLedger(input: {
  servings: readonly LedgerServing[];
  doses: readonly LedgerDose[];
  pending: readonly PendingDayDose[];
}): LedgerGroup[] {
  const stacks = new Map<string, LedgerStack>();
  const loose: LedgerDose[] = [];
  for (const dose of input.doses) {
    // A dose with no stack was not part of a routine, so there is nothing to collapse
    // it into — and a SKIPPED dose is its own statement, with its own reason, which a
    // "6 doses" row could not carry.
    if (!dose.stack || dose.status !== "taken") {
      loose.push(dose);
      continue;
    }
    // Fixed-width fields joined by the unit separator, the `doseSortKey` idiom: it
    // sorts below every printable character and cannot occur in a bucket, a stack
    // label or a timestamp, so no pair of distinct triples can mint one key.
    const key = [dose.bucket, dose.stack, dose.writeMinute].join(KEY_SEP);
    const existing = stacks.get(key);
    if (existing) existing.written.push(dose);
    else
      stacks.set(key, {
        kind: "stack",
        id: `stack:${key}`,
        bucket: dose.bucket,
        stack: dose.stack,
        hhmm: dose.hhmm,
        clockKind: dose.clockKind,
        written: [dose],
        open: [],
      });
  }
  // A single dose is not a composed write however it was stored, so it reads as itself.
  for (const [key, stack] of [...stacks]) {
    if (stack.written.length < 2) {
      stacks.delete(key);
      loose.push(...stack.written);
    }
  }
  const claimed = new Set<number>();
  for (const stack of stacks.values()) {
    for (const dose of input.pending) {
      if (dose.stack === stack.stack && dose.bucket === stack.bucket) {
        stack.open.push(dose);
        claimed.add(dose.doseId);
      }
    }
  }
  const byBucket = new Map<TimeBucket, LedgerRow[]>();
  const push = (bucket: TimeBucket, row: LedgerRow) => {
    const list = byBucket.get(bucket);
    if (list) list.push(row);
    else byBucket.set(bucket, [row]);
  };
  for (const serving of input.servings) push(serving.bucket, serving);
  for (const dose of loose) push(dose.bucket, dose);
  for (const stack of stacks.values()) {
    stack.written.sort(compareRows);
    push(stack.bucket, stack);
  }
  const dueByBucket = new Map<TimeBucket, PendingDayDose[]>();
  for (const dose of input.pending) {
    if (claimed.has(dose.doseId)) continue;
    const list = dueByBucket.get(dose.bucket);
    if (list) list.push(dose);
    else dueByBucket.set(dose.bucket, [dose]);
  }
  for (const [bucket, doses] of dueByBucket)
    push(bucket, { kind: "due", id: `due:${bucket}`, bucket, doses });

  const groups: LedgerGroup[] = [];
  for (const bucket of TIME_BUCKETS) {
    const rows = byBucket.get(bucket);
    if (!rows || rows.length === 0) continue;
    rows.sort(compareRows);
    groups.push({
      bucket,
      rows,
      servings: rows.filter((row) => row.kind === "serving").length,
      doses: rows.reduce(
        (n, row) =>
          n +
          (row.kind === "dose"
            ? 1
            : row.kind === "stack"
              ? row.written.length
              : 0),
        0
      ),
    });
  }
  return groups;
}
