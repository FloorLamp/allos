// The unified attention model (issue #524) — the ONE computation behind dashboard
// attention candidates and the Upcoming page. PURE (no DB, no JSX).
//
// The design (issue #524): Upcoming and dashboard placement present the shared facts
// differently, but they must never disagree on what an item means. So this module is:
//
//   1. ONE item builder (buildAttentionModel) — every attention-worthy thing
//      (dose, retest, flagged biomarker, appointment, care-plan, refill, review
//      item, failing integration) is built ONCE as a UpcomingItem carrying its
//      dueness, action copy, href, risk priority (#517), and suppressibility.
//      Neither surface recomputes an item's meaning. The "something's off" signals
//      (flagged results #526, failing integrations, the review count) are first-class
//      items in the shared set, so a flagged HDL keeps one key and action verb.
//   2. ONE within-band comparator — compareWithinBand (lib/upcoming.ts), shared
//      with groupUpcoming, so the two surfaces order the same facts identically.
//      buildAttentionModel emits the model ALREADY in that order, with the item key
//      as a last-resort tiebreak so the rule is total (#3554) — see
//      compareAttentionOrder below for why a surface must not inherit generator
//      emission order by default.
//   3. The Upcoming presentation groups the full model. Dashboard placement projects
//      the same items into Now, Ahead, and Show everything without changing identity.
//   4. `attentionBadgeItems` is the care-tier subset used only for the app badge;
//      it never decides dashboard placement.
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
  compareAbsoluteOrder,
  compareWithinBand,
} from "./upcoming";
import { biomarkerFlagDismissalKey } from "./dismissal-keys";
import {
  clinicalResultDetailHref,
  dataSectionHref,
  integrationDetailHref,
} from "./hrefs";
import { biomarkerFlagTitle, biomarkerFlagDetail } from "./biomarker-flag-copy";
import { flagLabel, isOutOfRange } from "./reference-range";
import { type Reason, concatReasons, flaggedReason } from "./reasons";
import type { DigestFlaggedBiomarker } from "./notifications/digest";
import type { IntegrationId } from "./types";

// A broken integration source, reduced to what the model renders. `kind` distinguishes
// the two ways a source can be broken (#1685), because they need different copy and ask
// the user for different things:
//   "failing" — a recorded failure / dead grant. The cause is known and the fix is
//               consent: reconnect.
//   "stale"   — nothing has failed, and nothing has arrived either. The connection may be
//               perfectly authorized; all we honestly know is that it stopped, so the
//               copy states the observation ("no data since <date>") and asks the user to
//               check rather than claiming a cause.
// Both carry the SAME item key, so a source is one row on every surface no matter which
// signal raised it, and the gather guarantees only one of the two can fire per source.
//
// A THIRD kind since #2146, and it is not a third way of being broken:
//   "quiet-stream" — the connection is FINE and one continuous DATA STREAM stopped (the
//               watch off the wrist while the phone keeps pushing). Heart rate is an
//               observation domain — nobody committed to wearing a watch — so this is
//               COACHING TIER: it renders where the user goes looking and never travels
//               a send. It also yields to the two above, so a source is still one row.
//
// So `kind` now names the TIER as well as the copy, and the difference is enforced
// rather than documented: `isEscalatingIntegration` below is the one gate,
// `buildAttentionModel` and the digest's own integration section both apply it, and
// the quiet rows arrive through a separate query entry point
// (`getQuietStreamAttention`) that the care badge / Upcoming / digest never call.
export interface AttentionIntegration {
  id: IntegrationId | null;
  sourceName: string;
  detail: string | null;
  kind?: "failing" | "stale" | "quiet-stream";
}

/**
 * May this integration row travel to an ESCALATION surface — the profile-menu badge,
 * dashboard placement, the Upcoming page's review group, and the
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
  // Currently-failing integration sources.
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
    href: clinicalResultDetailHref(b.canonicalName, b.name),
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
    key: `integration:${i.id ?? i.sourceName}`,
    domain: "integration",
    signalGroup: "review",
    title: stale
      ? `${i.sourceName} sync has stopped`
      : `${i.sourceName} sync needs attention`,
    detail,
    // The digest's named line asks for a CAUSE FRAGMENT (#1913 item 6). This producer's
    // detail already IS one — the recorded error text ("weather fetch failed (503)"), or
    // the observation behind a quiet stop — so the field is declared rather than derived,
    // and the rendered line is unchanged from what it printed before.
    because: detail,
    // Match the CTA's promise: known, connectable sources go straight to their
    // setup page. Unknown/planned sources safely fall back to Review.
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

// THE ORDER OF THE ATTENTION MODEL (#3554). Total, stated here, and the only order
// any consumer of the model may assume:
//
//     effective due date  →  risk priority (#517)  →  domain  →  dose-day slot
//     (#297)  →  title  →  item key
//
// The first five keys are the shared compareWithinBand (lib/upcoming.ts) — the one
// order the Upcoming page's bands already render in. The LAST key is what makes the
// rule total: `key` is the item's stable identity and no two items in one model
// share one, so no pair can tie. Without it, `Array.prototype.sort` is stable and
// hands a tie straight back to the order the generators happened to emit in — which
// is the whole defect, relocated rather than fixed.
//
// It matters because the dashboard reads this order as `sourceOrder`
// (lib/dashboard-candidates/attention.ts), and the Now lane's ordinary tier ranks by
// score then `sourceOrder` before cutting at NOW_CANDIDATE_CAP. Every owed `must`
// dose scores identically, so the cut was decided by generator emission: collectUpcoming
// concatenates its generators in source order and `doseItems` emits doses grouped by
// ITEM, so one supplement's Midday AND Evening doses filled both Now slots while
// another supplement's equally-owed Midday dose was absent — an Evening dose ranked
// ahead of a Midday one, on cards printing the slot label that was supposed to explain
// the order (#297/#2578, the Upcoming page's version of the same interleaving).
function compareAttentionOrder(
  a: UpcomingItem,
  b: UpcomingItem,
  today: string
): number {
  return (
    compareWithinBand(a, b, today) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

// Assemble every signal into ONE flat item set — the model both surfaces render —
// in the ONE order stated above. The Upcoming page still groups and re-sorts with
// the same comparator (groupAttentionForPage), so ordering here changes nothing it
// renders; it gives the DASHBOARD, whose `sourceOrder` is this list's index, the
// canonical order instead of raw generator emission (#3554).
export function buildAttentionModel(input: AttentionInput): UpcomingItem[] {
  const items: UpcomingItem[] = [...input.upcoming];
  for (const b of input.flaggedBiomarkers)
    items.push(buildFlaggedItem(b, b.riskReasons ?? []));
  // Escalating integration rows only (#2146). The gather hands this the escalation
  // list already, so the filter is a second lock on the one direction the doctrine
  // forbids: a coaching-tier quiet-stream row must never reach Upcoming, the care
  // badge, or — through this same model — the digest.
  for (const i of input.integrations.filter(isEscalatingIntegration))
    items.push(integrationToItem(i));
  const review = reviewToItem(input.reviewCount);
  if (review) items.push(review);
  return items.sort((a, b) => compareAttentionOrder(a, b, input.today));
}

// ---------------------------------------------------------------------------
// Presentation A — the Upcoming PAGE (planning view): everything, time-ordered,
// with the "something's off" signals under their own groupings.
// ---------------------------------------------------------------------------

// A page group is either an urgency date band or one of the signal groupings.
export type PageGroupKind = UrgencyBand | SignalGroup;

// The one label for the never-recorded preventive group (issue #1433), shared by the
// Upcoming page section. It counts rather than alarms: the number is a to-do list
// length, not a backlog.
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
// NOT reuse compareWithinBand here: its FIRST key is the effective due date resolved
// against a single `today`, which would evaluate one member's item against another
// member's clock. Each member's banding is already decided in its own context
// (below), so the merged order needs a date rule that carries no clock — the raw due
// date, undated items last.
//
// Everything AFTER that date rule is the shared clock-free comparator
// (compareAbsoluteOrder): risk priority (#517), then DOMAIN_ORDER, then the dose-day
// sortHint (#297), then title. Those three were dropped along with the date fallback
// when this comparator was written (#1096) even though none of them reads a clock,
// and since #1096 the Upcoming page renders EVERY view — single profile included —
// through this merge. The result was a dose fold ordered by raw key string
// ("dose:104" before "dose:12"), reading Before sleep → Evening → Midday → Midday
// while each row carried the slot label #297 added to explain the ordering (#2578).
// profileId and key stay LAST, as the stability tiebreak they always were.
function compareMerged(
  a: ProfiledUpcomingItem,
  b: ProfiledUpcomingItem
): number {
  const ad = a.dueDate ?? "9999-12-31";
  const bd = b.dueDate ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  const absolute = compareAbsoluteOrder(a, b);
  if (absolute !== 0) return absolute;
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
// Presentation B — the installed-app badge subset.
// ---------------------------------------------------------------------------

export type AttentionEmphasisBand = "urgent" | "today" | "review";

const ATTENTION_EMPHASIS_BAND_RANK: Record<AttentionEmphasisBand, number> = {
  urgent: 0,
  today: 1,
  review: 2,
};

// Calm domains excluded from the app-badge care-tier count. Dashboard placement is
// independent: these items may still land in Now, Ahead, or Show everything according
// to their atomic candidate facts.
const ATTENTION_BADGE_EXCLUDED_DOMAINS: ReadonlySet<UpcomingDomain> = new Set([
  "portal-sync",
  "records-recency",
]);

// Which badge band an item belongs to, or null if the badge excludes it. Signals →
// "Needs review". A date-scheduled item is act-now only when it's overdue (→ Urgent)
// or due today (→ Today); a this-week / later scheduled item is excluded because the
// badge reports current care-tier work, not far-future scheduling.
export function attentionEmphasisBandForItem(
  item: UpcomingItem,
  today: string
): AttentionEmphasisBand | null {
  if (ATTENTION_BADGE_EXCLUDED_DOMAINS.has(item.domain)) return null;
  // Never-recorded setup is not part of the care-tier app-badge count.
  if (item.signalGroup === "setup") return null;
  if (item.signalGroup) return "review";
  const band = bandForItem(item, today);
  if (band === "overdue") return "urgent";
  if (band === "today") return "today";
  return null;
}

// The care-tier app-badge subset. Every returned item is unchanged and ordered by
// band then the shared comparator.
export function attentionBadgeItems(
  items: UpcomingItem[],
  today: string
): UpcomingItem[] {
  return items
    .filter((i) => attentionEmphasisBandForItem(i, today) != null)
    .sort(
      (a, b) =>
        ATTENTION_EMPHASIS_BAND_RANK[attentionEmphasisBandForItem(a, today)!] -
          ATTENTION_EMPHASIS_BAND_RANK[
            attentionEmphasisBandForItem(b, today)!
          ] || compareWithinBand(a, b, today)
    );
}
