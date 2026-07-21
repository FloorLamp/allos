// Medical passport domain types (providers, appointments, lab/biomarker records,
// canonical ranges, immunizations, allergies, conditions, encounters, procedures,
// family history, care plans/goals, documents). Split out of lib/types.ts (#319);
// the `@/lib/types` barrel re-exports everything here, so import paths are unchanged.

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
  // Provider specialty (issue #1056). `specialty_code` is the NUCC taxonomy code,
  // verbatim (code-first identity, like the NPI); `specialty` is the human display
  // string (curated NUCC label or the document's displayName). Both nullable.
  specialty_code: string | null;
  specialty: string | null;
  // Lifecycle (issue #1057): an archived provider drops out of the default directory
  // and picker suggestions but keeps every FK'd record's link. Instance-level.
  archived: 0 | 1;
  // Contact edit-lock (issue #1058): set by a manual phone/address edit; the import
  // upsert then preserves the edited contact fields (the #133 edit-lock stance).
  contact_edited: 0 | 1;
  created_at: string;
}

// Affiliation edge state (issue #1055): 'linked' is an accepted individual ↔
// organization affiliation; 'declined' a remembered "don't re-suggest this pair".
// Single source of truth for the union AND the provider_affiliations.status CHECK
// (enum-parity test), the visit-link decision precedent folded into the edge row.
export const PROVIDER_AFFILIATION_STATUSES = ["linked", "declined"] as const;
export type ProviderAffiliationStatus =
  (typeof PROVIDER_AFFILIATION_STATUSES)[number];

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
  | "well_child"
  | "physical"
  | "dental"
  | "vision"
  | "hearing"
  | "mental_health"
  | "screening"
  | "other";

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
  // The resulting visit once this appointment has happened (issue #288): set when
  // "Log this visit" creates a linked encounter or an import/sync auto-completes a
  // matching one. NULL for a still-scheduled or manually-completed appointment.
  encounter_id: number | null;
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
  // A GOOD durable-immunity titer (a positive hep A/B surface Ab, MMR/varicella IgG):
  // protective immunity is the desired result, so it's a neutral status, never a red
  // "abnormal" attention flag (issue #544). Derived by the qualitative classifier
  // (#549) in the flag reconcile; its tone is "default" and it is NOT out-of-range.
  | "immune"
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
  // The reading's LOINC when the source carried one (migration 034). Optional: the
  // column is nullable and legacy rows predate it. Selected by the `SELECT *`
  // record queries, so it rides along wherever a MedicalRecord is read — which is
  // what lets the retest/staleness path reach the qualitative class hint (#910).
  loinc?: string | null;
  // 1 when this is the most recent reading in its biomarker group; only set by
  // queries that select it (e.g. the biomarkers table). Absent otherwise.
  is_latest?: number;
  // The performing provider/organization. provider_id links the
  // shared GLOBAL registry; provider_name is joined for display. NULL/absent when
  // unlinked.
  provider_id: number | null;
  provider_name?: string | null;
  // Integration/import provenance: `source` names the provider ('health-connect',
  // etc.), `external_id` is the sync's natural key (NULL for manual/document rows).
  // `edited` is 1 when a source-owned row was hand-edited so ingest leaves it alone
  // on re-sync (#133); it drives the edit-lock badge (#659). Absent on some minimal
  // read shapes that don't select them.
  source?: string | null;
  external_id?: string | null;
  edited?: number | null;
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

// Cycle-phase reference overrides for a phase-dependent reproductive hormone
// (Estradiol/FSH/LH/Progesterone) — issue #718. Keyed by the two phases the
// non-predictive cycle derivation (lib/cycle) resolves for hormones: `follicular`
// (which also covers a MENSTRUAL date and — because there is no distinct derived
// ovulatory phase — the mid-cycle surge, so its curated range is a follicular→
// ovulatory ENVELOPE) and `luteal`. FEMALE physiology only; selected by the phase on
// the record's collection date, above the coarse reproductive-status proxy in
// referenceRange (lib/reference-range.selectCyclePhaseRange). The range shape reuses
// ReproductiveStatusRange (ref_low/ref_high/note; null low = open). Stored as JSON in
// canonical_biomarkers.ranges_by_cycle_phase.
export type CyclePhaseRangeKey = "follicular" | "luteal";
export type CyclePhaseRanges = Partial<
  Record<CyclePhaseRangeKey, ReproductiveStatusRange>
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
  // Cycle-phase reference overrides (female physiology only) for the phase-dependent
  // reproductive hormones (issue #718). When the subject is female and their cycle
  // phase on the record's collection date is derivable from the logged cycle history,
  // the matching phase range REPLACES all other ranges (above ranges_by_status) — see
  // lib/reference-range.selectCyclePhaseRange. NULL when the analyte isn't cycle-phase
  // dependent. Stored as a JSON object in the canonical_biomarkers table.
  ranges_by_cycle_phase: CyclePhaseRanges | null;
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
  // The encounter TYPE code + labeled system (CPT/CDT/SNOMED) captured on import
  // (#1035) — feeds the preventive visit-rule code matching. NULL on manual rows.
  code: string | null;
  code_system: string | null;
  class_code: string | null;
  reason: string | null;
  diagnoses: string | null;
  provider_id: number | null;
  provider_name: string | null;
  location_provider_id: number | null;
  location_name: string | null;
  // The facility provider's free-text address (joined from providers.address on
  // location_provider_id), for the "Open in Maps" affordance (#568). Null when the
  // encounter has no linked facility or the facility has no stored address.
  location_address: string | null;
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

// ── Genomic variants (#709) ──────────────────────────────────────────────────
// A stored genetic result, captured STRUCTURALLY from a clinical genetics / PGx
// report (never re-interpreted from raw calls — see #712). The `result_type`
// discriminator is the load-bearing routing key: `pharmacogenomic` feeds the PGx
// cross-check (#710), `hereditary-risk` feeds the screening-cadence consumer
// (#711). Predictive variants are stored FACTUALLY with no risk editorializing.

// Where a variant routes downstream. `other` is the safe default for anything not
// clearly one of the actionable classes.
export type GenomicResultType =
  "pharmacogenomic" | "hereditary-risk" | "carrier" | "diagnostic" | "other";

// ACMG clinical-significance terms (VUS is stored as 'uncertain-significance').
// Null for a result the report states without an ACMG call (e.g. a PGx star-allele
// whose meaning is its metabolizer function, not a pathogenicity classification).
export type GenomicSignificance =
  | "pathogenic"
  | "likely-pathogenic"
  | "uncertain-significance"
  | "likely-benign"
  | "benign";

// Zygosity of the call, when the report states one.
export type Zygosity = "heterozygous" | "homozygous" | "hemizygous";

// A structured genomic variant (table: genomic_variants). `gene` is the HGNC
// symbol (the identity anchor, required). `variant` holds the rsID and/or HGVS.
// `genotype` / `star_allele` / `zygosity` carry the call as the report states it.
// `interpretation` is the report's own text (stored verbatim, never editorialized).
// Provenance/dedup (`source`/`document_id`/`external_id`) mirror the conditions
// table so the import footprint clears/moves/counts it by document_id.
export interface GenomicVariant {
  id: number;
  gene: string;
  variant: string | null;
  genotype: string | null;
  star_allele: string | null;
  zygosity: Zygosity | null;
  significance: GenomicSignificance | null;
  result_type: GenomicResultType;
  interpretation: string | null;
  source_lab: string | null;
  report_date: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// ── Imaging studies (#702) ───────────────────────────────────────────────────
// A stored radiology STUDY, captured STRUCTURALLY from an uploaded report (the
// image pixels / DICOM are OUT of scope — Allos holds the report, not the images).
// This is the NARRATIVE + METADATA home for imaging: modality, body region,
// laterality, contrast, and the radiologist's `impression` (which for most imaging
// IS the result). Numeric imaging metrics (DEXA T-scores, coronary calcium, EF,
// IMT) keep routing to `scan` biomarker rows — the study LINKS to those, it does
// not absorb them. It is the entity #700's follow-up loop and #701's contrast check
// hang off.

// Imaging modality. `other` is the safe default for anything not clearly one of the
// listed classes (normalized in lib/imaging-study.ts). `pet`, `nuclear-medicine`
// (SPECT/scintigraphy), and `fluoroscopy` (incl. interventional angiography, whose
// dose mechanism is fluoroscopic) joined in #1034 so the highest-dose modalities
// stop falling to `other` and contributing 0 to the cumulative radiation total.
export type ImagingModality =
  | "x-ray"
  | "ct"
  | "mri"
  | "ultrasound"
  | "dexa"
  | "pet"
  | "nuclear-medicine"
  | "fluoroscopy"
  | "other";

// Which side the study covers, when stated. `na` = not applicable / midline (e.g. a
// chest X-ray or an abdominal CT), distinct from an unstated (null) laterality.
export type ImagingLaterality = "left" | "right" | "bilateral" | "na";

// A structured imaging study (table: imaging_studies). `modality` is the anchor
// classifier. `body_region` / `laterality` / `contrast` describe what was imaged;
// `impression` is the radiologist's report body (stored verbatim). `indication` is
// the reason the study was ordered — captured for a future screening-vs-diagnostic
// decision (#703), NOT gated on today. `ordering_provider_id` / `reading_provider_id`
// link the global providers registry (for #701's contrast context). Provenance/dedup
// (`source`/`document_id`/`external_id`) mirror the conditions table so the import
// footprint clears/moves/counts it by document_id.
export interface ImagingStudy {
  id: number;
  modality: ImagingModality;
  body_region: string | null;
  laterality: ImagingLaterality | null;
  // Stored 0/1 in SQLite; surfaced as a boolean by the read layer.
  contrast: boolean;
  contrast_agent: string | null;
  study_date: string | null;
  // Effective radiation dose in millisieverts (mSv), when the report prints it
  // (#703). Usually null — consumer radiology reports rarely state a dose, so this is
  // captured manually or, rarely, by AI extraction. When null the Imaging section
  // falls back to a curated typical-dose-by-modality ESTIMATE, kept separate from
  // recorded doses. MRI / ultrasound use no ionizing radiation (dose 0).
  dose_msv: number | null;
  impression: string | null;
  indication: string | null;
  status: string | null;
  ordering_provider_id: number | null;
  reading_provider_id: number | null;
  // Ordering / reading (radiologist) providers, joined for display (#1088).
  ordering_provider_name?: string | null;
  reading_provider_name?: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// An optical prescription's kind. `glasses` and `contacts` carry the same per-eye
// refraction (sphere/cylinder/axis/add); only `contacts` adds base_curve/diameter/
// brand. Normalized in lib/optical-prescription.ts.
export type OpticalKind = "glasses" | "contacts";

// A structured optical (eyeglass/contact) prescription (table: optical_prescriptions,
// issue #697). Per-eye refraction in standard optometry notation — OD = right eye,
// OS = left eye: `*_sphere` / `*_cylinder` / `*_add` are dioptres (may be negative),
// `*_axis` is a whole degree 0–180. `pd` is pupillary distance (mm). The contacts-only
// extras (`base_curve` / `diameter` / `brand`) stay null for a glasses Rx.
// `issued_date` / `expiry_date` bound its validity (expiry surfaces on the Vision page
// as plain "expires soon"/"expired" text). `provider_id` links the PRESCRIBER in the
// global providers registry. Provenance/dedup (`source`/`document_id`/`external_id`)
// mirror the conditions table so the import footprint clears/moves/counts it by
// document_id.
export interface OpticalPrescription {
  id: number;
  kind: OpticalKind;
  od_sphere: number | null;
  od_cylinder: number | null;
  od_axis: number | null;
  od_add: number | null;
  os_sphere: number | null;
  os_cylinder: number | null;
  os_axis: number | null;
  os_add: number | null;
  pd: number | null;
  base_curve: number | null;
  diameter: number | null;
  brand: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  provider_id: number | null;
  // Prescriber, joined for display (#1088). NULL for a self-entered Rx.
  provider_name?: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// ── Dental procedures (#705) ─────────────────────────────────────────────────
// A structured DENTAL record captured from a dental exam/treatment record or
// after-visit summary (the AI-extraction path is the primary entry — dental has no
// FHIR structured feed, #708). Mirrors the imaging-study record type (#702). The
// general `procedures` table carries name+code+date but NO tooth notation, so a
// per-tooth timeline ("what's happened to #14") is impossible there; this record
// type anchors a restoration/extraction/finding to a tooth + surface + CDT code.
//
// It ALSO holds dental exam FINDINGS ("watch #14, recheck in 6 months") that seed
// the follow-up loop (#700), distinguished from history by `status`. Periodontal
// MEASUREMENTS (probing depth, bleeding-on-probing) are NOT here — they reuse the
// medical_records biomarker store as curated canonical analytes (the #698 vision-
// analyte precedent), so they trend + flag on the Biomarkers surface.

// The dental record lifecycle classifier. 'completed' is history; 'planned' is a
// planned procedure (the #704 planned-procedure signal when invasive); 'watch' is a
// monitored exam finding that seeds a dental follow-up.
export type DentalStatus = "completed" | "planned" | "watch";

// The tooth-numbering system the `tooth` value is expressed in. `universal` = ADA
// Universal (1–32), `fdi` = FDI/ISO two-digit, `palmer` = Palmer notation. Null when
// the record isn't tooth-specific or the system is unknown.
export type ToothSystem = "universal" | "fdi" | "palmer";

// A structured dental procedure/finding (table: dental_procedures). `name` is the
// anchor (the procedure or finding). `tooth`/`surface`/`cdt_code` anchor it
// clinically; `status` gates the downstream consumers (#704 planned signal, #700
// follow-up). `finding` is the free-text exam impression; `follow_up_interval_days`
// is the recommended recheck cadence. Provenance/dedup mirror imaging_studies so the
// import footprint clears/moves/counts it by document_id.
export interface DentalProcedure {
  id: number;
  name: string;
  status: DentalStatus;
  tooth: string | null;
  tooth_system: ToothSystem | null;
  surface: string | null;
  cdt_code: string | null;
  procedure_date: string | null;
  finding: string | null;
  follow_up_interval_days: number | null;
  provider_id: number | null;
  // Recording provider, joined for display (#1088). NULL for a self-photographed lesion.
  provider_name?: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// A structured skin lesion / mole record (table: skin_lesions, issue #715). Each row
// is a DATED observation of one lesion; serial observations of the SAME lesion share
// an identity (normalized body_region + body_side + label, see lib/skin-lesion.ts) so
// a recheck resolves the right follow-up and its photos gather together. `label` is the
// free-text identity/location ("upper left forearm"); `body_region`/`body_side` are the
// COARSE body-map bucket. The five ABCDE fields are USER-RECORDED OBSERVATIONS (0/1),
// never a malignancy score (#715 scope). `status` gates the follow-up loop ('watch'
// seeds a recheck). Provenance/dedup mirror imaging_studies so the import footprint
// clears/moves/counts it by document_id.
export interface SkinLesion {
  id: number;
  label: string | null;
  body_region: string | null;
  body_side: string | null;
  size_mm: number | null;
  asymmetry: 0 | 1;
  border: 0 | 1;
  color: 0 | 1;
  diameter: 0 | 1;
  evolving: 0 | 1;
  status: SkinLesionStatusValue;
  observed_date: string | null;
  finding: string | null;
  follow_up_interval_days: number | null;
  provider_id: number | null;
  // Recording provider, joined for display (#1088). NULL for a self-photographed lesion.
  provider_name?: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
}

// Mirror of lib/skin-lesion.ts's SkinLesionStatus, inlined here so lib/types has no
// import into a helper module (the DentalStatus posture).
export type SkinLesionStatusValue = "active" | "watch" | "removed";

// A stored lesion photo (table: lesion_photos, #715 serial-photo tracking). Rides the
// medical-uploads posture (per-profile dir, sha256 dedup, profile-scoped serving) but
// its OWN table + files dir, bound to a lesion by `lesion_id` and dated by `date` so a
// side-by-side "is this mole changing?" comparison reads chronologically.
export interface LesionPhoto {
  id: number;
  lesion_id: number;
  date: string;
  mime_type: string | null;
  caption: string | null;
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
  // 'completed' (markCarePlanItemDone, lib/queries/upcoming/generators.ts); every other value is
  // clinical passthrough. A closed enum here would drop or mangle real record data.
  status: string | null;
  provider_id: number | null;
  provider_name: string | null;
  notes: string | null;
  source: string | null;
  document_id: number | null;
  external_id: string | null;
  created_at: string;
  // Finding → follow-up → resolution chain (issue #700, migration 050). All null for
  // a generic care-plan item; a TRACKED follow-up sets source_kind + one concrete
  // source FK and (once closed) the resolution + a resolving FK.
  source_kind: string | null; // adapter discriminator ('imaging' | 'labs'); null ⇒ not a follow-up
  source_imaging_study_id: number | null; // the imaging source finding
  source_medical_record_id: number | null; // the flagged-lab source finding (#700 labs adapter, migration 057)
  source_dental_procedure_id: number | null; // the dental source finding (#705 dental adapter, migration 066)
  source_skin_lesion_id: number | null; // the skin-lesion source finding (#715 skin adapter, migration 070)
  recommended_interval_days: number | null; // the recommended follow-up interval
  resolution: string | null; // 'resolved' | 'stable' | 'changed' once closed
  resolved_by_imaging_study_id: number | null; // the later study it was resolved against
  resolved_by_medical_record_id: number | null; // the later lab reading it was resolved against (labs adapter)
  resolved_by_dental_procedure_id: number | null; // the later dental record it was resolved against (dental adapter)
  resolved_by_skin_lesion_id: number | null; // the later lesion record it was resolved against (skin adapter)
  resolved_at: string | null;
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
  // When extraction last transitioned to 'done' (issue #1022) — stamped by the
  // one finalize UPDATE in lib/import-persist.ts; the digest's "new documents"
  // window keys on it. NULL until a document first completes.
  extraction_completed_at: string | null;
}
