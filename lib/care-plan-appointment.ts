// Pure, DB-free matcher between a completed appointment and the profile's OPEN
// care-plan items (issue #658). It answers one question the visit → care-plan
// close-the-loop needs: "which open care-plan items does completing THIS appointment
// plausibly satisfy?" — so the UI can OFFER to complete them (confirm-first, the
// same posture as the existing "log this visit" / preventive offers; never a silent
// auto-complete).
//
// The contract, mirroring the issue: match by KIND / CODE / DESCRIPTION within a
// date WINDOW. Concretely a candidate item matches when
//   (1) it is still OPEN (isCarePlanItemOpen — completed/cancelled never re-offer),
//   (2) it sits inside the date window around the visit (undated items always pass —
//       an undated intention has no date to disqualify it), AND
//   (3) an appointment "needle" (a meaningful word from its title/notes plus the
//       curated keywords its kind implies) appears as a whole word in the item's
//       description or code.
// The needle set is deliberately conservative (short/generic words are dropped), so
// a bare "screening" appointment with no title needles nothing — the coarse
// screening kind can't pick a single item, exactly as it can't for the preventive
// catalog. Because the match only ever drives a confirm-first offer, a rare
// over-match is harmless (the user declines) and a miss just leaves the item to the
// manual mark-done it has today.

import type { AppointmentKind } from "./types";
import { daysBetweenDateStr } from "./date";
import { isCarePlanItemOpen } from "./care-plan-upcoming";

// The window (in days, each side of the visit) a dated care-plan item may sit within
// and still be considered covered by the visit. Care plans are written months out
// ("colonoscopy in March"), and a visit may land before or after the planned date,
// so a generous ±6 months keeps real matches without spanning into next year's plan.
export const CARE_PLAN_MATCH_WINDOW_DAYS = 183;

// The minimal appointment shape the matcher needs. The query/UI layers map their
// row into this before calling in.
export interface AppointmentMatchInput {
  kind: AppointmentKind | null;
  title: string | null;
  notes?: string | null;
  scheduledAt: string; // YYYY-MM-DD or "YYYY-MM-DD HH:MM"
}

// The minimal care-plan item shape the matcher reads (a structural subset of
// CarePlanItem so it stays testable with tiny fixtures).
export interface CarePlanMatchItem {
  id: number;
  description: string;
  code?: string | null;
  planned_date?: string | null;
  status?: string | null;
}

// Curated keywords a kind contributes even when the appointment carries no title —
// so a bare "Dental" appointment still needles a "Dental cleaning" item and a
// "Vision" appointment reaches an "Eye exam" item (whose distinguishing word, "eye",
// is too short to survive the generic tokenizer). well_child / screening / other are
// intentionally absent: they map to many items, so completing one can't single out a
// care-plan item — it relies on the title needles (or a manual mark-done).
const KIND_KEYWORDS: Partial<Record<AppointmentKind, string[]>> = {
  dental: ["dental", "teeth", "cleaning", "dentist"],
  vision: ["vision", "eye", "eyes", "optometry", "ophthalmology", "retinal"],
  physical: ["physical", "checkup"],
};

// Generic clinical filler that must NOT become a match needle — otherwise every
// "annual visit" would match every "annual" care-plan item. Compared lowercased.
const STOPWORDS = new Set([
  "visit",
  "visits",
  "appointment",
  "appt",
  "exam",
  "exams",
  "check",
  "checkup",
  "check-up",
  "annual",
  "yearly",
  "routine",
  "care",
  "plan",
  "with",
  "your",
  "the",
  "for",
  "and",
  "order",
  "ordered",
  "schedule",
  "scheduled",
  "planned",
  "referral",
  "refer",
  "consult",
  "consultation",
  "followup",
  "follow-up",
  "follow",
  "review",
]);

// Normalize free text to a space-padded lowercase haystack of alphanumeric words,
// so a needle test can require whole-word boundaries via ` needle ` containment.
function haystack(text: string | null | undefined): string {
  const norm = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${norm} `;
}

// Tokenize appointment free text into meaningful match needles: lowercase words of
// length ≥ 4 that aren't generic clinical filler.
function tokenize(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// The set of match needles an appointment contributes: meaningful words from its
// title + notes, plus the curated keywords its kind implies. Deduplicated. Exported
// for the unit test.
export function appointmentMatchNeedles(appt: AppointmentMatchInput): string[] {
  const set = new Set<string>();
  for (const t of tokenize(appt.title)) set.add(t);
  for (const t of tokenize(appt.notes)) set.add(t);
  if (appt.kind) for (const k of KIND_KEYWORDS[appt.kind] ?? []) set.add(k);
  return [...set];
}

// Whether a single OPEN item matches the appointment: inside the date window AND
// some needle appears as a whole word in its description or code.
function itemMatches(
  needles: string[],
  item: CarePlanMatchItem,
  visitDate: string,
  windowDays: number
): boolean {
  if (!isCarePlanItemOpen(item.status)) return false;
  if (item.planned_date != null) {
    const delta = daysBetweenDateStr(item.planned_date, visitDate);
    if (delta == null || Math.abs(delta) > windowDays) return false;
  }
  const hay = haystack(`${item.description} ${item.code ?? ""}`);
  return needles.some((n) => hay.includes(` ${n} `));
}

// The OPEN care-plan items a completed appointment plausibly satisfies (issue #658).
// Pure over the inputs; returns the matching subset in the order given. An empty
// needle set (e.g. a bare screening appointment) matches nothing.
export function matchCarePlanItemsForAppointment(
  appt: AppointmentMatchInput,
  items: readonly CarePlanMatchItem[],
  windowDays: number = CARE_PLAN_MATCH_WINDOW_DAYS
): CarePlanMatchItem[] {
  const needles = appointmentMatchNeedles(appt);
  if (needles.length === 0) return [];
  const visitDate = appt.scheduledAt.slice(0, 10);
  return items.filter((i) => itemMatches(needles, i, visitDate, windowDays));
}
