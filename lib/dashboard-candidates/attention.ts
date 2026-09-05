import type { UpcomingItem } from "../upcoming";
import { bandForItem, upcomingDueText } from "../upcoming";
import { itemSuppressionPolicy } from "../upcoming-suppress";
import { doseBucketFromSortHint } from "../dose-order";
import {
  OBLIGATION_ORDER,
  TIME_BUCKET_LABELS,
  TIME_BUCKET_OPENS_AT,
  type TimeBucket,
} from "../intake-schedule";
import { formatClockMinutes, type DisplayFormatPrefs } from "../format-date";
import { preventiveReviewFactKey } from "../preventive-review";
import { actionCandidate, statementCandidate } from "./candidate";
import type {
  DashboardCandidate,
  DashboardObligation,
  DashboardSubject,
} from "../dashboard-relevance";
import {
  dashboardAttentionCandidateId,
  dashboardAttentionFactKey,
} from "../dashboard-attention-identity";
import { localTimeWindow } from "../dashboard-relevance";

function doseOpensAt(item: UpcomingItem): number | null {
  if (item.domain !== "dose") return null;
  const bucket = doseBucketFromSortHint(item.sortHint);
  return bucket == null ? null : TIME_BUCKET_OPENS_AT[bucket];
}

export function attentionAheadDetail(
  item: UpcomingItem,
  today: string,
  prefs: DisplayFormatPrefs
): string {
  const detail = upcomingDueText(item, today, prefs);
  const opensAt = doseOpensAt(item);
  return opensAt == null
    ? detail
    : `${detail} · from ${formatClockMinutes(prefs.timeFormat, opensAt)}`;
}

// THE DOSE CHIP'S LABEL (#4752 item 7): `Midday · [Take]`. The labeled-verb chip's
// one promise is that the label shows the PAYLOAD the tap carries, and for a
// scheduled dose that payload is the SLOT it belongs to — which is also the shortest
// true thing to say, and the row needs it short: the chip does not shrink, so a long
// label costs the row's own identity line its one-line form on a phone.
//
// IT IS NOT `attentionAheadDetail`. That is Ahead's sentence — "Due today · from
// 11:00" — and Ahead is where a row states why it is not now; a Now row is already
// here. A dose with no slot to name (nothing in its sortHint) falls back to the due
// text, which is the same fact at the only other resolution available.
export function attentionDoseChipLabel(
  item: UpcomingItem,
  today: string,
  prefs: DisplayFormatPrefs
): string {
  const bucket =
    item.domain === "dose" ? doseBucketFromSortHint(item.sortHint) : null;
  return bucket == null
    ? upcomingDueText(item, today, prefs)
    : TIME_BUCKET_LABELS[bucket];
}

function attentionObligation(
  item: UpcomingItem,
  setup: boolean
): DashboardObligation {
  if (item.obligation) return item.obligation;
  // An available item is an offer, never owed: its null date or open window cannot
  // promote it into Now without a separate user/context signal (#3082).
  if (setup || item.domain === "available") return "may";
  // A due date says when a fact matters, not that the source declared it a must.
  // Non-intake attention models do not carry the three-level obligation field.
  return "should";
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
    const bucket = doseSlotBucket(item);
    const run = bucket == null ? undefined : slots.get(bucket);
    if (run == null || run.items.length < 2)
      return [{ kind: "item", item, sourceIndex }];
    return run.sourceIndex === sourceIndex
      ? [{ kind: "dose-slot", bucket: bucket!, items: run.items, sourceIndex }]
      : [];
  });
}

// Whether this item is owed RIGHT NOW. Upcoming exposes one due-now fact, so this
// producer cannot distinguish owed from window-open; the separate Now tiers remain
// reachable through target-log candidates, which carry the two booleans
// independently (#4255).
function attentionDueNow(item: UpcomingItem, today: string): boolean {
  const band = bandForItem(item, today);
  return item.signalGroup == null && (band === "overdue" || band === "today");
}

export function attentionCandidates(
  subject: DashboardSubject,
  items: readonly UpcomingItem[],
  today: string,
  sourceOrder = 0
): DashboardCandidate[] {
  return attentionEntries(items).map((entry) =>
    attentionEntryCandidate(
      subject,
      entry,
      today,
      sourceOrder + entry.sourceIndex
    )
  );
}

// ONE ENTRY, ONE CANDIDATE. Both arms mint their id through the same attention
// identity helper, so a slot and a dose share one namespace and the exact-once
// partition still holds over `factKey`.
export function attentionEntryCandidate(
  subject: DashboardSubject,
  entry: AttentionEntry,
  today: string,
  sourceOrder: number
): DashboardCandidate {
  if (entry.kind === "item")
    return attentionItemCandidate(subject, entry.item, today, sourceOrder);
  const key = doseSlotKey(entry.bucket);
  const dueNow = entry.items.some((item) => attentionDueNow(item, today));
  return actionCandidate({
    candidateId: dashboardAttentionCandidateId(key),
    factKey: dashboardAttentionFactKey(key),
    groupKey: "attention.due",
    subject,
    applicable: true,
    relevance: { kind: "event" },
    rankReasons: {
      safety: entry.items.some(
        (item) => itemSuppressionPolicy(item) === "safety-ungated"
      ),
      owed: dueNow,
      windowOpen: dueNow,
      changed: false,
    },
    // Every member was declared for this bucket, so the slot's window IS the
    // bucket's — the same span each member carried alone.
    timing: localTimeWindow(TIME_BUCKET_OPENS_AT[entry.bucket], 24 * 60 - 1),
    sourceOrder,
    // AS STRONGLY OWED AS ITS STRONGEST MEMBER. A `must` dose may not be softened
    // by the `should` doses it now shares a seat with — the seat is the same act.
    obligation: entry.items.reduce<DashboardObligation>((strongest, item) => {
      const own = attentionObligation(item, false);
      return OBLIGATION_ORDER[own] < OBLIGATION_ORDER[strongest]
        ? own
        : strongest;
    }, "may"),
  });
}

function attentionItemCandidate(
  subject: DashboardSubject,
  item: UpcomingItem,
  today: string,
  sourceOrder: number
): DashboardCandidate {
  const opensAt = doseOpensAt(item);
  const setup = item.signalGroup === "setup";
  const dueNow = attentionDueNow(item, today);
  // Carry the owning Upcoming surface's declared affordances. `actionLabel`
  // covers only navigation-first status rows; the typed one-tap actions have
  // their own source fields and are still action candidates even when the
  // current viewer cannot perform the write.
  const actionable =
    item.actionLabel != null ||
    item.altAction != null ||
    item.doseId != null ||
    item.practiceLog != null ||
    item.preventiveRuleKey != null ||
    item.bookHref != null ||
    item.carePlanItemId != null ||
    item.conditionSuggestion != null ||
    item.followUpResolve != null ||
    item.followUpSettle != null;
  const common = {
    candidateId: dashboardAttentionCandidateId(item.key),
    factKey: dashboardAttentionFactKey(item.key),
    groupKey: item.signalGroup
      ? `attention.${item.signalGroup}`
      : "attention.due",
    subject,
    // Read access still owns the fact. Write capability controls the atom's
    // controls in presentation; filtering here erased safety information.
    applicable: true,
    relevance: setup
      ? ({ kind: "setup" } as const)
      : ({ kind: "event" } as const),
    rankReasons: {
      safety: itemSuppressionPolicy(item) === "safety-ungated",
      owed: dueNow,
      windowOpen: dueNow,
      changed: item.signalGroup === "flagged" || item.signalGroup === "review",
    },
    timing: opensAt == null ? undefined : localTimeWindow(opensAt, 24 * 60 - 1),
    // The candidate's rank tiebreak IS this list's index, so the order the
    // model arrives in decides which owed `must` doses survive
    // NOW_CANDIDATE_CAP when they all score alike. buildAttentionModel states
    // and guarantees that order — date → priority → domain → dose-day slot
    // (#297) → title → key — so this index means the canonical dose-day order,
    // never raw generator emission (#3554).
    sourceOrder,
  };
  return actionable
    ? actionCandidate({
        ...common,
        obligation: attentionObligation(item, setup),
      })
    : statementCandidate(common);
}

// A preventive REVIEW CANDIDATE (#3025): one dashboard fact per open
// record/rule candidate riding on a due preventive item, keyed
// `preventive-review:<recordId>:<ruleKey>`. Structurally BARRED from the Now
// lane: every rank reason is false and the obligation is "may", so nowScore is
// null in rankDashboardCandidates and the fact can only land in the exhaustive
// Show everything remainder — a suggestion the person goes looking for, never an
// attention claim, never a send.
export function preventiveReviewCandidate(
  subject: DashboardSubject,
  offer: { recordId: number; ruleKey: string },
  sourceOrder: number
): DashboardCandidate {
  const key = preventiveReviewFactKey(offer);
  return actionCandidate({
    candidateId: key,
    factKey: key,
    groupKey: "attention.preventive-review",
    subject,
    applicable: true,
    relevance: { kind: "event" },
    obligation: "may",
    sourceOrder,
  });
}
