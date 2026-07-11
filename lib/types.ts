export type ActivityType = "strength" | "cardio" | "sport";

export interface Activity {
  id: number;
  date: string;
  type: ActivityType;
  title: string;
  notes: string | null;
  duration_min: number | null;
  distance_km: number | null;
  intensity: string | null;
  start_time: string | null;
  end_time: string | null;
  components: string | null; // JSON ActivityComponent[]
  created_at: string;
  // Last-edited timestamp (issue #11); NULL until the row is first updated. Same
  // UTC datetime form as created_at.
  updated_at: string | null;
  // Integration provenance + idempotent dedup key. NULL for manual entries; set
  // for imported rows (e.g. source 'health-connect', external_id 'health-connect:<start>').
  source: string | null;
  external_id: string | null;
  // 1 when a source-owned (imported) row has been hand-edited; 0/NULL otherwise.
  edited: number | null;
  // Richer per-activity metrics from pull integrations (Strava). All nullable:
  // NULL for manual entries / providers that don't supply them. Power, cadence,
  // and kilojoules are populated for cycling only; avg_temp_c for any outdoor
  // activity; workout_type is a label ('race' | 'long run' | 'workout').
  avg_hr: number | null;
  max_hr: number | null;
  elevation_m: number | null;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  relative_effort: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null;
  avg_cadence: number | null;
  avg_temp_c: number | null;
  kilojoules: number | null;
  workout_type: string | null;
  // ESTIMATED calorie burn for a MANUAL activity (issue #151): the auto-value the
  // activity form fills from the MET dataset × nearest bodyweight × duration, or the
  // user's manual override of it. NULL for legacy/seed rows and every imported row —
  // device energy lives in metric_samples (active_kcal), never here, so an estimate
  // can't shadow a measured value. Distinct from `kilojoules` (Strava mechanical
  // work). See lib/calorie-estimate.ts.
  est_calories: number | null;
  // The piece of gear the whole SESSION was performed with (Equipment.id), or NULL
  // (issue #342). Session-level — a ride's bike, a run's shoes, a sauna session's
  // sauna — distinct from the per-set implement link (exercise_sets.equipment_id),
  // which stays for strength. deleteEquipment nulls this so a removed row's history
  // survives; the FK is enforced (migration 019).
  equipment_id: number | null;
}

// A single component of a (possibly multi-type) activity. Strength components
// carry their sets in exercise_sets (keyed by name); others carry distance/duration.
export interface ActivityComponent {
  name: string;
  type: ActivityType;
  distance_km: number | null;
  duration_min: number | null;
}

// Parse an activity's stored `components` JSON into a components array. Centralizes
// the try/catch + array-guard that was open-coded at every read site (the journal
// feed, the editor seed, the validator, the icon resolver, the goal/effort queries).
// Absent (null/empty), malformed, or non-array JSON all yield [] — a caller that
// must distinguish "no components list at all" from "an empty list" checks the raw
// string's presence itself (`raw ? parseComponents(raw) : null`), since a valid
// stored "[]" and a malformed blob both parse to []. The elements are trusted to be
// ActivityComponent-shaped (we only ever write JSON.stringify(ActivityComponent[])).
export function parseComponents(
  json: string | null | undefined
): ActivityComponent[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ActivityComponent[]) : [];
  } catch {
    return [];
  }
}

export interface ExerciseSet {
  id: number;
  activity_id: number;
  exercise: string;
  set_number: number;
  weight_kg: number | null;
  reps: number | null;
  // Right-side load for per-side (asymmetric) unilateral sets. NULL for normal
  // bilateral sets; when present, weight_kg/reps are the left side.
  weight_kg_right: number | null;
  reps_right: number | null;
  // Hold time (seconds) for timed exercises (planks, dead hangs); NULL for
  // rep-based sets. *_right is the right side of a per-side timed hold.
  duration_sec: number | null;
  duration_sec_right: number | null;
  // Declared intent for rep-based sets: the planned rep count, or "to failure"
  // (AMRAP, 1 = true). NULL when no intent was declared.
  target_reps: number | null;
  to_failure: number | null;
  // The user-defined implement this set was performed with (Equipment.id), or
  // NULL when no specific implement is recorded. Informational: stored weight_kg
  // is always the TOTAL load regardless of the implement.
  equipment_id: number | null;
}

// A user-defined piece of equipment (a custom bar/implement). `weight_kg` is the
// implement's own weight (kg, nullable), kept for reference only — logged set
// weights are always the TOTAL load, so the bar weight is never added in.
export interface Equipment {
  id: number;
  name: string;
  weight_kg: number | null;
  category: string | null;
  // Soft-retire flag (0/1), mirroring intake_item_doses.retired: a retired row is
  // hidden from pickers/recency-defaulting but keeps labelling historical sets
  // (see lib/equipment.ts). Sold/broken gear is retired, not deleted, so "which bar
  // did I PR on" survives. Hard delete stays available for genuine mistakes.
  retired: number;
  created_at: string;
}

// Equipment types — ONE deliberate, fixed set (issue #341), enforced by a DB CHECK
// on equipment.category (migration 018) so the TS union and the DB constraint can't
// drift (parity pinned in lib/__db_tests__/enum-parity.test.ts). Grouped by kind via
// kindOf() below: strength, cardio, recovery, other. Only "Barbell" enables the
// plate builder (isBarbell). NULL is a legal stored value (category unknown).
export const EQUIPMENT_CATEGORIES = [
  "Barbell",
  "Dumbbell",
  "Kettlebell",
  "Machine",
  "Bike",
  "Shoes",
  "Sauna",
  "Cold plunge",
  "Red light",
  "Massage device",
  "Other",
] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

// The functional grouping a category belongs to. Lets pickers filter by context
// (a strength log offers strength implements; #345's recommendations reason over
// recovery gear) without hard-coding category lists at each call site.
export type EquipmentKind = "strength" | "cardio" | "recovery" | "other";

const EQUIPMENT_KIND: Record<EquipmentCategory, EquipmentKind> = {
  Barbell: "strength",
  Dumbbell: "strength",
  Kettlebell: "strength",
  Machine: "strength",
  Bike: "cardio",
  Shoes: "cardio",
  Sauna: "recovery",
  "Cold plunge": "recovery",
  "Red light": "recovery",
  "Massage device": "recovery",
  Other: "other",
};

// The kind of an equipment category (case-insensitive). An unknown/NULL category
// reads as "other" — the safe default for legacy or unclassified rows.
export function kindOf(category: string | null | undefined): EquipmentKind {
  const c = (category ?? "").trim().toLowerCase();
  const match = EQUIPMENT_CATEGORIES.find((x) => x.toLowerCase() === c);
  return match ? EQUIPMENT_KIND[match] : "other";
}

// Whether an equipment row is a barbell (case-insensitive); gates plate builder.
export function isBarbell(category: string | null | undefined): boolean {
  return (category ?? "").trim().toLowerCase() === "barbell";
}

// One dated body-metrics row (table: body_metrics). weight_kg is nullable
// so a row can carry only body fat and/or resting HR (a vitals panel or wearable
// with no scale weight). Distinct from BodyMetricKind below, which names *which*
// metric a value is (weight / body_fat / resting_hr).
export interface BodyMetric {
  id: number;
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
  notes: string | null;
  // Integration provenance: NULL for manual entries, set (e.g. 'health-connect')
  // for imported rows so ingest can keep at most one imported row per day.
  // Rows imported from an uploaded medical document use 'document:<id>'.
  source: string | null;
}

// A body-metrics row with its provenance resolved for display: document-sourced
// rows carry the document's id (for linking) and a human label (its lab/provider,
// doc type, or filename); integration ids resolve to the integration's display
// name; manual rows label as "Manual".
export interface BodyMetricWithSource extends BodyMetric {
  source_label: string;
  document_id: number | null;
}

// Achievement state. Archiving is a separate flag (Goal.archived) so an achieved
// goal stays achieved when filed away. The runtime array is the single source of
// truth for the union AND the goals.status CHECK (migration 016); the enum-parity
// DB test (lib/__db_tests__/enum-parity.test.ts) fails if the two drift.
export const GOAL_STATUSES = ["active", "achieved"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// Exercise-linked goals measure one of these; progress is auto-derived from sets.
export type GoalMetric = "weight" | "reps" | "sets" | "hold";
// Which body metric a body goal targets (and the metric-kind selector shared by
// getLatestBodyMetric and the document-import classifier in body-metric-extract).
export type BodyMetricKind = "weight" | "body_fat" | "resting_hr";

export interface Goal {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  target_date: string | null;
  status: GoalStatus;
  created_at: string;
  // Exercise-linked goal fields (all null for freeform goals). A goal is
  // exercise-linked when `exercise` and `metric` are both set.
  exercise: string | null;
  metric: GoalMetric | null;
  target_weight_kg: number | null;
  target_reps: number | null;
  target_sets: number | null;
  target_duration_sec: number | null;
  // Body-metric goal fields (null otherwise). A goal is body-linked when
  // `body_metric` is set; progress runs baseline_value → target_value.
  body_metric: BodyMetricKind | null;
  baseline_value: number | null;
  // Filed away (0/1). Independent of status, so achieved goals stay achieved.
  archived: number;
}

export type FrequencyScopeKind = "region" | "group" | "type";

// A user-defined "hit X at least N times/week" target.
export interface FrequencyTarget {
  id: number;
  scope_kind: FrequencyScopeKind;
  scope_value: string;
  per_week: number;
  created_at: string;
}

// A healthcare provider or organization. GLOBAL — shared across the
// whole family/instance (a family sees one "Quest Diagnostics" / "Dr. Smith"),
// modeled like logins/profiles, so it is intentionally NOT profile-scoped. Records
// link to it via a nullable provider_id FK on their profile-owned row. `type`
// discriminates an organization from an individual clinician.
export type ProviderType = "organization" | "individual";

export interface Provider {
  id: number;
  name: string;
  type: ProviderType;
  // National Provider Identifier (US), when the source carried one — authoritative
  // for global dedup. `identifier` holds any other stable id (org/EMR id). Both
  // nullable; phone/address are captured from the CCD when present.
  npi: string | null;
  identifier: string | null;
  phone: string | null;
  address: string | null;
  created_at: string;
}

// A scheduled medical visit. Profile-owned; optionally
// linked to the shared providers registry via a nullable provider_id FK.
// `scheduled_at` is a date (YYYY-MM-DD) or datetime; `status` drives whether it
// still surfaces on the Upcoming page (only 'scheduled' does). Runtime array is the
// single source for the union AND the appointments.status CHECK (enum-parity test).
export const APPOINTMENT_STATUSES = [
  "scheduled",
  "completed",
  "cancelled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// Optional visit category (issue #85). NULL on existing rows and whenever the user
// leaves it blank — a NULL kind never matches a preventive rule (no fuzzy title
// guessing). The values map to preventive-care rules in lib/preventive-appointment.ts,
// which powers the prefilled "Book" CTA, the scheduled-visit suppression, and the
// close-the-loop satisfaction on completion.
export type AppointmentKind =
  "well_child" | "physical" | "dental" | "vision" | "screening" | "other";

export interface Appointment {
  id: number;
  profile_id: number;
  scheduled_at: string;
  provider_id: number | null;
  // Joined display name of the linked provider (from the global registry), null
  // when unlinked. Populated by getAppointments, not a stored column.
  provider_name: string | null;
  title: string | null;
  location: string | null;
  notes: string | null;
  status: AppointmentStatus;
  // Optional visit category (well_child | physical | dental | vision | screening |
  // other), or null when unset. See AppointmentKind above.
  kind: AppointmentKind | null;
  created_at: string;
}

export type MedicalCategory =
  "vitals" | "lab" | "genomics" | "biomarker" | "scan" | "prescription";

// "non-optimal" is the legacy directionless value (older rows, pre-migration);
// new derivations use the directional "-high"/"-low" variants so the UI can show
// an up/down arrow. All three are treated as non-optimal by isNonOptimal().
export type MedicalFlag =
  | "normal"
  | "high"
  | "low"
  | "abnormal"
  | "non-optimal"
  | "non-optimal-high"
  | "non-optimal-low";

export interface MedicalRecord {
  id: number;
  date: string;
  category: MedicalCategory;
  name: string;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  notes: string | null;
  created_at: string;
  // Populated when the row came from an uploaded document (see MedicalDocument).
  document_id: number | null;
  panel: string | null;
  flag: MedicalFlag | null;
  value_num: number | null;
  // A clean, consistent biomarker name used to group readings of the same
  // analyte across documents/labs. Assigned by the AI at extraction/backfill,
  // editable per record; falls back to `name` when absent.
  canonical_name: string | null;
  // 1 when this is the most recent reading in its biomarker group; only set by
  // queries that select it (e.g. the biomarkers table). Absent otherwise.
  is_latest?: number;
  // The performing provider/organization. provider_id links the
  // shared GLOBAL registry; provider_name is joined for display. NULL/absent when
  // unlinked.
  provider_id: number | null;
  provider_name?: string | null;
  // Set on VIRTUAL records computed at read time from other readings (issue #40 —
  // derived clinical indices like Non-HDL, HOMA-IR, eGFR). These are never stored:
  // they carry a synthetic negative `id`, no `document_id`, and are read-only in the
  // UI. `derived_formula` is the human formula with the component values substituted
  // (shown as the "derived" tooltip/subtitle). Absent on real stored rows.
  derived?: boolean;
  derived_formula?: string;
}

// "higher is better", "lower is better", or "best inside a range" — governs how
// a value is judged against its optimal band (one-sided optima honor this).
export type BiomarkerDirection = "higher_better" | "lower_better" | "in_range";

// An entry in the committed canonical biomarker reference dataset
// (lib/canonical-biomarkers.json), seeded into the canonical_biomarkers table.
// Ranges are informational, not medical advice, and may vary by sex/age.
export type Sex = "male" | "female";

// A profile's reproductive (menopausal) status — a CURRENT attribute of the
// tracked person (no history is modeled, so it applies to ALL of that profile's
// hormone records, the same simplification as the stored-age fallback). Drives
// sex- and life-stage-aware hormone ranges for FEMALE physiology: when set it takes
// precedence over the age proxy (e.g. the FSH 51+ age band), so a genuinely
// post-menopausal HIGH estradiol/FSH/LH flags while a still-cycling woman at 51+
// isn't false-flagged. Unset (null) = not specified → today's age-proxy behavior.
export type ReproductiveStatus = "premenopausal" | "postmenopausal";

// One female-physiology reference range keyed by reproductive status — parallel to
// AgeBandedRange but selected by menopausal status, not age. ref_low null = open.
export interface ReproductiveStatusRange {
  ref_low: number | null;
  ref_high: number | null;
  note?: string | null;
}

// Reproductive-status reference overrides for an analyte (Estradiol/FSH/LH). A
// partial map: only the statuses with a curated range are present. Applies to
// FEMALE physiology only — male ranges are entirely unaffected. Highest precedence
// in referenceRange (above the age band) when the subject's sex is female and their
// reproductive status is set. Stored as JSON in canonical_biomarkers.
export type ReproductiveStatusRanges = Partial<
  Record<ReproductiveStatus, ReproductiveStatusRange>
>;

// An age-banded reference/optimal range for a biomarker whose normal values shift
// with age (the pediatric/geriatric case — e.g. ALP and resting heart rate in
// children). Ages are WHOLE YEARS (matching ageFromBirthdate) and the band is
// half-open [min_age, max_age): a value at exactly max_age falls into the next
// band. `max_age` null means the band is open-ended at the top. The range fields
// mirror the adult top-level shape, so the same sex-override resolution applies
// within a band; any field left null means "no bound" (as with the adult fields).
export interface AgeBandedRange {
  min_age: number; // inclusive, whole years
  max_age: number | null; // exclusive; null = open-ended upper bound
  ref_low: number | null;
  ref_high: number | null;
  ref_low_male?: number | null;
  ref_high_male?: number | null;
  ref_low_female?: number | null;
  ref_high_female?: number | null;
  optimal_low?: number | null;
  optimal_high?: number | null;
  optimal_low_male?: number | null;
  optimal_high_male?: number | null;
  optimal_low_female?: number | null;
  optimal_high_female?: number | null;
  note?: string | null;
}

export interface CanonicalBiomarker {
  name: string;
  category: string | null;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  // Sex-specific reference-range overrides. When set for the user's sex they take
  // precedence over the generic ref_low/high (the fallback when sex is unknown).
  // Used for analytes whose normal range differs by sex (e.g. testosterone, CBC).
  ref_low_male: number | null;
  ref_high_male: number | null;
  ref_low_female: number | null;
  ref_high_female: number | null;
  optimal_low: number | null;
  optimal_high: number | null;
  // Sex-specific optimal overrides. When set for the user's sex they take
  // precedence over the generic optimal_low/high (which remains the fallback
  // when the user's sex is unknown or no override exists).
  optimal_low_male: number | null;
  optimal_high_male: number | null;
  optimal_low_female: number | null;
  optimal_high_female: number | null;
  direction: BiomarkerDirection | null;
  // Age-banded overrides for analytes whose normal range shifts with age. When a
  // band matches the data subject's age at the record's collection date, it
  // replaces the adult top-level fields (sex overrides then resolve within the
  // band); absent or no-match falls back to the adult fields. Stored as a JSON
  // array in the canonical_biomarkers table.
  ranges_by_age: AgeBandedRange[] | null;
  // Reproductive-status reference overrides (female physiology only). When the
  // subject's sex is female and their reproductive_status is set and this map has a
  // range for that status, it REPLACES all other ranges (above the age band) — see
  // lib/reference-range.selectStatusRange. NULL when the analyte isn't hormone-like.
  // Stored as a JSON object in the canonical_biomarkers table.
  ranges_by_status: ReproductiveStatusRanges | null;
  // Recommended retest cadence, in days, for the Upcoming retest signal. NULL
  // falls back to the flat DEFAULT_RETEST_DAYS (365) — see lib/reference-range.
  // Curated per-analyte in scripts/gen-canonical-biomarkers (RETEST_DAYS) so e.g.
  // an HbA1c retests quarterly while a lipid panel is annual. NOT a flag input
  // (deliberately absent from FLAG_RELEVANT_FIELDS), so editing it never triggers
  // a flag re-derivation. Carried in the committed JSON; the retest signal reads
  // it from there (lib/biomarker-retest), not from the canonical_biomarkers table.
  retest_days?: number | null;
  note: string | null;
  source: string; // 'seed' | 'ai'
  created_at: string;
}

// A recorded vaccine administration. `vaccine` is a catalog/combo code from
// lib/immunization-catalog (or a slug fallback for an unrecognized name). A
// combination shot (e.g. Vaxelis) is one row under the combo code; the status
// engine expands it to its component series. `source` mirrors the medical
// provenance convention: NULL for manual entries, 'document:<id>' for rows
// projected from an uploaded immunization record.
export interface Immunization {
  id: number;
  date: string;
  vaccine: string;
  dose_label: string | null;
  notes: string | null;
  source: string | null;
  // Idempotent dedup key for synced rows (integration / SMART Health Card);
  // NULL for manual and document-extracted rows.
  external_id: string | null;
  created_at: string;
  // The administering provider/organization. provider_id links the
  // shared GLOBAL registry; provider_name is joined for display.
  provider_id: number | null;
  provider_name?: string | null;
}

// ---- Allergies & conditions (CCD clinical lists) ----

// Clinical status of an allergy/intolerance. `active` is the default for a
// documented allergy; `inactive`/`resolved` come from the source's concern-act
// or clinical-status observation. Runtime array is the single source for the union
// AND the allergies.status CHECK (enum-parity test).
export const ALLERGY_STATUSES = ["active", "inactive", "resolved"] as const;
export type AllergyStatus = (typeof ALLERGY_STATUSES)[number];

// A recorded allergy / intolerance (table: allergies). `substance` is the
// offending agent (drug/food/environmental) — a name, ideally with a code when
// the source carried one. reaction/manifestation and severity are free text as
// printed. `source` mirrors the medical provenance convention: NULL for manual
// entries, 'document:<id>' for rows projected from an uploaded record; external_id
// is the stable per-document dedup key.
export interface Allergy {
  id: number;
  onset_date: string | null; // onset date (YYYY-MM-DD) when known
  substance: string;
  substance_code: string | null;
  substance_code_system: string | null;
  reaction: string | null;
  severity: string | null; // mild/moderate/severe when coded, else free text
  status: AllergyStatus;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// Clinical status of a problem-list condition. Runtime array is the single source
// for the union AND the conditions.status CHECK (enum-parity test).
export const CONDITION_STATUSES = ["active", "inactive", "resolved"] as const;
export type ConditionStatus = (typeof CONDITION_STATUSES)[number];

// A problem-list condition / diagnosis (table: conditions). `name` is the display
// term, `code`/`code_system` the coded identity (ICD-10 / SNOMED) when present.
export interface Condition {
  id: number;
  name: string;
  code: string | null;
  code_system: string | null;
  status: ConditionStatus;
  onset_date: string | null;
  resolved_date: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A visit / encounter (table: encounters). `type` is the
// display ("Office Visit"), `class_code` the HL7 ActEncounterCode (AMB/IMP/…),
// `reason` the chief complaint, `diagnoses` a '; '-joined summary of the visit
// diagnoses. provider_id / location_provider_id link the shared providers registry
// (attending clinician + facility); the joined names are surfaced for display.
export interface Encounter {
  id: number;
  date: string;
  end_date: string | null;
  type: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string | null;
  provider_id: number | null;
  provider_name: string | null;
  location_provider_id: number | null;
  location_name: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A procedure / surgical-history entry (table: procedures). `name` is the display
// term, `code`/`code_system` the coded identity (CPT / SNOMED / ICD-10-PCS) when
// present, `date` the performed date. provider_id links the shared providers
// registry (the performing clinician); the joined name is surfaced for display.
// Provenance/dedup mirror the conditions table.
export interface Procedure {
  id: number;
  name: string;
  code: string | null;
  code_system: string | null;
  date: string | null;
  provider_id: number | null;
  provider_name: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A family-history entry (table: family_history): one condition affecting one
// relative. `relation` is the affected relative (mother/father/sibling/…);
// `condition` the display term for their diagnosis; `code`/`code_system` its coded
// identity when present. `onset_age` is the relative's age (years) at onset when
// known; `deceased` is 1/0 (null when unknown). Provenance/dedup mirror conditions.
export interface FamilyHistory {
  id: number;
  relation: string | null;
  condition: string;
  code: string | null;
  code_system: string | null;
  onset_age: number | null;
  deceased: number | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A care-plan item (table: care_plan_items): a single planned / ordered future
// care activity pulled from a health record's Plan of Treatment / Care Plan
// section, or entered manually. `description` is the display term; `code`/
// `code_system` its coded identity when present; `category` classifies the planned
// activity (procedure / encounter / medication / observation / …); `planned_date`
// is when it's scheduled/intended; `status` its lifecycle (planned / active / …).
// provider_id links the shared providers registry (the ordering/responsible
// clinician). Provenance/dedup mirror the procedures table. NB: distinct from the
// user's own fitness `goals` — these are imported CLINICAL plans/goals.
export interface CarePlanItem {
  id: number;
  description: string;
  code: string | null;
  code_system: string | null;
  category: string | null;
  planned_date: string | null;
  // FREE-FORM BY DESIGN — deliberately bare TEXT with no DB CHECK (issue #328): the
  // importers pass FHIR CarePlan.activity status codes through verbatim, and the app
  // form takes a free-text clinical status. The only app-WRITTEN sentinel is
  // 'completed' (setCarePlanItemDone, lib/queries/upcoming.ts); every other value is
  // clinical passthrough. A closed enum here would drop or mangle real record data.
  status: string | null;
  provider_id: number | null;
  provider_name: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A care goal (table: care_goals): a clinical target from a health record's Goals
// section, or entered manually. `description` is the goal statement; `code`/
// `code_system` its coded identity when present; `target_date` when it's aimed to
// be met; `status` its lifecycle (proposed / active / achieved / …). Provenance/
// dedup mirror the conditions table. NB: this is DISTINCT from the `goals` table
// (the user's own fitness/body goals) — care_goals are imported clinical goals.
export interface CareGoal {
  id: number;
  description: string;
  code: string | null;
  code_system: string | null;
  target_date: string | null;
  // FREE-FORM BY DESIGN — deliberately bare TEXT with no DB CHECK (issue #328): the
  // importers pass FHIR Goal.lifecycleStatus / achievementStatus codes through
  // verbatim (proposed / active / achieved / …), and the app form takes a free-text
  // clinical status. There is no app-written sentinel. A closed enum here would drop
  // or mangle real record data.
  status: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

export type ExtractionStatus =
  "pending" | "processing" | "done" | "failed" | "skipped";

export interface MedicalDocument {
  id: number;
  filename: string;
  stored_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string | null;
  source: string | null;
  document_date: string | null;
  patient_name: string | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  extracted_count: number;
  raw_extraction: string | null;
  model: string | null;
  content_hash: string | null;
  // The import DEBUGGER report as JSON: dropped candidates +
  // section/resource coverage. NULL for AI-extracted docs or pre-feature rows.
  import_report: string | null;
  uploaded_at: string;
}

// How a supplement's day-context is decided: every day; only on
// workout/rest days (from the journal); or only while a named situation
// (e.g. "Illness") is active.
export type SupplementCondition =
  "daily" | "pre_workout" | "post_workout" | "rest_day" | "situational";

// Importance band. `mandatory` is reserved for lab-confirmed deficiencies
// (normally set by the AI engine); `high`/`low` are user-managed.
export type SupplementPriority = "mandatory" | "high" | "low";

// How a dose relates to food. A property of the substance (fat-soluble vitamins
// need dietary fat; plant sterols go before a meal; some must be on an empty
// stomach), defaulted from the catalog and editable per dose.
export type FoodTiming =
  "any" | "with_food" | "with_fat" | "before_meal" | "empty_stomach";

export interface Supplement {
  id: number;
  name: string;
  notes: string | null;
  active: number;
  created_at: string;
  condition: SupplementCondition;
  priority: SupplementPriority;
  brand: string | null; // manufacturer, e.g. "Thorne" (free text)
  product: string | null; // specific product/SKU (free text)
  situation: string | null; // label when condition = 'situational'
  // Optional "stack" label grouping supplements taken together (e.g. "D3 + K2");
  // members render adjacently in their time bucket. Free text.
  stack: string | null;
  // Missed-dose escalation. critical=1 opts this
  // (medication) into a follow-up nudge when a sent dose reminder goes
  // unconfirmed; escalate_after_min is the wait after the slot's reminder
  // (null → a sensible default); escalate_chat_id optionally routes the
  // escalation to a second chat (e.g. a caregiver) instead of the profile's own.
  critical: number;
  escalate_after_min: number | null;
  escalate_chat_id: string | null;
  // Refill tracking. quantity_on_hand is the units left
  // (NULL = not tracked); qty_per_dose is units consumed per confirmed dose
  // (defaults to 1). Decremented on the "taken" path; drives "≈N days left".
  quantity_on_hand: number | null;
  qty_per_dose: number;
  // Medication identity. kind splits medications from
  // supplements (shared table/machinery); prescriber/pharmacy/rx_number are
  // medication-only free text; as_needed (0/1) marks a PRN med that generates no
  // scheduled reminders/escalation/adherence-due (an as-needed med is never
  // "missed"). Dose strength (mg/IU) reuses the existing dose `amount`.
  kind: SupplementKind;
  prescriber: string | null;
  pharmacy: string | null;
  rx_number: string | null;
  as_needed: number;
  // Cached RxNorm concept id (RxCUI) for this item's name (issue #144), resolved
  // via NLM's approximateTerm API and user-confirmed on the edit form; NULL when
  // never resolved (the interaction matcher then falls back to name matching).
  rxcui: string | null;
  // Cached ACTIVE-INGREDIENT RxCUIs for the confirmed rxcui (issue #279): a JSON
  // array of code strings resolved via RxNav `/rxcui/{id}/related?tty=IN` at
  // confirm time. A combination product's single product-level rxcui never appears
  // in the ingredient-keyed interaction datasets, so both matchers also try each
  // of these. NULL when unresolved (product-rxcui + name matching still apply).
  // Decode with parseRxcuiIngredients (lib/rxnorm.ts).
  rxcui_ingredients: string | null;
  // Provenance. source is 'manual' for
  // hand-entered rows and 'extracted' for medications auto-structured from an
  // uploaded prescription document; document_id points at that source document
  // (NULL for manual/legacy rows). The extraction persist replaces/removes only
  // the (profile, document_id, source='extracted') set, never a manual row.
  document_id: number | null;
  source: string | null;
  // The prescribing provider — a medication links to the shared
  // GLOBAL registry via provider_id; provider_name is joined for display. NULL for
  // supplements and unlinked medications.
  provider_id: number | null;
  provider_name?: string | null;
}

// Whether a row is an ordinary supplement or a prescription medication.
// Same table, same dose/schedule/adherence machinery; the UI
// groups by this and reveals the stricter medication fields.
export type SupplementKind = "supplement" | "medication";

// One scheduled intake of a supplement. A supplement has one or more doses, so a
// split dose (e.g. 1200 mg omega-3 across two fat meals) is two dose rows, each
// with its own amount, time, and food relationship.
export interface SupplementDose {
  id: number;
  item_id: number;
  amount: string | null; // e.g. "600 mg", "1 cap"
  time_of_day: string | null; // bucketed via timeBucket()
  food_timing: FoodTiming;
  sort: number;
  // Soft-retire flag: 1 when an edit removed the dose from the schedule but it
  // was kept because adherence logs reference it. Retired doses are excluded
  // from every "current schedule" read (getSupplementDoses) and are never
  // loggable; history reads still join them.
  retired: 0 | 1;
}

// A dose's resolution on a given day. A skip is a first-class LOG ROW (issue
// #232): a deliberate "chose not to take it" that is neither a taken dose nor a
// silent miss. Stored in intake_item_logs.status (DEFAULT 'taken', so every
// pre-#232 row reads as taken).
export type DoseStatus = "taken" | "skipped";

// Outcome of saveActivity (issue #332). The activity form auto-saves, so it must
// confirm ONLY a save that actually persisted. Previously a validation failure
// (`return;`) or a failed ownership check (`return null`) reached the client as
// `undefined`, which persist() read as success — it advanced its saved signature,
// showed "Saved ✓" and marked the form clean, so the auto-saver never retried and
// the user's edits were silently lost. The action now answers with the persisted
// outcome (same principle as the DoseTakenOutcome convention below): never
// unconditionally confirm; report what really happened.
export type SaveActivityOutcome =
  | { ok: true; id: number } // row inserted/updated; `id` is its row id
  | { ok: false; reason: "invalid" | "not-owned" };
//    "invalid"   → title/date failed the server-side guard; nothing written
//    "not-owned" → the untrusted form id isn't the active profile's; nothing written

// Outcome of an attempt to log a dose as taken/skipped (markDoseTaken /
// markDoseSkipped). Lets the Telegram callback answer honestly instead of
// claiming "Logged" for a tap on a button whose dose has since been
// deleted/retired or whose item was paused. An already-resolved dose carries
// the prior log's ACTUAL status (issue #280) — never a flat "already logged":
// a stale ⏭ tap on a taken dose (or ✅ on a skipped one) writes nothing, so
// the answer must state what is really persisted instead of letting each
// button type confirm its own action against the other's log.
export type DoseTakenOutcome =
  | "logged" // a new taken log row was written
  | "skipped" // a new skipped log row was written (issue #232)
  | "already-taken" // dose+date already resolved as TAKEN; nothing written
  | "already-skipped" // dose+date already resolved as SKIPPED; nothing written
  | "stale-dose" // dose deleted/retired (or not this profile's): nothing logged
  | "inactive"; // parent item is paused/stopped: nothing logged

// Outcome of a caregiver's "👍 I'm on it" acknowledgement on a missed-dose
// escalation (issue #233). Unlike "✅ Confirmed taken" (which routes through
// markDoseTaken and logs the dose), an ack NEVER claims the dose was taken — it
// only records that the episode is being handled, so the tick stops re-nudging.
// The staleness/paused cases mirror DoseTakenOutcome so a stale tap is answered
// honestly; "already-taken" tells the caregiver the dose is in fact confirmed,
// and "already-skipped" (issue #280) that it was deliberately skipped — an
// episode that's over must not be answered as a fresh "we'll hold off".
export type EscalationAckOutcome =
  | "acknowledged" // episode marked handled; dose NOT logged as taken
  | "already-taken" // a taken log already exists for the day — nothing to chase
  | "already-skipped" // a skipped log already resolves the day — nothing to chase
  | "stale-dose" // dose deleted/retired (or not this profile's): nothing recorded
  | "inactive"; // parent item is paused/stopped: nothing recorded

// A relationship between two supplements: take them together (synergy) or keep
// them apart (antagonism). `separate` pairs raise a warning when both land in
// the same time bucket.
export type PairRelation = "with" | "separate";

export interface SupplementPair {
  id: number;
  a_id: number;
  b_id: number;
  relation: PairRelation;
  note: string | null;
  // Joined names for display.
  a_name?: string;
  b_name?: string;
}

// Medication history / lifecycle. A medication's real-world
// use is a sequence of COURSES (episodes): a course opens when the med is started
// and closes when it's stopped, so restarting a med after a break is a NEW course
// rather than an edit of the old one. `intake_items.active` stays the live
// "currently taken" flag scheduling/reminders read; a med is "current" exactly
// when it has an open (stopped_on IS NULL) course.
export type MedStopReason =
  | "side_effect"
  | "ineffective"
  | "completed_course"
  | "switched"
  | "provider_discontinued"
  | "cost"
  | "other";

// One episode of taking a medication (a child of intake_items). started_on is the
// episode start; stopped_on NULL means the course is still open (the med is
// currently taken). stop_reason is a controlled MedStopReason; free-text detail
// for 'other' (or any reason) lives in notes.
export interface MedicationCourse {
  id: number;
  item_id: number;
  started_on: string | null;
  stopped_on: string | null;
  stop_reason: MedStopReason | null;
  notes: string | null;
  created_at: string;
}

export type SideEffectSeverity = "mild" | "moderate" | "severe";

// A side effect noted against a medication (a child of intake_items), optionally
// linked to the course it occurred during (course_id → medication_courses, SET
// NULL if that course row is later removed). resolved marks it as no longer
// ongoing. A side effect can be promoted to an allergies/intolerance row.
export interface MedicationSideEffect {
  id: number;
  item_id: number;
  course_id: number | null;
  effect: string;
  severity: SideEffectSeverity | null;
  noted_on: string | null;
  notes: string | null;
  resolved: number;
  created_at: string;
}

// Runtime array is the single source for the union AND the suggestions.status CHECK
// (enum-parity test).
export const SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "dismissed",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

// An AI-proposed supplement awaiting user review (see intake_item_suggestions).
export interface SupplementSuggestion {
  id: number;
  name: string;
  dosage: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
  condition: SupplementCondition;
  priority: SupplementPriority;
  brand: string | null;
  product: string | null;
  situation: string | null;
  rationale: string;
  trigger: string | null; // 'labs' | 'feedback'
  source_detail: string | null; // lab names referenced, or the feedback text
  status: SuggestionStatus;
  model: string | null;
  created_at: string;
}

export interface Insight {
  id: number;
  date: string;
  summary: string;
  model: string | null;
  created_at: string;
}

// A stored AI narrative (issue #20): a weekly/monthly period recap or a lab-trend
// interpretation. kind selects which; period_end anchors it (recap end date or
// latest lab date), period_start is the recap window start (null for lab-trend).
export type NarrativeKind = "week" | "month" | "labs";

export interface Narrative {
  id: number;
  kind: NarrativeKind;
  period_start: string | null;
  period_end: string;
  summary: string;
  model: string | null;
  created_at: string;
}

// ---- Integrations ----

// How a provider delivers data: 'push' (the source POSTs to us, e.g. Health
// Connect via an exporter app), 'oauth' (we connect and pull, e.g. Strava/Garmin),
// or 'feed' (we EXPOSE data for an external subscriber to pull — the calendar
// subscribe feed, where a calendar client polls our token-authed .ics URL).
// 'push' = phone exporter POSTs to us (Health Connect); 'oauth' = OAuth pull with a
// redirect/callback (Strava); 'token' = pull with a pasted personal access token, no
// OAuth app/redirect/callback (Oura); 'feed' = outbound subscription (calendar).
export type IntegrationKind = "push" | "oauth" | "token" | "feed";

// 'available' integrations can be configured now; 'planned' render as a preview.
export type IntegrationStatus = "available" | "planned";

export type IntegrationId =
  | "health-connect"
  | "strava"
  | "oura"
  | "withings"
  | "garmin"
  | "calendar-feed";

// A row in the integrations registry — the Integrations page renders from these.
export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  blurb: string;
  dataTypes: string[];
  docsUrl?: string;
}

// Persisted connection state for a provider (integration_connections table).
// `needs_reauth` (issue #326) is the terminal-until-user-acts state a provider lands
// in after a DEFINITIVE auth failure (a dead/revoked refresh token or PAT): the
// hourly tick only auto-syncs `connected` rows, so it stops re-attempting forever,
// and the UI surfaces a "Reconnect" prompt. Stored in the existing bare-TEXT `status`
// column (no schema change); the value set is enforced at the single upsertConnection
// writer.
export type IntegrationConnectionStatus =
  "connected" | "disconnected" | "needs_reauth";

export interface IntegrationConnection {
  profile_id: number;
  provider: string;
  status: IntegrationConnectionStatus;
  config: string | null; // JSON: { token } for push; OAuth tokens for pull
  last_sync_at: string | null;
  last_sync_summary: string | null; // JSON counts
  created_at: string;
  updated_at: string;
}

// One append-only debug record of an integration sync (integration_sync_events).
// Written best-effort by the Health Connect ingest (one per POST) and the Strava
// sync (one per run), and read back by the "Recent activity" debug panel on the
// setup pages. Profile-scoped; `ok` is 1/0; count/window/error columns are nullable.
export interface IntegrationSyncEvent {
  id: number;
  profile_id: number;
  provider: string;
  at: string;
  ok: number; // 1 = success, 0 = failure
  window_start: string | null;
  window_end: string | null;
  received: number | null;
  written: number | null;
  // Real insert/update/unchanged accounting. Null on legacy rows recorded
  // before the split columns existed — the Review feed falls back to `written`.
  inserted: number | null;
  updated: number | null;
  unchanged: number | null;
  skipped: number | null;
  // Bare filename of the captured raw provider payload under
  // data/integration-payloads/<profile_id>/ (issue #9), or null. Read back only by
  // the admin-only raw viewer route; never surfaced to members.
  raw_ref: string | null;
  error: string | null;
  created_at: string;
}

// One ingested record for a summable/scalar daily metric (metric_samples table).
export interface MetricSample {
  id: number;
  source: string;
  metric: string;
  date: string;
  start_time: string;
  end_time: string;
  value: number;
}

// A 1-minute heart-rate bucket (hr_minutes table).
export interface HrMinute {
  ts: string; // 'YYYY-MM-DDTHH:MM'
  bpm: number; // count-weighted average
  bpm_min: number | null;
  bpm_max: number | null;
  n: number;
  source: string | null;
}

// An N-of-1 protocol (issue #161): a dated self-experiment with a declared set of
// outcome-metric keys the app compares before vs. during. `end_date` NULL = the
// protocol is still running ("ongoing"). `outcome_keys` is stored as a JSON array
// of namespaced metric keys (see lib/protocol-metrics); `outcomeKeys` is the
// parsed form the query layer returns. `situation` is the optional situational-
// intake label the protocol activates on start.
export interface Protocol {
  id: number;
  name: string;
  start_date: string;
  end_date: string | null;
  notes: string | null;
  situation: string | null;
  outcomeKeys: string[];
  created_at: string;
}
