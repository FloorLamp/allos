import { db, writeTx } from "../db";
import { cache } from "../request-cache";
import { biomarkerFamily } from "../canonical-name";
import { BIOMARKER_FAMILY_FN, BIOMARKER_PANEL_FN } from "../sql-functions";
import { panelOrderOfPanelExpr, type PanelId } from "../biomarker-panels";
import type {
  CanonicalBiomarker,
  MedicalDocument,
  MedicalFlag,
  MedicalRecord,
} from "../types";
export { getCanonicalBiomarker } from "./medical/canonical";
export {
  ENCOUNTER_REPRESENTATIVE_IDS,
  getEncounter,
  getEncounters,
  visitContextForEncounter,
} from "./medical/encounters";
export {
  getImmunityTiters,
  getImmunizationOverride,
  getImmunizationOverrides,
  getImmunizations,
  type ImmunityTiter,
  type ImmunizationOverrideRow,
} from "./medical/immunizations";
export { previewReconcileFlags, reconcileFlags } from "./medical/flags";
export {
  getRecordRevisions,
  getRevisionsByRecord,
  insertRecordRevision,
  type RevisionSnapshot,
} from "./medical/revisions";
export {
  detectRecordUnitMislabel,
  getUnitMislabelReviews,
  unitMislabelSignalKey,
  type UnitMislabelReview,
} from "./medical/unit-mislabel";

// ---- Medical ----
export type MedicalSortColumn = "name" | "panel" | "date";
export type SortDirection = "asc" | "desc";

// Flag-based row filter: "oor" = out of the lab reference range (high/low/
// abnormal); "nonoptimal" = that plus rows flagged non-optimal (a superset).
export type RangeFilter = "oor" | "nonoptimal";

// SQL predicate for a RangeFilter, or null for "All". Flag literals are fixed,
// so this is safe to inline.
export function rangeFilterClause(range?: RangeFilter): string | null {
  if (range === "oor") return "flag IN ('high','low','abnormal')";
  if (range === "nonoptimal")
    return "flag IN ('high','low','abnormal','non-optimal','non-optimal-high','non-optimal-low')";
  return null;
}

export interface MedicalRecordFilters {
  category?: string;
  // Categories to hide entirely (e.g. drop 'prescription' from the biomarkers
  // browser — meds live on the document view + Supplements & Meds). Rendered as a
  // parameterized `category NOT IN (…)`; an empty/absent list adds no clause.
  excludeCategories?: string[];
  // The NORMALIZED panel slug (#1502), never the stored free-text heading — the
  // `?panel=` param is a clinical facet ("show my Lipids"), not a lab-vendor
  // filter. Rows match on the panel RESOLVED from their canonical name, so the
  // facet works regardless of what any document's section heading said.
  panel?: PanelId;
  // Flag-based filter: out-of-range only, or all non-optimal rows.
  range?: RangeFilter;
  // Free-text search matched against name and panel.
  q?: string;
  // Optional user-chosen sort; falls back to each query's natural order.
  sort?: MedicalSortColumn;
  dir?: SortDirection;
  // When set, keep only the most recent reading per biomarker (its current
  // value), grouped by the canonical name shown in the table.
  current?: boolean;
}

// Display/grouping identity for a biomarker: the canonical name when present,
// otherwise the raw name. Name sorting and the "current value" filter both key
// off this so the table orders and dedupes by the same identity it shows.
// Pass a table alias (e.g. "mr2") when disambiguating a self-join.
export function biomarkerNameKey(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(TRIM(${p}canonical_name), ''), ${p}name)`;
}
const BIOMARKER_NAME_KEY = biomarkerNameKey();

// The biomarker FAMILY identity as a SQL expression (#482) — the ONE grouping key
// every biomarker surface partitions/matches on so none of them can disagree about
// what "Vitamin D" is: the dedup partition, the is_latest/current marker, the
// chart/detail series, and the starred tile all key on THIS instead of the bare
// per-name key.
//
// It calls the SAME pure biomarkerFamily() the JS surfaces do, through the
// `biomarker_family()` SQLite user function lib/db.ts registers (see
// lib/sql-functions.ts) — literally one computation, not two realizations of it.
// This USED to be a finite-preimage (#394) `CASE WHEN lower(name) IN (<members>)`
// built from BIOMARKER_FAMILIES, which could only enumerate each family's finite
// member list and structurally dropped the family's freeform `match` matcher. A
// stored name caught only by that regex (an un-snapped AI-coined A1c spelling) was
// then one family to the JS star/retest/dismissal surfaces and its OWN singleton
// to the partitions below — the same measurement double-counted on one date and
// markable "current" twice (#1401). Behavior is otherwise unchanged: an enumerated
// member resolves to the identical `family:<key>` string, and every non-family name
// still resolves to its own display name (now trimmed on both sides rather than
// only the JS side), byte-for-byte the pre-#482 grouping for non-family analytes.
//
// Reused both for the records grouping key (over the canonical-or-raw display name)
// and the star store (over its bare `key` column), so both key on the identical
// family identity. The function name is a hardcoded constant, so this is
// injection-safe. Pass a table alias for a self-join.
function familyKeyOfExpr(nameExpr: string): string {
  return `${BIOMARKER_FAMILY_FN}(${nameExpr})`;
}
export function biomarkerFamilyKey(alias = ""): string {
  return familyKeyOfExpr(biomarkerNameKey(alias));
}
// The normalized PANEL slug as a SQL expression (#1502), over the same canonical-or-
// raw display-name key the family grouping uses. A name the taxonomy doesn't know
// resolves to 'other'. Pass a table alias for a self-join.
//
// Like the family key above, it calls the SAME pure panelForCanonicalName() the JS
// surfaces do, through the `biomarker_panel()` SQLite user function lib/db.ts
// registers (see lib/sql-functions.ts). This USED to be a generated finite-preimage
// (#394) `CASE WHEN lower(name) IN (<member spellings>)` over each panel's enumerated
// members — which inherited the #1401 blind spot one level up (#1629): a stored name
// caught only by a family's freeform `match` matcher was a family member to the
// family key but panel 'other' to THIS expression, so the Biomarkers panel facet and
// the Timeline panel titles could file one reading of a family under its clinical
// panel and a sibling reading of the same family under "Other". Behavior is otherwise
// unchanged: every enumerated spelling resolves to the identical slug, and an unknown
// name still resolves to 'other' (including a NULL name — the resolver maps blank to
// the fallback exactly as the CASE's ELSE did).
export function biomarkerPanelKey(alias = ""): string {
  return `${BIOMARKER_PANEL_FN}(${biomarkerNameKey(alias)})`;
}
const BIOMARKER_PANEL_KEY = biomarkerPanelKey();
// The panel's curated sort order, over the slug the expression above resolves.
const BIOMARKER_PANEL_ORDER = panelOrderOfPanelExpr(BIOMARKER_PANEL_KEY);
const BIOMARKER_FAMILY_KEY = biomarkerFamilyKey();
// The same family identity computed over the SAVE store's key column (saved_items.key
// where kind='biomarker' — the canonical analyte name, #1456), so a save keys on the
// identical family identity the readings do.
const SAVED_FAMILY_KEY = familyKeyOfExpr("key");

// Build a "contains" LIKE pattern for free-text search, escaping the SQL wildcards
// (%, _) and the escape char (\) so a user typing e.g. "50%" or "a_b" matches
// literally. Pair with `LIKE ? ESCAPE '\'`.
function likeContains(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

// ---- Cross-source de-duplication (read layer, import assessment P1-1) ----
//
// Storage keeps ONE physical row per source document — lib/import-persist scopes
// every parsed external_id with the document source, so the SAME reading appearing
// in two separately-uploaded documents lands as two rows (and a manual reading
// plus its imported twin as two rows). That is deliberate: deleting one document
// must never orphan a reading a DIFFERENT document independently contributed, and
// the per-document delete-set relies on each document owning its own rows. The
// cost is user-visible double-counting in lists, series, and counts.
//
// This collapses those duplicates at READ time only — no schema change, no storage
// change — so per-document delete semantics are untouched: every physical row still
// exists and is cleared with exactly its own document; deleting one of two documents
// that both contributed a reading simply leaves the other document's row, which this
// CTE then surfaces as the single representative, and deleting the ONLY contributor
// removes the reading entirely.
//
// Content-identity = (profile_id, biomarker FAMILY NOCASE, date, value,
// value_num, unit). The name dimension is the #482 FAMILY key, not the bare name,
// so two names that are the same measurement (a "Vitamin D, 25-Hydroxy" and a
// generic "Vitamin D" reading of the same value/date/unit from two documents)
// collapse to one representative instead of double-counting — the same identity
// the series/starred/is_latest surfaces now use. Rows sharing ALL of these are the
// SAME reading and collapse to one; any difference — most importantly a DIFFERENT
// value for the same date+family (a genuine conflict, not a dup) — puts rows in
// different groups so BOTH stay visible and are never silently merged (so a
// same-date total/D2/D3 breakdown with distinct values stays fully visible; only an
// exact value+date+unit coincidence across two family members would coalesce).
// value/value_num/unit NULLs group together (window PARTITION BY treats NULLs as
// equal), so a numeric-only reading (value NULL, value_num set) dedups correctly too.
//
// Representative rule: prefer a MANUAL row (document_id IS NULL — manual entries
// carry no document; both import paths stamp one) over an imported twin, so the
// user's own entry and its reference_range/flag win; then the most-recent physical
// row (id DESC — a proxy for the newest upload, since a reprocess re-inserts). The
// single `?` binds profile_id.
const DEDUP_IDS_CTE = `deduped AS (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, ${BIOMARKER_FAMILY_KEY} COLLATE NOCASE,
                   date, value, value_num, unit
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM medical_records
    WHERE profile_id = ?
  ) WHERE rn = 1
)`;
// Membership test: this row is the surviving representative of its content-identity.
const IN_DEDUPED = `id IN (SELECT id FROM deduped)`;

// CTE that ranks every reading within its biomarker group (keyed on the #482
// FAMILY identity, case-insensitively — so the vitamin-D 25-OH variants share one
// current reading) newest-first — date, then id as tie-break — and keeps
// only rn = 1, the current reading. Ranked over the DE-DUPED id set (not all rows)
// so the "current value" filter and is_latest marker agree with the de-duplicated
// list: whichever representative dedup kept is the one ranked here, so a manual
// reading preferred by dedup is also the one flagged current. Filtered by
// profile_id, independent of the table's other filters (category/panel/range/q).
// The `?` binds profile_id (a second time, after the deduped CTE's).
const LATEST_IDS_CTE = `latest AS (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, ${BIOMARKER_FAMILY_KEY} COLLATE NOCASE
      ORDER BY date DESC, id DESC
    ) AS rn
    FROM medical_records
    WHERE profile_id = ? AND ${IN_DEDUPED}
  ) WHERE rn = 1
)`;
// True for the current reading in a biomarker group — a membership test against
// the ranked CTE above. Same identity the "current value" filter uses.
const LATEST_IN_GROUP = `id IN (SELECT id FROM latest)`;

// Build an ORDER BY clause for the given sort column, or `fallback` when none
// is set. Columns and direction are whitelisted, so this is safe to inline.
function medicalOrderBy(
  fallback: string,
  sort?: MedicalSortColumn,
  dir: SortDirection = "asc"
): string {
  const d = dir === "desc" ? "DESC" : "ASC";
  const name = `${BIOMARKER_NAME_KEY} COLLATE NOCASE`;
  // Every non-name sort tie-breaks on the canonical name ascending, then id.
  if (sort === "name") return `${name} ${d}, date DESC, id DESC`;
  // Panel sort orders by the RESOLVED panel's curated order (#1502) — clinical
  // sequence, not the alphabetical accident of a slug or a vendor string. The
  // unresolved `other` bucket stays last in BOTH directions, exactly like the
  // pre-#1502 "nulls last" rule it replaces.
  if (sort === "panel")
    return `${BIOMARKER_PANEL_KEY} = 'other', ${BIOMARKER_PANEL_ORDER} ${d}, ${name}, id`;
  if (sort === "date") return `date ${d}, ${name}, id`;
  return fallback;
}

// Stable, order-independent serialization of the filter object so the
// request-scoped cache() below keys on a primitive. Plain object args are
// compared by reference, so two call sites building an equivalent filter (e.g.
// { current: true }) would never share a cache entry; serializing collapses them.
// Sorted via Object.fromEntries rather than a stringify replacer ARRAY — an array
// replacer key-filters at EVERY depth, so a future nested-object filter value
// would be silently stripped from the key (two different filters, one cache slot).
function medicalFiltersKey(filters: MedicalRecordFilters): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );
}

// cache(): one dashboard render fans the same profile's medical_records dedup
// window out ~4× (upcoming biomarker items + preventive inference + the recent-
// labs widget + healthspan pillars), each a full-table scan + sort partitioned by
// a non-indexable name expression (#386). Keyed on (profileId, serialized
// filters) so equivalent calls collapse to a single scan per request.
const getMedicalRecordsCached = cache(function getMedicalRecordsCached(
  profileId: number,
  filtersKey: string
): MedicalRecord[] {
  const filters = JSON.parse(filtersKey) as MedicalRecordFilters;
  // Cross-source de-dup: the list always shows ONE representative per
  // content-identity (see DEDUP_IDS_CTE), so a reading uploaded in two documents —
  // or a manual reading plus its imported twin — is never double-counted.
  const where: string[] = ["profile_id = ?", IN_DEDUPED];
  const args: (string | number)[] = [profileId];
  if (filters.category) {
    where.push("category = ?");
    args.push(filters.category);
  }
  if (filters.excludeCategories && filters.excludeCategories.length > 0) {
    const placeholders = filters.excludeCategories.map(() => "?").join(", ");
    where.push(`category NOT IN (${placeholders})`);
    args.push(...filters.excludeCategories);
  }
  if (filters.panel) {
    // Resolved-panel equality, not `panel = ?` on the stored heading. The slug is
    // a validated PanelId (parsePanelId at the boundary) and the expression is
    // built from hardcoded constants, so inlining it is injection-safe; it also
    // makes `?panel=other` mean "analytes the taxonomy doesn't know", which a
    // bound stored-column compare could never express.
    where.push(`${BIOMARKER_PANEL_KEY} = ?`);
    args.push(filters.panel);
  }
  const rangeClause = rangeFilterClause(filters.range);
  if (rangeClause) {
    where.push(rangeClause);
  }
  if (filters.q) {
    // Match the CANONICAL name too (the row heading the table renders), not just
    // the raw lab string and panel — so a record shown as "Total Cholesterol"
    // (imported as "CHOLESTEROL, TOTAL") is findable by its own visible heading
    // (#383). Raw name still matches so the lab's original string works.
    where.push(
      "(name LIKE ? ESCAPE '\\' OR canonical_name LIKE ? ESCAPE '\\' OR panel LIKE ? ESCAPE '\\')"
    );
    const like = likeContains(filters.q);
    args.push(like, like, like);
  }
  if (filters.current) {
    // Keep only rows with no later reading in the same biomarker group — i.e.
    // the current value. Latest is computed over all readings, independent of
    // the other filters, so the row shown is the biomarker's true latest.
    where.push(LATEST_IN_GROUP);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = medicalOrderBy(
    "date DESC, id DESC",
    filters.sort,
    filters.dir
  );
  // is_latest (1/0) marks the current reading per biomarker group so the table
  // can flag it. Computed over the DE-DUPED readings (via the CTEs), so it holds
  // even when older rows are filtered out of the result set and never marks a
  // collapsed duplicate. Both CTEs bind profile_id (deduped first, then latest —
  // in WITH order), before the main query's `args` (which start with profile_id).
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE},
            ${LATEST_IDS_CTE}
       SELECT *,
              (SELECT p.name FROM providers p WHERE p.id = medical_records.provider_id)
                AS provider_name,
              -- The ORDERING clinician (#1404), a separate link from the performing
              -- lab above, resolved for display the same way.
              (SELECT p.name FROM providers p WHERE p.id = medical_records.ordering_provider_id)
                AS ordering_provider_name,
              (${LATEST_IN_GROUP}) AS is_latest FROM medical_records ${clause} ORDER BY ${orderBy}`
    )
    .all(profileId, profileId, ...args) as MedicalRecord[];
});

export function getMedicalRecords(
  profileId: number,
  filters: MedicalRecordFilters = {}
): MedicalRecord[] {
  return getMedicalRecordsCached(profileId, medicalFiltersKey(filters));
}

// A narrative diagnostic report row (#708): the free-text body of a microbiology
// culture / gram stain / cytopathology report, imported from a CCD/XDM Results-section
// ED-valued observation. It carries its text in `notes` with no value/flag, so it never
// trends — it's a dated document. Feeds Results → Reports only.
export interface ReportRecord {
  id: number;
  date: string;
  name: string;
  notes: string | null;
  loinc: string | null;
  provider_name: string | null;
  document_id: number | null;
  source: string | null;
}

// Every `report`-category record for a profile, newest collection first. Profile-
// scoped; the provider (performing lab/pathologist) is resolved for display.
export function getReportRecords(profileId: number): ReportRecord[] {
  return db
    .prepare(
      `SELECT id, date, name, notes, loinc, document_id, source,
              (SELECT p.name FROM providers p WHERE p.id = medical_records.provider_id)
                AS provider_name
       FROM medical_records
       WHERE profile_id = ? AND category = 'report'
       ORDER BY date DESC, id DESC`
    )
    .all(profileId) as ReportRecord[];
}

// A currently-flagged biomarker reading — a biomarker family whose CURRENT
// (latest-per-family) reading is out-of-range/non-optimal. The minimal shape the
// digest/hero flagged surface consumes (canonical-preferred display name so links
// key on the same identity the biomarker view resolves).
export interface CurrentFlaggedReading {
  name: string;
  canonicalName: string | null;
  value: string | null;
  flag: string;
  date: string;
}

// THE shared "which biomarkers are currently flagged" computation (issue #557).
// Returns one row per biomarker family whose CURRENT reading is flagged, reusing
// the SAME DEDUP+LATEST CTE machinery (LATEST_IDS_CTE / the #482/#394 family
// identity layer) that getMedicalRecords(current:true) drives for the household
// (range:"oor") and passport (range:"nonoptimal") surfaces. So the three surfaces
// can never disagree, and a SUPERSEDED historical out-of-range reading — a
// 5-year-old low that a later normal reading has since replaced — can NEVER
// surface: only an analyte whose LATEST reading is flagged does. Before #557 the
// digest/hero read raw SQL (`created_at > since AND flag NOT IN ...`) with no
// current-reading filter, so any historical flagged row leaked through.
//
// Category scope (#1076): `category = 'lab'` ONLY. This is the care-tier hero +
// digest source, so a non-lab flagged reading — a fever ('vitals'), a high BP
// ('vitals'), a severe PHQ-9 ('instrument') — must NEVER surface here; each is
// owned by its domain engine (temp-red-flag #859, BP percentiles #150, instrument
// severity bands #716/#998). The mental-health/substance sensitivity is load-
// bearing: a depression/alcohol score can never leak into the general health hero.
//
// Flag set: the digest denylist (`flag NOT IN ('normal','immune')`) — equivalent
// to range:"nonoptimal" over the known flag set, and it keeps #544's "immune" (a
// good durable-immunity status) off the care-tier surface.
//
// Recency (#557 fix 2): when `since` is given the read is windowed by BOTH the
// import cursor (`created_at > since` — the digest send-cursor / hero stable
// window, so a delivered digest doesn't re-report and the #283 stable window is
// preserved) AND the COLLECTION date (`date >= date(since)`). The collection-date
// half is what stops a history backfill (created_at = today, collection date years
// ago) from lighting the window even though the old reading is still the current
// one — "newly flagged" means the current reading was actually COLLECTED recently,
// not merely imported recently. Omit `since` for the whole current-flagged set.
export function getCurrentFlaggedBiomarkers(
  profileId: number,
  since?: string
): CurrentFlaggedReading[] {
  const args: (string | number)[] = [profileId, profileId, profileId];
  let windowClause = "";
  if (since != null) {
    windowClause = "AND created_at > ? AND date >= date(?)";
    args.push(since, since);
  }
  // Both CTEs bind profile_id (deduped first, then latest — in WITH order), then
  // the main query's profile_id, then the optional window's two `since` binds.
  // ORDER BY date DESC (newest collection first) with an id ASC tiebreak keeps the
  // slice the caller applies deterministic.
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE},
            ${LATEST_IDS_CTE}
       SELECT COALESCE(NULLIF(TRIM(canonical_name), ''), name) AS name,
              NULLIF(TRIM(canonical_name), '') AS canonicalName,
              value, flag, date
         FROM medical_records
        WHERE profile_id = ? AND ${LATEST_IN_GROUP}
          AND category = 'lab'
          AND flag IS NOT NULL AND flag NOT IN ('normal', 'immune')
          ${windowClause}
        ORDER BY date DESC, id ASC`
    )
    .all(...args) as CurrentFlaggedReading[];
}

// The CURRENT qualitative (value_num IS NULL) lab/biomarker readings — one per
// biomarker family, newest-first — with the name/value/notes/reference/loinc the
// shared classifier (#549) reads. Feeds the condition-suggestion builder (#685):
// unlike getCurrentFlaggedBiomarkers this does NOT pre-filter on the stored `flag`,
// because #549 established the extractor's qualitative flag is untrusted — a positive
// infection the extractor left unflagged must still be caught. Reuses the SAME
// DEDUP+LATEST CTE machinery so it agrees with every other current-reading surface.
export interface CurrentQualitativeReading {
  id: number;
  name: string;
  value: string | null;
  notes: string | null;
  reference: string | null;
  loinc: string | null;
  date: string;
}

export function getCurrentQualitativeResults(
  profileId: number
): CurrentQualitativeReading[] {
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE},
            ${LATEST_IDS_CTE}
       SELECT id,
              COALESCE(NULLIF(TRIM(canonical_name), ''), name) AS name,
              value, notes, reference_range AS reference, loinc, date
         FROM medical_records
        WHERE profile_id = ? AND ${LATEST_IN_GROUP}
          AND category IN ('lab', 'biomarker')
          AND value_num IS NULL
        ORDER BY date DESC, id ASC`
    )
    .all(profileId, profileId, profileId) as CurrentQualitativeReading[];
}

export function getMedicalDocuments(profileId: number): MedicalDocument[] {
  return db
    .prepare(
      "SELECT * FROM medical_documents WHERE profile_id = ? ORDER BY uploaded_at DESC, id DESC"
    )
    .all(profileId) as MedicalDocument[];
}

export function getMedicalDocument(
  profileId: number,
  id: number
): MedicalDocument | undefined {
  return db
    .prepare("SELECT * FROM medical_documents WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as MedicalDocument | undefined;
}

// Fetch several documents at once (e.g. to label a biomarker's readings by
// source) in a single query instead of one lookup per id. Ids arrive from data
// and can't be trusted, so they're filtered by profile_id.
export function getMedicalDocumentsByIds(
  profileId: number,
  ids: number[]
): MedicalDocument[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM medical_documents WHERE profile_id = ? AND id IN (${ids.map(() => "?").join(",")})`
    )
    .all(profileId, ...ids) as MedicalDocument[];
}

// Filters for the per-document results table. Mirrors the biomarkers table's
// affordances (category filter, flag-range filter, free-text search, and a
// sortable name/panel/date column set), so the shared UI controls thread the
// same params through to this query.
export interface DocumentRecordFilters {
  category?: string;
  // Flag-based filter: out-of-range only, or all non-optimal rows.
  range?: RangeFilter;
  // Free-text search matched against name and panel.
  q?: string;
  sort?: MedicalSortColumn;
  dir?: SortDirection;
}

// Records imported from one document, grouped sensibly for review (by panel,
// then name) unless an explicit sort is chosen. Optionally narrowed by category,
// flag range, and free-text search — matching the biomarkers table's filters.
export function getRecordsForDocument(
  profileId: number,
  documentId: number,
  filters: DocumentRecordFilters = {}
): MedicalRecord[] {
  const where = ["profile_id = ?", "document_id = ?"];
  const args: (string | number)[] = [profileId, documentId];
  if (filters.category) {
    where.push("category = ?");
    args.push(filters.category);
  }
  const rangeClause = rangeFilterClause(filters.range);
  if (rangeClause) where.push(rangeClause);
  if (filters.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR panel LIKE ? ESCAPE '\\')");
    const like = likeContains(filters.q);
    args.push(like, like);
  }
  const orderBy = medicalOrderBy(
    "panel IS NULL, panel, name",
    filters.sort,
    filters.dir
  );
  return db
    .prepare(
      `SELECT *,
              (SELECT p.name FROM providers p WHERE p.id = medical_records.provider_id)
                AS provider_name,
              (SELECT p.name FROM providers p WHERE p.id = medical_records.ordering_provider_id)
                AS ordering_provider_name
         FROM medical_records WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`
    )
    .all(...args) as MedicalRecord[];
}

// ---- Biomarkers (canonical names, ranges, series, stars) ----

// The trusted controlled vocabulary: canonical names from the reference table
// (both 'seed' and AI-discovered 'ai' rows). This is the only set fed back to
// the AI as context, so user free-text canonical names never circulate.
// Curated (source='seed') names FIRST, then ai-coined ('ai'), each alphabetical.
// Two consumers depend on this order (#918): the extraction prompt injects only the
// first VOCAB_CAP names, so curated-first guarantees the authoritative vocabulary
// reaches the model instead of being crowded out by accumulated ai-coined names; and
// buildCanonicalIndex resolves a key collision to the FIRST spelling, so a curated
// name always wins over an ai-coined one describing the same analyte.
export function getCanonicalVocabulary(): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM canonical_biomarkers ORDER BY (source = 'ai'), name COLLATE NOCASE"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

// Register AI-produced canonical names (from extraction/backfill) in the
// reference table with source 'ai' and null ranges. INSERT OR IGNORE keeps it
// idempotent and never overwrites a seeded/curated row. NOT called from manual
// entry, so user-typed names never enter the AI-facing vocabulary.
export function addCanonicalNames(names: string[]): void {
  const distinct = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (distinct.length === 0) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO canonical_biomarkers (name, source) VALUES (?, 'ai')"
  );
  writeTx(() => {
    for (const n of distinct) insert.run(n);
  });
}

// Distinct canonical names actually used by records — including user-typed ones
// not in the vocabulary, so prior manual names still autocomplete.
export function getUsedCanonicalNames(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT canonical_name FROM medical_records
         WHERE profile_id = ? AND canonical_name IS NOT NULL AND TRIM(canonical_name) != ''
         ORDER BY canonical_name COLLATE NOCASE`
      )
      .all(profileId) as { canonical_name: string }[]
  ).map((r) => r.canonical_name);
}

// Vocabulary ∪ used names — the autocomplete source for the canonical-name input.
export function getCanonicalAutocomplete(profileId: number): string[] {
  const set = new Map<string, string>(); // lowercased -> display
  for (const n of getCanonicalVocabulary()) set.set(n.toLowerCase(), n);
  for (const n of getUsedCanonicalNames(profileId))
    if (!set.has(n.toLowerCase())) set.set(n.toLowerCase(), n);
  return [...set.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// The single most recent record for a canonical name (newest date, id tie-break),
// or undefined. Used by the profile passport to read the latest 'ABO Blood Group'
// and 'Rh Type' records — a record read, not a biomarker chart.
export function getLatestMedicalRecordByCanonical(
  profileId: number,
  canonical: string
): MedicalRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM medical_records
       WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE
       ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId, canonical) as MedicalRecord | undefined;
}

// All readings for one canonical biomarker, oldest first (for the chart + table).
// De-duplicated across sources: the same reading uploaded in two documents (or a
// manual reading plus its imported twin) appears ONCE on the chart/table, while a
// genuinely differing value for the same date stays visible as its own point. The
// deduped CTE binds profile_id first, then the main WHERE binds it again.
// cache(): the derived-index and bio-age paths each request one series per input
// analyte (~10-20 per render), and the same analyte is often charted again on the
// same request — each call re-runs the O(N log N) dedup window over the profile's
// whole lab history (#386). Primitive args, so cache() dedupes per (profile,
// canonical) per request with no key gymnastics.
export const getBiomarkerSeries = cache(function getBiomarkerSeries(
  profileId: number,
  canonical: string
): MedicalRecord[] {
  // Match by the #482 FAMILY identity, not the exact canonical name: a request for
  // any family member (e.g. the total-25-OH spellings, or A1c ↔ eAG) returns the
  // WHOLE family's readings, so the chart/detail page and the starred tile show one
  // series instead of several — the same collapse the dedup/latest partitions apply.
  // A non-family analyte's family key is just its own name, so its series is
  // unchanged. NOTE (#1193): the vitamin-D D2/D3 FRACTIONS are NOT in this family
  // anymore — each is its own trendable series (biomarkerFamily gives it its own
  // identity), so a request for "Vitamin D3, 25-Hydroxy" returns only the D3
  // readings, apart from the total; they share only the retest clock.
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE AND ${IN_DEDUPED}
       ORDER BY date ASC, id ASC`
    )
    .all(profileId, profileId, biomarkerFamily(canonical)) as MedicalRecord[];
});

// The latest two numeric readings of a biomarker family, oldest→newest — the exact
// tail getBiomarkerSeries's caller reads to compute a trend delta (#1367). The
// dashboard vitals card only needs the last two points latestTrend consumes, not the
// whole history, so this bounds the query with `ORDER BY date DESC LIMIT 2` instead of
// materializing years of synced BP readings on every render. Filtering
// `value_num IS NOT NULL` here matches the card's `.filter(r => r.value_num != null)`,
// so the two rows returned are IDENTICAL to the tail of the filtered full series — a
// pure query-bound optimization, no display change. Same DEDUP/family collapse as
// getBiomarkerSeries; the DESC+reverse tie-break (date, then id) mirrors its ASC order.
export function getLatestBiomarkerTrendPoints(
  profileId: number,
  canonical: string
): MedicalRecord[] {
  const rows = db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE
         AND ${IN_DEDUPED} AND value_num IS NOT NULL
       ORDER BY date DESC, id DESC LIMIT 2`
    )
    .all(profileId, profileId, biomarkerFamily(canonical)) as MedicalRecord[];
  return rows.reverse();
}

// Every canonically-named reading for a profile in ONE deduped pass, ordered so
// each analyte's rows are contiguous and oldest-first — the bulk companion to
// getBiomarkerSeries for callers that need EVERY analyte's series (the trajectory
// rules). Per-analyte getBiomarkerSeries calls re-run the dedup window over the
// whole table each time, which is O(analytes × records) per request (#105);
// grouping this one result by canonical name (lib/biomarker-group) yields the
// same per-analyte series as N individual calls.
export function getAllBiomarkerSeries(profileId: number): MedicalRecord[] {
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND canonical_name IS NOT NULL
         AND TRIM(canonical_name) != '' AND ${IN_DEDUPED}
       ORDER BY canonical_name COLLATE NOCASE, date ASC, id ASC`
    )
    .all(profileId, profileId) as MedicalRecord[];
}

// The content-identity of a reading — the tuple the read-layer de-dup groups on.
// `nameKey` is the display/grouping name (canonical when present, else the raw
// name), matching biomarkerNameKey().
export interface RecordIdentity {
  nameKey: string;
  date: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
}

// Every stored medical_records row for THIS profile whose content-identity matches
// `identity` — same (canonical-or-raw name NOCASE, date, value, value_num, unit).
// This is the row-level counterpart of the DEDUP_IDS_CTE grouping key: the CTE
// collapses these to one representative for lists/series/counts, and this helper
// surfaces the full set behind that representative — the seam a later
// conflict-surfacing feature reads (an imported reading whose value DIFFERS from an
// existing same date+analyte reading is, by definition, NOT returned here, so the
// two stay distinct). Manual-preferred, newest-first, mirroring the representative
// rule. `IS ?` matches NULL value/value_num/unit correctly. Profile-scoped.
export function findRecordsByContentIdentity(
  profileId: number,
  identity: RecordIdentity
): MedicalRecord[] {
  return db
    .prepare(
      `SELECT * FROM medical_records
       WHERE profile_id = ?
         AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE
         AND date = ?
         AND value IS ?
         AND value_num IS ?
         AND unit IS ?
       ORDER BY (document_id IS NULL) DESC, id DESC`
    )
    .all(
      profileId,
      biomarkerFamily(identity.nameKey),
      identity.date,
      identity.value,
      identity.value_num,
      identity.unit
    ) as MedicalRecord[];
}

// Drop any saved biomarker whose FAMILY no longer has a backing record (its last
// reading was deleted or its canonical name changed), so the status card can't
// point at nothing. Family-keyed (#482): a save on "Vitamin D, 25-Hydroxy"
// survives as long as ANY family member (a D2/D3 breakdown) still has a reading,
// matching the family-collapsed tile. Shared by every path that deletes records.
// Scoped to kind='biomarker' — a `trend-metric` save keys on a metric id, not a
// biomarker name, and must never be swept by a records-driven de-orphan (#1456).
export function cleanupOrphanSavedBiomarkers(profileId: number): void {
  db.prepare(
    `DELETE FROM saved_items
     WHERE profile_id = ?
       AND kind = 'biomarker'
       AND ${SAVED_FAMILY_KEY} NOT IN (
         SELECT ${BIOMARKER_FAMILY_KEY} FROM medical_records
         WHERE profile_id = ? AND canonical_name IS NOT NULL
       )`
  ).run(profileId, profileId);
}

// True when THIS biomarker — or any sibling in its #482 family — is saved, so
// the star toggle reflects the family-collapsed tile (starring "Vitamin D, Total"
// lights the star on the "Vitamin D3" detail page too). Saves are few, so the
// family compare is done in JS over the profile's saved biomarker list.
export function isBiomarkerSaved(
  profileId: number,
  canonical: string
): boolean {
  const fam = biomarkerFamily(canonical);
  const saved = db
    .prepare(
      "SELECT key FROM saved_items WHERE profile_id = ? AND kind = 'biomarker'"
    )
    .all(profileId) as { key: string }[];
  return saved.some((s) => biomarkerFamily(s.key) === fam);
}

// Save a biomarker for a profile (the star half of the toggle). Idempotent — the
// store's NOCASE UNIQUE makes a re-save a no-op — and deliberately keyed on the NAME
// the user starred, not its family key: the family is resolved on READ
// (isBiomarkerSaved / getSavedBiomarkers), so the stored row stays a real analyte
// name that a rename can re-key (#203) and a human can read in an export.
export function saveBiomarker(profileId: number, canonical: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)`
  ).run(profileId, canonical);
}

// Remove every saved biomarker in a #482 family (the unsave half of the toggle):
// because a save on any member lights the whole family, un-saving must clear all
// of them, not just the exact name — else isBiomarkerSaved would still report the
// family saved and the toggle would appear stuck. Returns rows deleted.
export function unsaveBiomarkerFamily(
  profileId: number,
  canonical: string
): number {
  const fam = biomarkerFamily(canonical);
  const info = db
    .prepare(
      `DELETE FROM saved_items
        WHERE profile_id = ? AND kind = 'biomarker'
          AND ${SAVED_FAMILY_KEY} = ? COLLATE NOCASE`
    )
    .run(profileId, fam);
  return info.changes;
}

// Toggle a biomarker's save, returning the resulting state — the write core behind
// the ★ gesture (auth-blind, profileId-first; the Server Action in
// app/(app)/saved-actions.ts is the auth boundary). Check-then-act as ONE atomic
// transaction so two concurrent toggles can't both read the same state and race (two
// inserts, or an insert lost to a delete). Unsave clears the whole #482 family.
export function toggleBiomarkerSaved(
  profileId: number,
  canonical: string
): boolean {
  return writeTx(() => {
    if (isBiomarkerSaved(profileId, canonical)) {
      unsaveBiomarkerFamily(profileId, canonical);
      return false;
    }
    saveBiomarker(profileId, canonical);
    return true;
  });
}

export interface SavedBiomarker {
  canonical_name: string;
  latest_value: string | null;
  latest_value_num: number | null;
  latest_unit: string | null;
  latest_flag: MedicalFlag | null;
  latest_date: string | null;
  // The latest reading's own record category (e.g. 'genomics') — carried so the
  // tile judges staleness on the RECORD's category, exactly like the detail page
  // (latest.category) and the table (r.category). The canonical entry's category
  // is null for AI-registered rows and never 'genomics', so it could never fire
  // the never-stale genomics rule from the tile (#381).
  latest_category: string | null;
  // Latest reading's notes + reference text — carried so the tile's staleness check
  // can recognize an immune-positive durable-immunity titer (#516), exactly like the
  // detail page and table (which read the full MedicalRecord).
  latest_notes: string | null;
  latest_reference_range: string | null;
  // Reference entry (ranges/direction) joined in so the chip needs no extra query.
  canonical: CanonicalBiomarker | null;
}

// Saved biomarkers with their latest reading and the canonical reference entry
// (ranges/direction). The one read behind every biomarker-save surface: the Results →
// Biomarkers status card, the Trends Overview chart tiles, and the profile passport
// summary (#1456 — save membership IS summary inclusion; see lib/profile-summary-load).
//
// Ordered by the canonical saved order — positioned rows first, then unpositioned ones
// newest-first — the SQL twin of orderSavedRefs() in lib/saved-items.ts (position is
// set only by the Trends reorder affordance; a plain star leaves it NULL).
export function getSavedBiomarkers(profileId: number): SavedBiomarker[] {
  const stars = (
    db
      .prepare(
        `SELECT key FROM saved_items
          WHERE profile_id = ? AND kind = 'biomarker'
          ORDER BY (position IS NULL), position, created_at DESC, id DESC`
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
  if (stars.length === 0) return [];

  // The latest reading, chosen over the DE-DUPED id set so it agrees with the
  // detail page / table (which read via getBiomarkerSeries / getMedicalRecords):
  // when a manual reading and its imported twin share content-identity, dedup's
  // representative rule (prefer the manual, unflagged row) wins here too, so the
  // tile's flag chip matches the representative the other surfaces show (#381).
  // Matched by the #482 FAMILY identity, so a save on "Vitamin D, 25-Hydroxy"
  // surfaces the newest reading of ANY family member (a fresh D3 breakdown), the
  // same series the chart shows. Binds profile_id (for DEDUP_IDS_CTE), then
  // profile_id + the saved name's family key.
  const latestStmt = db.prepare(
    `WITH ${DEDUP_IDS_CTE}
     SELECT * FROM medical_records
     WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE AND ${IN_DEDUPED}
     ORDER BY date DESC, id DESC LIMIT 1`
  );

  // Fetch the canonical reference entries for all saved names in one query
  // (the table's PK is COLLATE NOCASE, so IN matches case-insensitively),
  // rather than a per-save lookup.
  const cbRows = db
    .prepare(
      `SELECT * FROM canonical_biomarkers
       WHERE name IN (${stars.map(() => "?").join(",")})`
    )
    .all(...stars) as CanonicalBiomarker[];
  const cbByName = new Map(cbRows.map((c) => [c.name.toLowerCase(), c]));

  return stars.map((name) => {
    const latest = latestStmt.get(
      profileId,
      profileId,
      biomarkerFamily(name)
    ) as MedicalRecord | undefined;
    const cb = cbByName.get(name.toLowerCase()) ?? null;
    return {
      canonical_name: name,
      latest_value: latest?.value ?? null,
      latest_value_num: latest?.value_num ?? null,
      latest_unit: latest?.unit ?? null,
      latest_flag: latest?.flag ?? null,
      latest_date: latest?.date ?? null,
      latest_category: latest?.category ?? null,
      latest_notes: latest?.notes ?? null,
      latest_reference_range: latest?.reference_range ?? null,
      canonical: cb,
    };
  });
}
