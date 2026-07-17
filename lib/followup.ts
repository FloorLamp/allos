// The domain-AGNOSTIC finding → follow-up → resolution chain core (issue #700,
// #860 Track A / #707 Substrate 1). PURE — no DB/network. The chain lives over
// care_plan_items (extending #658's lifecycle, migration 050); this module owns the
// state machine, the dedupeKey, the care-tier persistence contract, and the ADAPTER
// interface each finding-producing domain plugs into. Imaging is the first adapter
// (lib/followup-imaging.ts); IOP (#698), dental (#705), skin (#715), and flagged
// labs each supply their own adapter — what counts as a source finding, how to
// describe it, and which later record resolves it — WITHOUT touching this core.
//
// The highest-harm failure mode across all of them is a flagged finding whose
// follow-up never happens. So a follow-up here is a first-class chain node, not an
// untyped planned-care line: it knows its SOURCE finding (for legibility + a serial
// view), whether it is due/overdue/resolvable, and — once OVERDUE — it becomes a
// care-tier SAFETY signal that resists the "dismiss once, silence everywhere"
// convenience path the way a medication-dose escalation does (#449/#171/#227).

import type { SuppressionRecord } from "./upcoming-suppress";

// The dedupeKey namespace for a follow-up chain node. Registered in
// RULE_FINDING_PREFIXES (#448) so the page's prefix-guarded dismiss action can match
// it and the reflection guard proves the keys are guardable. Keyed on the
// care_plan_items row id (the chain node is the subject), so a dismiss/snooze follows
// the chain across time and never drifts — an integer id never recycles (#203).
export const FOLLOWUP_PREFIX = "followup:";

// The resolution outcomes a later record can record against a source finding — the
// serial-tracking verdict. Deliberately small + confirm-first (#560): the app never
// auto-resolves; a human picks one against a specific resolving record.
export type FollowUpResolution = "resolved" | "stable" | "changed";

const RESOLUTIONS: readonly FollowUpResolution[] = [
  "resolved",
  "stable",
  "changed",
];

// Coerce a submitted/stored value onto the closed resolution set, or null when it
// isn't one — validated in code (like the imaging modality/laterality enums), so a
// tampered form or an off-vocabulary stored value can never assert a bad outcome.
export function normalizeResolution(
  raw: unknown
): FollowUpResolution | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (RESOLUTIONS as readonly string[]).includes(v)
    ? (v as FollowUpResolution)
    : null;
}

// The normalized, cross-domain source ref a follow-up links back to — the ONE shape
// the core reasons over regardless of which concrete FK column carried it.
export interface FollowUpSourceRef {
  kind: string; // adapter discriminator, e.g. "imaging"
  recordId: number; // the source finding record's id (imaging_studies.id, …)
}

// A stored follow-up chain node, reduced to what the core + surfaces need. The
// builder maps a care_plan_items row (with the migration-050 columns) into this.
export interface FollowUpItemLike {
  id: number;
  title: string; // the care-plan description ("Follow-up chest CT")
  plannedDate: string | null; // when the follow-up is due (care_plan_items.planned_date)
  recommendedIntervalDays: number | null;
  source: FollowUpSourceRef | null; // null ⇒ not a linked follow-up (a generic care-plan item)
  resolution: FollowUpResolution | null; // null ⇒ still open
}

// The lifecycle state of an OPEN linked follow-up, given today and whether a matching
// later record is available to resolve it. Precedence is deliberate:
//   - "resolvable": a later matching record has landed — OFFER the outcome (this
//     takes precedence over any due/overdue nag; you had the scan, we don't nag you
//     to do it, we ask what it showed).
//   - "overdue": past its planned date with no resolving record — the safety signal
//     that must never silently age out.
//   - "upcoming": due today or in the future, tracked quietly.
export type FollowUpState = "resolvable" | "overdue" | "upcoming";

// Whether a follow-up is past its planned date. A null planned date is an undated
// intent — never "overdue" (there's nothing to be late against).
export function isFollowUpOverdue(
  plannedDate: string | null,
  today: string
): boolean {
  return plannedDate != null && plannedDate < today;
}

// The state of an open follow-up. `hasResolvingRecord` is the adapter's verdict
// (a later matching record exists); when true the offer wins regardless of date.
export function followUpState(
  plannedDate: string | null,
  today: string,
  hasResolvingRecord: boolean
): FollowUpState {
  if (hasResolvingRecord) return "resolvable";
  if (isFollowUpOverdue(plannedDate, today)) return "overdue";
  return "upcoming";
}

// ---- Care-tier persistence contract (#449, #700 ask 5) ----------------------
//
// An OVERDUE safety follow-up (a possibly-missed nodule re-scan) must NOT be
// silenceable by the "dismiss once, silence everywhere" convenience path — the same
// principle that keeps a medication-dose escalation off the bus (#171/#227). But it
// is NOT a black hole: a user can still time-box-DEFER it.
//
//   Policy by state:
//     - "normal": upcoming OR resolvable follow-ups are fully suppressible — a
//       snooze OR a dismiss hides them like any finding. (A resolvable offer is an
//       optional "tell us the outcome"; a not-yet-due follow-up is ordinary planned
//       care.)
//     - "snooze-only": an OVERDUE follow-up HONORS a live time-boxed SNOOZE (a
//       deliberate "remind me next week") but RESISTS an indefinite DISMISS — a
//       dismissed_at row is IGNORED for it, and the surfaces render no dismiss
//       affordance. A dismiss can therefore never permanently silence a missed
//       follow-up; only a snooze defers it, and the snooze expires.
export type FollowUpSuppressionPolicy = "normal" | "snooze-only";

export function followUpSuppressionPolicy(
  state: FollowUpState
): FollowUpSuppressionPolicy {
  return state === "overdue" ? "snooze-only" : "normal";
}

// Whether a follow-up is hidden RIGHT NOW under its persistence policy — the ONE
// decision both the Upcoming filter and the "snoozed & dismissed" complement route
// through for follow-ups. Under "snooze-only" a dismiss is ignored (resisted) while
// a live snooze still hides it; under "normal" it's the standard isSuppressed rule.
// (The generic isSuppressed lives in upcoming-suppress.ts; this is the follow-up
// specialization the pure care-tier test pins.)
export function isFollowUpHidden(
  policy: FollowUpSuppressionPolicy,
  record: SuppressionRecord | undefined,
  today: string
): boolean {
  if (!record) return false;
  if (policy === "snooze-only") {
    // Resist an indefinite dismiss; honor only a live snooze.
    if (record.snooze_until && !record.dismissed_at)
      return today < record.snooze_until;
    return false;
  }
  // "normal": dismiss hides indefinitely, snooze while today < snooze_until.
  if (record.dismissed_at) return true;
  if (record.snooze_until) return today < record.snooze_until;
  return false;
}

// ---- The domain ADAPTER interface -------------------------------------------
//
// Each finding-producing domain supplies one adapter: the label for its source
// finding (legibility), the follow-up title, and its resolution-matching rule (which
// later record of its own kind resolves a follow-up). The core stays blind to
// imaging vs IOP vs dental — it only ever sees these methods. `Source` is the domain
// record shape (an ImagingStudy, an IOP reading…); `Candidate` is a later record of
// the resolving kind (usually the same type).
export interface FollowUpAdapter<Source, Candidate> {
  // The adapter discriminator stored in care_plan_items.source_kind.
  kind: string;
  // A short human label for the source finding, for the "for the …" reason line
  // ("6 mm RLL nodule (2026-03)").
  describeSource(source: Source): string;
  // The default follow-up title for a source ("Follow-up chest CT").
  followUpTitle(source: Source): string;
  // The later record that resolves a follow-up for this source, from the candidate
  // records — or null when none has landed yet. Confirm-first: this only OFFERS; the
  // user confirms the outcome against the returned record.
  findResolvingRecord(
    source: Source,
    followUp: FollowUpItemLike,
    candidates: readonly Candidate[]
  ): Candidate | null;
  // A short label for a resolving candidate, for the offer copy ("CT chest · 2026-03").
  describeResolvingRecord(candidate: Candidate): string;
}

// The confirm payload the surfaces carry so an inline "mark resolved/stable/changed"
// control can post the resolution against the matched later record. ids only.
export interface FollowUpResolveOffer {
  carePlanItemId: number;
  resolvingRecordId: number;
  resolvingLabel: string;
}
