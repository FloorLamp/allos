// The unified attention model (issue #524) — the ONE computation behind BOTH the
// dashboard "Needs attention" card and the Upcoming page. PURE (no DB, no JSX), so
// it's importable by both server surfaces and unit-tested in isolation.
//
// The design (issue #524): the card and the page do DIFFERENT jobs — the card is a
// triage glance (the few act-now things, quiet otherwise), the page is a planning
// view (everything on the horizon, time-ordered) — but they must never DISAGREE on
// what an item MEANS. So this module is:
//
//   1. ONE item builder (buildAttentionModel) — every attention-worthy thing
//      (dose, retest, flagged biomarker, appointment, care-plan, refill, review
//      item, failing integration) is built ONCE as a UpcomingItem carrying its
//      dueness, action copy, href, risk priority (#517), and suppressibility.
//      Neither surface recomputes an item's meaning. The "something's off" signals
//      (flagged labs #526, failing integrations, the review count) that used to
//      exist ONLY on the card are now first-class items in the shared set, so a
//      flagged HDL lands on BOTH surfaces with the same key and an action verb.
//   2. ONE within-band comparator — compareWithinBand (lib/upcoming.ts), shared
//      with groupUpcoming, so the two surfaces order the same facts identically.
//   3. TWO presentations over that one model:
//        - groupAttentionForCard: the act-now slice (overdue + today + signals,
//          capped, EXCLUDING far-future scheduled items), banded Urgent / Today /
//          Needs review.
//        - groupAttentionForPage: everything, time-ordered (Overdue / Today / This
//          week / Later) plus the signals under their own Flagged / For review
//          groupings.
//   4. The load-bearing invariant: the card's items are a strict SUBSET of the
//      page's item set (attentionCardItems just filters the model), so the counts
//      the two surfaces show always reconcile — a user who sees "8 · +7 more in
//      Upcoming" can click through and find exactly those items.
//
// The DB gather that feeds buildAttentionModel lives in lib/queries/attention.ts
// (every read there is profile-scoped); this module only shapes and orders.

import {
  type UpcomingItem,
  type SignalGroup,
  type UrgencyBand,
  BAND_LABELS,
  bandForItem,
  compareWithinBand,
} from "./upcoming";
import { biomarkerFlagDismissalKey } from "./dismissal-keys";
import { biomarkerViewHref, dataSectionHref, type AppRoute } from "./hrefs";
import { biomarkerFlagTitle, biomarkerFlagDetail } from "./biomarker-flag-copy";
import { flagLabel, isOutOfRange } from "./reference-range";
import type { DigestFlaggedBiomarker } from "./notifications/digest";

// A failing/needs-reauth integration provider, reduced to what the model renders.
export interface AttentionIntegration {
  provider: string;
  detail: string | null;
}

export interface AttentionInput {
  // The date-scheduled due-signals, already snooze/dismiss-filtered (collectUpcoming
  // does the filtering).
  upcoming: UpcomingItem[];
  // Newly-flagged out-of-range biomarkers, already suppression-filtered (same read
  // as the digest).
  flaggedBiomarkers: DigestFlaggedBiomarker[];
  // Currently-failing integration providers.
  integrations: AttentionIntegration[];
  // Count of unresolved review-inbox pairs (duplicates/conflicts).
  reviewCount: number;
  today: string;
}

// A newly-flagged biomarker → a shared attention item (issue #524/#526). Keyed on
// the SAME `biomarker-flag:<name>` dismissal identity the query layer filters on,
// so a dismiss/snooze from either surface silences the analyte's flag like any
// other finding ("dismiss once, silence everywhere"). The title now carries a verb
// and the href deep-links to the analyte's series (the view page treats ?name= as
// the canonical name; an uncanonicalized reading falls back to the list) — the
// actionless dead-end #526 called out. An out-of-range reading outranks a merely
// non-optimal one within the group (#517-style priority). Exported so the query
// layer can rebuild the same item for the page's "Snoozed & dismissed" restore
// section (a flag dismissed on either surface stays restorable).
export function buildFlaggedItem(b: DigestFlaggedBiomarker): UpcomingItem {
  return {
    key: biomarkerFlagDismissalKey(b.name),
    domain: "biomarker-flag",
    signalGroup: "flagged",
    title: biomarkerFlagTitle(b.name),
    detail: biomarkerFlagDetail(b.flag, b.value),
    // #283 bug 5: link the CANONICAL name (not the raw display name) — the view
    // page resolves ?name= as canonical. Shared with biomarkerItems via the helper.
    href: biomarkerViewHref(b.canonicalName, b.name),
    dueDate: null,
    dueText: flagLabel(b.flag),
    suppressible: true,
    priority: isOutOfRange(b.flag) ? 1 : 0,
  };
}

// A failing/needs-reauth integration → a shared attention item. Structural (you
// reconnect it, you don't snooze it), so it's non-suppressible and files under the
// "For review" grouping alongside the import-review count.
function integrationToItem(i: AttentionIntegration): UpcomingItem {
  return {
    key: `integration:${i.provider}`,
    domain: "integration",
    signalGroup: "review",
    title: `${i.provider} sync needs attention`,
    detail: i.detail ?? "Reconnect to resume syncing.",
    href: dataSectionHref("review"),
    dueDate: null,
    dueText: "Reconnect",
    suppressible: false,
  };
}

// The unresolved import-review pair count → a single "For review" item, or null
// when there's nothing to review. Structural, so non-suppressible.
function reviewToItem(count: number): UpcomingItem | null {
  if (count <= 0) return null;
  return {
    key: "review",
    domain: "review",
    signalGroup: "review",
    title: `${count} import ${count === 1 ? "item" : "items"} to review`,
    detail: "Duplicates or conflicts detected in synced data.",
    href: dataSectionHref("review"),
    dueDate: null,
    dueText: "Review",
    suppressible: false,
  };
}

// Assemble every signal into ONE flat item set — the model both surfaces render.
// Order within a surface is decided by the grouping functions (each sorts with the
// shared compareWithinBand), so this just concatenates deterministically.
export function buildAttentionModel(input: AttentionInput): UpcomingItem[] {
  const items: UpcomingItem[] = [...input.upcoming];
  for (const b of input.flaggedBiomarkers) items.push(buildFlaggedItem(b));
  for (const i of input.integrations) items.push(integrationToItem(i));
  const review = reviewToItem(input.reviewCount);
  if (review) items.push(review);
  return items;
}

// ---------------------------------------------------------------------------
// Presentation A — the Upcoming PAGE (planning view): everything, time-ordered,
// with the "something's off" signals under their own groupings.
// ---------------------------------------------------------------------------

// A page group is either an urgency date band or one of the two signal groupings.
export type PageGroupKind = UrgencyBand | SignalGroup;

const PAGE_GROUP_ORDER: PageGroupKind[] = [
  "overdue",
  "today",
  "week",
  "later",
  "flagged",
  "review",
];

const PAGE_GROUP_LABELS: Record<PageGroupKind, string> = {
  ...BAND_LABELS,
  flagged: "Flagged",
  review: "For review",
};

export interface AttentionPageGroup {
  kind: PageGroupKind;
  label: string;
  items: UpcomingItem[];
}

// Which page group an item belongs to: a signal item goes under its signalGroup;
// every date-scheduled item bands by its due date (Overdue → Today → This week →
// Later).
function pageGroupKind(item: UpcomingItem, today: string): PageGroupKind {
  return item.signalGroup ?? bandForItem(item, today);
}

// Group the FULL model for the page: date bands in calendar order, then the Flagged
// and For-review groupings, each sorted by the shared within-band comparator. Empty
// groups are dropped. This is the complete, uncapped set — completeness is the
// point of the planning view.
export function groupAttentionForPage(
  items: UpcomingItem[],
  today: string
): AttentionPageGroup[] {
  const byKind = new Map<PageGroupKind, UpcomingItem[]>();
  for (const item of items) {
    const kind = pageGroupKind(item, today);
    const arr = byKind.get(kind);
    if (arr) arr.push(item);
    else byKind.set(kind, [item]);
  }
  const groups: AttentionPageGroup[] = [];
  for (const kind of PAGE_GROUP_ORDER) {
    const arr = byKind.get(kind);
    if (!arr || arr.length === 0) continue;
    arr.sort((a, b) => compareWithinBand(a, b, today));
    groups.push({ kind, label: PAGE_GROUP_LABELS[kind], items: arr });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Presentation B — the dashboard CARD (triage glance): the act-now slice only,
// a strict SUBSET of the page's model.
// ---------------------------------------------------------------------------

export type CardBand = "urgent" | "today" | "review";

export const CARD_BAND_ORDER: CardBand[] = ["urgent", "today", "review"];

// Deliberately DIFFERENT band words from the page (issue #524): the page frames a
// calendar ("Overdue"), the card frames urgency ("Urgent") — sharing the word is
// what made the old mismatch read as a bug.
export const CARD_BAND_LABELS: Record<CardBand, string> = {
  urgent: "Urgent",
  today: "Today",
  review: "Needs review",
};

const CARD_BAND_RANK: Record<CardBand, number> = {
  urgent: 0,
  today: 1,
  review: 2,
};

// Which card band an item belongs to, or null if the card EXCLUDES it. Signals →
// "Needs review". A date-scheduled item is act-now only when it's overdue (→ Urgent)
// or due today (→ Today); a this-week / later scheduled item is planning-view-only
// (the card's whole value is that it hides far-future scheduled work), so it returns
// null and lives only on the Upcoming page.
export function cardBandForItem(
  item: UpcomingItem,
  today: string
): CardBand | null {
  if (item.signalGroup) return "review";
  const band = bandForItem(item, today);
  if (band === "overdue") return "urgent";
  if (band === "today") return "today";
  return null;
}

// The card's item SUBSET of the full model (issue #524's load-bearing invariant):
// every returned item is one of `items`, unchanged, so the card can never show a
// key the page doesn't. Ordered by card band then the shared comparator.
export function attentionCardItems(
  items: UpcomingItem[],
  today: string
): UpcomingItem[] {
  return items
    .filter((i) => cardBandForItem(i, today) != null)
    .sort(
      (a, b) =>
        CARD_BAND_RANK[cardBandForItem(a, today)!] -
          CARD_BAND_RANK[cardBandForItem(b, today)!] ||
        compareWithinBand(a, b, today)
    );
}

export interface AttentionCardGroup {
  band: CardBand;
  label: string;
  items: UpcomingItem[];
  // Items beyond the per-band cap (issue #283): count only — the card renders a
  // "+N more" link instead of the rows, so a pathological day (a giant lab import,
  // a backlog of overdue visits) can't blow the layout.
  overflow: number;
}

// Defensive per-band row cap for the card (issue #283). High enough that a normal
// day never trips it; low enough that a flood collapses to a link.
export const ATTENTION_GROUP_CAP = 8;

// Group the card's subset by band in fixed Urgent → Today → Needs review order,
// dropping empty bands. Each band keeps at most `cap` rows (most urgent first) and
// reports the rest as `overflow`.
export function groupAttentionForCard(
  items: UpcomingItem[],
  today: string,
  cap: number = ATTENTION_GROUP_CAP
): AttentionCardGroup[] {
  const subset = attentionCardItems(items, today);
  const byBand = new Map<CardBand, UpcomingItem[]>();
  for (const item of subset) {
    const band = cardBandForItem(item, today)!;
    const arr = byBand.get(band);
    if (arr) arr.push(item);
    else byBand.set(band, [item]);
  }
  const groups: AttentionCardGroup[] = [];
  for (const band of CARD_BAND_ORDER) {
    const arr = byBand.get(band);
    if (!arr || arr.length === 0) continue;
    groups.push({
      band,
      label: CARD_BAND_LABELS[band],
      items: arr.slice(0, cap),
      overflow: Math.max(0, arr.length - cap),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Count reconciliation (issue #512 / #524) — the numbers the two surfaces show
// must nest.
// ---------------------------------------------------------------------------

// The honest per-band count label for a capped card band (issue #512): when the cap
// truncated the rendered rows, show BOTH the shown count and the true pre-cap total
// ("8 of 11") so a band never reads as a bare capped "8". No overflow → plain count.
export function attentionCountLabel(shown: number, overflow: number): string {
  return overflow > 0 ? `${shown} of ${shown + overflow}` : `${shown}`;
}

// The "+N more in Upcoming" figure for the card (issue #524): the page-only items —
// the far-future scheduled work the card deliberately hides. Because the card set is
// a strict subset of the model, this is exactly model − card, so "N shown · +M more
// in Upcoming" always reconciles with the page's total.
export function moreInUpcomingCount(
  model: UpcomingItem[],
  cardCount: number
): number {
  return Math.max(0, model.length - cardCount);
}

// ---------------------------------------------------------------------------
// "+N more" link copy (issue #538) — disambiguate by what DIFFERS, never by
// position (the #531 convention). The card can show TWO kinds of overflow link:
//   1. a per-band cap overflow (#283) — "more items in THIS band", and
//   2. the card-level remainder (#524) — "far-future scheduled items the card
//      hides for the Upcoming page".
// Post-#524 both read as a bare "+N more in Upcoming", so when the last band's cap
// overflow renders directly above the card-level remainder they stack as two
// identical-looking links (#538). This pure helper gives each link copy that names
// its referent, and MERGES the two into one line when they'd stack adjacently.
// ---------------------------------------------------------------------------

// The noun a band's cap-overflow link uses for its own items (what the "+N more"
// points at). Frames the same urgency the band header shows.
const CARD_BAND_MORE_NOUN: Record<CardBand, string> = {
  urgent: "overdue",
  today: "due today",
  review: "to review",
};

// The Upcoming-page anchor a band's cap-overflow link deep-links to (issue #538) —
// the page's sections carry id={group.kind}. Urgent/Today map cleanly onto the
// page's Overdue/Today bands; the review band spans two page groupings
// (Flagged + For review), so it lands at the top of the page rather than mis-
// pointing at one of them.
const CARD_BAND_ANCHOR: Record<CardBand, string | null> = {
  urgent: "overdue",
  today: "today",
  review: null,
};

function upcomingHref(anchor: string | null): AppRoute {
  return anchor ? `/upcoming#${anchor}` : "/upcoming";
}

export interface AttentionMoreLink {
  count: number;
  text: string;
  href: AppRoute;
}

export interface AttentionMoreLinks {
  // Per-band cap-overflow links, keyed by band, for the card to render at the foot
  // of each band section. The LAST band's link is omitted here when it merged into
  // `trailing` (so two links never stack).
  perBand: Partial<Record<CardBand, AttentionMoreLink>>;
  // The single trailing line at the card foot: either the plain far-future
  // remainder, or the merged (last-band-overflow + remainder) line.
  trailing: AttentionMoreLink | null;
}

// Compute the card's "+N more" links so each names what it points at and the
// last-band-overflow + card-remainder pair never stacks as two look-alike links
// (issue #538). `groups` are the rendered card bands (each carrying its cap
// `overflow`, in render order); `more` is moreInUpcomingCount (the hidden far-
// future scheduled items).
export function planAttentionMoreLinks(
  groups: { band: CardBand; overflow: number }[],
  more: number
): AttentionMoreLinks {
  const perBand: Partial<Record<CardBand, AttentionMoreLink>> = {};
  const lastIdx = groups.length - 1;
  const last = lastIdx >= 0 ? groups[lastIdx] : null;
  // The two links would render adjacently only when the LAST band overflows AND
  // there's a card-level remainder — that's the exact stack #538 reported.
  const merge = last != null && last.overflow > 0 && more > 0;

  groups.forEach((g, i) => {
    if (g.overflow <= 0) return;
    if (merge && i === lastIdx) return; // folded into `trailing`
    perBand[g.band] = {
      count: g.overflow,
      text: `+${g.overflow} more ${CARD_BAND_MORE_NOUN[g.band]} in Upcoming`,
      href: upcomingHref(CARD_BAND_ANCHOR[g.band]),
    };
  });

  let trailing: AttentionMoreLink | null = null;
  if (merge && last) {
    trailing = {
      count: last.overflow + more,
      text: `+${last.overflow} more ${CARD_BAND_MORE_NOUN[last.band]} and ${more} scheduled later in Upcoming`,
      href: "/upcoming",
    };
  } else if (more > 0) {
    trailing = {
      count: more,
      text: `+${more} scheduled later — view all in Upcoming`,
      href: upcomingHref("later"),
    };
  }

  return { perBand, trailing };
}
