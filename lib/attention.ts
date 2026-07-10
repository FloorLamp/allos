// The "Needs attention" model — PURE severity-ordering + merge logic, no DB and no
// JSX, so it's importable by both the server page and unit-tested in isolation.
//
// This is the ONE aggregation behind the dashboard's Tier-1 hero (issue #171). It
// merges every already-computed attention signal into a single severity-ordered
// strip so the signal is no longer split across the old Today's-actions card, the
// Upcoming findings, and the review badge:
//   - the Upcoming findings engine (doses, refills/low-supply, appointments,
//     care-plan items, preventive visits/screenings, immunizations, biomarker
//     retests, goals, training) — already snooze/dismiss-filtered by collectUpcoming
//   - newly-flagged biomarkers — the SAME rows the Telegram morning digest reports
//     (lib/notifications/digest-data.getNewlyFlaggedBiomarkers), so the hero and the
//     bot never drift
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
import type { DigestFlaggedBiomarker } from "./notifications/digest";

// Four coarse severity bands, most-urgent first. Overdue and Today are the
// act-now bands; Soon is this-week runway; Info is low-stakes housekeeping
// (review inbox, non-optimal reads) that's still worth a glance.
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
// the week band is "soon" runway and anything further out ("later") is quiet info.
const BAND_SEVERITY: Record<UrgencyBand, AttentionSeverity> = {
  overdue: "overdue",
  today: "today",
  week: "soon",
  later: "info",
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
  // Upcoming-derived items do; the review/integration signals are structural (you
  // resolve them, you don't snooze them) so they're not suppressible.
  suppressible: boolean;
  // Inline "mark taken" fast path for a due dose (mirrors UpcomingItem.doseId).
  doseId: number | null;
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
  if (flag === "high" || flag === "low" || flag === "abnormal") return "today";
  return "soon";
}

// Human label for a biomarker flag, for the right-aligned status text.
function flagLabel(flag: string): string {
  if (flag === "high") return "High";
  if (flag === "low") return "Low";
  if (flag === "abnormal") return "Abnormal";
  if (flag === "non-optimal-high") return "Above optimal";
  if (flag === "non-optimal-low") return "Below optimal";
  return "Non-optimal";
}

// One Upcoming due-signal → an attention item. The band decides severity; the
// dedupeKey (item.key) carries through so snooze/dismiss lines up with Upcoming.
function upcomingToAttention(item: UpcomingItem, today: string): AttentionItem {
  return {
    key: item.key,
    domain: item.domain,
    severity: BAND_SEVERITY[bandForItem(item, today)],
    title: item.title,
    detail: item.detail ?? null,
    href: item.href,
    dueText: upcomingDueText(item, today),
    suppressible: true,
    doseId: item.doseId ?? null,
  };
}

// A newly-flagged biomarker → an attention item. Not suppressible: the flag clears
// itself once a fresh in-range reading lands, so there's nothing to snooze.
function flaggedToAttention(b: DigestFlaggedBiomarker): AttentionItem {
  const val = b.value ? ` ${b.value}` : "";
  return {
    key: `biomarker-flag:${b.name.toLowerCase()}`,
    domain: "biomarker-flag",
    severity: flagSeverity(b.flag),
    title: b.name,
    detail: `Flagged result${val}`,
    href: `/biomarkers/view?name=${encodeURIComponent(b.name)}`,
    dueText: flagLabel(b.flag),
    suppressible: false,
    doseId: null,
  };
}

// Assemble every signal into one severity-ordered list. Within a severity items
// sort by domain rank then title, so the order is deterministic (unit-testable).
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const u of input.upcoming) {
    items.push(upcomingToAttention(u, input.today));
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
      a.title.localeCompare(b.title)
  );
  return items;
}

export interface AttentionGroup {
  severity: AttentionSeverity;
  label: string;
  items: AttentionItem[];
}

// Group the ordered items by severity, dropping empty bands, in fixed
// Overdue → Today → This week → For review order — for the hero's section layout.
export function groupAttention(items: AttentionItem[]): AttentionGroup[] {
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
    groups.push({ severity, label: SEVERITY_LABELS[severity], items: arr });
  }
  return groups;
}
