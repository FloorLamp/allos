// THE DASHBOARD'S VIEW OF THE ATTENTION MODEL: one entry per dose slot.
//
// A READER over the shared upcoming list — no scores, no lanes, no candidates —
// which is why it outlived the ranker's deletion (#5435 §8, #5885). `lib/home-list.ts`
// is its only consumer. Everything here that minted candidates went with
// `rankDashboardCandidates`.

import type { UpcomingItem } from "../upcoming";
import { doseBucketFromSortHint } from "../dose-order";
import type { TimeBucket } from "../intake-schedule";

// The scheduled slot a dose item sits in, read from the key the dose generator itself
// stamps (#297). One answer to "which slot is this dose in", shared with Home's
// composer rather than re-derived there.
export function itemDoseBucket(item: UpcomingItem): TimeBucket | null {
  return item.domain === "dose" ? doseBucketFromSortHint(item.sortHint) : null;
}

// WHETHER THIS ITEM HOSTS SOMETHING THE PERSON CAN DO.
//
// The affordance fields are the item's own declaration of what it can host, so this
// asks the item rather than its domain — the same distinction #2578 drew when asking
// the domain deleted three unrelated row kinds at once. `actionLabel` covers only
// navigation-first status rows; the typed one-tap actions have their own source
// fields and are still actions even when the current viewer cannot perform the write.
//
// ONE answer for the whole app. The attention model's candidates and Home's Now band
// (#5435 §2.2) ask exactly this question, so they read exactly this predicate: a
// second copy would drift silently the next time `UpcomingItem` gains an affordance.
// A fact with no control is neither's — it belongs to the glance card or the record,
// which read it from a neutral dated reader and state it once.
export function itemIsActionable(item: UpcomingItem): boolean {
  return (
    item.actionLabel != null ||
    item.altAction != null ||
    item.doseId != null ||
    item.practiceLog != null ||
    item.preventiveRuleKey != null ||
    item.bookHref != null ||
    item.carePlanItemId != null ||
    item.conditionSuggestion != null ||
    item.followUpResolve != null ||
    item.followUpSettle != null
  );
}

// ── A SLOT'S DUE DOSES ARE ONE CANDIDATE (#5063) ─────────────────────────────
//
// Six doses declared for one time bucket are ONE act at one moment. As one candidate
// each, the Now cap seated two and the rest fell through Standing and Ahead into the
// fold — a stack split from its own smoothie, with the control that takes the whole
// slot sitting below the stragglers. So a bucket holding two or more due doses is ONE
// entry carrying its members, and a bucket holding one is the dose itself, unchanged.
//
// It groups the DASHBOARD'S view of the attention model and nothing upstream of it:
// Upcoming's rows, the digest, the app badge and the calendar feed still see one item
// per dose. What changes is only what this page treats as one thing to do.
export type AttentionEntry =
  | { kind: "item"; item: UpcomingItem; sourceIndex: number }
  | {
      kind: "dose-slot";
      bucket: TimeBucket;
      items: readonly UpcomingItem[];
      sourceIndex: number;
    };

// The bucket a due dose sits in, or null for anything that is not one. `doseId` is
// part of the test because every member of a slot row is a one-tap write.
function doseSlotBucket(item: UpcomingItem): TimeBucket | null {
  if (item.domain !== "dose" || item.doseId == null) return null;
  return doseBucketFromSortHint(item.sortHint);
}

// The slot's key inside the attention namespace (`dashboardAttentionCandidateId`
// still mints the id), so a slot and a dose can never collide and the slot acquires
// no identity namespace of its own.
export function doseSlotKey(bucket: TimeBucket): string {
  return `dose-slot:${bucket}`;
}

// A WEEKLY TARGET IS A STANDING READING, NOT AN UPCOMING ITEM (#5064). Its
// progress reaches this page as `target.weekly-progress:<id>` — the family Standing
// states, and whose behind member Attention already highlights — so the same four
// facts arriving again through the upcoming model gave one screen two lanes saying
// one thing in two spellings ("Cardio 1 of 2 this week" and "Cardio 1/2 this week").
//
// Dropped HERE, in the dashboard's own view of the attention model, and nowhere
// else: `weeklyTarget` is the producer's declaration of what the row IS
// (lib/queries/upcoming/plans.ts, #2579-E), and /upcoming's planning ledger, the
// digest, the app badge and the calendar feed all still see the item — completeness
// is that page's charter, and one dashboard is not it.
function weeklyTargetReading(item: UpcomingItem): boolean {
  return item.weeklyTarget === true;
}

export function attentionEntries(
  items: readonly UpcomingItem[]
): AttentionEntry[] {
  const slots = new Map<
    TimeBucket,
    { items: UpcomingItem[]; sourceIndex: number }
  >();
  items.forEach((item, sourceIndex) => {
    const bucket = doseSlotBucket(item);
    if (bucket == null) return;
    const run = slots.get(bucket);
    if (run) run.items.push(item);
    else slots.set(bucket, { items: [item], sourceIndex });
  });
  // Emitted in the model's OWN order, and a slot takes the position of its FIRST
  // member — so every other candidate keeps the `sourceOrder` it had, and the
  // #3554 dose-day order still decides which owed act reaches Now.
  return items.flatMap<AttentionEntry>((item, sourceIndex) => {
    if (weeklyTargetReading(item)) return [];
    const bucket = doseSlotBucket(item);
    const run = bucket == null ? undefined : slots.get(bucket);
    if (run == null || run.items.length < 2)
      return [{ kind: "item", item, sourceIndex }];
    return run.sourceIndex === sourceIndex
      ? [{ kind: "dose-slot", bucket: bucket!, items: run.items, sourceIndex }]
      : [];
  });
}
