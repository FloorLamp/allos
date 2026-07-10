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
import type {
  Allergy,
  AllergyStatus,
  Condition,
  ConditionStatus,
  FamilyHistory,
  Procedure,
  CarePlanItem,
  CareGoal,
} from "../types";

// Read layer for the CCD clinical-list domains — allergies (#179) and the problem
// list / conditions (#180). Both tables are profile-owned, so every statement
// filters profile_id. The allergen-specific IgE merge is derived at READ TIME from
// medical_records (no stored duplication) so a lab edit/delete flows straight
// through to the allergies view.

export function getAllergies(profileId: number): Allergy[] {
  return db
    .prepare(
      `SELECT * FROM allergies WHERE profile_id = ?
       ORDER BY (status = 'active') DESC, substance COLLATE NOCASE ASC, id DESC`
    )
    .all(profileId) as Allergy[];
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
// through to the name branch.
export const CONDITION_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, COALESCE(
        'code:' || NULLIF(TRIM(code), ''),
        'name:' || LOWER(TRIM(name))
      )
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM conditions WHERE profile_id = ?
  ) WHERE rn = 1`;

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

// Conditions, optionally filtered to a single status (drives the page's
// active/resolved filter). Active first, then most recent onset. De-duplicated
// across documents via CONDITION_REPRESENTATIVE_IDS (its profile_id bind comes
// after the main WHERE's). The status filter applies to the surviving
// representative, so a condition shows once with its representative's status.
export function getConditions(
  profileId: number,
  opts: { status?: ConditionStatus } = {}
): Condition[] {
  const where = ["profile_id = ?", `id IN (${CONDITION_REPRESENTATIVE_IDS})`];
  const args: (string | number)[] = [profileId, profileId];
  if (opts.status) {
    where.push("status = ?");
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
              cp.notes, cp.source, cp.document_id, cp.external_id, cp.created_at
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
