// Preventive care (issue #82). The satisfaction/override stores + the shared
// profile assessment (assessProfilePreventive). assessProfilePreventive is the
// single resolver both the Upcoming builder (its preventiveItems adapter lives
// with the other item builders in ./generators) and the proactive preventive
// nudge (lib/notifications/preventive.ts) share, so the page and the push can
// never diverge on WHICH items are due. Every read here is profile-scoped
// (enforced by lib/__tests__/profile-scoping.test.ts).

import { db } from "../../db";
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
  getUserSex,
  profileAgeMonths,
  getSmokingHistory,
} from "../../settings";
import { resolveSmoking } from "../../smoking";
import { appointmentKindInferenceText } from "../../preventive-appointment";
import { getAppointments } from "../appointments";
import {
  getMedicalRecords,
  getEncounters,
  getCurrentQualitativeResults,
} from "../medical";
import {
  hasImportedSmokingHistory,
  getCarePlanItems,
  getProcedures,
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

// Medical-record categories whose results can satisfy a lab-based screening
// (cholesterol/A1c/glucose labs; blood-pressure vitals). Genomics/scans/
// prescriptions are never screening RESULTS in this sense.
const INFERENCE_RESULT_CATEGORIES = new Set(["lab", "biomarker", "vitals"]);

// INFERRED satisfactions (issue #86): preventive rules a profile's EXISTING
// records already satisfy — a colonoscopy procedure, a lipid/A1c result, a
// completed physical/eye/dental visit or encounter, a completed care-plan item —
// derived deterministically by the pure concept-mapping layer
// (lib/preventive-inference.ts). These feed the SAME `(ruleKey, date)` stream as
// the manual "mark done" events and NEVER touch the stored preventive_events rows;
// the merge happens in-memory in preventiveItems below. Every read here is
// profile-scoped (each getX filters profile_id). Records are routed to the rule
// KINDS their source can legitimately satisfy: procedures/labs → screenings,
// appointments/encounters → visits, completed care-plan items → either.
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

  // Lab / vitals results → lab screenings, by canonical biomarker name (or the
  // raw result name as a fallback synonym match).
  for (const r of getMedicalRecords(profileId)) {
    if (!INFERENCE_RESULT_CATEGORIES.has(r.category)) continue;
    records.push({
      code: null,
      name: r.name,
      canonicalName: r.canonical_name,
      date: r.date,
      allow: ["screening"],
    });
  }

  // Completed appointments → visits (name-matched on the title PLUS the explicit
  // kind's inference text, #997). Folding appointmentKindInferenceText in lets a
  // mental_health visit satisfy the depression/anxiety screenings via the shared
  // stream even when its title is generic — the KIND is the reliable signal.
  for (const a of getAppointments(profileId)) {
    if (!isCompletedStatus(a.status)) continue;
    records.push({
      code: null,
      name:
        [a.title, appointmentKindInferenceText(a.kind)]
          .filter(Boolean)
          .join(" ") || null,
      date: a.scheduled_at.slice(0, 10),
      allow: ["visit"],
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
  for (const e of getEncounters(profileId)) {
    records.push({
      code: null,
      name:
        [e.type, e.reason, e.notes, e.provider_name, e.location_name]
          .filter(Boolean)
          .join(" ") || null,
      date: e.date,
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

  return [...inferPreventiveSatisfactions(records), ...screeningResults];
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
  db.prepare(
    `INSERT INTO preventive_events (profile_id, rule_key, date, source)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, rule_key, date, source) DO NOTHING`
  ).run(profileId, ruleKey, date, source);
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
export function assessProfilePreventive(
  profileId: number,
  today: string
): PreventiveSummary {
  return assessCatalog({
    ageMonths: profileAgeMonths(profileId, today),
    sex: getUserSex(profileId),
    // Manual "mark done" events PLUS inferred satisfactions from existing records
    // (issue #86), merged into one stream. Both are `(ruleKey, date)`; the assessor
    // takes the most recent per rule, so a manual event is never overwritten — a
    // later real record simply advances the clock, exactly as a later manual event
    // would. Overrides still win (they force not_recommended downstream).
    satisfactions: [
      ...getPreventiveSatisfactions(profileId),
      ...getInferredPreventiveSatisfactions(profileId),
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
