// Pure adapter from a preventive-care assessment (lib/preventive-status.ts) to an
// Upcoming due-signal (lib/upcoming.ts) — issue #82. NO DB/network: the query
// layer (lib/queries/upcoming.ts) resolves the profile's age/sex + satisfactions +
// overrides, runs the pure assessor, and maps its actionable (due/overdue) slice
// through the function below into UpcomingItems. Keeping the mapping here (not
// inline in the query builder) makes it unit-testable and keeps the key/band/href
// contract in one place.
//
// The two preventive kinds map 1:1 onto two Upcoming domains — a `visit` (well-
// visit, satisfied by an appointment) and a `screening` (satisfied by a result) —
// consistent with how the existing domains are cut by satisfaction semantics. Each
// item is STATUS-driven (no calendar due date), so it carries an explicit band +
// due-text exactly like immunizationItems.

import type { PreventiveAssessment } from "./preventive-status";
import type { UpcomingItem, UrgencyBand } from "./upcoming";

// Where a preventive row links to for follow-through. A visit is acted on by
// booking/logging an appointment; a screening by its result in the medical
// passport. Neither has a bespoke page — these reuse existing surfaces.
const HREF_BY_KIND: Record<PreventiveAssessment["kind"], string> = {
  visit: "/appointments",
  screening: "/medical",
};

// Map one due/overdue preventive assessment to an Upcoming item. Overdue → the
// Overdue band with "Overdue" text; due → the Today band with "Due" text (mirrors
// immunizationItems). The stable key is `<kind>:<ruleKey>` — namespaced so it
// never collides with another domain's key and so a snooze/dismiss follows the
// rule across time. `preventiveRuleKey` drives the row's inline mark-done +
// override forms.
export function preventiveAssessmentToUpcomingItem(
  a: PreventiveAssessment
): UpcomingItem {
  const overdue = a.status === "overdue";
  const band: UrgencyBand = overdue ? "overdue" : "today";
  return {
    key: `${a.kind}:${a.key}`,
    domain: a.kind,
    title: a.name,
    detail: a.nextLabel ?? a.detail,
    // A rule-specific override (e.g. the lung prompt → Settings) wins; otherwise
    // the kind-based default (visit → appointments, screening → passport).
    href: a.href ?? HREF_BY_KIND[a.kind],
    dueDate: null,
    band,
    dueText: overdue ? "Overdue" : "Due",
    preventiveRuleKey: a.key,
  };
}
