// The "Needs attention" model — PURE severity-ordering + merge logic, no DB and no
// JSX, so it's importable by both the server page and unit-tested in isolation.
//
// This is the ONE aggregation behind the dashboard's Tier-1 hero (issue #171). It
// merges every already-computed attention signal into a single severity-ordered
// strip so the signal is no longer split across the old Today's-actions card, the
// Upcoming findings, and the review badge:
//   - the Upcoming findings engine (doses, refills/low-supply, appointments,
//     care-plan items, preventive visits/screenings, immunizations, biomarker
//     retests, goals, training) — already snooze/dismiss-filtered by collectUpcoming,
//     with the far-future `later` band excluded here (issue #283)
//   - newly-flagged biomarkers — the SAME read the Telegram morning digest reports
//     (lib/notifications/digest-data.getNewlyFlaggedBiomarkers) so WHICH rows are
//     flagged never drifts, but over the hero's own stable window (issue #283:
//     the digest's send-cursor window made items vanish whenever a digest sent)
//   - failing / reauth integrations (getImportIssues)
//   - unresolved review-inbox items (getReviewPairCount)
//
// The DB gather that feeds buildAttention lives in lib/queries/attention.ts (every
// read there is profile-scoped); this module only shapes and orders.

import {
  type UpcomingItem,
  type UrgencyBand,
  bandForItem,
  upcomingDueText,
} from "./upcoming";
import { biomarkerFlagDismissalKey } from "./dismissal-keys";
import { flagLabel, isOutOfRange } from "./reference-range";
import { compareSortHint } from "./dose-order";
import type { DigestFlaggedBiomarker } from "./notifications/digest";

// Four coarse severity bands, most-urgent first. Overdue and Today are the
// act-now bands; Soon is this-week runway; Info ("For review") is low-stakes
// housekeeping (the review inbox) that's still worth a glance.
export type AttentionSeverity = "overdue" | "today" | "soon" | "info";

export const SEVERITY_ORDER: AttentionSeverity[] = [
  "overdue",
  "today",
  "soon",
  "info",
];

export const SEVERITY_LABELS: Record<AttentionSeverity, string> = {
  overdue: "Overdue",
  today: "Today",
  soon: "This week",
  info: "For review",
};

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  overdue: 0,
  today: 1,
  soon: 2,
  info: 3,
};

// Upcoming urgency band → attention severity. Overdue/today map straight through;
// the week band is "soon" runway. The `later` band is deliberately EXCLUDED
// (issue #283): an appointment weeks out or a screening due in months is exactly
// what the hero must NOT flood with — those stay on the Upcoming page (matching
// #171's "appointments within N days" intent), and the household count derived
// from this model excludes them too. "For review" (info) is reserved for the
// genuinely informational structural signals (review inbox).
const BAND_SEVERITY: Record<
  Exclude<UrgencyBand, "later">,
  AttentionSeverity
> = {
  overdue: "overdue",
  today: "today",
  week: "soon",
};

// Stable within-severity ordering. Clinical/medication signals sort ahead of the
// housekeeping ones (integration/review) so the most consequential items lead.
const DOMAIN_RANK: Record<string, number> = {
  dose: 0,
  "biomarker-flag": 1,
  refill: 2,
  appointment: 3,
  careplan: 4,
  visit: 5,
  screening: 6,
  immunization: 7,
  biomarker: 8,
  goal: 9,
  training: 10,
  integration: 11,
  review: 12,
};

function domainRank(domain: string): number {
  return DOMAIN_RANK[domain] ?? 99;
}

export interface AttentionItem {
  // Stable React key + suppression identity. For Upcoming-derived items this IS the
  // Finding dedupeKey (e.g. "dose:12"), so a snooze/dismiss here matches Upcoming.
  key: string;
  domain: string;
  severity: AttentionSeverity;
  title: string;
  detail: string | null;
  href: string;
  // Short right-aligned status text ("Overdue", "2 days left", flag name…).
  dueText: string | null;
  // Whether this item supports snooze/dismiss through the shared findings store.
  // Upcoming-derived items and biomarker flags do; the review/integration signals
  // are structural (you resolve them, you don't snooze them) so they're not
  // suppressible.
  suppressible: boolean;
  // Inline "mark taken" fast path for a due dose (mirrors UpcomingItem.doseId).
  doseId: number | null;
  // Optional within-severity ordering key carried through from the Upcoming item
  // (issue #297) — dose items set the shared dose-day key so the hero orders them
  // bucket → priority → name, matching the Upcoming band. Undefined for non-dose
  // signals (they fall through to the title tiebreak).
  sortHint?: string;
}

// A failing/needs-reauth integration provider, reduced to what the strip renders.
export interface AttentionIntegration {
  provider: string;
  detail: string | null;
}

export interface AttentionInput {
  // Already snooze/dismiss-filtered (collectUpcoming does the filtering).
  upcoming: UpcomingItem[];
  // Newly-flagged out-of-range biomarkers (same read as the digest).
  flaggedBiomarkers: DigestFlaggedBiomarker[];
  // Currently-failing integration providers.
  integrations: AttentionIntegration[];
  // Count of unresolved review-inbox pairs (duplicates/conflicts).
  reviewCount: number;
  today: string;
}

// An out-of-range flag (high/low/abnormal) is act-now "today"; a non-optimal read
// is softer "soon" runway.
function flagSeverity(flag: string): AttentionSeverity {
  return isOutOfRange(flag) ? "today" : "soon";
}

// One Upcoming due-signal → an attention item, or null for a `later`-band item
// (far-future signals never reach the hero — see BAND_SEVERITY). The band decides
// severity; the dedupeKey (item.key) carries through so snooze/dismiss lines up
// with Upcoming.
function upcomingToAttention(
  item: UpcomingItem,
  today: string
): AttentionItem | null {
  const band = bandForItem(item, today);
  if (band === "later") return null;
  return {
    key: item.key,
    domain: item.domain,
    severity: BAND_SEVERITY[band],
    title: item.title,
    detail: item.detail ?? null,
    href: item.href,
    dueText: upcomingDueText(item, today),
    suppressible: true,
    doseId: item.doseId ?? null,
    sortHint: item.sortHint,
  };
}

// A newly-flagged biomarker → an attention item. Suppressible through the shared
// findings bus (issue #283) keyed on `biomarker-flag:<name>` — a dismiss/snooze
// from the hero hides the analyte's flag like any other finding (the query layer
// filters on the same key). The href gates like biomarkerItems (upcoming.ts): a
// canonicalized reading deep-links to its series (the view page treats ?name= as
// the canonical name), an uncanonicalized one falls back to the biomarkers list.
function flaggedToAttention(b: DigestFlaggedBiomarker): AttentionItem {
  const val = b.value ? ` ${b.value}` : "";
  return {
    key: biomarkerFlagDismissalKey(b.name),
    domain: "biomarker-flag",
    severity: flagSeverity(b.flag),
    title: b.name,
    detail: `Flagged result${val}`,
    href: b.canonicalName
      ? `/biomarkers/view?name=${encodeURIComponent(b.name)}`
      : "/biomarkers",
    dueText: flagLabel(b.flag),
    suppressible: true,
    doseId: null,
  };
}

// Assemble every signal into one severity-ordered list. Within a severity items
// sort by domain rank, then the optional dose-day sortHint (#297), then title,
// so the order is deterministic (unit-testable).
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const u of input.upcoming) {
    const item = upcomingToAttention(u, input.today);
    if (item) items.push(item);
  }
  for (const b of input.flaggedBiomarkers) {
    items.push(flaggedToAttention(b));
  }
  for (const i of input.integrations) {
    items.push({
      key: `integration:${i.provider}`,
      domain: "integration",
      severity: "today",
      title: `${i.provider} sync needs attention`,
      detail: i.detail ?? "Reconnect to resume syncing.",
      href: "/data?section=review",
      dueText: "Reconnect",
      suppressible: false,
      doseId: null,
    });
  }
  if (input.reviewCount > 0) {
    items.push({
      key: "review",
      domain: "review",
      severity: "info",
      title: `${input.reviewCount} import ${input.reviewCount === 1 ? "item" : "items"} to review`,
      detail: "Duplicates or conflicts detected in synced data.",
      href: "/data?section=review",
      dueText: "Review",
      suppressible: false,
      doseId: null,
    });
  }

  items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      domainRank(a.domain) - domainRank(b.domain) ||
      compareSortHint(a.sortHint, b.sortHint) ||
      a.title.localeCompare(b.title)
  );
  return items;
}

export interface AttentionGroup {
  severity: AttentionSeverity;
  label: string;
  items: AttentionItem[];
  // Items beyond the per-severity cap (issue #283): count only — the hero renders
  // a "+N more" link to Upcoming instead of the rows, so a pathological day
  // (a giant lab import, a backlog of overdue visits) can't blow the layout.
  overflow: number;
}

// Defensive per-severity row cap for the hero (issue #283). High enough that a
// normal day never trips it; low enough that a flood collapses to a link.
export const ATTENTION_GROUP_CAP = 8;

// The honest per-band count label for the hero (issue #512). When the per-band
// cap truncated the rendered rows, the badge must show BOTH the shown count and
// the true pre-cap total — "8 of 11" — so the card reconciles with the Upcoming
// page (which shows the full band count) instead of reading as a bare "8" that
// silently means the cap. No overflow → the plain count. Pure so it's unit-tested
// and the hero component is a formatter over it.
export function attentionCountLabel(shown: number, overflow: number): string {
  return overflow > 0 ? `${shown} of ${shown + overflow}` : `${shown}`;
}

// Group the ordered items by severity, dropping empty bands, in fixed
// Overdue → Today → This week → For review order — for the hero's section layout.
// Each group keeps at most `cap` rows (most urgent first — the input is already
// severity/domain-ordered) and reports the rest as `overflow`.
export function groupAttention(
  items: AttentionItem[],
  cap: number = ATTENTION_GROUP_CAP
): AttentionGroup[] {
  const bySeverity = new Map<AttentionSeverity, AttentionItem[]>();
  for (const item of items) {
    const arr = bySeverity.get(item.severity);
    if (arr) arr.push(item);
    else bySeverity.set(item.severity, [item]);
  }
  const groups: AttentionGroup[] = [];
  for (const severity of SEVERITY_ORDER) {
    const arr = bySeverity.get(severity);
    if (!arr || arr.length === 0) continue;
    groups.push({
      severity,
      label: SEVERITY_LABELS[severity],
      items: arr.slice(0, cap),
      overflow: Math.max(0, arr.length - cap),
    });
  }
  return groups;
}
