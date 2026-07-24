// Pre-surgery / Post-op situations via a SUGGEST-ONLY scheduled-procedure bridge
// (issue #1299) — the producer for #1296's pause capability. The strongest use for a
// situational HOLD is the pre-surgical supplement stop (fish oil, vitamin E, ginkgo,
// high-dose garlic — the standard stop-7-days-before list), and the app already stores
// the scheduled procedure/visit. This module is the pure string + window discipline
// behind that bridge: a curated surgical-keyword list matched against upcoming
// appointment titles, the lead-time window math, and the per-procedure dismissal key.
//
// SUGGEST-ONLY, NEVER derived-auto (the #560/#1092 discipline, stakes INVERTED from
// #1292): this context SILENCES medication-adjacent reminders (via #1296), so
// activation must be consented — the confirm chip carries what it will do ("Surgery
// scheduled Aug 12 — activate Pre-surgery? 3 items will be held"). Nothing auto-clears:
// a postponed surgery must not silently resume held blood-thinners, so the date passing
// is a SUGGESTION trigger (clear Pre-surgery / activate Post-op), never an auto-flip.
//
// Pure (string constants + date-string math), so the matcher and window are
// unit-testable and the DB gather / actions layer over them.

import { shiftDateStr } from "./date";
import { sameSituation } from "./situations";

// The two built-in situation names (constants; no illness_type, no episodes). Pre-
// surgery is PAUSE-shaped (#1296 links hold blood-thinning supplements); Post-op is
// ON-shaped (wound-care / recovery items) and pairs with a recovery protocol (#1259).
export const BUILTIN_PRESURGERY_SITUATION = "Pre-surgery";
export const BUILTIN_POSTOP_SITUATION = "Post-op";

// The default lead: suggest activating Pre-surgery this many days before the surgery
// date (a configurable lead per the issue; the DB gather may override).
export const DEFAULT_SURGERY_LEAD_DAYS = 7;

// The curated surgical-keyword list — the CLINICAL_SITUATIONS shape in lib/situations.ts,
// applied to appointment/procedure titles. Whole-word-ish substring match plus the
// productive operative SUFFIX forms (-ectomy / -otomy / -ostomy / -plasty / -oscopy)
// so "Appendectomy" / "Arthroscopy" / "Rhinoplasty" match without enumerating every
// procedure. False positives are cheap (a dismissible chip); false negatives cost the
// user the pre-surgical stop, so the list leans inclusive.
export const SURGERY_KEYWORDS: readonly string[] = [
  "surgery",
  "surgical",
  "operation",
  "operative",
  "pre-op",
  "preop",
  "post-op",
  "postop",
  "anesthesia",
  "anaesthesia",
  "arthroscopy",
  "laparoscopy",
  "endoscopy",
  "biopsy",
  "resection",
  "excision",
  "amputation",
  "transplant",
  "implant",
  "graft",
];

// The productive operative suffixes — a title word ending in one of these is an
// operation ("-ectomy" remove, "-otomy" incise, "-ostomy" open, "-plasty" reshape,
// "-oscopy" scope). Requires a real stem before the suffix so a bare "otomy" / short
// noise word can't match.
const SURGICAL_SUFFIXES: readonly string[] = [
  "ectomy",
  "otomy",
  "ostomy",
  "plasty",
  "oscopy",
];

// Words that would otherwise trip a keyword but are NOT operative — a "consultation"
// or "follow-up" about a possible surgery is not itself the surgery. Conservative: an
// unrecognized title matches nothing rather than guessing.
const NEGATIVE_KEYWORDS: readonly string[] = [
  "consultation",
  "consult",
  "follow-up",
  "followup",
  "referral",
];

// Whether an appointment/procedure title names an operation (issue #1299). Case-
// folded; a negative keyword ("consultation") vetoes the whole title even when a
// surgical word is present ("surgical consultation" is a talk, not an operation).
export function isSurgicalTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  if (NEGATIVE_KEYWORDS.some((n) => t.includes(n))) return false;
  if (SURGERY_KEYWORDS.some((k) => t.includes(k))) return true;
  // Suffix forms: check each word's tail with a minimum stem so "-ectomy" etc. match
  // a real procedure noun, not a short token.
  for (const word of t.split(/[^a-z]+/)) {
    for (const suf of SURGICAL_SUFFIXES) {
      if (word.length >= suf.length + 3 && word.endsWith(suf)) return true;
    }
  }
  return false;
}

// The bridge suggestion's PHASE. "pre" = before the surgery (activate Pre-surgery to
// hold blood-thinners); "post" = the date has passed (clear Pre-surgery, offer Post-op).
export type SurgeryPhase = "pre" | "post";

export interface SurgeryVisitInput {
  visitId: number;
  title: string;
  // The surgery DATE (YYYY-MM-DD — the date part of the appointment's scheduled_at).
  scheduledDate: string;
}

export interface SurgeryBridgeSuggestion {
  visitId: number;
  phase: SurgeryPhase;
  title: string;
  scheduledDate: string;
  // The pre-surgery situation is currently active (drives the "post" copy: whether
  // there's a Pre-surgery to CLEAR).
  presurgeryActive: boolean;
  postopActive: boolean;
}

// The pure suggestion decision for ONE scheduled surgical visit (issue #1299), or null
// when nothing should be offered. SUGGEST-ONLY at both ends:
//   • PRE — the visit is a surgery, its date is today-or-later AND within `leadDays`
//     (not before the window opens), and Pre-surgery isn't already active → offer to
//     activate Pre-surgery (which will hold the linked items).
//   • POST — the date has PASSED and either Pre-surgery is still active (offer to clear
//     it — the reconcile acknowledgment, resumption is automatic) or Post-op isn't yet
//     active and we're still inside the post-recovery window (offer to activate it).
//     Deliberately NOT auto: a postponed surgery must not silently resume held meds.
export function surgeryBridgeSuggestion(
  visit: SurgeryVisitInput,
  today: string,
  active: { presurgery: boolean; postop: boolean },
  leadDays: number = DEFAULT_SURGERY_LEAD_DAYS
): SurgeryBridgeSuggestion | null {
  if (!isSurgicalTitle(visit.title)) return null;
  const d = visit.scheduledDate;
  const base = {
    visitId: visit.visitId,
    title: visit.title,
    scheduledDate: d,
    presurgeryActive: active.presurgery,
    postopActive: active.postop,
  };
  if (d >= today) {
    // Upcoming surgery: only inside the lead window, and only if not already held.
    const windowOpens = shiftDateStr(d, -Math.max(0, leadDays));
    if (today >= windowOpens && !active.presurgery) {
      return { ...base, phase: "pre" };
    }
    return null;
  }
  // Date passed. Keep offering to CLEAR Pre-surgery as long as it's active (safety —
  // held blood-thinners should be resumed), but stop nagging to ACTIVATE Post-op once
  // the recovery window closes.
  const postWindowEnds = shiftDateStr(d, Math.max(0, leadDays));
  if (active.presurgery) return { ...base, phase: "post" };
  if (!active.postop && today <= postWindowEnds)
    return { ...base, phase: "post" };
  return null;
}

// ---- Dismissal key (issue #1299 / #203 key hygiene) ----
// A suggestion is dismissible per-PROCEDURE, keyed to the visit id + phase, so
// dismissing one surgery's suggestion never silences next year's (ids never recycle —
// a deleted/rescheduled visit's key becomes a dead row, cleaned at the delete seam),
// and dismissing the pre-surgery chip doesn't also silence the later post-op chip.
export const SURGERY_BRIDGE_PREFIX = "surgery-bridge:";

export function surgeryBridgeDismissKey(
  phase: SurgeryPhase,
  visitId: number
): string {
  return `${SURGERY_BRIDGE_PREFIX}${phase}:${visitId}`;
}

// The situation a suggestion of this phase would ACTIVATE (the accept action's target).
// A "post" suggestion activates Post-op (the clear-Pre-surgery half is a separate,
// explicit toggle in the copy). Pure.
export function situationForPhase(phase: SurgeryPhase): string {
  return phase === "pre"
    ? BUILTIN_PRESURGERY_SITUATION
    : BUILTIN_POSTOP_SITUATION;
}

// Whether a situation name IS one of the built-in surgery situations (case/whitespace-
// folded) — so the create/backfill paths and any surface can recognize them.
export function isBuiltInSurgerySituation(name: string): boolean {
  return (
    sameSituation(name, BUILTIN_PRESURGERY_SITUATION) ||
    sameSituation(name, BUILTIN_POSTOP_SITUATION)
  );
}

// Whether `name` is in the active-situations list (case/whitespace-folded). Pure.
export function sameSituationActive(
  activeNames: readonly string[],
  name: string
): boolean {
  return activeNames.some((a) => sameSituation(a, name));
}
