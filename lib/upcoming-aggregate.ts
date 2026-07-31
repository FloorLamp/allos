// Display aggregation for the Upcoming PAGE (issue #1504) — pure, no DB, no JSX.
//
// The audit: at 390px the seeded planning page was 7,145px / 58 rows, and "Today"
// (29 of them) was almost entirely routine — every scheduled dose as its own full
// row, then ~8 pairwise interaction/PGx notes each asking to be reviewed. The
// genuinely attention-worthy items (a fever pattern, a screening, a pre-surgery
// bleeding note) were needles in that haystack.
//
// The fix ports the ALWAYS-PRESENT contract owner-confirmed in #1413-B for the
// dashboard hero: the care tier's contract is not "always full", it is "always
// present" — the COUNT is never hidden, the VERTICAL COST becomes opt-in, and the
// safety classes are exempt from the compaction entirely. Applied here:
//
//   A. Scheduled doses fold into ONE expandable row PER BAND, headed by the count
//      (and, for today, the day's taken fraction).
//   B. Interaction + PGx findings fold into ONE expandable med-safety row.
//
// What this module is NOT allowed to change, and doesn't: the engines, the bands,
// compareWithinBand, collectUpcoming, and the suppression bus. RENDERING aggregates;
// IDENTITY does not (the #1496 discipline). Every folded row keeps its own
// `dedupeKey`/`key`, its own snooze/dismiss, and its own WriteTarget, because the
// aggregate hands the SAME item objects back to the same row renderer. Nothing here
// is persisted either: an aggregate is collapsed on every visit (stateless), so
// there is no hidden per-user state that could make two people's pages disagree.
//
// The digest, the dashboard hero, and the calendar feed read the same model and are
// untouched — this is page-side presentation only.

import {
  type UpcomingItem,
  type UpcomingDomain,
  type UrgencyBand,
} from "./upcoming";
import { itemSuppressionPolicy } from "./upcoming-suppress";

// ---------------------------------------------------------------------------
// What folds
// ---------------------------------------------------------------------------

// The two fold classes. Each is a CLOSED, named set of domains — never "everything
// that looks routine" — so adding a domain to a rollup is a deliberate edit with a
// test to update, not a silent inheritance.
export type AggregateKind = "dose" | "med-safety";

// The med-safety rollup covers `interaction` + `pgx` ONLY (#1504 scope pin).
// Deliberately NOT included:
//   - `allergy-med` — ranked ABOVE the interactions on purpose (#1029: an allergy on
//     file outranks a pairwise interaction) and care-persistent; its per-item
//     salience is the whole point, so it stays an individual row.
//   - `illness-care`, `condition-review`, `contrast`, `dental-safety`, `ototoxic`,
//     `uv-exposure`, `mental-health` — singular findings about one situation, not a
//     repetitive pairwise list. Folding them would hide a fever pattern behind a
//     count, which is the exact failure this page had.
// lib/__tests__/upcoming-aggregate.test.ts reflects over the FULL UpcomingDomain
// union so a newly added domain must CHOOSE a side rather than drift in.
export const MED_SAFETY_ROLLUP_DOMAINS: readonly UpcomingDomain[] = [
  "interaction",
  "pgx",
];

// The domains each fold class claims. `dose` is the scheduled-dose row and nothing
// else: `prn-max` is a safety note (below), and `available` never reaches a band at
// all — a `may` item lives in Upcoming's own collapsed "available" disclosure
// (#1505) and is deliberately outside both the page total and this aggregate, so
// folding it here would double-fold it and make an accepted demotion look like a
// deletion.
export function aggregateKindForDomain(
  domain: UpcomingDomain
): AggregateKind | null {
  if (domain === "dose") return "dose";
  if (MED_SAFETY_ROLLUP_DOMAINS.includes(domain)) return "med-safety";
  return null;
}

// The SAFETY EXEMPTION, pinned (#1504, the #449/#942 posture). Two kinds of row are
// never folded and always lead their band:
//
//   1. Any item that declares the `safety-ungated` lifecycle policy — the property
//      that already means "the dismissal bus may never hide this" (a missed-dose
//      ESCALATION, the #716 crisis finding). Reading the tier off the item's OWN
//      declared policy through the shared `itemSuppressionPolicy` dispatcher — the
//      same way the hero's collapse carve-out does (#1413-B) — means a future safety
//      signal inherits the exemption automatically. A domain allowlist here would
//      have to be separately remembered, which is exactly how a safety carve-out
//      silently stops covering something.
//   2. A `prn-max` row (#798) — the dose aggregate's safety twin. It is a count that
//      has already been exceeded, so it must never be summarised by another count.
//
// "Above", not merely "outside": these render FIRST in their band, before the
// aggregate, so compaction can never push a safety row below a summary of routine
// work.
export function isSafetyPinnedItem(
  item: Pick<UpcomingItem, "domain" | "carePersistent" | "suppressionPolicy">
): boolean {
  if (item.domain === "prn-max") return true;
  return itemSuppressionPolicy(item) === "safety-ungated";
}

// Whether an item may be folded into an aggregate at all.
export function foldClassOf(
  item: Pick<UpcomingItem, "domain" | "carePersistent" | "suppressionPolicy">
): AggregateKind | null {
  if (isSafetyPinnedItem(item)) return null;
  return aggregateKindForDomain(item.domain);
}

// Two rows are not a haystack. Below this many foldable rows the aggregate would
// cost a tap to save less vertical space than the summary row itself occupies, and
// the user would be paying for a disclosure that discloses nothing. So a class folds
// only once it is genuinely a LIST.
export const AGGREGATE_MIN_ROWS = 3;

// ---------------------------------------------------------------------------
// The band render plan
// ---------------------------------------------------------------------------

// One thing the page draws inside a band's card: either an ordinary row, or an
// aggregate disclosure carrying the items it folded (in the band's own order).
export type BandNode<T> =
  | { node: "item"; item: T }
  | { node: "aggregate"; kind: AggregateKind; items: T[] };

// Turn one band's already-sorted items into the list of things to draw.
//
// Order rules, all of them stable and stateless:
//   - Safety-pinned rows lead the band, in their existing relative order.
//   - Every other item keeps its position from compareWithinBand.
//   - An aggregate occupies the position of the FIRST item it folded, so the fold
//     never moves a class out of the order the comparator chose for it.
//   - A class with fewer than AGGREGATE_MIN_ROWS foldable items does not fold; its
//     rows render individually, exactly as before.
//
// The input order is the band's order (the caller has already sorted); this function
// never re-sorts, so it cannot silently become a second ordering of the same facts.
export function planBandRender<T extends UpcomingItem>(
  items: readonly T[]
): BandNode<T>[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (isSafetyPinnedItem(item)) pinned.push(item);
    else rest.push(item);
  }

  const buckets = new Map<AggregateKind, T[]>();
  for (const item of rest) {
    const kind = foldClassOf(item);
    if (kind == null) continue;
    const arr = buckets.get(kind);
    if (arr) arr.push(item);
    else buckets.set(kind, [item]);
  }
  const folding = new Set<AggregateKind>();
  for (const [kind, arr] of buckets) {
    if (arr.length >= AGGREGATE_MIN_ROWS) folding.add(kind);
  }

  const nodes: BandNode<T>[] = pinned.map((item) => ({
    node: "item" as const,
    item,
  }));
  const emitted = new Set<AggregateKind>();
  for (const item of rest) {
    const kind = foldClassOf(item);
    if (kind != null && folding.has(kind)) {
      if (emitted.has(kind)) continue;
      emitted.add(kind);
      nodes.push({ node: "aggregate", kind, items: buckets.get(kind) ?? [] });
      continue;
    }
    nodes.push({ node: "item", item });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// The day's dose progress
// ---------------------------------------------------------------------------

// How many doses today's schedule asked for and how many are logged taken. The
// denominator is the SAME due set the rows come from (must/should, cadence-gated by
// doseDueOn — #1602), so "9 of 14 taken" always reconciles with the rows behind the
// disclosure; a `may` item is in neither number, because it was never owed (#1505).
export interface DoseDayProgress {
  scheduled: number;
  taken: number;
}

export const EMPTY_DOSE_PROGRESS: DoseDayProgress = { scheduled: 0, taken: 0 };

// Sum several members' progress for the merged cross-profile band. By-person mode
// passes one member's own progress instead, so each presentation states a fraction
// over exactly the rows it is showing.
export function sumDoseProgress(
  parts: Iterable<DoseDayProgress>
): DoseDayProgress {
  let scheduled = 0;
  let taken = 0;
  for (const p of parts) {
    scheduled += p.scheduled;
    taken += p.taken;
  }
  return { scheduled, taken };
}

// ---------------------------------------------------------------------------
// Summary copy
// ---------------------------------------------------------------------------

// The dose aggregate's ALWAYS-VISIBLE headline. The count of what is folded comes
// first (the user must be able to price the tap without taking it), and the day's
// taken fraction follows when it is meaningful — that fraction is the reason a fold
// is acceptable at all: "12 doses left · 9 of 21 taken" says you are most of the way
// through, which 12 stacked rows never said.
//
// Progress is only shown for the TODAY band: a fraction of "today's schedule" means
// nothing next to a row banded Overdue or This week, and a denominator that doesn't
// match the rows would be worse than no denominator.
export function doseAggregateLabel(
  pending: number,
  progress?: DoseDayProgress | null
): string {
  const noun = pending === 1 ? "dose" : "doses";
  if (progress == null || progress.scheduled <= 0) {
    return `${pending} ${noun}`;
  }
  return `${pending} ${noun} left · ${progress.taken} of ${progress.scheduled} taken`;
}

// The med-safety rollup's always-visible headline. Named by what the count spans
// (#531) — these are interaction and PGx notes, so "medication-safety notes" is the
// honest label for the pair.
export function medSafetyAggregateLabel(count: number): string {
  return `${count} medication-safety ${count === 1 ? "note" : "notes"}`;
}

export function aggregateLabel(
  kind: AggregateKind,
  count: number,
  progress?: DoseDayProgress | null
): string {
  return kind === "dose"
    ? doseAggregateLabel(count, progress)
    : medSafetyAggregateLabel(count);
}

// Whether a band should carry the dose progress fraction (see doseAggregateLabel).
// Takes the page group kind, which is an urgency band or one of the two signal
// groupings; only the date band "today" qualifies.
export function bandShowsDoseProgress(kind: string): boolean {
  return kind === ("today" satisfies UrgencyBand);
}
