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
import type { AppRoute } from "./hrefs";
import type { UpcomingItem, UrgencyBand } from "./upcoming";
import {
  appointmentKindForRule,
  suggestedBookDate,
} from "./preventive-appointment";
import { PREVENTIVE_CONCEPT_MAP } from "./preventive-concept-map";

// Where a preventive row links to for follow-through — always an EXISTING surface
// (there is no bespoke preventive page, and the old `/medical` target was removed;
// issue #283 found the dead link). A visit is acted on by booking/logging an
// appointment. A screening links to the surface that shows what SATISFIES it,
// which the concept map already knows per rule: a lab-satisfied screening (lipids,
// A1c, BP) → the biomarkers list, a procedure-satisfied one (colonoscopy, DEXA,
// mammogram) → the procedures list, and an unmapped (manual-only) rule → the
// passport, where its completion is recorded.
export function preventiveHref(
  kind: PreventiveAssessment["kind"],
  ruleKey: string
): AppRoute {
  if (kind === "visit") return "/encounters";
  const matcher = PREVENTIVE_CONCEPT_MAP.find((m) => m.ruleKey === ruleKey);
  if (!matcher) return "/profile";
  return matcher.canonicalBiomarkers.length > 0 ? "/biomarkers" : "/procedures";
}

// The stable suppression/identity key for a preventive rule: `<kind>:<ruleKey>`
// (e.g. "screening:colorectal_cancer"). Namespaced by kind so it never collides
// with another Upcoming domain's key. This is the SINGLE source of truth for the
// key — both the Upcoming item below AND the proactive preventive nudge
// (lib/notifications/preventive.ts) derive their dedupeKey from it, so a page
// dismissal and its push cousin line up on the same string (issue #227).
export function preventiveSignalKey(
  kind: PreventiveAssessment["kind"],
  ruleKey: string
): string {
  return `${kind}:${ruleKey}`;
}

// The prefilled new-appointment URL for a preventive rule's "Book" CTA (issue #85):
// the appointments page's create form, focused (?new=1), seeded with the rule name
// as the title, the mapped visit kind, and a suggested date. The appointments page
// reads these query params to pre-fill the form.
function bookHrefForRule(a: PreventiveAssessment, today: string): AppRoute {
  const kind = appointmentKindForRule(a.key);
  const params = new URLSearchParams({ new: "1", title: a.name });
  if (kind) params.set("kind", kind);
  params.set("date", suggestedBookDate(a.nextDueDate, today));
  return `/encounters?${params.toString()}`;
}

// Map one due/overdue preventive assessment to an Upcoming item. Overdue → the
// Overdue band with "Overdue" text; due → the Today band with "Due" text (mirrors
// immunizationItems). The stable key is `<kind>:<ruleKey>` — namespaced so it
// never collides with another domain's key and so a snooze/dismiss follows the
// rule across time. `preventiveRuleKey` drives the row's inline mark-done +
// override forms.
//
// `ctx.today` seeds the "Book" CTA's suggested date. When `ctx.scheduledDate` is
// set, a FUTURE matching-kind appointment is already booked (issue #85), so the
// item flips to a quiet "Scheduled" state — pushed down to the Later band, no
// "Book" CTA, its link pointing at the booked visit — instead of nagging.
export function preventiveAssessmentToUpcomingItem(
  a: PreventiveAssessment,
  ctx: { today: string; scheduledDate?: string | null }
): UpcomingItem {
  const scheduled = ctx.scheduledDate != null;
  if (scheduled) {
    return {
      key: preventiveSignalKey(a.kind, a.key),
      domain: a.kind,
      title: a.name,
      detail: `Scheduled for ${ctx.scheduledDate}`,
      href: "/encounters",
      dueDate: null,
      band: "later",
      dueText: "Scheduled",
      preventiveRuleKey: a.key,
      scheduled: true,
    };
  }
  const overdue = a.status === "overdue";
  const band: UrgencyBand = overdue ? "overdue" : "today";
  return {
    key: preventiveSignalKey(a.kind, a.key),
    domain: a.kind,
    title: a.name,
    detail: a.nextLabel ?? a.detail,
    // A rule-specific override (e.g. the lung prompt → Settings) wins; otherwise
    // the satisfaction-derived default (visit → appointments, screening → the
    // surface its satisfying record lives on).
    href: a.href ?? preventiveHref(a.kind, a.key),
    dueDate: null,
    band,
    dueText: overdue ? "Overdue" : "Due",
    preventiveRuleKey: a.key,
    bookHref: bookHrefForRule(a, ctx.today),
  };
}
