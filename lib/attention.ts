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
  type UpcomingDomain,
  type SignalGroup,
  type UrgencyBand,
  BAND_LABELS,
  bandForItem,
  compareWithinBand,
} from "./upcoming";
import { biomarkerFlagDismissalKey } from "./dismissal-keys";
import { itemSuppressionPolicy } from "./upcoming-suppress";
import {
  readingDetailHref,
  dataSectionHref,
  integrationDetailHref,
  type AppRoute,
} from "./hrefs";
import { biomarkerFlagTitle, biomarkerFlagDetail } from "./biomarker-flag-copy";
import { flagLabel, isOutOfRange } from "./reference-range";
import { type Reason, concatReasons, flaggedReason } from "./reasons";
import type { DigestFlaggedBiomarker } from "./notifications/digest";
import type { IntegrationId } from "./types";

// A broken integration provider, reduced to what the model renders. `kind` distinguishes
// the two ways a provider can be broken (#1685), because they need different copy and ask
// the user for different things:
//   "failing" — a recorded failure / dead grant. The cause is known and the fix is
//               consent: reconnect.
//   "stale"   — nothing has failed, and nothing has arrived either. The connection may be
//               perfectly authorized; all we honestly know is that it stopped, so the
//               copy states the observation ("no data since <date>") and asks the user to
//               check rather than claiming a cause.
// Both carry the SAME item key, so a provider is one row on every surface no matter which
// signal raised it, and the gather guarantees only one of the two can fire per provider.
//
// A THIRD kind since #2146, and it is not a third way of being broken:
//   "quiet-stream" — the connection is FINE and one continuous DATA STREAM stopped (the
//               watch off the wrist while the phone keeps pushing). Heart rate is an
//               observation domain — nobody committed to wearing a watch — so this is
//               COACHING TIER: it renders where the user goes looking and never travels
//               a send. It also yields to the two above, so a provider is still one row.
//
// So `kind` now names the TIER as well as the copy, and the difference is enforced
// rather than documented: `isEscalatingIntegration` below is the one gate,
// `buildAttentionModel` and the digest's own integration section both apply it, and
// the quiet rows arrive through a separate query entry point
// (`getQuietStreamAttention`) that the badge / hero / digest never call.
export interface AttentionIntegration {
  id: IntegrationId | null;
  provider: string;
  detail: string | null;
  kind?: "failing" | "stale" | "quiet-stream";
}

/**
 * May this integration row travel to an ESCALATION surface — the profile-menu badge,
 * the non-hideable Needs-attention hero, the Upcoming page's review group, and the
 * morning digest's broken-sync section?
 *
 * Only a broken CONNECTION may. A quiet stream is a coaching-tier observation, and the
 * contact-consent rule (docs/internals/findings.md §2) is one-directional: the system
 * may reduce contact unilaterally, never increase it. Promoting "your watch seems to
 * be off" into a send is an increase, and nobody consented to it.
 */
export function isEscalatingIntegration(i: AttentionIntegration): boolean {
  return i.kind !== "quiet-stream";
}

// A newly-flagged biomarker plus its optional risk-layer reasons (issue #656 item
// 4). The reasons ride the input (not a separate map) so buildAttentionModel stays
// a plain fan-out and the gather owns the one risk computation.
export type FlaggedBiomarkerInput = DigestFlaggedBiomarker & {
  riskReasons?: Reason[];
};

export interface AttentionInput {
  // The date-scheduled due-signals, already snooze/dismiss-filtered (collectUpcoming
  // does the filtering).
  upcoming: UpcomingItem[];
  // Newly-flagged out-of-range biomarkers, already suppression-filtered (same read
  // as the digest). Each MAY carry the risk-layer "why this profile" reasons (issue
  // #656 item 4), computed by the gather so the flag item explains its elevation.
  flaggedBiomarkers: FlaggedBiomarkerInput[];
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
// `riskReasons` are the risk-layer "why THIS profile" reasons for the flagged
// analyte (issue #656 item 4) — computed by the gather (collectAttentionModel) via
// retestModulationFor over the same factors the retest generator uses, so a flagged
// LDL for a family-cardiac-history profile explains itself. Empty for an analyte
// with no risk elevation (the plain flag line).
export function buildFlaggedItem(
  b: DigestFlaggedBiomarker,
  riskReasons: readonly Reason[] = []
): UpcomingItem {
  return {
    key: biomarkerFlagDismissalKey(b.name),
    domain: "biomarker-flag",
    signalGroup: "flagged",
    title: biomarkerFlagTitle(b.name),
    detail: biomarkerFlagDetail(
      b.flag,
      b.value,
      riskReasons.map((r) => r.text)
    ),
    // The flag itself PLUS the cited risk reasons, carried structurally (issue
    // #656) so the elevation is explained, not just ordered. The flag leads (it's
    // the finding); the "why this profile" risk lines follow.
    reasons: concatReasons([flaggedReason(b.flag)], [...riskReasons]),
    // #283 bug 5: link the CANONICAL name (not the raw display name) — the view
    // page resolves ?name= as canonical. Shared with biomarkerItems via the helper.
    href: readingDetailHref(b.canonicalName, b.name),
    dueDate: null,
    dueText: flagLabel(b.flag),
    actionLabel: "Review result",
    suppressible: true,
    priority: isOutOfRange(b.flag) ? 1 : 0,
  };
}

// A broken integration → a shared attention item. Structural (you reconnect it, you
// don't snooze it), so it's non-suppressible and files under the "For review" grouping
// alongside the import-review count.
//
// Exported since #1685 so the morning digest can render the SAME item the two web
// surfaces do rather than re-deriving a second description of a broken sync (#221).
//
// The two kinds share the key, the domain, the grouping and the href, and differ only in
// the words: a stale connection must not be told to "Reconnect", because reconnecting is
// a guess about a cause we have no evidence for — the honest ask is to check it.
export function integrationToItem(i: AttentionIntegration): UpcomingItem {
  const reconnectHref = i.id ? integrationDetailHref(i.id) : null;
  const stale = i.kind === "stale";
  const detail =
    i.detail ??
    (stale
      ? "No recent data from this source."
      : "Reconnect to resume syncing.");
  return {
    key: `integration:${i.id ?? i.provider}`,
    domain: "integration",
    signalGroup: "review",
    title: stale
      ? `${i.provider} sync has stopped`
      : `${i.provider} sync needs attention`,
    detail,
    // The digest's named line asks for a CAUSE FRAGMENT (#1913 item 6). This producer's
    // detail already IS one — the recorded error text ("weather fetch failed (503)"), or
    // the observation behind a quiet stop — so the field is declared rather than derived,
    // and the rendered line is unchanged from what it printed before.
    because: detail,
    // Match the CTA's promise: known, connectable providers go straight to their
    // setup page. Unknown/planned providers safely fall back to Review.
    href: reconnectHref ?? dataSectionHref("review"),
    dueDate: null,
    dueText: stale ? "No recent data" : "Reconnect",
    actionLabel: stale ? "Check connection" : "Reconnect",
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
    actionLabel: "Review",
    suppressible: false,
  };
}

// Assemble every signal into ONE flat item set — the model both surfaces render.
// Order within a surface is decided by the grouping functions (each sorts with the
// shared compareWithinBand), so this just concatenates deterministically.
export function buildAttentionModel(input: AttentionInput): UpcomingItem[] {
  const items: UpcomingItem[] = [...input.upcoming];
  for (const b of input.flaggedBiomarkers)
    items.push(buildFlaggedItem(b, b.riskReasons ?? []));
  // Escalating integration rows only (#2146). The gather hands this the escalation
  // list already, so the filter is a second lock on the one direction the doctrine
  // forbids: a coaching-tier quiet-stream row must never reach the hero, the badge, or
  // — through this same model — the digest.
  for (const i of input.integrations.filter(isEscalatingIntegration))
    items.push(integrationToItem(i));
  const review = reviewToItem(input.reviewCount);
  if (review) items.push(review);
  return items;
}

// ---------------------------------------------------------------------------
// Presentation A — the Upcoming PAGE (planning view): everything, time-ordered,
// with the "something's off" signals under their own groupings.
// ---------------------------------------------------------------------------

// A page group is either an urgency date band or one of the signal groupings.
export type PageGroupKind = UrgencyBand | SignalGroup;

// The one label for the never-recorded preventive group (issue #1433), shared by the
// Upcoming page section and the dashboard hero's collapsed line so the two surfaces
// name the same thing identically (#221). It counts rather than alarms: the number is
// a to-do list length, not a backlog.
export const SETUP_GROUP_LABEL = "Set up your screening history";

const PAGE_GROUP_ORDER: PageGroupKind[] = [
  "overdue",
  "today",
  "week",
  "later",
  "flagged",
  "review",
  // Last on the page, always (issue #1433): the never-recorded preventive rules are
  // the only group that describes what the app does NOT know, so nothing that is
  // actually due can ever sort below them.
  "setup",
];

const PAGE_GROUP_LABELS: Record<PageGroupKind, string> = {
  ...BAND_LABELS,
  flagged: "Flagged",
  review: "For review",
  setup: SETUP_GROUP_LABEL,
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
// Multi-profile MERGE (issue #1096) — the Upcoming page's cross-profile view.
// ---------------------------------------------------------------------------

// An attention item tagged with the profile it belongs to. The multi-view Upcoming
// stamps this on every item so a merged row can render its subject (#534) and its
// per-item write can target the item's OWN profile.
export type ProfiledUpcomingItem = UpcomingItem & { profileId: number };

// One member's already-gathered attention items, plus THAT member's own "today"
// (its timezone-local date). The date is carried per member on purpose — it is the
// per-profile-context trap (issue #1096): a member's banding (overdue/today/week)
// MUST be computed against its OWN today, never a shared one. Sam's dose due on his
// local Tuesday is not "overdue" just because Mia's timezone already rolled over.
export interface MemberAttention {
  profileId: number;
  today: string;
  items: ProfiledUpcomingItem[];
}

// Absolute (context-free) within-band order for merged cross-profile items. We do
// NOT reuse compareWithinBand here: it takes a single `today` and would evaluate one
// member's item against another member's clock. Each member's banding is already
// decided in its own context (below); within a merged band we only need a stable,
// timezone-independent tiebreak — soonest due date, then risk priority, then a
// stable id — so the merged list never reorders between renders.
function compareMerged(
  a: ProfiledUpcomingItem,
  b: ProfiledUpcomingItem
): number {
  const ad = a.dueDate ?? "9999-12-31";
  const bd = b.dueDate ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  const ap = a.priority ?? 0;
  const bp = b.priority ?? 0;
  if (ap !== bp) return bp - ap; // higher priority first
  if (a.profileId !== b.profileId) return a.profileId - b.profileId;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// Merge several members' attention models into ONE page-grouped view, banding EACH
// member's items in that member's OWN today (the trap), then concatenating same-kind
// groups and ordering within each with the absolute comparator above. The result is
// the same AttentionPageGroup shape the single-profile page renders, so the page is
// a formatter over this — one grouping engine, whether one profile or five (#221).
// Empty groups are dropped; group order stays PAGE_GROUP_ORDER.
export function mergeAttentionPageGroups(
  members: readonly MemberAttention[]
): AttentionPageGroup[] {
  const byKind = new Map<PageGroupKind, ProfiledUpcomingItem[]>();
  for (const member of members) {
    // groupAttentionForPage bands + orders THIS member's items against THIS
    // member's today — the per-profile computation, composed per member.
    for (const group of groupAttentionForPage(member.items, member.today)) {
      const arr = byKind.get(group.kind);
      const profiled = group.items as ProfiledUpcomingItem[];
      if (arr) arr.push(...profiled);
      else byKind.set(group.kind, [...profiled]);
    }
  }
  const groups: AttentionPageGroup[] = [];
  for (const kind of PAGE_GROUP_ORDER) {
    const arr = byKind.get(kind);
    if (!arr || arr.length === 0) continue;
    arr.sort(compareMerged);
    groups.push({ kind, label: PAGE_GROUP_LABELS[kind], items: arr });
  }
  return groups;
}

// One member's own page-grouped attention, for the BY-PERSON view mode (issue #1327
// fix 2). Carries the member's `profileId`/`today` so the page renders a per-member
// header, plus `empty` so an in-view member with nothing due is rendered as a calm
// "All caught up" section rather than silent (#489 / #1327 fix 3) — silence reads as
// "scrolled past her", which is exactly what the caregiver can't afford.
export interface MemberSection {
  profileId: number;
  today: string;
  groups: AttentionPageGroup[];
  empty: boolean;
}

// By-person mode: group EACH member's items under that member's OWN page bands, banded
// in that member's OWN today (the per-profile-context trap — same rule as the interleaved
// merge). Returns one section per member IN VIEW ORDER, INCLUDING empty members (so the
// page can render their "All caught up"). The alternative presentation to
// mergeAttentionPageGroups over the SAME per-member models — the mode lives in this shared
// merge layer so every #1328 adopter inherits both orderings, never a per-page fork (#221).
export function groupAttentionByPerson(
  members: readonly MemberAttention[]
): MemberSection[] {
  return members.map((m) => {
    const groups = groupAttentionForPage(m.items, m.today);
    return {
      profileId: m.profileId,
      today: m.today,
      groups,
      empty: groups.length === 0,
    };
  });
}

// The in-view members with NOTHING due (issue #1327 fix 3), in view order. The
// interleaved mode appends one compact "All caught up: <name>" line per empty member so a
// quiet member is acknowledged, never silently absent. Returns profileIds only; the caller
// maps each to its disambiguated name from the scope (#534) — this layer stays name-blind.
export function emptyMemberIds(members: readonly MemberAttention[]): number[] {
  return members.filter((m) => m.items.length === 0).map((m) => m.profileId);
}

// ---------------------------------------------------------------------------
// Presentation B — the dashboard CARD (triage glance): the act-now slice only,
// a strict SUBSET of the page's model.
// ---------------------------------------------------------------------------

export type CardBand = "urgent" | "today" | "review";

export const CARD_BAND_ORDER: CardBand[] = ["urgent", "today", "review"];

// The page and card do different jobs, but the card must not overstate what the
// model knows: a past date establishes lateness, not clinical urgency.
export const CARD_BAND_LABELS: Record<CardBand, string> = {
  // Date lateness alone does not establish clinical urgency. Keep the strong
  // visual treatment, but describe the fact the model actually knows.
  urgent: "Past due",
  today: "Today",
  review: "Needs review",
};

const CARD_BAND_RANK: Record<CardBand, number> = {
  urgent: 0,
  today: 1,
  review: 2,
};

// Domains the dashboard hero deliberately never carries, whatever their date says.
//
// The "Needs attention" hero is care-tier: pinned, and the one surface a user cannot
// choose not to look at. `portal-sync` (#1757) is COACHING tier by hard product contract
// — portal hygiene is never a safety signal — so it lives on the Upcoming page and in
// the morning digest line that page's grouping produces, and nowhere else. Without this
// it would drift onto the hero on the single day its expiry lands on "today", which is
// exactly the un-ignorable treatment a calm ask must never get.
//
// A SET, not a special case: the next calm domain that must stay off the hero adds a
// name here rather than another branch.
// `records-recency` (#2164/#2176) is the next name, and it arrives for exactly the
// reason the set exists: it is the same coaching-tier ask one step further out — "your
// Takeout export is six weeks behind", "your newest lab result is from last May" — and
// a month-scale drift that a person fixes when they next have twenty minutes has no
// claim on the one surface a user cannot choose not to look at.
const CARD_EXCLUDED_DOMAINS: ReadonlySet<UpcomingDomain> = new Set([
  "portal-sync",
  "records-recency",
]);

// Which card band an item belongs to, or null if the card EXCLUDES it. Signals →
// "Needs review". A date-scheduled item is act-now only when it's overdue (→ Urgent)
// or due today (→ Today); a this-week / later scheduled item is planning-view-only
// (the card's whole value is that it hides far-future scheduled work), so it returns
// null and lives only on the Upcoming page.
export function cardBandForItem(
  item: UpcomingItem,
  today: string
): CardBand | null {
  if (CARD_EXCLUDED_DOMAINS.has(item.domain)) return null;
  // A never-recorded preventive rule (#1433) is never a card row and never counts.
  // The hero is the one surface a user cannot choose not to look at, so an item whose
  // entire basis is "you just told us your age" has no claim on it. It still reaches
  // the hero — as ONE collapsed setup line (attentionSetupItems) — but not as an
  // attention row and not in the count/badge.
  if (item.signalGroup === "setup") return null;
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

// Total row budget for the hero. The old cap applied independently to all three
// bands and could still render 24 rows — no longer a glanceable dashboard.
export const ATTENTION_CARD_CAP = 5;

// Group the card's subset by band in fixed Past due → Today → Needs review order,
// dropping empty bands. The total card is capped, while every populated band gets
// one representative before remaining slots are allocated in band order. This
// keeps a large overdue backlog from hiding a failing integration or new lab flag.
export function groupAttentionForCard(
  items: UpcomingItem[],
  today: string,
  cap: number = ATTENTION_CARD_CAP
): AttentionCardGroup[] {
  const subset = attentionCardItems(items, today);
  const byBand = new Map<CardBand, UpcomingItem[]>();
  for (const item of subset) {
    const band = cardBandForItem(item, today)!;
    const arr = byBand.get(band);
    if (arr) arr.push(item);
    else byBand.set(band, [item]);
  }
  const populated = CARD_BAND_ORDER.filter((band) => byBand.get(band)?.length);
  const selected = new Map<CardBand, number>();
  let remaining = Math.max(0, cap);

  // Preserve representation across bands when the budget permits it.
  for (const band of populated) {
    if (remaining === 0) break;
    selected.set(band, 1);
    remaining -= 1;
  }
  // Spend the rest in urgency order, keeping each band's internal ordering.
  for (const band of populated) {
    if (remaining === 0) break;
    const available = byBand.get(band)!.length - (selected.get(band) ?? 0);
    const add = Math.min(available, remaining);
    selected.set(band, (selected.get(band) ?? 0) + add);
    remaining -= add;
  }

  const groups: AttentionCardGroup[] = populated.flatMap((band) => {
    const arr = byBand.get(band)!;
    const shown = selected.get(band) ?? 0;
    if (shown === 0) return [];
    return [
      {
        band,
        label: CARD_BAND_LABELS[band],
        items: arr.slice(0, shown),
        overflow: arr.length - shown,
      },
    ];
  });
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
//
// The never-recorded setup items (#1433) are subtracted first: the link they'd
// inflate reads "+N scheduled later", and nothing about them is scheduled. They get
// their own counted line on the hero (attentionSetupItems) and their own page group,
// so they are described exactly once, by copy that is true of them.
export function moreInUpcomingCount(
  model: UpcomingItem[],
  cardCount: number
): number {
  const scheduled = model.filter((i) => i.signalGroup !== "setup").length;
  return Math.max(0, scheduled - cardCount);
}

// The never-recorded preventive rules in the model (issue #1433), in a stable display
// order. The hero renders these as ONE collapsed "Set up your screening history (N)"
// line and the Upcoming page renders them as its own trailing group — the same items,
// two formatters, one decision (#221).
export function attentionSetupItems(items: UpcomingItem[]): UpcomingItem[] {
  return items
    .filter((i) => i.signalGroup === "setup")
    .sort((a, b) => a.title.localeCompare(b.title));
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

// ---------------------------------------------------------------------------
// Hero collapse (issue #1413, section B) — the owner-confirmed refinement of the
// #449 care tier from ALWAYS-FULL to ALWAYS-PRESENT.
// ---------------------------------------------------------------------------
//
// The "Needs attention" hero is care-tier PUSH: pinned, non-hideable, no dismiss
// control. On a phone the full card also costs the better part of a screen, even
// on a day whose items you have already read — which is a real cost, but NOT a
// reason to weaken the tier. So the contract changes on exactly one axis: the
// VERTICAL COST becomes opt-in, while presence and the COUNT never do.
//
// What that buys, precisely:
//   - Collapsed still renders the count and the highest-severity band, so
//     "3 need attention, one of them past due" survives the compaction. A
//     collapsed hero is a smaller signal, never an absent one.
//   - There is still no dismiss. Collapse is a two-way toggle the user can
//     always reverse from the same control; nothing here can reach a state with
//     no attention affordance on the page.
//   - The SAFETY CARVE-OUT below outranks the preference entirely.
//
// These are pure decisions so the #449 contract is pinned by unit tests rather
// than by reviewer memory of what the component happens to render.

// The bands a collapsed hero can advertise, most severe first — the same
// vocabulary and order as the expanded card's sections, so the compact line can
// never describe the card differently from the card.
export function attentionTopBand(
  items: UpcomingItem[],
  today: string
): CardBand | null {
  const subset = attentionCardItems(items, today);
  for (const band of CARD_BAND_ORDER) {
    if (subset.some((i) => cardBandForItem(i, today) === band)) return band;
  }
  return null;
}

// Whether the hero carries a SAFETY-tier item and must therefore render expanded
// no matter what the viewer's collapse preference says (#942's `isHiddenUnderPolicy`
// posture applied to compaction rather than suppression).
//
// The tier is read from the item's OWN declared lifecycle policy via the shared
// `itemSuppressionPolicy` dispatcher — NOT from a second list of "serious-looking"
// domains maintained here. That matters: "safety-ungated" is already the property
// that means "the dismissal bus may never hide this" (dose reminders, missed-dose
// escalation, the #716 crisis finding), so a signal that opts into it inherits the
// no-compaction guarantee automatically, and a future safety signal cannot be
// added without also getting this behavior. A domain allowlist here would have to
// be remembered and updated separately, which is precisely how a safety carve-out
// silently stops covering something.
export function attentionSafetyLocked(
  items: UpcomingItem[],
  today: string
): boolean {
  return attentionCardItems(items, today).some(
    (i) => itemSuppressionPolicy(i) === "safety-ungated"
  );
}

// The hero's resolved display state. `collapsed` is what the surface renders;
// `locked` tells it to suppress the collapse CONTROL as well, so a safety-locked
// hero offers no toggle that would do nothing (a dead control reads as a bug and
// invites the user to keep pressing it).
export interface AttentionHeroState {
  collapsed: boolean;
  locked: boolean;
  count: number;
  topBand: CardBand | null;
}

// Resolve the hero's state from the viewer's stored preference and the items.
// The safety carve-out is checked FIRST and unconditionally — the preference is
// not consulted for a safety-locked hero — mirroring how `isHiddenUnderPolicy`
// puts its "safety-ungated" branch ahead of any stored record, so neither can be
// weakened by editing what is stored.
//
// An EMPTY hero (the quiet "all clear") is also never collapsed: there is nothing
// to compact, and a collapsed all-clear line would be a strictly worse rendering
// of the same zero.
export function attentionHeroState(
  items: UpcomingItem[],
  today: string,
  preferCollapsed: boolean
): AttentionHeroState {
  const count = attentionCardItems(items, today).length;
  const locked = attentionSafetyLocked(items, today);
  return {
    collapsed: !locked && count > 0 && preferCollapsed,
    locked,
    count,
    topBand: attentionTopBand(items, today),
  };
}
