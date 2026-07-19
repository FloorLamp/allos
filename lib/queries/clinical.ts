import { db } from "../db";
import { getMedicalRecords } from "./medical";
import {
  isAllergenSpecificIgE,
  allergenFromIgEName,
  isSensitizedIgE,
  rastClassFromValue,
  buildAllergiesView,
  type IgESensitizationInput,
  type AllergyViewItem,
} from "../allergy-ige";
import {
  findCrossReactivity,
  type CrossReactivityMatch,
} from "../allergen-cross-reactivity";
import type {
  Allergy,
  AllergyStatus,
  Condition,
  ConditionStatus,
  FamilyHistory,
  Procedure,
  CarePlanItem,
  CareGoal,
  GenomicVariant,
  ImagingStudy,
  OpticalPrescription,
  DentalProcedure,
  SkinLesion,
} from "../types";

// Read layer for the CCD clinical-list domains — allergies and the problem
// list / conditions. Both tables are profile-owned, so every statement
// filters profile_id. The allergen-specific IgE merge is derived at READ TIME from
// medical_records (no stored duplication) so a lab edit/delete flows straight
// through to the allergies view.

// The profile's recorded allergies, newest/active first. De-duplicated across
// documents via ALLERGY_REPRESENTATIVE_IDS (defined with its clinical-list
// siblings below) — two overlapping CCDs each carrying "Penicillin — hives" would
// otherwise both show and be counted in the "Recorded allergies (N)" manager,
// unlike Conditions/Procedures/Visits which hide theirs (#134/#384). The
// representative subquery's profile_id bind comes after the main WHERE's.
export function getAllergies(profileId: number): Allergy[] {
  return db
    .prepare(
      `SELECT * FROM allergies
       WHERE profile_id = ? AND id IN (${ALLERGY_REPRESENTATIVE_IDS})
       ORDER BY (status = 'active') DESC, substance COLLATE NOCASE ASC, id DESC`
    )
    .all(profileId, profileId) as Allergy[];
}

export function getAllergy(profileId: number, id: number): Allergy | undefined {
  return db
    .prepare("SELECT * FROM allergies WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as Allergy | undefined;
}

// ---- Cross-document read-layer de-duplication (#134, extends #71) ----
//
// Two overlapping CCDs each carry the full clinical history, so the same problem /
// procedure / family-history entry is stored once PER uploaded document (import
// persistence scopes external_id with the document source, so each document keeps
// its own physical row and a per-document delete never orphans another document's
// copy — see lib/import-persist). These CTEs collapse those per-document twins to
// ONE representative at READ TIME on the entry's NATURAL identity, exactly as
// ENCOUNTER_REPRESENTATIVE_IDS (#71) does for visits. Storage / delete are
// untouched; each is the SINGLE source of truth for its collapse, shared by the
// list pages, the Timeline, and Search so every read surface hides the duplicates
// identically. Each takes ONE profile_id bind param.
//
// Representative rule (shared): prefer a MANUAL row (document_id IS NULL — the
// user's own entry) over an imported twin, then the most recent physical row
// (id DESC, a proxy for the newest upload). Identity is CONSERVATIVE — any
// difference in the key leaves rows in separate groups so genuinely distinct
// entries (e.g. type-1 vs type-2 diabetes, coded differently) both stay visible
// and are never silently merged.

// Conditions collapse on the coded identity when present ('code:<code>'), else the
// normalized name ('name:<lower(name)>'). The 'code:'/'name:' prefixes keep the two
// namespaces from ever colliding; NULLIF(TRIM(code),'') makes a blank code fall
// through to the name branch. This COALESCE is the SQL mirror of the pure
// conditionCollapseKey() in lib/icd10.ts (#155) — the ICD-10-CM entry-suggestion that
// fills a code on a previously code-less row strengthens this natural key (code
// equality beats name-string equality across documents from different providers); a
// db-tier test pins that the SQL groups rows exactly as conditionCollapseKey() keys
// them so the two can't drift.
//
// Representative ORDER (#193): an ACTIVE-status row wins the representative slot
// BEFORE the manual-over-imported / newest tiebreakers, so when a same-name twin
// pair (e.g. a resolved 2015 entry + an active 2023 recurrence of the same uncoded
// condition) collapses, the SURVIVING representative is the active one — the
// unfiltered list, Timeline, and Search all show the live problem, and an "active"
// filtered view can never be emptied by a resolved representative hiding an active
// twin.
//
// The status filter (#193, issue option (c)) is injected INTO the inner FROM (via
// `filterStatus`) so the representative is chosen from ONLY the matching-status
// rows: a filtered view then can't be emptied by a representative the filter would
// exclude while a matching twin exists. The optional status bind comes AFTER the
// profile_id bind.
function conditionRepresentativeIds(filterStatus: boolean): string {
  return `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, COALESCE(
        'code:' || NULLIF(TRIM(code), ''),
        'name:' || LOWER(TRIM(name))
      )
      ORDER BY (status = 'active') DESC, (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM conditions WHERE profile_id = ?${filterStatus ? " AND status = ?" : ""}
  ) WHERE rn = 1`;
}

// Unfiltered representative set — shared by the Timeline and Search (one row per
// condition, preferring the active twin). Takes ONE profile_id bind param.
export const CONDITION_REPRESENTATIVE_IDS = conditionRepresentativeIds(false);

// Procedures collapse on (coded-or-named identity, performed date). Two procedures
// with the same name on different dates stay distinct; an undated pair groups
// together (COALESCE(date,'') treats NULLs as equal).
export const PROCEDURE_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id,
        COALESCE('code:' || NULLIF(TRIM(code), ''), 'name:' || LOWER(TRIM(name))),
        COALESCE(date, '')
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM procedures WHERE profile_id = ?
  ) WHERE rn = 1`;

// Family history collapses on (relative, condition), both normalized. An unknown
// relation (NULL) groups with other unknown-relation rows for the same condition.
export const FAMILY_HISTORY_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id,
        'rel:' || LOWER(TRIM(COALESCE(relation, ''))),
        'cond:' || LOWER(TRIM(condition))
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM family_history WHERE profile_id = ?
  ) WHERE rn = 1`;

// Allergies collapse on (substance, reaction, status), all normalized — the same
// entry stored once per uploaded document (two overlapping CCDs each carrying
// "Penicillin — hives") collapses to one representative, while a genuinely
// different reaction or a status change (active vs resolved) stays visible as its
// own row (conservative identity, like its siblings). The 'sub:'/'rxn:'/'st:'
// prefixes keep the three namespaces from colliding. Used by getAllergies (#384).
export const ALLERGY_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id,
        'sub:' || LOWER(TRIM(substance)),
        'rxn:' || LOWER(TRIM(COALESCE(reaction, ''))),
        'st:' || COALESCE(status, '')
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM allergies WHERE profile_id = ?
  ) WHERE rn = 1`;

// Conditions, optionally filtered to a single status (drives the page's
// active/resolved filter). Active first, then most recent onset. De-duplicated
// across documents via the condition-representative subquery (its profile_id bind
// comes after the main WHERE's). When a status is requested, the filter is pushed
// INTO the representative selection (#193) so the representative is picked from only
// the matching-status rows — a resolved same-name twin can't hide an active one, and
// an active-filtered view is never emptied. The status bind (when present) follows
// the subquery's profile_id bind.
export function getConditions(
  profileId: number,
  opts: { status?: ConditionStatus } = {}
): Condition[] {
  const filterStatus = opts.status != null;
  const where = [
    "profile_id = ?",
    `id IN (${conditionRepresentativeIds(filterStatus)})`,
  ];
  const args: (string | number)[] = [profileId, profileId];
  if (opts.status) {
    args.push(opts.status);
  }
  return db
    .prepare(
      `SELECT * FROM conditions WHERE ${where.join(" AND ")}
       ORDER BY (status = 'active') DESC,
                COALESCE(onset_date, '') DESC, name COLLATE NOCASE ASC`
    )
    .all(...args) as Condition[];
}

// Whether the profile has an IMPORTED social-history smoking condition (#188) — the
// "ever smoked, details unknown" FALLBACK for the smoking-history resolver (#83)
// when no structured record has been entered or seeded. The parser only keeps
// tobacco-EXPOSURE statuses ("never smoker" is dropped), so the mere presence of
// such a row means ever-smoked. Profile-scoped; the social-smoking namespace is
// source-prefixed in external_id, hence the leading-% LIKE (mirrors import-persist).
export function hasImportedSmokingHistory(profileId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM conditions
         WHERE profile_id = ? AND external_id LIKE '%ccda:social-smoking:%'
         LIMIT 1`
    )
    .get(profileId);
  return row != null;
}

export function getCondition(
  profileId: number,
  id: number
): Condition | undefined {
  return db
    .prepare("SELECT * FROM conditions WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as Condition | undefined;
}

// Procedures / surgical history, newest performed first. The performing clinician's
// name is joined from the shared providers registry for display. De-duplicated
// across documents via PROCEDURE_REPRESENTATIVE_IDS (the subquery's profile_id bind
// comes after the main WHERE's).
export function getProcedures(profileId: number): Procedure[] {
  return db
    .prepare(
      `SELECT pr.id, pr.name, pr.code, pr.code_system, pr.date,
              pr.provider_id, p.name AS provider_name,
              pr.notes, pr.source, pr.document_id, pr.external_id, pr.created_at
         FROM procedures pr
         LEFT JOIN providers p ON p.id = pr.provider_id
        WHERE pr.profile_id = ? AND pr.id IN (${PROCEDURE_REPRESENTATIVE_IDS})
        ORDER BY COALESCE(pr.date, '') DESC, pr.name COLLATE NOCASE ASC, pr.id DESC`
    )
    .all(profileId, profileId) as Procedure[];
}

// Structured genomic variants (#709), newest report first. Read straight from the
// table — a genomic result is a durable fact (it never goes stale, never nags for
// retest, never flags abnormal), so there is no representative-id dedup here.
// Predictive variants are returned factually; no risk interpretation is derived.
export function getGenomicVariants(profileId: number): GenomicVariant[] {
  return db
    .prepare(
      `SELECT id, gene, variant, genotype, star_allele, zygosity, significance,
              result_type, interpretation, source_lab, report_date, notes,
              source, document_id, external_id, created_at
         FROM genomic_variants
        WHERE profile_id = ?
        ORDER BY COALESCE(report_date, '') DESC, gene COLLATE NOCASE ASC, id DESC`
    )
    .all(profileId) as GenomicVariant[];
}

// Structured imaging studies (#702), newest study first. Read straight from the
// table — a study is a durable narrative fact (it never nags for retest or flags
// abnormal), so there is no representative-id dedup here. `contrast` is stored 0/1
// and surfaced as a boolean. The impression is the radiologist's report body; the
// indication is captured but not gated on (screening-vs-diagnostic is deferred).
export function getImagingStudies(profileId: number): ImagingStudy[] {
  const rows = db
    .prepare(
      `SELECT id, modality, body_region, laterality, contrast, contrast_agent,
              study_date, dose_msv, impression, indication, status,
              ordering_provider_id, reading_provider_id, notes,
              source, document_id, external_id, created_at
         FROM imaging_studies
        WHERE profile_id = ?
        ORDER BY COALESCE(study_date, '') DESC, id DESC`
    )
    .all(profileId) as (Omit<ImagingStudy, "contrast"> & {
    contrast: number;
  })[];
  return rows.map((r) => ({ ...r, contrast: r.contrast === 1 }));
}

// Structured optical prescriptions (#697), newest ISSUED first. Read straight from
// the table — an Rx is a durable dated fact. Per-eye refraction (OD = right, OS =
// left) drives the Vision page's history + sphere-over-time progression view; expiry
// surfaces as plain "expires soon"/"expired" UI text (no findings engine, #697).
export function getOpticalPrescriptions(
  profileId: number
): OpticalPrescription[] {
  return db
    .prepare(
      `SELECT id, kind, od_sphere, od_cylinder, od_axis, od_add,
              os_sphere, os_cylinder, os_axis, os_add, pd,
              base_curve, diameter, brand, issued_date, expiry_date,
              provider_id, notes, source, document_id, external_id, created_at
         FROM optical_prescriptions
        WHERE profile_id = ?
        ORDER BY COALESCE(issued_date, '') DESC, id DESC`
    )
    .all(profileId) as OpticalPrescription[];
}

// The tracked follow-up (issue #700), if any, for each imaging study — so the Imaging
// list can show a study's follow-up state (or offer to track one). Returns one row
// per care_plan_items follow-up linked to an imaging source, newest follow-up first,
// carrying only the fields the list renders. Profile-scoped.
export interface ImagingFollowUpSummary {
  carePlanItemId: number;
  sourceImagingStudyId: number;
  plannedDate: string | null;
  status: string | null;
  resolution: string | null;
}

export function getImagingStudyFollowUps(
  profileId: number
): ImagingFollowUpSummary[] {
  return db
    .prepare(
      `SELECT id AS carePlanItemId,
              source_imaging_study_id AS sourceImagingStudyId,
              planned_date AS plannedDate, status, resolution
         FROM care_plan_items
        WHERE profile_id = ? AND source_kind = 'imaging'
          AND source_imaging_study_id IS NOT NULL
        ORDER BY id DESC`
    )
    .all(profileId) as ImagingFollowUpSummary[];
}

// ---- Dental procedures (issue #705) -----------------------------------------

// All structured dental procedures/findings for a profile, newest first. Like
// imaging_studies, a dental record is a durable narrative fact. Profile-scoped.
export function getDentalProcedures(profileId: number): DentalProcedure[] {
  return db
    .prepare(
      `SELECT id, name, status, tooth, tooth_system, surface, cdt_code,
              procedure_date, finding, follow_up_interval_days, provider_id,
              notes, source, document_id, external_id, created_at
         FROM dental_procedures
        WHERE profile_id = ?
        ORDER BY COALESCE(procedure_date, '') DESC, id DESC`
    )
    .all(profileId) as DentalProcedure[];
}

// The tracked follow-up (issue #700), if any, for each dental record — so the Dental
// list can show a record's follow-up state (or offer to track one). Profile-scoped.
export interface DentalFollowUpSummary {
  carePlanItemId: number;
  sourceDentalProcedureId: number;
  plannedDate: string | null;
  status: string | null;
  resolution: string | null;
}

export function getDentalProcedureFollowUps(
  profileId: number
): DentalFollowUpSummary[] {
  return db
    .prepare(
      `SELECT id AS carePlanItemId,
              source_dental_procedure_id AS sourceDentalProcedureId,
              planned_date AS plannedDate, status, resolution
         FROM care_plan_items
        WHERE profile_id = ? AND source_kind = 'dental'
          AND source_dental_procedure_id IS NOT NULL
        ORDER BY id DESC`
    )
    .all(profileId) as DentalFollowUpSummary[];
}

// ---- Skin lesions (issue #715) ----------------------------------------------

// All structured skin-lesion records for a profile, newest first. Each row is a dated
// observation; the caller groups serial observations of the same lesion by the #482
// identity (lib/skin-lesion.ts). The builder also loads these as the resolution pool.
// Profile-scoped.
export function getSkinLesions(profileId: number): SkinLesion[] {
  return db
    .prepare(
      `SELECT id, label, body_region, body_side, size_mm,
              asymmetry, border, color, diameter, evolving,
              status, observed_date, finding, follow_up_interval_days,
              provider_id, notes, source, document_id, external_id, created_at
         FROM skin_lesions
        WHERE profile_id = ?
        ORDER BY COALESCE(observed_date, '') DESC, id DESC`
    )
    .all(profileId) as SkinLesion[];
}

// The tracked follow-up (issue #700), if any, for each skin-lesion record — so the Skin
// list can show a record's follow-up state (or offer to track one). Profile-scoped.
export interface SkinLesionFollowUpSummary {
  carePlanItemId: number;
  sourceSkinLesionId: number;
  plannedDate: string | null;
  status: string | null;
  resolution: string | null;
}

export function getSkinLesionFollowUps(
  profileId: number
): SkinLesionFollowUpSummary[] {
  return db
    .prepare(
      `SELECT id AS carePlanItemId,
              source_skin_lesion_id AS sourceSkinLesionId,
              planned_date AS plannedDate, status, resolution
         FROM care_plan_items
        WHERE profile_id = ? AND source_kind = 'skin'
          AND source_skin_lesion_id IS NOT NULL
        ORDER BY id DESC`
    )
    .all(profileId) as SkinLesionFollowUpSummary[];
}

// ---- Flagged-labs follow-up chain (issue #700 labs adapter) -----------------

// Every lab reading a labs follow-up could link — its narrow identity/value shape
// (LabFollowUpRecord), the pool the builder loads to resolve both a follow-up's
// SOURCE (by id) and its RESOLVING candidates (a later reading of the same #482
// family). All medical_records rows are returned (family matching in the adapter
// naturally restricts resolution to same-analyte readings, and a prescription/vital
// row simply never matches a lab family); profile-scoped.
export function getLabFollowUpRecords(
  profileId: number
): import("../followup-labs").LabFollowUpRecord[] {
  return db
    .prepare(
      `SELECT id, date, canonical_name, name, value, unit, value_num, flag
         FROM medical_records WHERE profile_id = ?`
    )
    .all(profileId) as import("../followup-labs").LabFollowUpRecord[];
}

// The tracked labs follow-ups (issue #700), each joined to its SOURCE reading so the
// biomarker detail page can show a family's follow-up state (or offer to track one).
// One row per care_plan_items follow-up linked to a medical_records source, newest
// first, carrying the source reading's display name so the caller can group by #482
// family in JS. Profile-scoped (the JOIN carries medical_records' profile_id too).
export interface LabFollowUpSummary {
  carePlanItemId: number;
  sourceRecordId: number;
  sourceName: string;
  plannedDate: string | null;
  status: string | null;
  resolution: string | null;
}

export function getLabFollowUps(profileId: number): LabFollowUpSummary[] {
  return db
    .prepare(
      `SELECT cp.id AS carePlanItemId,
              cp.source_medical_record_id AS sourceRecordId,
              COALESCE(NULLIF(TRIM(mr.canonical_name), ''), mr.name) AS sourceName,
              cp.planned_date AS plannedDate, cp.status, cp.resolution
         FROM care_plan_items cp
         JOIN medical_records mr
           ON mr.id = cp.source_medical_record_id AND mr.profile_id = cp.profile_id
        WHERE cp.profile_id = ? AND cp.source_kind = 'labs'
          AND cp.source_medical_record_id IS NOT NULL
        ORDER BY cp.id DESC`
    )
    .all(profileId) as LabFollowUpSummary[];
}

// Every intraocular-pressure reading an IOP follow-up could link (#698 §6) — the pool
// the builder loads to resolve a follow-up's SOURCE (by id) and its RESOLVING
// candidates (a later repeat pressure, either eye). Filtered to IOP readings by name:
// the canonical entries all contain "intraocular pressure", plus the bare "IOP"
// abbreviation (never a loose "iop" substring, which would catch "biopsy"). Profile-
// scoped. The adapter treats any of these as the same bilateral question.
export function getIopFollowUpRecords(
  profileId: number
): import("../followup-iop").IopFollowUpRecord[] {
  return db
    .prepare(
      `SELECT id, date, canonical_name, name, value, unit, value_num, flag
         FROM medical_records
        WHERE profile_id = ?
          AND (LOWER(COALESCE(canonical_name, name)) LIKE '%intraocular pressure%'
               OR LOWER(COALESCE(canonical_name, name)) IN
                    ('iop', 'iop od', 'iop os', 'iop right eye', 'iop left eye',
                     'iop, right eye', 'iop, left eye'))`
    )
    .all(profileId) as import("../followup-iop").IopFollowUpRecord[];
}

// The tracked IOP follow-ups (#698 §6), the labs mirror for the glaucoma-workup chain.
// One row per source_kind='iop' care_plan_items follow-up joined to its source reading,
// newest first, so the biomarker detail page can show the (single, bilateral) IOP
// follow-up's state or offer to track one. Reuses LabFollowUpSummary (identical shape).
// Profile-scoped (the JOIN carries medical_records' profile_id too).
export function getIopFollowUps(profileId: number): LabFollowUpSummary[] {
  return db
    .prepare(
      `SELECT cp.id AS carePlanItemId,
              cp.source_medical_record_id AS sourceRecordId,
              COALESCE(NULLIF(TRIM(mr.canonical_name), ''), mr.name) AS sourceName,
              cp.planned_date AS plannedDate, cp.status, cp.resolution
         FROM care_plan_items cp
         JOIN medical_records mr
           ON mr.id = cp.source_medical_record_id AND mr.profile_id = cp.profile_id
        WHERE cp.profile_id = ? AND cp.source_kind = 'iop'
          AND cp.source_medical_record_id IS NOT NULL
        ORDER BY cp.id DESC`
    )
    .all(profileId) as LabFollowUpSummary[];
}

// Family history, grouped by relative (relation) then condition. Rows with an
// unknown relation sort last. De-duplicated across documents via
// FAMILY_HISTORY_REPRESENTATIVE_IDS (the subquery's profile_id bind comes after the
// main WHERE's).
export function getFamilyHistory(profileId: number): FamilyHistory[] {
  return db
    .prepare(
      `SELECT * FROM family_history
        WHERE profile_id = ? AND id IN (${FAMILY_HISTORY_REPRESENTATIVE_IDS})
        ORDER BY (relation IS NULL) ASC, relation COLLATE NOCASE ASC,
                 condition COLLATE NOCASE ASC, id DESC`
    )
    .all(profileId, profileId) as FamilyHistory[];
}

// Care plan items — planned / ordered future care, soonest planned date first
// (undated last). The ordering clinician's name is joined from the shared providers
// registry for display. NB: distinct from the user's own fitness `goals`.
export function getCarePlanItems(profileId: number): CarePlanItem[] {
  return db
    .prepare(
      `SELECT cp.id, cp.description, cp.code, cp.code_system, cp.category,
              cp.planned_date, cp.status, cp.provider_id, p.name AS provider_name,
              cp.notes, cp.source, cp.document_id, cp.external_id, cp.created_at,
              cp.source_kind, cp.source_imaging_study_id,
              cp.source_medical_record_id, cp.source_dental_procedure_id,
              cp.source_skin_lesion_id,
              cp.recommended_interval_days, cp.resolution,
              cp.resolved_by_imaging_study_id,
              cp.resolved_by_medical_record_id,
              cp.resolved_by_dental_procedure_id,
              cp.resolved_by_skin_lesion_id, cp.resolved_at
         FROM care_plan_items cp
         LEFT JOIN providers p ON p.id = cp.provider_id
        WHERE cp.profile_id = ?
        ORDER BY (cp.planned_date IS NULL) ASC, cp.planned_date ASC,
                 cp.description COLLATE NOCASE ASC, cp.id DESC`
    )
    .all(profileId) as CarePlanItem[];
}

// Care goals — clinical targets from the record, soonest target date first
// (undated last). NB: DISTINCT from the `goals` table (the user's own fitness/body
// goals) — these are imported clinical goals.
export function getCareGoals(profileId: number): CareGoal[] {
  return db
    .prepare(
      `SELECT * FROM care_goals WHERE profile_id = ?
        ORDER BY (target_date IS NULL) ASC, target_date ASC,
                 description COLLATE NOCASE ASC, id DESC`
    )
    .all(profileId) as CareGoal[];
}

// Derive the positive allergen-specific IgE sensitizations from the profile's
// current lab/biomarker readings (RAST / ImmunoCAP). Total serum IgE is excluded;
// only above-range / class≥1 results become sensitizations. Read-time only.
export function getAllergenSensitizations(
  profileId: number
): IgESensitizationInput[] {
  const rows = getMedicalRecords(profileId, { current: true });
  const out: IgESensitizationInput[] = [];
  for (const r of rows) {
    const name = r.canonical_name?.trim() || r.name;
    if (!isAllergenSpecificIgE(name)) continue;
    if (
      !isSensitizedIgE({ flag: r.flag, value: r.value, valueNum: r.value_num })
    )
      continue;
    const allergen = allergenFromIgEName(name);
    if (!allergen) continue;
    out.push({
      allergen,
      marker: name,
      value: r.value,
      valueNum: r.value_num,
      unit: r.unit,
      rastClass: rastClassFromValue(r.value, r.value_num),
      flag: r.flag,
      date: r.date,
    });
  }
  return out;
}

// The merged allergies view: documented allergies + lab-derived IgE sensitizations,
// deduped by allergen. Shared by the Allergies page and the profile passport.
export function getAllergiesView(profileId: number): AllergyViewItem[] {
  const stored = getAllergies(profileId)
    .filter((a) => a.status !== "resolved")
    .map((a) => ({
      id: a.id,
      substance: a.substance,
      reaction: a.reaction,
      severity: a.severity,
      status: a.status as AllergyStatus,
      onsetDate: a.onset_date,
      source: a.source,
      documentId: a.document_id,
    }));
  return buildAllergiesView(stored, getAllergenSensitizations(profileId));
}

// Informational allergen cross-reactivity notes derived from the merged allergies
// view (documented allergies + lab-derived IgE sensitizations). Pure matcher over
// a curated dataset (lib/allergen-cross-reactivity) — the ONE computation shared
// by the Allergies page and the profile passport (one-question-one-computation).
export function getCrossReactivityNotes(
  profileId: number
): CrossReactivityMatch[] {
  const substances = getAllergiesView(profileId).map((a) => a.substance);
  return findCrossReactivity(substances);
}
