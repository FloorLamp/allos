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
import type { DoseBundleId } from "./dose-bundle";
import type { PendingDayDose } from "./queries/usual-routine";

// HOW MANY DAYS THE LEDGER IS ABOUT: today plus the previous six. The day picker offers
// exactly these (`FoodTab`), which is enough to recover a missed meal without turning the
// one-tap habit log into an unrestricted historical editor — the deep doors (`/history`'s
// food door, `logHistoricalDose`) are the honest path further back. Named here rather than
// spelled as a literal at each site because the SELECTION EDIT's server-side move bound
// (#4118, lib/day-ledger-edit.ts) has to be the same span the picker draws, and two
// spellings of one span is how a forged POST reaches a day the surface never offered.
export const LEDGER_DAY_SPAN = 7;

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
  /**
   * The composed action that wrote this row (#4328), or null when one tap wrote one
   * dose — and null for every row written before the column existed, which is why an
   * old day states its doses one by one.
   */
  bundleId: DoseBundleId | null;
}

/**
 * ONE COMPOSED WRITE, collapsed (#2458's bundle, read back).
 *
 * Keyed on (bucket, stack, bundle, clock) — and NEVER on the bucket alone: two doses of
 * one stack taken hours apart did not share a tap and must not share a timestamp
 * (#3987's ruling, verbatim). A stack with unresolved members states "4 of 6"; a single
 * check over a partial stack is a claim the day does not support.
 *
 * WHY THE CLOCK IS IN THE KEY AND NOT JUST THE BUNDLE. The bundle is the TAP's identity;
 * `hhmm` is what the row STATES. Those agree until somebody amends one member:
 * `updateHistoricalDose` moves `occurred_at` and deliberately never touches the write
 * event (#2228/#2876), so a dose corrected to "I actually took this at 5:15" is still a
 * row that tap wrote. Keyed on the bundle alone the row would go on stating 8:07 for a
 * dose the record says was three hours earlier — the exact thing the ruling forbids. So a
 * member whose stated clock no longer matches its tap-mates steps OUT of the collapse and
 * states its own time, and that is also the whole of #4477's member-split rendering: a
 * subset given its own instant leaves the stack row, while a whole stack moved together
 * stays one row, because they still agree. The bundle itself is never rewritten — it
 * records what happened, and a correction is not a second tap. Every member of a stack
 * row shares that row's clock by construction, which is why the expanded members carry no
 * clock of their own.
 *
 * WHAT "COMPOSED" MEANS HERE, AND WHERE THE ANSWER COMES FROM (#4328). It is RECORDED,
 * not inferred: every composed writer stamps one `bundleId` on the rows its single
 * action writes, and this key reads that. It used to infer the bundle from a shared
 * WRITE MINUTE, which was right almost always and wrong invisibly — two independent taps
 * of one routine landing in the same minute read as one composed row, found with four
 * ordinary one-at-a-time confirms at 07:07 and 10:07. A row with no bundle composed
 * nothing and never joins a collapse, which is also the honest reading of every row
 * written before the column existed: they are stated one by one rather than grouped by a
 * guess the schema cannot support.
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
   *
   * EMPTY when the bucket holds more than one row for this routine — no fact names which
   * row would own an open dose, and letting each take a copy is how one dose came to be
   * on two. See the claim loop in `buildDayLedger`.
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
    servings > 0
      ? `${servings} ${servings === 1 ? "serving" : "servings"}`
      : "",
    doses > 0 ? `${doses} ${doses === 1 ? "dose" : "doses"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// A stated row sorts above every filing-time row; within each half the clock decides,
// and the id is the total-order tie-break (code units, never localeCompare — the
// #3958/#4016 argument: a collation that answers 0 for two distinct ids leaves the sort
// unstable).
//
// THE DUE ROW LEADS ITS GROUP (#4315, owner ruling 2026-08-31). The ledger is opened to
// ACT, so the one actionable row reads first and the record follows it UNCHANGED: the
// stated/filing-time order below it is the order it would have had with nothing owed.
// That is why the ranks are a RELABELLING rather than a second comparator — one row is
// lifted, nothing is re-sorted, and the relative order of every other pair is untouched
// by construction. This is the rule for ANY surface rendering due-and-done together, so
// the next one does not re-derive it.
const KEY_SEP = "\u001f";

const RANK = { due: "0", stated: "1", logged: "2" } as const;

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
 * collapse; the bucket's remaining due doses lead the group.
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
    // …and a dose no composed action wrote has nothing to collapse WITH: the bundle is
    // the event, so its absence is the answer, never an invitation to infer one.
    if (!dose.stack || dose.status !== "taken" || !dose.bundleId) {
      loose.push(dose);
      continue;
    }
    // Joined by the unit separator, the `doseSortKey` idiom — it sorts below every
    // printable character, which is what keeps `stack:` ids ordering sanely.
    //
    // WHAT ACTUALLY MAKES THE KEY UNFORGEABLE IS THE FIXED-WIDTH TAIL, not the separator.
    // `stack` is free text a person types, so it CAN contain a separator; the separator
    // alone therefore proves nothing. But the tuple is still recoverable from any string
    // this builds, because everything around the free field is pinned: `bucket` is a
    // closed enum in first position, and the three fields after `stack` are
    // fixed-width — a 16-char bundle id, `stated` or `logged`, a 5-char `HH:MM`. Read
    // from the right, those three come off unambiguously whatever the label contains, and
    // what remains between the enum and them is the label. So no pair of distinct tuples
    // can mint one key, and a label crafted to impersonate another routine's tail cannot.
    const key = [
      dose.bucket,
      dose.stack,
      dose.bundleId,
      dose.clockKind,
      dose.hhmm,
    ].join(KEY_SEP);
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
  // THE OPEN MEMBERS BELONG TO ONE ROW OR TO NONE.
  //
  // A partial stack states "4 of 6" and expands to the doses it still owes, which means
  // it CLAIMS those doses off the bucket's due row. That claim is only well-founded when
  // the bucket holds a single stack row for the routine: with two rows — two taps of one
  // routine, or one tap with a member amended out of it — there is no fact saying which
  // of them the open doses belong to, and letting each take a copy put one dose on two
  // rows, double-rendered its Take control, and made the two labels sum past the
  // routine's size ("2 of 4" twice for a routine of six). The day is stated once, so an
  // unownable open dose stays where it always had an honest home: the bucket's due row.
  //
  // AND NOT "THE LATEST ROW OWNS THEM", which is the tempting alternative. Picking a row
  // would be this renderer deciding something the WRITE PATH never recorded: nothing in
  // the log says a still-open dose was meant for the 10:07 tap rather than the 07:07 one,
  // so any rule here would be inventing that fact and then rendering it as though the
  // record held it. Declining to answer is the honest answer; the due row is where an
  // unanswered dose already belongs.
  // COUNTED AFTER THE DISSOLUTION LOOP, and the order is load-bearing rather than
  // incidental. Move this count above it and every conservation property still holds —
  // each dose stays on exactly one row — while a stack that is about to dissolve into
  // loose rows still counts toward its routine's total, so a legitimately claimable open
  // dose is quietly demoted to the due row. Green fuzz, wrong ledger: the two questions
  // ("is every dose on exactly one row?" and "is it on the RIGHT one?") are answered by
  // different instruments, and only the first is cheap to fuzz.
  //
  // TWO CASES HOLD THIS POSITION, both in `lib/__tests__/day-ledger.test.ts`: "lets the
  // survivor claim when a singleton member dissolves" and its two-singleton sibling. Lift
  // the count above the loop and they red with `expected '2 doses' to be '2 of 3'` and
  // `expected '3 doses' to be '3 of 4'` — the demotion, stated exactly. They were written
  // because nothing else caught it: before them the whole file stayed green under that
  // move, and so did the conservation fuzz, since every dose was still on exactly one row.
  // Each asserts first that the fixture really does dissolve a member, so it cannot drift
  // into passing on a shape that no longer exercises the ordering at all.
  const rowsPerRoutine = new Map<string, number>();
  for (const stack of stacks.values()) {
    const routine = [stack.bucket, stack.stack].join(KEY_SEP);
    rowsPerRoutine.set(routine, (rowsPerRoutine.get(routine) ?? 0) + 1);
  }
  const claimed = new Set<number>();
  for (const stack of stacks.values()) {
    if (rowsPerRoutine.get([stack.bucket, stack.stack].join(KEY_SEP)) !== 1)
      continue;
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
