// Read layer for the unified import log + import detail.
// Every statement here is PROFILE-SCOPED (the scoping rule): the log lists a
// profile's own medical_documents + import_jobs, and the produced-breakdown
// counts each trace one document's output through the provenance link the writer
// stamped (lib/import-persist.ts) — `document_id` for records/allergies/
// conditions/encounters/extracted meds, the `documentSource(id)` string for
// body_metrics/immunizations/height+head-circ metric_samples. Providers are the
// shared GLOBAL registry, so we count DISTINCT provider_id referenced by this
// document's (profile-owned, scoped) rows rather than scanning the providers
// table.

import { db } from "../db";
import { documentSource, undeferredBodyMetrics } from "../body-metric-extract";
import type {
  GenomicResultType,
  GenomicSignificance,
  Zygosity,
  ImagingModality,
  ImagingLaterality,
  OpticalKind,
  DentalStatus,
  Provider,
} from "../types/medical";
import {
  interleaveImportLog,
  producedTotal,
  documentLogStatus,
  type DocumentProducedCounts,
} from "../import-log";
import {
  mergeFeed,
  documentEntry,
  jobEntry,
  syncEntry,
  type FeedSyncEvent,
  type FeedEntry,
} from "../import-feed";
import {
  emptySnapshot,
  recordRow,
  immunizationRow,
  allergyRow,
  conditionRow,
  encounterRow,
  medicationRow,
  bodyMetricRow,
  sampleRow,
  unscopeExternalId,
  type DiffRow,
  type ImportSnapshot,
} from "../import-diff";
import { getMedMatchStates } from "./intake/medications";
import { foldConsolidatedMeds } from "../medication-renewal";
import { parsePrescription } from "../prescription-parse";
import type { PersistInput, PersistRecord } from "../import-shape";

export interface ImportLogDocumentRow {
  kind: "document";
  id: number;
  filename: string;
  doc_type: string | null;
  source: string | null;
  document_date: string | null;
  patient_name: string | null;
  extraction_status: string;
  extraction_error: string | null;
  extracted_count: number;
  // How many extracted rows the model itself hedged on (#1601) — the PRECOMPUTED
  // `scrutiny` total off this document's stored import_report. 0 for every path with
  // no confidence signal: a deterministic import, a keyless extraction, a document
  // imported before the field existed, or a report the reader can't parse.
  confidence_scrutiny: number;
  // ACQUIRED-BY (#1748): the display name of the portal this document was pushed in
  // from, LEFT JOINed off the registry so a rename shows up everywhere at once. NULL for
  // every document a person uploaded — which is most of them — and the feed simply says
  // nothing in that case rather than "acquired via: —".
  acquired_portal_name: string | null;
  // 1 when the row has a file on disk, 0 for a file-less duplicate MARKER (#612 bytes,
  // #1780 records). The feed reads it to distinguish "recognized, nothing stored" from a
  // real document whose extraction was skipped — see documentDetail in lib/import-feed.
  has_file: number;
  uploaded_at: string;
  sortTime: string;
}

export interface ImportLogJobRow {
  kind: "job";
  id: number;
  type: string;
  status: string;
  summary: string | null;
  error: string | null;
  created_at: string;
  sortTime: string;
}

export type ImportLogRow = ImportLogDocumentRow | ImportLogJobRow;

// A profile's uploaded documents as log rows (newest first).
export function getImportLogDocuments(
  profileId: number
): ImportLogDocumentRow[] {
  // The confidence badge (#1601) PROJECTS the scrutiny total that
  // summarizeExtractionConfidence already computed and stored on the report — it never
  // re-decides which tiers deserve a look, so the badge, the detail card, and the tests
  // can't disagree. json_valid() keeps a truncated/garbled report from failing the whole
  // Review feed (json_extract raises on malformed JSON), mirroring parseImportReport's
  // own tolerance; the blob itself stays in SQLite rather than being shipped per feed
  // row. This note stays OUTSIDE the prepared call: the profile-scoping scanner reads
  // the statement's first argument as a bare literal.
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.filename AS filename, d.doc_type AS doc_type,
              d.source AS source, d.document_date AS document_date,
              d.patient_name AS patient_name,
              d.extraction_status AS extraction_status,
              d.extraction_error AS extraction_error,
              d.extracted_count AS extracted_count,
              CASE WHEN d.import_report IS NOT NULL AND json_valid(d.import_report)
                   THEN CAST(COALESCE(json_extract(d.import_report, '$.confidence.scrutiny'), 0) AS INTEGER)
                   ELSE 0 END AS confidence_scrutiny,
              p.name AS acquired_portal_name,
              CASE WHEN d.stored_path IS NOT NULL AND d.stored_path <> ''
                   THEN 1 ELSE 0 END AS has_file,
              d.uploaded_at AS uploaded_at
         FROM medical_documents d
         LEFT JOIN portals p ON p.id = d.acquired_portal_id
        WHERE d.profile_id = ?
        ORDER BY d.uploaded_at DESC, d.id DESC`
    )
    .all(profileId) as Omit<ImportLogDocumentRow, "kind" | "sortTime">[];
  return rows.map((r) => ({ kind: "document", ...r, sortTime: r.uploaded_at }));
}

// A profile's paste/CSV import jobs as log rows (newest first).
export function getImportLogJobs(profileId: number): ImportLogJobRow[] {
  const rows = db
    .prepare(
      `SELECT id, type, status, summary, error, created_at
         FROM import_jobs
        WHERE profile_id = ?
        ORDER BY created_at DESC, id DESC`
    )
    .all(profileId) as Omit<ImportLogJobRow, "kind" | "sortTime">[];
  return rows.map((r) => ({ kind: "job", ...r, sortTime: r.created_at }));
}

// The unified, newest-first import log: documents + jobs interleaved by date.
export function getImportLog(profileId: number): ImportLogRow[] {
  return interleaveImportLog<ImportLogRow>([
    ...getImportLogDocuments(profileId),
    ...getImportLogJobs(profileId),
  ]);
}

// A profile's archive-import sync events, newest first. Fitbit Takeout is a one-off
// user upload, not a recurring connected source, so its event history belongs beside
// uploaded documents and paste jobs in Review's chronological Imports feed.
function getArchiveImportSyncEvents(
  profileId: number,
  limit: number
): FeedSyncEvent[] {
  return db
    .prepare(
      `SELECT id, provider, at, ok, window_start, window_end,
              inserted, updated, unchanged, written, suppressed, edited, skipped,
              error, raw_ref
         FROM integration_sync_events
        WHERE profile_id = ? AND provider = 'fitbit-takeout'
        ORDER BY at DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, limit) as FeedSyncEvent[];
}

// The "Imports" feed behind Data → Review: a profile's ONE-OFF imports — uploaded
// documents, paste/CSV jobs, and archive imports — merged newest-first, where
// chronology is the point. Recurring integration syncs remain in their own
// "Connected sources" section (getConnectedSources), collapsed to latest-state, so
// hourly sync noise cannot drown the occasional import. Capped at `limit` after the
// merge.
export function getImportDocumentsFeed(
  profileId: number,
  limit = 40
): FeedEntry[] {
  const documents = getImportLogDocuments(profileId).map((d) =>
    documentEntry({
      ...d,
      // The LIVE footprint count, so the feed reconciles the extracted_count
      // snapshot against what remains (#1339). Only DONE documents render a count,
      // so skip the ~18-COUNT footprint read for in-flight/failed rows (it would be
      // 0 anyway). producedTotal(getDocumentProduced) is the SAME footprint the
      // detail page sums, so the two surfaces can't disagree.
      live_count:
        documentLogStatus(d.extraction_status) === "done"
          ? producedTotal(getDocumentProduced(profileId, d.id))
          : 0,
    })
  );
  const jobs = getImportLogJobs(profileId).map(jobEntry);
  const archives = getArchiveImportSyncEvents(profileId, limit).map(syncEntry);
  return mergeFeed([...documents, ...jobs, ...archives]).slice(0, limit);
}

// Read a single scalar COUNT(*) from a prepared statement result.
function scalar(row: unknown): number {
  return (row as { c: number } | undefined)?.c ?? 0;
}

// What one document import produced, per kind — the "verify" breakdown. Each
// count is scoped to the profile AND traced to the document via the same link
// the writer stamped. Every statement below uses a literal SQL string (never a
// runtime-built one) so the source-scanning scoping guard can verify profile_id
// is present.
export function getDocumentProduced(
  profileId: number,
  docId: number
): DocumentProducedCounts {
  const source = documentSource(docId);

  const recordsByCategory = db
    .prepare(
      `SELECT category, COUNT(*) AS count
         FROM medical_records
        WHERE profile_id = ? AND document_id = ?
        GROUP BY category
        ORDER BY category`
    )
    .all(profileId, docId) as { category: string; count: number }[];

  const immunizations = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM immunizations WHERE profile_id = ? AND source = ?`
      )
      .get(profileId, source)
  );
  const allergies = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM allergies WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const conditions = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM conditions WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const encounters = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM encounters WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const procedures = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM procedures WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const familyHistory = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM family_history WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const carePlanItems = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM care_plan_items WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const careGoals = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM care_goals WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const genomicVariants = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM genomic_variants WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const imagingStudies = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM imaging_studies WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const opticalPrescriptions = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM optical_prescriptions WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const dentalProcedures = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM dental_procedures WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const appointments = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM appointments WHERE profile_id = ? AND document_id = ?`
      )
      .get(profileId, docId)
  );
  const medications = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM intake_items
           WHERE profile_id = ? AND document_id = ? AND source = 'extracted'`
      )
      .get(profileId, docId)
  );
  const bodyMetrics = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM body_metrics WHERE profile_id = ? AND source = ?`
      )
      .get(profileId, source)
  );
  const heightSamples = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM metric_samples
           WHERE profile_id = ? AND source = ? AND metric = 'height_cm'`
      )
      .get(profileId, source)
  );
  const headCircSamples = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM metric_samples
           WHERE profile_id = ? AND source = ? AND metric = 'head_circumference_cm'`
      )
      .get(profileId, source)
  );
  // Distinct providers referenced by this document's rows. Each SELECT names a
  // profile-owned table filtered by profile_id + the document link; the shared
  // providers row a provider_id points at is global (not scoped here, by design).
  const providers = scalar(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
            SELECT provider_id AS pid FROM medical_records
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM immunizations
              WHERE profile_id = ? AND source = ? AND provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM encounters
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
            UNION
            SELECT location_provider_id FROM encounters
              WHERE profile_id = ? AND document_id = ? AND location_provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM optical_prescriptions
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
         )`
      )
      .get(
        profileId,
        docId,
        profileId,
        source,
        profileId,
        docId,
        profileId,
        docId,
        profileId,
        docId
      )
  );

  return {
    recordsByCategory,
    immunizations,
    allergies,
    conditions,
    encounters,
    procedures,
    familyHistory,
    carePlanItems,
    careGoals,
    genomicVariants,
    imagingStudies,
    opticalPrescriptions,
    dentalProcedures,
    appointments,
    medications,
    bodyMetrics,
    heightSamples,
    headCircSamples,
    providers,
  };
}

// ---- Per-tab listings for the import-detail records browser (#271) ----
//
// The read-only rows one document produced in each non-medical_records table,
// for the tabbed browser on /import/[id] (medical_records tabs reuse
// getRecordsForDocument). Each read is profile-scoped AND traced to the document
// via the exact provenance link the writer stamped — document_id, or
// documentSource(id) for the source-keyed tables — mirroring getDocumentProduced
// above, so a tab's rows are exactly the rows its count counted. The page maps
// these raw rows through the pure shapers in lib/import-browser.ts.

export function getDocumentVisits(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, date, end_date, type, class_code, reason FROM encounters
        WHERE profile_id = ? AND document_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, docId) as {
    id: number;
    date: string;
    end_date: string | null;
    type: string | null;
    class_code: string | null;
    reason: string | null;
  }[];
}

export function getDocumentConditions(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, name, status, onset_date, code FROM conditions
        WHERE profile_id = ? AND document_id = ?
        ORDER BY name COLLATE NOCASE, id`
    )
    .all(profileId, docId) as {
    id: number;
    name: string;
    status: string;
    onset_date: string | null;
    code: string | null;
  }[];
}

export function getDocumentAllergies(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, substance, reaction, severity, status FROM allergies
        WHERE profile_id = ? AND document_id = ?
        ORDER BY substance COLLATE NOCASE, id`
    )
    .all(profileId, docId) as {
    id: number;
    substance: string;
    reaction: string | null;
    severity: string | null;
    status: string;
  }[];
}

export function getDocumentImmunizations(profileId: number, docId: number) {
  const source = documentSource(docId);
  return db
    .prepare(
      `SELECT id, date, vaccine, dose_label FROM immunizations
        WHERE profile_id = ? AND source = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, source) as {
    id: number;
    date: string;
    vaccine: string;
    dose_label: string | null;
  }[];
}

export function getDocumentProcedures(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, name, code, date FROM procedures
        WHERE profile_id = ? AND document_id = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, docId) as {
    id: number;
    name: string;
    code: string | null;
    date: string | null;
  }[];
}

export function getDocumentFamilyHistory(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, relation, condition, onset_age FROM family_history
        WHERE profile_id = ? AND document_id = ?
        ORDER BY relation COLLATE NOCASE, condition COLLATE NOCASE, id`
    )
    .all(profileId, docId) as {
    id: number;
    relation: string | null;
    condition: string;
    onset_age: number | null;
  }[];
}

export function getDocumentCarePlanItems(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, description, category, planned_date, status FROM care_plan_items
        WHERE profile_id = ? AND document_id = ?
        ORDER BY planned_date IS NULL, planned_date, id`
    )
    .all(profileId, docId) as {
    id: number;
    description: string;
    category: string | null;
    planned_date: string | null;
    status: string | null;
  }[];
}

export function getDocumentCareGoals(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, description, target_date, status FROM care_goals
        WHERE profile_id = ? AND document_id = ?
        ORDER BY target_date IS NULL, target_date, id`
    )
    .all(profileId, docId) as {
    id: number;
    description: string;
    target_date: string | null;
    status: string | null;
  }[];
}

export function getDocumentGenomicVariants(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, gene, variant, genotype, star_allele, zygosity, significance,
              result_type, report_date FROM genomic_variants
        WHERE profile_id = ? AND document_id = ?
        ORDER BY gene COLLATE NOCASE, id`
    )
    .all(profileId, docId) as {
    id: number;
    gene: string;
    variant: string | null;
    genotype: string | null;
    star_allele: string | null;
    // CHECK-constrained columns, so the stored strings ARE these enum values.
    zygosity: Zygosity | null;
    significance: GenomicSignificance | null;
    result_type: GenomicResultType;
    report_date: string | null;
  }[];
}

export function getDocumentImagingStudies(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, modality, body_region, laterality, contrast, study_date,
              impression FROM imaging_studies
        WHERE profile_id = ? AND document_id = ?
        ORDER BY COALESCE(study_date, '') DESC, id`
    )
    .all(profileId, docId) as {
    id: number;
    // CHECK-constrained columns, so the stored strings ARE these enum values.
    modality: ImagingModality;
    body_region: string | null;
    laterality: ImagingLaterality | null;
    contrast: number;
    study_date: string | null;
    impression: string | null;
  }[];
}

export function getDocumentOpticalPrescriptions(
  profileId: number,
  docId: number
) {
  return db
    .prepare(
      `SELECT id, kind, od_sphere, os_sphere, pd, issued_date
         FROM optical_prescriptions
        WHERE profile_id = ? AND document_id = ?
        ORDER BY COALESCE(issued_date, '') DESC, id`
    )
    .all(profileId, docId) as {
    id: number;
    // CHECK-constrained column, so the stored string IS the enum value.
    kind: OpticalKind;
    od_sphere: number | null;
    os_sphere: number | null;
    pd: number | null;
    issued_date: string | null;
  }[];
}

export function getDocumentDentalProcedures(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, name, status, tooth, surface, cdt_code, procedure_date, finding
         FROM dental_procedures
        WHERE profile_id = ? AND document_id = ?
        ORDER BY COALESCE(procedure_date, '') DESC, id`
    )
    .all(profileId, docId) as {
    id: number;
    name: string;
    status: DentalStatus;
    tooth: string | null;
    surface: string | null;
    cdt_code: string | null;
    procedure_date: string | null;
    finding: string | null;
  }[];
}

export function getDocumentAppointments(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, date, title, location, status FROM appointments
        WHERE profile_id = ? AND document_id = ?
        ORDER BY date DESC, time_of_day DESC, id DESC`
    )
    .all(profileId, docId) as {
    id: number;
    date: string;
    title: string | null;
    location: string | null;
    status: string;
  }[];
}

export function getDocumentMedications(profileId: number, docId: number) {
  return db
    .prepare(
      `SELECT id, name, kind FROM intake_items
        WHERE profile_id = ? AND document_id = ? AND source = 'extracted'
        ORDER BY name COLLATE NOCASE, id`
    )
    .all(profileId, docId) as { id: number; name: string; kind: string }[];
}

// The three body-sample reads behind the merged "Body metrics" tab.
export function getDocumentBodyRows(profileId: number, docId: number) {
  const source = documentSource(docId);
  const bodyMetrics = db
    .prepare(
      `SELECT id, date, weight_kg, body_fat_pct, resting_hr FROM body_metrics
        WHERE profile_id = ? AND source = ?
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, source) as {
    id: number;
    date: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    resting_hr: number | null;
  }[];
  const heights = db
    .prepare(
      `SELECT id, date, value FROM metric_samples
        WHERE profile_id = ? AND source = ? AND metric = 'height_cm'
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, source) as { id: number; date: string; value: number }[];
  const headCircs = db
    .prepare(
      `SELECT id, date, value FROM metric_samples
        WHERE profile_id = ? AND source = ? AND metric = 'head_circumference_cm'
        ORDER BY date DESC, id DESC`
    )
    .all(profileId, source) as { id: number; date: string; value: number }[];
  return { bodyMetrics, heights, headCircs };
}

// The distinct providers referenced by THIS document's rows (#1182): the listing
// behind the import-detail Providers tab, promoted from the bare count chip now
// that /providers/[id] exists (#275). The provider set is the SAME distinct-
// provider_id union getDocumentProduced counts — every SELECT names a profile-
// owned table filtered by profile_id + the document link, so the tab count and
// the listing can't disagree — but here it joins the shared global `providers`
// row for display (id/name/type + the disambiguation fields #531/#534 needs).
// Providers stay EXCLUDED from extracted_count (they're global-registry rows, not
// this profile's owned records — the #212 invariant); this is a separate read.
export function getDocumentProviders(
  profileId: number,
  docId: number
): Provider[] {
  const source = documentSource(docId);
  return db
    .prepare(
      `SELECT p.* FROM providers p
        WHERE p.id IN (
            SELECT provider_id FROM medical_records
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM immunizations
              WHERE profile_id = ? AND source = ? AND provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM encounters
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
            UNION
            SELECT location_provider_id FROM encounters
              WHERE profile_id = ? AND document_id = ? AND location_provider_id IS NOT NULL
            UNION
            SELECT provider_id FROM optical_prescriptions
              WHERE profile_id = ? AND document_id = ? AND provider_id IS NOT NULL
         )
        ORDER BY p.name COLLATE NOCASE, p.id`
    )
    .all(
      profileId,
      docId,
      profileId,
      source,
      profileId,
      docId,
      profileId,
      docId,
      profileId,
      docId
    ) as Provider[];
}

// The currently-persisted rows a document produced, reduced to the neutral
// ImportSnapshot the reprocess-diff compares against. This
// is the PERSISTED ("current") side; the freshly-extracted ("next") side comes
// from snapshotFromPersistInput on an in-memory PersistInput that is NEVER
// written. Both funnel through the SAME row builders (lib/import-diff), so a
// stable natural key on each side matches — a source-scoped external_id (unscoped
// here so it lines up with the raw id the extraction side carries) or a content
// identity when the row has none.
//
// Every statement is profile-scoped AND traced to the document via the exact
// provenance link the writer stamped (import-persist): document_id for
// records/allergies/conditions/encounters/extracted meds, documentSource(id) for
// body_metrics / immunizations / height + head-circumference metric_samples.
export function getReprocessSnapshot(
  profileId: number,
  docId: number
): ImportSnapshot {
  const source = documentSource(docId);
  const snap = emptySnapshot();

  const records = db
    .prepare(
      `SELECT date, category, name, value, value_num, unit, reference_range,
              panel, flag, canonical_name, notes, external_id
         FROM medical_records
        WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    date: string;
    category: string;
    name: string;
    value: string | null;
    value_num: number | null;
    unit: string | null;
    reference_range: string | null;
    panel: string | null;
    flag: string | null;
    canonical_name: string | null;
    notes: string | null;
    external_id: string | null;
  }[];
  snap.records = records.map((r) =>
    recordRow({
      date: r.date,
      category: r.category,
      name: r.name,
      value: r.value,
      value_num: r.value_num,
      unit: r.unit,
      reference_range: r.reference_range,
      panel: r.panel,
      flag: r.flag,
      canonical: r.canonical_name,
      notes: r.notes,
      external_id: unscopeExternalId(r.external_id),
    })
  );

  const imms = db
    .prepare(
      `SELECT date, vaccine, dose_label, notes, external_id
         FROM immunizations WHERE profile_id = ? AND source = ?`
    )
    .all(profileId, source) as {
    date: string;
    vaccine: string;
    dose_label: string | null;
    notes: string | null;
    external_id: string | null;
  }[];
  snap.immunizations = imms.map((im) =>
    immunizationRow({
      date: im.date,
      vaccine: im.vaccine,
      dose_label: im.dose_label,
      notes: im.notes,
      external_id: unscopeExternalId(im.external_id),
    })
  );

  const allergies = db
    .prepare(
      `SELECT substance, reaction, severity, status, onset_date, external_id
         FROM allergies WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    substance: string;
    reaction: string | null;
    severity: string | null;
    status: string;
    onset_date: string | null;
    external_id: string | null;
  }[];
  snap.allergies = allergies.map((a) =>
    allergyRow({
      substance: a.substance,
      reaction: a.reaction,
      severity: a.severity,
      status: a.status,
      onset_date: a.onset_date,
      external_id: unscopeExternalId(a.external_id),
    })
  );

  const conditions = db
    .prepare(
      `SELECT name, status, onset_date, resolved_date, code, external_id
         FROM conditions WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    name: string;
    status: string;
    onset_date: string | null;
    resolved_date: string | null;
    code: string | null;
    external_id: string | null;
  }[];
  snap.conditions = conditions.map((c) =>
    conditionRow({
      name: c.name,
      status: c.status,
      onset_date: c.onset_date,
      resolved_date: c.resolved_date,
      code: c.code,
      external_id: unscopeExternalId(c.external_id),
    })
  );

  const encounters = db
    .prepare(
      `SELECT date, end_date, type, class_code, reason, diagnoses, external_id
         FROM encounters WHERE profile_id = ? AND document_id = ?`
    )
    .all(profileId, docId) as {
    date: string;
    end_date: string | null;
    type: string | null;
    class_code: string | null;
    reason: string | null;
    diagnoses: string | null;
    external_id: string | null;
  }[];
  snap.encounters = encounters.map((e) =>
    encounterRow({
      date: e.date,
      end_date: e.end_date,
      type: e.type,
      class_code: e.class_code,
      reason: e.reason,
      diagnoses: e.diagnoses ?? "",
      external_id: unscopeExternalId(e.external_id),
    })
  );

  const meds = db
    .prepare(
      `SELECT name FROM intake_items
        WHERE profile_id = ? AND document_id = ? AND source = 'extracted'`
    )
    .all(profileId, docId) as { name: string }[];
  snap.medications = meds.map((m) => medicationRow(m.name));

  const bms = db
    .prepare(
      `SELECT date, weight_kg, body_fat_pct, resting_hr
         FROM body_metrics WHERE profile_id = ? AND source = ?`
    )
    .all(profileId, source) as {
    date: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    resting_hr: number | null;
  }[];
  snap.bodyMetrics = bms.map((b) =>
    bodyMetricRow({
      date: b.date,
      weight_kg: b.weight_kg,
      body_fat_pct: b.body_fat_pct,
      resting_hr: b.resting_hr,
    })
  );

  const heights = db
    .prepare(
      `SELECT date, value FROM metric_samples
        WHERE profile_id = ? AND source = ? AND metric = 'height_cm'`
    )
    .all(profileId, source) as { date: string; value: number }[];
  snap.heights = heights.map((h) => sampleRow("h", h.date, h.value));

  const headCircs = db
    .prepare(
      `SELECT date, value FROM metric_samples
        WHERE profile_id = ? AND source = ? AND metric = 'head_circumference_cm'`
    )
    .all(profileId, source) as { date: string; value: number }[];
  snap.headCircs = headCircs.map((h) => sampleRow("hc", h.date, h.value));

  return snap;
}

// The medications snapshot above keys on intake_items.document_id — but since the
// #1204 renewal consolidation, a drug a document derives that the profile ALREADY
// tracks persists as courses on the EXISTING item, and no intake_items row carries
// the later document's id. Left alone, every later document's reprocess preview
// shows those drugs as phantom "+ added" medications. This DB seam gathers the
// tracked-med match states + the derived rows' parsed strengths and hands them to
// the pure `foldConsolidatedMeds`, which folds only the derived rows that would
// RENEW onto a tracked med (so they compare unchanged) — MIRRORING the commit-time
// classifyReprescription. Critically (#1280) it does NOT fold a derived med that
// would resolve to a "separate" item (existing open course + provably different
// strength, the #1027 carve-out): that is a genuinely-new medication and must
// preview as an addition, never be silently hidden. `derivedRecords` are the fresh
// extraction's records, from which we recover each derived med's strength the same
// way the commit path does (parsePrescription), keyed by the medicationRow key.
export function foldConsolidatedMedsIntoSnapshot(
  profileId: number,
  snap: ImportSnapshot,
  derivedMeds: DiffRow[],
  derivedRecords: PersistRecord[]
): void {
  const newStrengthByKey = new Map<string, string | null>();
  for (const r of derivedRecords) {
    if (r.category !== "prescription" || !r.name?.trim()) continue;
    const key = medicationRow(r.name).key;
    if (newStrengthByKey.has(key)) continue; // first record per key wins (mirrors grouping)
    newStrengthByKey.set(
      key,
      parsePrescription({
        name: r.name,
        value: r.value,
        unit: r.unit,
        notes: r.notes,
      }).strength
    );
  }
  foldConsolidatedMeds(
    getMedMatchStates(profileId),
    snap,
    derivedMeds,
    newStrengthByKey
  );
}

// A projected body metric / height / head-circ that a reprocess would DEFER — because
// another source (a manual entry, a device integration, or ANOTHER document) already
// covers that date's measure (the import-persist undeferredBodyMetrics + height/
// head-circ "covered" probes) — is still proposed by the defer-blind
// snapshotFromPersistInput, so it reads as a phantom "add" on EVERY reprocess of a
// document whose weight / resting-HR / height / head-circ share a date with another
// source. Reconcile the fresh (`next`) side with the SAME defer the commit applies:
// probe coverage from every source EXCEPT this document's own (a reprocess clears the
// document's rows before re-persisting, so its metrics never self-defer) and rebuild
// next's metric arrays to what a reprocess would actually store — so an otherwise
// unchanged document previews as unchanged instead of re-proposing deferred metrics.
export function pruneDeferredMetricsFromSnapshot(
  profileId: number,
  docId: number,
  next: ImportSnapshot,
  input: PersistInput
): void {
  const source = documentSource(docId);
  // `source IS NOT ?` counts every OTHER source (NULL-source paste rows included) but
  // never this document's own rows — mirroring the post-clear state a reprocess probes.
  const bmCoverage = db.prepare(
    `SELECT MAX(weight_kg IS NOT NULL) AS w,
            MAX(body_fat_pct IS NOT NULL) AS bf,
            MAX(resting_hr IS NOT NULL) AS rhr
       FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS NOT ?`
  );
  next.bodyMetrics = undeferredBodyMetrics(input.bodyMetrics, (date) => {
    const c = bmCoverage.get(profileId, date, source) as
      { w: number | null; bf: number | null; rhr: number | null } | undefined;
    return {
      weight_kg: !!c?.w,
      body_fat_pct: !!c?.bf,
      resting_hr: !!c?.rhr,
    };
  }).map((b) =>
    bodyMetricRow({
      date: b.date,
      weight_kg: b.weight_kg,
      body_fat_pct: b.body_fat_pct,
      resting_hr: b.resting_hr,
    })
  );

  const sampleCovered = db.prepare(
    `SELECT 1 FROM metric_samples
       WHERE profile_id = ? AND metric = ? AND date = ? AND source IS NOT ? LIMIT 1`
  );
  next.heights = input.heights
    .filter((h) => !sampleCovered.get(profileId, "height_cm", h.date, source))
    .map((h) => sampleRow("h", h.date, h.height_cm));
  next.headCircs = input.headCircs
    .filter(
      (h) =>
        !sampleCovered.get(profileId, "head_circumference_cm", h.date, source)
    )
    .map((h) => sampleRow("hc", h.date, h.head_circumference_cm));
}
