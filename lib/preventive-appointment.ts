import type { AppointmentKind } from "./types";
import { PREVENTIVE_CATALOG } from "./preventive-catalog";

// Pure, DB-free glue between the preventive-care catalog (lib/preventive-catalog.ts)
// and booked appointments (issue #85). It answers three questions, all as pure
// functions the query/action layers call with data they've already read:
//
//   1. CTA prefill — given a due preventive rule, WHAT appointment kind (and
//      suggested date) should the "Book" link pre-fill? (appointmentKindForRule /
//      suggestedBookDate)
//   2. Scheduled suppression — is there a FUTURE, still-scheduled appointment whose
//      kind matches this rule, so the Upcoming item can quiet to "Scheduled" instead
//      of nagging? (scheduledMatchForRule)
//   3. Close the loop — when an appointment of kind K is completed, which single
//      preventive rule (if any) should we offer to record as satisfied?
//      (satisfiedRuleForCompletedKind)
//
// A NULL appointment kind NEVER matches (no fuzzy title guessing — that is the job
// of the record-inference layer, lib/preventive-inference.ts, which name-matches
// titles). Kind matching is a stronger, EXPLICIT signal alongside that inference:
// it needs no title synonym to line up. Because kind is a small shared enum, the
// generic `screening` bucket is intentionally coarse — booking one screening visit
// quiets every due screening reminder (they stay visible as "Scheduled", not
// hidden), which is the desired "you'll triage screenings at that visit" behavior.

export const APPOINTMENT_KINDS: AppointmentKind[] = [
  "well_child",
  "physical",
  "dental",
  "vision",
  "hearing",
  "screening",
  "other",
];

// Human labels for the form select + any surfaced kind.
export const APPOINTMENT_KIND_LABELS: Record<AppointmentKind, string> = {
  well_child: "Well-child visit",
  physical: "Physical / check-up",
  dental: "Dental",
  vision: "Vision / eye exam",
  hearing: "Hearing / audiology",
  screening: "Screening",
  other: "Other",
};

// Narrowing guard for a free-form string coming off a form (validates the write
// boundary so a tampered value can't reach the DB).
export function isAppointmentKind(s: string | null): s is AppointmentKind {
  return s != null && (APPOINTMENT_KINDS as string[]).includes(s);
}

// The appointment kind you'd book for a given preventive rule. Every catalog rule
// maps to exactly one kind: well-child milestones + the annual → well_child; the
// adult check-up → physical; dental/vision have their own kinds; skin check and all
// screenings fall to the generic `screening`. Returns null only for an unknown key.
function computeKindForRule(ruleKey: string): AppointmentKind | null {
  if (ruleKey.startsWith("wellchild")) return "well_child";
  switch (ruleKey) {
    case "adult_physical":
      return "physical";
    case "dental_cleaning":
      return "dental";
    case "vision_exam":
      return "vision";
    case "hearing_screening":
      return "hearing";
  }
  // Every other catalog rule is a screening-shaped item (incl. skin_check).
  return "screening";
}

const KIND_BY_RULE: Map<string, AppointmentKind> = new Map(
  PREVENTIVE_CATALOG.map((r) => [r.key, computeKindForRule(r.key)!])
);

export function appointmentKindForRule(
  ruleKey: string
): AppointmentKind | null {
  return KIND_BY_RULE.get(ruleKey) ?? null;
}

// The kinds that map to EXACTLY ONE satisfiable rule, so completing an appointment
// of that kind can unambiguously offer to record that rule as done. well_child and
// screening are intentionally absent — they cover many rules (which milestone? which
// screening?), so completing one can't pick a single rule to satisfy; those still
// rely on record inference / a manual mark-done. `other` never satisfies anything.
const RULE_BY_COMPLETED_KIND: Partial<Record<AppointmentKind, string>> = {
  physical: "adult_physical",
  dental: "dental_cleaning",
  vision: "vision_exam",
  hearing: "hearing_screening",
};

// The single preventive rule key a completed appointment of this kind satisfies,
// or null when the kind is unset / ambiguous / non-preventive.
export function satisfiedRuleForCompletedKind(
  kind: string | null
): string | null {
  if (!isAppointmentKind(kind)) return null;
  return RULE_BY_COMPLETED_KIND[kind] ?? null;
}

// The minimal appointment shape the matcher needs — kind, its calendar date, and
// lifecycle status. The query layer maps its rows into this before calling in.
export interface KindedAppointment {
  kind: AppointmentKind | null;
  scheduledAt: string; // YYYY-MM-DD or "YYYY-MM-DD HH:MM"
  status: string;
}

// Is a rule covered by a FUTURE, still-scheduled appointment whose kind matches?
// Returns the SOONEST matching appointment's date (YYYY-MM-DD) or null. A match
// requires: status 'scheduled', a non-null kind equal to the rule's kind, and a
// calendar date on/after `today` (a past-and-still-scheduled visit doesn't count —
// it's itself an overdue signal, not a booking that covers the reminder).
export function scheduledMatchForRule(
  ruleKey: string,
  appointments: KindedAppointment[],
  today: string
): string | null {
  const kind = appointmentKindForRule(ruleKey);
  if (kind == null) return null;
  let soonest: string | null = null;
  for (const a of appointments) {
    if (a.status !== "scheduled") continue;
    if (a.kind == null || a.kind !== kind) continue; // NULL never matches
    const date = a.scheduledAt.slice(0, 10);
    if (date < today) continue; // must be today or future
    if (soonest == null || date < soonest) soonest = date;
  }
  return soonest;
}

// The suggested date to pre-fill the "Book" form with for a due item: the rule's
// concrete next-due date when it's still in the future, else today (an overdue or
// age-based item is booked now). Pure — the caller passes the assessment's
// nextDueDate (or null).
export function suggestedBookDate(
  nextDueDate: string | null,
  today: string
): string {
  return nextDueDate != null && nextDueDate > today ? nextDueDate : today;
}
