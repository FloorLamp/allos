// MOMENT-LED SECTIONS (#2652 behavior 1). PURE — no DB, no clock read, no JSX. The one
// function that decides "whose moment is now", so it is testable without a DOM.
//
// THE RULE, generalized from the /upcoming charter (#2579). There, *a row earns full
// height only if this page is its primary home*. Here: **a section earns full height only
// if this moment is its moment.** In the morning the Morning dose slot renders in full,
// with its Take controls; the Evening slot spends one line. In the evening it inverts.
//
// SAME DATA, ONLY HEIGHT MOVES — and that is meant literally, in two ways this module
// enforces:
//
//   1. NO REORDERING. Sections stay in dose-day order (`TIME_BUCKETS`), never hoisted by
//      relevance. Moving the current slot to the top would change where a thing IS, not
//      just how tall it is, and it would push a past-due slot down the page — the one
//      place height is the wrong thing to be spending less of. Compressed slots are one
//      line each, so the current slot is near the top anyway; that is a consequence of
//      compression, not a second mechanism.
//   2. NO REMOVAL, NO LOSS OF REACH. A compressed section keeps every dose it had, in a
//      disclosure the caller renders: one tap re-opens the full rows WITH their log
//      controls. Nothing is filtered out and no affordance is further away than a tap
//      (#1504's "collapsed, never filtered out").
//
// WHEN A SECTION MAY NOT COLLAPSE. This is the load-bearing half, and it is the local
// answer to the deceptive-success line the issue names (#2385: taps-to-first-log falls
// while EVENING adherence drops, because the off slot's real dueness got compressed
// away). A section collapses only when it can state its whole truth in one line:
//
//   • The MOMENT's own section never collapses WHILE IT OWES SOMETHING. It is why the
//     reader is here. Once it is finished it is just another settled slot, and holding it
//     open would spend the moment's height on a wall of checked rows.
//   • A section carrying an OBLIGATION NOW never collapses — an unresolved dose whose
//     slot has arrived or passed. That is the owner's standing ruling for behavior 2
//     ("anything carrying an obligation never collapses") applied to slots, and it is
//     the specific thing that keeps compression from hiding a missed evening.
//     "Anytime" has no clock, so an unresolved Anytime dose is owed all day and its
//     section stays open all day.
//   • Everything else states its truth honestly: a SETTLED slot says what it settled to,
//     an AHEAD slot says how many are coming and when. Neither can be misread as the
//     other, because a settled line leads with a check and an ahead line never does.
//
// AN HONEST LINE IS NOT A SMALLER LIE. "Morning ▸" is a truncation — it withholds the
// outcome the reader came for. "✓ Morning · 3 of 3 taken · 08:12" IS the section, one
// line tall. Every line this module produces names the count it is summarizing, so a
// slot with a skipped dose can never read as a slot that was fully taken: skips are
// stated, not folded into "done".
//
// REDUCED MOTION (#2654) is the designed state. Collapsed and expanded are two
// STATES, each legible standing still: the collapsed one carries a full sentence and the
// expanded one carries a heading and its rows. Nothing here describes a transition, and
// the caller's disclosure needs no animation for either state to be readable.

import { TIME_BUCKETS, type TimeBucket } from "./intake-schedule";

/** One dose, already bucketed and resolved by the caller. `key` is the caller's row id. */
export interface MomentDose<K = number> {
  key: K;
  bucket: TimeBucket;
  /** Taken OR deliberately skipped — either way it needs no more action. */
  resolved: boolean;
  /** Resolved AND taken (as opposed to skipped). Meaningless when `resolved` is false. */
  taken: boolean;
  /**
   * The preformatted local clock this dose was taken at (the caller owns the profile's
   * TimeFormat), or null. The line quotes the LATEST one it has.
   */
  takenClock?: string | null;
}

export type MomentSectionState =
  // This moment is its moment. Full height, always.
  | "moment"
  // Owes something NOW — an unresolved dose whose slot has arrived or passed, or an
  // unresolved timeless dose. Full height, always: compressing this is the failure mode.
  | "obligation"
  // Every dose resolved. Collapses to what it settled to.
  | "settled"
  // Still ahead of the clock, nothing owed yet. Collapses to what is coming.
  | "ahead";

export interface MomentSection<K = number> {
  bucket: TimeBucket;
  label: string;
  doses: MomentDose<K>[];
  state: MomentSectionState;
  /** Full height? True for `moment` and `obligation`; false for the two collapsible states. */
  expanded: boolean;
  /**
   * The section's whole truth in one line. Computed for EVERY section, not only the
   * collapsed ones, so an expanded section's header can show the same count and the two
   * renderings cannot drift apart.
   */
  line: string;
  /**
   * The same line WITHOUT its leading label, for a renderer that already shows the slot
   * name as a heading beside it. Split here rather than by string surgery at the call
   * site, so the two renderings cannot come apart.
   */
  lineDetail: string;
  /**
   * Whether the line leads with a check — i.e. the slot is settled AND something in it
   * was actually taken. A slot that was entirely skipped is settled but never checked.
   */
  checked: boolean;
  /** Doses resolved / total, and how the resolved ones resolved. */
  takenCount: number;
  skippedCount: number;
  total: number;
}

export interface MomentSectionsInput<K = number> {
  doses: MomentDose<K>[];
  /**
   * The bucket the profile-local wall clock is in right now — `currentTimeBucket(nowHhmm)`
   * at the call site, so the moment is derived in the PROFILE's timezone and this stays
   * clock-free.
   */
  currentBucket: TimeBucket;
  /**
   * Optional preformatted slot clocks ("21:00"), by bucket — the profile's own intake
   * reminder times where the caller has them. An ahead line quotes the clock when it is
   * given and simply omits it when it is not; it never invents one.
   */
  slotClocks?: Partial<Record<TimeBucket, string>>;
  /** Bucket display names (`TIME_BUCKET_LABELS` at the call site). */
  labels: Record<TimeBucket, string>;
}

// "Anytime" is owed all day and is never ahead of or behind the clock.
const ANYTIME: TimeBucket = "Anytime";

function bucketRank(b: TimeBucket): number {
  return TIME_BUCKETS.indexOf(b);
}

/**
 * Whether `bucket`'s slot has arrived, given the bucket the clock is in. "Anytime" has
 * arrived from the start of the day. Mirrors the past-due comparison
 * `buildTodayPanelModel` already makes, extended to include the CURRENT slot: a dose in
 * the slot you are standing in is owed now, not later.
 */
function slotHasArrived(bucket: TimeBucket, currentBucket: TimeBucket): boolean {
  if (bucket === ANYTIME) return true;
  return bucketRank(bucket) <= bucketRank(currentBucket);
}

/**
 * The one-line truth for a section. Never a truncation: it names the count it summarizes
 * and, where it has one, the time.
 *
 *   settled, all taken     "✓ Morning · 3 of 3 taken · 08:12"
 *   settled, some skipped  "✓ Morning · 2 taken, 1 skipped"
 *   settled, all skipped   "Morning · 3 skipped"      (no check — nothing was taken)
 *   ahead, none taken      "Evening · 4 doses · 21:00"
 *   ahead, some taken      "Evening · 1 of 4 taken · 21:00"
 *   open now               "Morning · 1 of 3 taken"    (header line for a full section)
 */
export function momentSectionLine(
  section: Omit<MomentSection, "line" | "lineDetail" | "checked">,
  slotClock?: string
): { line: string; lineDetail: string; checked: boolean } {
  const { label, takenCount, skippedCount, total, state } = section;
  const resolved = takenCount + skippedCount;
  const settled = resolved === total && total > 0;
  // A check mark is a claim that the slot was TAKEN. A slot that was entirely skipped is
  // settled but was not taken, and must not wear one.
  const checked = settled && takenCount > 0;
  const parts: string[] = [];

  if (settled) {
    if (skippedCount === 0) {
      parts.push(`${takenCount} of ${total} taken`);
    } else if (takenCount === 0) {
      parts.push(`${skippedCount} skipped`);
    } else {
      parts.push(`${takenCount} taken, ${skippedCount} skipped`);
    }
  } else if (takenCount > 0 || skippedCount > 0) {
    parts.push(`${takenCount} of ${total} taken`);
  } else {
    parts.push(`${total} ${total === 1 ? "dose" : "doses"}`);
  }

  // The time. A settled slot quotes when it actually happened; a slot still to come
  // quotes when it is scheduled, and only when the caller supplied one.
  const stamp = settled
    ? lastTakenClock(section.doses)
    : state === "ahead"
      ? slotClock
      : undefined;
  if (stamp) parts.push(stamp);

  const lineDetail = parts.join(" · ");
  return {
    line: `${checked ? "✓ " : ""}${label} · ${lineDetail}`,
    lineDetail,
    checked,
  };
}

function lastTakenClock(doses: readonly MomentDose[]): string | undefined {
  const clocks = doses
    .filter((d) => d.resolved && d.taken && d.takenClock)
    .map((d) => d.takenClock as string);
  if (clocks.length === 0) return undefined;
  // Lexical max is chronological for a zero-padded 24h clock, and for a 12h clock it is
  // only ever used to pick ONE of the slot's own stamps to show — never to order the day.
  return clocks.reduce((a, b) => (b > a ? b : a));
}

/**
 * Build the moment-led sections. Only buckets that HAVE doses become sections — an empty
 * slot has no truth to state and is not a collapsed line about nothing.
 */
export function buildMomentSections<K = number>({
  doses,
  currentBucket,
  slotClocks,
  labels,
}: MomentSectionsInput<K>): MomentSection<K>[] {
  const byBucket = new Map<TimeBucket, MomentDose<K>[]>();
  for (const d of doses) {
    const list = byBucket.get(d.bucket);
    if (list) list.push(d);
    else byBucket.set(d.bucket, [d]);
  }

  const sections: MomentSection<K>[] = [];
  for (const bucket of TIME_BUCKETS) {
    const group = byBucket.get(bucket);
    if (!group || group.length === 0) continue;

    const takenCount = group.filter((d) => d.resolved && d.taken).length;
    const skippedCount = group.filter((d) => d.resolved && !d.taken).length;
    const total = group.length;
    const unresolved = total - takenCount - skippedCount;

    let state: MomentSectionState;
    // The current slot leads — but only while it still owes something. A slot you have
    // already finished states its truth in one line as well as any other, and holding it
    // open would spend the moment's height on a wall of checked rows.
    if (bucket === currentBucket && unresolved > 0) state = "moment";
    else if (unresolved > 0 && slotHasArrived(bucket, currentBucket))
      state = "obligation";
    else if (unresolved === 0) state = "settled";
    else state = "ahead";

    const base = {
      bucket,
      label: labels[bucket],
      doses: group,
      state,
      expanded: state === "moment" || state === "obligation",
      takenCount,
      skippedCount,
      total,
    };
    sections.push({
      ...base,
      ...momentSectionLine(
        base as unknown as Omit<
          MomentSection,
          "line" | "lineDetail" | "checked"
        >,
        slotClocks?.[bucket]
      ),
    });
  }

  // A LONE slot never collapses. This rule is about what compression is FOR: height is
  // spent on the moment at the expense of the slots that are not it. With one slot there
  // is nothing it is being preferred over — collapsing it would replace the whole panel
  // with a single line and buy the reader nothing but a tap. The generalization says a
  // section earns full height when this moment is its moment; when it is the only
  // section, every moment is.
  if (sections.length === 1) sections[0].expanded = true;

  // A day with nothing owed and nothing happening in this slot would leave every section
  // collapsed. That is right when everything is SETTLED (the panel says "All done today"
  // above it), but wrong when work is merely ahead: some section has to be the one the
  // reader acts in. The EARLIEST unsettled section leads.
  if (sections.length > 0 && !sections.some((s) => s.expanded)) {
    const lead = sections.find((s) => s.state !== "settled");
    if (lead) lead.expanded = true;
  }

  return sections;
}
