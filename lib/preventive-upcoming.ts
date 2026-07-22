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
import {
  PREVENTIVE_CONCEPT_MAP,
  type ScreeningSatisfiedBy,
} from "./preventive-concept-map";

// The vitals ENTRY surface (#1076/#1179): vitals left the biomarker surface, so a
// self-recordable vital screening (blood pressure) deep-links to the Trends → Vitals
// quick-add, focused on the analyte. A stable ROUTE + prefill (NOT a Trends-section
// component internal), to stay clear of the parallel Trends overhaul (#1067).
const VITALS_ENTRY_HREF: AppRoute = "/trends?tab=vitals&focus=blood-pressure";

// The concrete deep link for a screening, from its explicit `satisfiedBy` concept
// (#1083) — NOT the old `canonicalBiomarkers.length` guess (which pointed the
// instrument/vital classes at the biomarker surface #1076 emptied of them). One
// place so the Upcoming row, the page, and the nudge all resolve the same target.
function screeningActionHref(sb: ScreeningSatisfiedBy): AppRoute {
  switch (sb.kind) {
    case "instrument":
      // `<page>?screen=<INSTRUMENT>` — the form preselects + focuses that instrument.
      return `${sb.page}?screen=${encodeURIComponent(sb.instrument)}`;
    case "lab":
      // The #662 biomarker add-form prefill; unprefilled when no tracked biomarker.
      return sb.primary
        ? `/results/biomarkers?new=1&name=${encodeURIComponent(sb.primary)}`
        : "/results/biomarkers?new=1";
    case "vital":
      return VITALS_ENTRY_HREF;
    case "procedure":
      // The procedures add-form prefill (mirrors #662).
      return `/records/history/procedures?new=1&name=${encodeURIComponent(
        sb.procedure
      )}`;
  }
}

// The CTA copy for a screening's concrete next action, verb driven by class (#1083):
// instrument in-app → "Complete the …"; instrument total-only → "Enter your … score"
// (a copyright-restricted instrument can't be administered in-app); lab → "Record …";
// vital → "Record a blood pressure reading"; procedure → "Log or schedule …". Named
// so the page, the row, and the nudge speak the identical instruction (#221).
function screeningActionLabel(sb: ScreeningSatisfiedBy): string {
  switch (sb.kind) {
    case "instrument":
      return sb.entry === "in-app"
        ? `Complete the ${sb.instrument}`
        : `Enter your ${sb.instrument} score`;
    case "lab":
      return sb.primary
        ? `Record your ${sb.primary} result`
        : "Record your result";
    case "vital":
      return "Record a blood pressure reading";
    case "procedure":
      return `Log or schedule a ${sb.procedure}`;
  }
}

// Look up a screening rule's `satisfiedBy` concept (undefined for a visit or an
// unmapped/manual-only rule).
function satisfiedByForRule(ruleKey: string): ScreeningSatisfiedBy | undefined {
  return PREVENTIVE_CONCEPT_MAP.find((m) => m.ruleKey === ruleKey)?.satisfiedBy;
}

// Where a preventive row's TITLE links for follow-through — the concrete next action
// (#1083), driven by the rule's explicit `satisfiedBy` concept. A visit is acted on
// by booking (the bookHref CTA), so its title links to the visits surface; a
// screening deep-links to the exact form that records/administers what satisfies it
// (a prefilled biomarker/procedure add form, the instrument `?screen=`, or the vitals
// quick-add); an unmapped (manual-only) rule falls back to the passport.
export function preventiveHref(
  kind: PreventiveAssessment["kind"],
  ruleKey: string
): AppRoute {
  if (kind === "visit") return "/records/history/visits";
  const sb = satisfiedByForRule(ruleKey);
  return sb ? screeningActionHref(sb) : "/profile";
}

// The named CTA for a preventive rule's concrete next action (#1083) — the SAME
// string the Upcoming row renders, the page shows, and the nudge's deep-link button
// carries (#221). Null for a visit (whose CTA is the existing "Book" affordance) and
// for an unmapped rule (no concrete action to name).
export function preventiveActionLabel(
  kind: PreventiveAssessment["kind"],
  ruleKey: string
): string | null {
  if (kind === "visit") return null;
  const sb = satisfiedByForRule(ruleKey);
  return sb ? screeningActionLabel(sb) : null;
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
  return `/records/history/visits?${params.toString()}`;
}

// The concrete-action deep link + CTA for a preventive nudge (#1083) — the SAME
// per-class link + label the Upcoming row derives, so the page, the row, and the
// notification say the identical thing (#221). A screening → its `satisfiedBy` deep
// link + named CTA; a visit → the prefilled Book path + "Book"; an unmapped rule →
// null (no concrete action to link/name). `today` seeds a visit's suggested date.
// Returns a RELATIVE href — the nudge absolute-izes it via getPublicUrl().
export function preventiveNudgeAction(
  a: PreventiveAssessment,
  today: string
): { href: AppRoute; label: string } | null {
  if (a.kind === "visit") {
    return { href: bookHrefForRule(a, today), label: "Book" };
  }
  const label = preventiveActionLabel(a.kind, a.key);
  if (!label) return null;
  return { href: a.href ?? preventiveHref(a.kind, a.key), label };
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
      href: "/records/history/visits",
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
    // the satisfaction-derived deep link to the concrete next action (#1083): a
    // screening → the prefilled form that records/administers what satisfies it, a
    // visit → the visits surface (its action is the "Book" CTA below).
    href: a.href ?? preventiveHref(a.kind, a.key),
    dueDate: null,
    band,
    dueText: overdue ? "Overdue" : "Due",
    // The named CTA for that concrete action (#1083/#221) — rendered as a deep-link
    // button on the row. Null for visits (the "Book" CTA names their action) and a
    // rule-override'd item (its href points elsewhere, so its default CTA is moot).
    actionLabel:
      a.href != null
        ? undefined
        : (preventiveActionLabel(a.kind, a.key) ?? undefined),
    preventiveRuleKey: a.key,
    bookHref: bookHrefForRule(a, ctx.today),
  };
}
