// Preventive care (issue #82). The satisfaction/override stores + the shared
// profile assessment (assessProfilePreventive). assessProfilePreventive is the
// single resolver both the Upcoming builder (its preventiveItems adapter lives
// with the other item builders in ./generators) and the proactive preventive
// nudge (lib/notifications/preventive.ts) share, so the page and the push can
// never diverge on WHICH items are due. Every read here is profile-scoped
// (enforced by lib/__tests__/profile-scoping.test.ts).

import { db, writeTx } from "../../db";
import { cache } from "../../request-cache";
import { tickCached } from "../../tick-cache";
import { clearPreventiveDismissal } from "./suppressions";
import {
  assessCatalog,
  type PreventiveOverride,
  type PreventiveOverrideKind,
  type PreventiveSatisfaction,
  type PreventiveSummary,
} from "../../preventive-status";
import {
  inferPreventiveSatisfactions,
  isCompletedStatus,
  type InferenceRecord,
} from "../../preventive-inference";
import { inferScreeningResultSatisfactions } from "../../preventive-screening-result";
import {
  derivePreventiveReviewCandidates,
  preventiveEvidenceRecord,
  type PreventiveReviewCandidate,
  type PreventiveReviewSource,
} from "../../preventive-review";
import { inferOpticalRxSatisfactions } from "../../preventive-optical";
import {
  getProfileSex,
  profileAgeMonths,
  getSmokingHistory,
} from "../../settings";
import { resolveSmoking } from "../../smoking";
import { appointmentKindInferenceText } from "../../preventive-appointment";
import { getAppointments } from "../appointments";
import {
  getClinicalObservations,
  getEncounters,
  getCurrentQualitativeResults,
} from "../medical";
import {
  hasImportedSmokingHistory,
  getCarePlanItems,
  getDentalProcedures,
  getProcedures,
  getOpticalPrescriptions,
} from "../clinical";
import { getRiskFactors } from "./risk";

// ---- Preventive care (issue #82) ------------------------------------------
// The manual "mark done" SATISFACTION stream for a profile: each row is a rule
// completed on a date, fed straight into the pure assessor. Profile-scoped.
export function getPreventiveSatisfactions(
  profileId: number
): PreventiveSatisfaction[] {
  return db
    .prepare(
      `SELECT rule_key AS ruleKey, date
         FROM preventive_events WHERE profile_id = ?`
    )
    .all(profileId) as PreventiveSatisfaction[];
}

// Which medical-record categories are screening evidence, and through which
// paths, is the CLOSED census in lib/preventive-review.ts (#3025): value-bearing
// result categories (labs, vitals, instrument scores) keep the full #86 matching;
// document categories (report, assessment) satisfy through structured identity
// ONLY — an exact concept-map code or a curated canonical name — never through
// their free-text title; the rest are excluded with a stated reason. An
// unclassified category fails loudly instead of being silently dropped, which is
// how a screened profile's Pap cytology (`category = 'report'`) got an overdue
// cervical-screening nudge.

// INFERRED satisfactions (issue #86): preventive rules a profile's EXISTING
// records already satisfy — a colonoscopy procedure, a lipid/A1c result, a
// completed physical/eye/dental visit or encounter, a dated optical prescription
// (#1098), a completed care-plan item —
// derived deterministically by the pure concept-mapping layer
// (lib/preventive-inference.ts). These feed the SAME `(ruleKey, date)` stream as
// the manual "mark done" events and NEVER touch the stored preventive_events rows;
// the merge happens in-memory in preventiveItems below. Every read here is
// profile-scoped (each getX filters profile_id). Records are routed to the rule
// KINDS their source can legitimately satisfy: procedures/labs → screenings,
// appointments/encounters/completed dental procedures → visits, completed
// care-plan items → either.
export function getInferredPreventiveSatisfactions(
  profileId: number
): PreventiveSatisfaction[] {
  const records: InferenceRecord[] = [];

  // Procedures → screenings (coded or name-matched, e.g. colonoscopy, DEXA).
  //
  // SCREENING-vs-DIAGNOSTIC INDICATION — a DELIBERATE decision, not an accident (#703).
  // Any coded/named mammogram (or colonoscopy, DEXA, …) PROCEDURE satisfies its
  // screening rule with NO indication check, so a DIAGNOSTIC study — a mammogram done
  // to work up a palpable lump, a colonoscopy done for bleeding — also quiets the
  // routine-screening clock. imaging_studies now stores an `indication` (#702), so the
  // ALTERNATIVE is available: gate satisfaction on indication and let a diagnostic
  // workup NOT reset (or reset differently from) the routine interval.
  //
  // We KEEP the current behavior on purpose. The person WAS imaged; if that workup
  // turned up a finding, it is tracked SEPARATELY through the follow-up loop (#700), not
  // by re-nagging a routine screening. Distinguishing screening from diagnostic here
  // would (a) depend on a free-text `indication` that is usually absent or ambiguous,
  // (b) risk telling someone who just had a diagnostic mammogram that they're "overdue"
  // for a screening mammogram — noisy and confusing — and (c) duplicate the finding's
  // own tracking. The indication is captured for the record and the FHIR feed; it is
  // intentionally NOT gated on here. (Documented in docs/features.md; see #703.)
  for (const p of getProcedures(profileId)) {
    records.push({
      code: p.code,
      name: p.name,
      date: p.date,
      allow: ["screening"],
    });
  }

  // Medical-record rows → lab screenings, per the closed evidence census
  // (lib/preventive-review.ts, #3025). Result rows keep the unchanged #86 shape
  // (canonical biomarker name, or the raw result name as a fallback synonym
  // match); document rows (report/assessment) contribute ONLY their structured
  // identity — LOINC via the exact-code path, curated canonical name — with the
  // free-text title withheld, so no wording auto-satisfies and none withholds an
  // authored identity. Excluded categories and the #2877 NULL review state map
  // to nothing.
  for (const r of getClinicalObservations(profileId)) {
    const rec = preventiveEvidenceRecord(r);
    if (rec) records.push(rec);
  }

  // Completed appointments → visits (name-matched on the title PLUS the explicit
  // kind's inference text, #997). Folding appointmentKindInferenceText in lets a
  // mental_health visit satisfy the depression/anxiety SCREENINGS via the shared
  // stream even when its title is generic — the KIND is the reliable signal. Those
  // rules are `screening`-kind (a screening rule isn't a visit rule, unlike the
  // physical/dental/eye visit rules), so a mental_health appointment additionally
  // passes "screening" in its `allow` (the care-plan-item precedent of a
  // multi-kind allow), reaching the depression/anxiety matchers without a forked
  // satisfaction path. Every other kind stays `allow: ["visit"]`.
  for (const a of getAppointments(profileId)) {
    if (!isCompletedStatus(a.status)) continue;
    records.push({
      code: null,
      name:
        [a.title, appointmentKindInferenceText(a.kind)]
          .filter(Boolean)
          .join(" ") || null,
      date: a.date,
      allow: a.kind === "mental_health" ? ["visit", "screening"] : ["visit"],
    });
  }

  // Encounters → visits: a recorded encounter IS a completed visit; match on its
  // type + reason free text PLUS its notes and the provider/facility name (issue
  // #515). A dermatology visit's evidence lives in the notes ("skin…") and the
  // provider/facility name ("… Dermatology"), not just type/reason — folding those
  // in lets a specialty visit satisfy the matching "see the right kind of doctor"
  // rule (skin/eye/dental). Whole-word matching against the SAME specific phrases
  // keeps this within the #86 conservatism: bare "skin" still matches nothing; a
  // specialty word ("dermatology") or an explicit phrase ("skin check") does.
  // The imported TYPE CODE (#1035) now feeds the concept map's exact-code path
  // too, so Epic's generic "Office Visit" carrying CPT 99396 satisfies
  // adult_physical even when every text field is generic.
  for (const e of getEncounters(profileId)) {
    records.push({
      code: e.code,
      name:
        [e.type, e.reason, e.notes, e.provider_name, e.location_name]
          .filter(Boolean)
          .join(" ") || null,
      date: e.date,
      allow: ["visit"],
    });
  }

  // Completed DENTAL procedures → the dental visit rule (issue #1037). The
  // dental-specific record type carries its own CDT column (D1110/D0120 → the
  // concept map's exact-code path) and a free-text name (→ the whole-word
  // synonyms), so a logged cleaning/exam satisfies dental_cleaning exactly like
  // a colonoscopy row satisfies its screening. Only status='completed' rows are
  // evidence — a 'planned' extraction or a 'watch' finding is not a done
  // cleaning (mirrors the appointment isCompletedStatus conservatism) — and a
  // row with no procedure_date is skipped by the pure layer (can't be placed on
  // the timeline), same as every other source.
  for (const d of getDentalProcedures(profileId)) {
    if (d.status !== "completed") continue;
    records.push({
      code: d.cdt_code,
      name: d.name,
      date: d.procedure_date,
      allow: ["visit"],
    });
  }

  // Completed care-plan items → whichever rule they identify (visit or screening).
  for (const c of getCarePlanItems(profileId)) {
    if (!isCompletedStatus(c.status)) continue;
    records.push({
      code: c.code,
      name: c.description,
      date: c.planned_date,
      allow: ["visit", "screening"],
    });
  }

  // Qualitative SCREENING RESULTS → screenings (issue #686): a result the shared
  // classifier (#549) recognizes, keyed by CONCEPT, satisfies its screening rule as
  // of its date — the screening counterpart of titerImmuneStatus. Catches results the
  // name/code inference above misses (an HPV result carrying only a LOINC → cervical
  // screening; HIV / hepatitis-B, which have no concept-map entry at all). The one
  // assessor takes the newest satisfaction per rule, so this merges cleanly with the
  // name/code + manual streams and never double-counts.
  const screeningResults = inferScreeningResultSatisfactions(
    getCurrentQualitativeResults(profileId)
  );

  // Dated optical prescriptions → the vision_exam rule (issue #1098). A new
  // eyeglass/contact Rx is written AT an eye exam, so the row is intrinsic proof the
  // exam happened — a DIRECT satisfaction source (the Rx has no CPT/name text to feed
  // the concept map, unlike the dental-procedure source above). The issued date drives
  // the satisfaction; the one assessor then applies the normal ~24-month interval. An
  // old Rx satisfies only as of its old date, so a stale Rx never suppresses a due exam.
  const opticalRxSatisfactions = inferOpticalRxSatisfactions(
    getOpticalPrescriptions(profileId)
  );

  return [
    ...inferPreventiveSatisfactions(records),
    ...screeningResults,
    ...opticalRxSatisfactions,
  ];
}

// The manual declined / not-applicable overrides for a profile. Each drops its
// rule out of the actionable set (the pure assessor reads them). Profile-scoped.
export function getPreventiveOverrides(
  profileId: number
): PreventiveOverride[] {
  return db
    .prepare(
      `SELECT rule_key AS ruleKey, kind
         FROM preventive_overrides WHERE profile_id = ?`
    )
    .all(profileId) as PreventiveOverride[];
}

// Record a manual "mark done": rule `ruleKey` satisfied on `date` (a completed
// visit or a screening result). Idempotent on (profile_id, rule_key, date, source)
// so re-confirming the same day is a no-op. `source` is 'manual' for this v1;
// later record-inference writes into the same stream with its own source.
export function recordPreventiveDone(
  profileId: number,
  ruleKey: string,
  date: string,
  source = "manual"
): void {
  writeTx(() => {
    db.prepare(
      `INSERT INTO preventive_events (profile_id, rule_key, date, source)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, rule_key, date, source) DO NOTHING`
    ).run(profileId, ruleKey, date, source);
    // A satisfying event ENDS the episode this rule's dismissal belonged to, so retire
    // that dismissal — the next cycle's due surfaces fresh instead of hitting the stale
    // suppression (issue #1024). Snoozes are left alone (they self-expire); a lasting
    // opt-out lives in preventive_overrides.
    clearPreventiveDismissal(profileId, ruleKey);
  });
}

// ---- Preventive review decisions (issue #3025) ------------------------------
//
// The durable answer to a review candidate — one row per (profile, record, rule)
// in preventive_record_decisions. A CONFIRMED row is the explicit stored link
// between a report and its screening rule: it projects into the same
// PreventiveSatisfaction stream as the manual and inferred events (below), and is
// deliberately NOT duplicated into preventive_events — the record link is the
// point, and the FK cascade retracts the satisfaction if the source record is
// deleted. A DISMISSED row suppresses ONLY this candidate; it asserts nothing
// about the screening and never suppresses the preventive item itself.

// The report rows a review candidate can be derived from. Profile-scoped.
function getReviewSourceReports(profileId: number): PreventiveReviewSource[] {
  return db
    .prepare(
      `SELECT id, category, name, date, value
         FROM medical_records
        WHERE profile_id = ? AND category = 'report'`
    )
    .all(profileId) as PreventiveReviewSource[];
}

export interface PreventiveRecordDecision {
  medicalRecordId: number;
  ruleKey: string;
  decision: "confirmed" | "dismissed";
  confirmedDate: string | null;
}

// Every stored review decision for a profile. Profile-scoped.
export function getPreventiveRecordDecisions(
  profileId: number
): PreventiveRecordDecision[] {
  return db
    .prepare(
      `SELECT medical_record_id AS medicalRecordId, rule_key AS ruleKey,
              decision, confirmed_date AS confirmedDate
         FROM preventive_record_decisions WHERE profile_id = ?`
    )
    .all(profileId) as PreventiveRecordDecision[];
}

// The OFFERED review candidates for a profile: every derived candidate (a
// valueless report whose title matches exactly one screening rule) that has no
// stored decision yet. Confirmed pairs are answered (and now satisfy through the
// projection below); dismissed pairs are answered too — the dismissal suppresses
// exactly this candidate and nothing else. Profile-scoped.
export function getPreventiveReviewOffers(
  profileId: number
): PreventiveReviewCandidate[] {
  const decided = new Set(
    getPreventiveRecordDecisions(profileId).map(
      (d) => `${d.medicalRecordId}:${d.ruleKey}`
    )
  );
  return derivePreventiveReviewCandidates(
    getReviewSourceReports(profileId)
  ).filter((c) => !decided.has(`${c.recordId}:${c.ruleKey}`));
}

export type PreventiveReviewDecisionOutcome =
  "written" | "not-a-candidate" | "invalid-date";

// Whether (recordId, ruleKey) still forms a derivable candidate for this
// profile. DECISION-BLIND on purpose: the same derivation that offered the
// candidate revalidates the write, so a forged profile/record/rule combination
// (or a record edited since the offer) writes nothing, while reconfirming an
// already-decided pair stays idempotent — the pair still derives after its
// decision exists.
function isDerivableCandidate(
  profileId: number,
  recordId: number,
  ruleKey: string
): boolean {
  return derivePreventiveReviewCandidates(
    getReviewSourceReports(profileId)
  ).some((c) => c.recordId === recordId && c.ruleKey === ruleKey);
}

// Confirm a review candidate: "yes, this record shows the screening was
// completed on `confirmedDate`" (the person confirmed or changed the prefilled
// record date before this write). Upserts on the (profile, record, rule) unique
// key, so reconfirming is idempotent and a changed date updates the one row.
// Ends the rule's suppression episode exactly like recordPreventiveDone: the
// dismissal is retired so the next cycle's due surfaces fresh (#1024); the
// notify_last_preventive_<ruleKey> marker is cleared by the existing preventive
// nudge lifecycle once the assessment is no longer actionable.
export function confirmPreventiveRecordDecision(
  profileId: number,
  recordId: number,
  ruleKey: string,
  confirmedDate: string
): PreventiveReviewDecisionOutcome {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmedDate)) return "invalid-date";
  if (!isDerivableCandidate(profileId, recordId, ruleKey))
    return "not-a-candidate";
  writeTx(() => {
    db.prepare(
      `INSERT INTO preventive_record_decisions
         (profile_id, medical_record_id, rule_key, decision, confirmed_date)
       VALUES (?, ?, ?, 'confirmed', ?)
       ON CONFLICT(profile_id, medical_record_id, rule_key) DO UPDATE SET
         decision = 'confirmed',
         confirmed_date = excluded.confirmed_date,
         updated_at = datetime('now')`
    ).run(profileId, recordId, ruleKey, confirmedDate);
    clearPreventiveDismissal(profileId, ruleKey);
  });
  return "written";
}

// Dismiss a review candidate: stop offering THIS record/rule pair. Not a claim
// that the screening was skipped — the preventive item and its ordinary contact
// behavior are untouched (that is what overrides/suppressions are for).
export function dismissPreventiveRecordCandidate(
  profileId: number,
  recordId: number,
  ruleKey: string
): PreventiveReviewDecisionOutcome {
  if (!isDerivableCandidate(profileId, recordId, ruleKey))
    return "not-a-candidate";
  db.prepare(
    `INSERT INTO preventive_record_decisions
       (profile_id, medical_record_id, rule_key, decision, confirmed_date)
     VALUES (?, ?, ?, 'dismissed', NULL)
     ON CONFLICT(profile_id, medical_record_id, rule_key) DO UPDATE SET
       decision = 'dismissed',
       confirmed_date = NULL,
       updated_at = datetime('now')`
  ).run(profileId, recordId, ruleKey);
  return "written";
}

// CONFIRMED decisions as satisfactions — the explicit-link stream, merged into
// the one assessor beside the manual and inferred streams (assessProfilePreventive
// below). `(ruleKey, date)`, the exact shape the others emit. Profile-scoped.
export function getConfirmedPreventiveRecordSatisfactions(
  profileId: number
): PreventiveSatisfaction[] {
  return db
    .prepare(
      `SELECT rule_key AS ruleKey, confirmed_date AS date
         FROM preventive_record_decisions
        WHERE profile_id = ? AND decision = 'confirmed'`
    )
    .all(profileId) as PreventiveSatisfaction[];
}

// Set a declined / not-applicable override on a preventive rule, upserting on
// (profile_id, rule_key) so re-setting flips the kind (mirrors the immunization
// override writer). Profile-scoped.
export function setPreventiveOverride(
  profileId: number,
  ruleKey: string,
  kind: PreventiveOverrideKind,
  note: string | null = null
): void {
  db.prepare(
    `INSERT INTO preventive_overrides (profile_id, rule_key, kind, note)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, rule_key) DO UPDATE SET
       kind = excluded.kind,
       note = excluded.note,
       created_at = datetime('now')`
  ).run(profileId, ruleKey, kind, note);
}

// Clear any override on a preventive rule so it re-enters the schedule assessment.
// Profile-scoped.
export function clearPreventiveOverride(
  profileId: number,
  ruleKey: string
): void {
  db.prepare(
    "DELETE FROM preventive_overrides WHERE profile_id = ? AND rule_key = ?"
  ).run(profileId, ruleKey);
}

// Preventive well-visits and screenings that are due/overdue for the profile
// (reuses the pure catalog assessor with the same age/sex resolution as the
// immunization schedule). A missing birthdate/age → the assessor emits nothing
// (its contract), so this returns []. Each actionable assessment maps to a
// status-driven `visit`/`screening` Upcoming item carrying its rule key for the
// inline mark-done + override forms.
// The profile's full preventive-care assessment (all rules + the due/overdue
// actionable slice), resolving age/sex/satisfactions/overrides/smoking identically
// for every consumer. Shared by the Upcoming builder below AND the proactive
// preventive nudge (lib/notifications/preventive.ts) so the page and the push can
// never diverge on WHICH items are due. Every read is profile-scoped.
//
// MEMOIZED ON BOTH LIFETIMES (#2118). This is not a cheap read — it merges manual and
// inferred satisfactions (medical records, encounters, screening results, optical Rx),
// overrides, smoking history and the whole `getRiskFactors` gather — and it answers a
// question that only changes at the profile-local date rollover, which its own `today`
// argument already names. Every caller in one request or one tick asks it the same
// pair of questions, so it is wrapped in BOTH memos:
//
//   • `cache()` — the request-scoped shim. Redundant today (the /upcoming page's two
//     fan-outs already collapse in `rawUpcoming`'s own cache), kept so a future direct
//     caller inherits the collapse instead of re-deriving it.
//   • `tickCached` — the tick-scoped memo. This is the one that mattered: the nudge
//     planner, the digest's `collectUpcoming` and the reconcile sweep's preventive
//     reconciler — which re-asked ONCE PER LIVE PREVENTIVE-CARRYING POINTER — all ran
//     it inside the same tick, where `cache()` is identity.
//
// Nothing inside a tick writes satisfactions, overrides, smoking history or risk
// inputs (those move through Server Actions and Telegram taps, neither of which runs
// in `tick()`), and the scope closes with the profile — see lib/tick-cache.ts.
export const assessProfilePreventive = cache(
  tickCached(
    "assessProfilePreventive",
    (profileId: number, today: string) => `${profileId}:${today}`,
    assessProfilePreventiveUncached
  )
);

function assessProfilePreventiveUncached(
  profileId: number,
  today: string
): PreventiveSummary {
  return assessCatalog({
    ageMonths: profileAgeMonths(profileId, today),
    sex: getProfileSex(profileId),
    // Manual "mark done" events PLUS inferred satisfactions from existing records
    // (issue #86) PLUS person-confirmed record links (#3025), merged into one
    // stream. All are `(ruleKey, date)`; the assessor takes the most recent per
    // rule, so a manual event is never overwritten — a later real record simply
    // advances the clock, exactly as a later manual event would. Overrides still
    // win (they force not_recommended downstream).
    satisfactions: [
      ...getPreventiveSatisfactions(profileId),
      ...getInferredPreventiveSatisfactions(profileId),
      ...getConfirmedPreventiveRecordSatisfactions(profileId),
    ],
    overrides: getPreventiveOverrides(profileId),
    // Resolve smoking (issue #83): the structured record wins, else the imported
    // social-history condition is the ever-smoker fallback. Activates the lung
    // LDCT / AAA rules that ship inert.
    smoking: resolveSmoking(
      getSmokingHistory(profileId),
      hasImportedSmokingHistory(profileId)
    ),
    // Risk-stratified VISIT cadence (Substrate 3, #707): the SAME per-request
    // getRiskFactors gather the retest/screening/immunization arms use — so a
    // diabetic profile's eye/dental visit comes due sooner (with a cited reason)
    // through the ONE shared assessor, and the Upcoming page + the preventive nudge
    // can never disagree on when a visit is due.
    riskFactors: getRiskFactors(profileId),
    today,
  });
}
