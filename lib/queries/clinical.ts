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

// Read layer for the CCD clinical-list domains — allergies and the problem
// list / conditions. Both tables are profile-owned, so every statement
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
