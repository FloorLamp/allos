import { db } from "../db";
import { cache } from "../request-cache";
import {
  getStoredAge,
  getUserBirthdate,
  getUserReproductiveStatus,
  getUserSex,
} from "../settings";
import { computeFlagReconciliation } from "../flag-reconcile";
import {
  TITER_DISTINCTIVE_TOKENS,
  matchesImmunityMarker,
  markerNameTokens,
} from "../titer-match";
import {
  titerImmuneStatus,
  immuneThresholdFor,
  type TiterStatus,
  type OverrideKind,
} from "../immunization-status";
import type {
  CanonicalBiomarker,
  Encounter,
  Immunization,
  MedicalDocument,
  MedicalFlag,
  MedicalRecord,
} from "../types";

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
  panel?: string;
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
// Content-identity = (profile_id, canonical-or-raw name NOCASE, date, value,
// value_num, unit). Rows sharing ALL of these are the SAME reading and collapse to
// one; any difference — most importantly a DIFFERENT value for the same
// date+analyte (a genuine conflict, not a dup) — puts rows in different groups so
// BOTH stay visible and are never silently merged. value/value_num/unit NULLs group
// together (window PARTITION BY treats NULLs as equal), so a numeric-only reading
// (value NULL, value_num set) dedups correctly too.
//
// Representative rule: prefer a MANUAL row (document_id IS NULL — manual entries
// carry no document; both import paths stamp one) over an imported twin, so the
// user's own entry and its reference_range/flag win; then the most-recent physical
// row (id DESC — a proxy for the newest upload, since a reprocess re-inserts). The
// single `?` binds profile_id.
const DEDUP_IDS_CTE = `deduped AS (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, ${BIOMARKER_NAME_KEY} COLLATE NOCASE,
                   date, value, value_num, unit
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM medical_records
    WHERE profile_id = ?
  ) WHERE rn = 1
)`;
// Membership test: this row is the surviving representative of its content-identity.
const IN_DEDUPED = `id IN (SELECT id FROM deduped)`;

// CTE that ranks every reading within its biomarker group (keyed on the canonical
// name, case-insensitively) newest-first — date, then id as tie-break — and keeps
// only rn = 1, the current reading. Ranked over the DE-DUPED id set (not all rows)
// so the "current value" filter and is_latest marker agree with the de-duplicated
// list: whichever representative dedup kept is the one ranked here, so a manual
// reading preferred by dedup is also the one flagged current. Filtered by
// profile_id, independent of the table's other filters (category/panel/range/q).
// The `?` binds profile_id (a second time, after the deduped CTE's).
const LATEST_IDS_CTE = `latest AS (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, ${BIOMARKER_NAME_KEY} COLLATE NOCASE
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
  if (sort === "panel")
    return `panel IS NULL, panel COLLATE NOCASE ${d}, ${name}, id`;
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
    where.push("panel = ?");
    args.push(filters.panel);
  }
  const rangeClause = rangeFilterClause(filters.range);
  if (rangeClause) {
    where.push(rangeClause);
  }
  if (filters.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR panel LIKE ? ESCAPE '\\')");
    const like = likeContains(filters.q);
    args.push(like, like);
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
                AS provider_name
         FROM medical_records WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`
    )
    .all(...args) as MedicalRecord[];
}

// ---- Biomarkers (canonical names, ranges, series, stars) ----

// The trusted controlled vocabulary: canonical names from the reference table
// (both 'seed' and AI-discovered 'ai' rows). This is the only set fed back to
// the AI as context, so user free-text canonical names never circulate.
export function getCanonicalVocabulary(): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM canonical_biomarkers ORDER BY name COLLATE NOCASE"
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
  const run = db.transaction(() => {
    for (const n of distinct) insert.run(n);
  });
  run();
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

// Full reference-dataset entry (unit + ranges) for a canonical name, for the
// detail-page header and chart bands. Case-insensitive (table PK is NOCASE).
export function getCanonicalBiomarker(
  name: string
): CanonicalBiomarker | undefined {
  return db
    .prepare("SELECT * FROM canonical_biomarkers WHERE name = ? COLLATE NOCASE")
    .get(name) as CanonicalBiomarker | undefined;
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
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE AND ${IN_DEDUPED}
       ORDER BY date ASC, id ASC`
    )
    .all(profileId, profileId, canonical) as MedicalRecord[];
});

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
         AND ${BIOMARKER_NAME_KEY} = ? COLLATE NOCASE
         AND date = ?
         AND value IS ?
         AND value_num IS ?
         AND unit IS ?
       ORDER BY (document_id IS NULL) DESC, id DESC`
    )
    .all(
      profileId,
      identity.nameKey,
      identity.date,
      identity.value,
      identity.value_num,
      identity.unit
    ) as MedicalRecord[];
}

// Drop any star whose biomarker no longer has a backing record (its last
// reading was deleted or its canonical name changed), so the pinned card can't
// point at nothing. Shared by every path that deletes medical records.
export function cleanupOrphanStars(profileId: number): void {
  db.prepare(
    `DELETE FROM starred_biomarkers
     WHERE profile_id = ?
       AND canonical_name NOT IN (
         SELECT canonical_name FROM medical_records
         WHERE profile_id = ? AND canonical_name IS NOT NULL
       )`
  ).run(profileId, profileId);
}

export function isBiomarkerStarred(
  profileId: number,
  canonical: string
): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM starred_biomarkers WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE"
      )
      .get(profileId, canonical)
  );
}

export interface StarredBiomarker {
  canonical_name: string;
  latest_value: string | null;
  latest_value_num: number | null;
  latest_unit: string | null;
  latest_flag: MedicalFlag | null;
  latest_date: string | null;
  // Reference entry (ranges/direction) joined in so the chip needs no extra query.
  canonical: CanonicalBiomarker | null;
}

// Starred biomarkers with their latest reading and the canonical reference
// entry (ranges/direction). Used by the pinned card on / and /biomarkers.
export function getStarredBiomarkers(profileId: number): StarredBiomarker[] {
  const stars = (
    db
      .prepare(
        "SELECT canonical_name FROM starred_biomarkers WHERE profile_id = ? ORDER BY created_at DESC"
      )
      .all(profileId) as { canonical_name: string }[]
  ).map((r) => r.canonical_name);
  if (stars.length === 0) return [];

  const latestStmt = db.prepare(
    `SELECT * FROM medical_records WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE
     ORDER BY date DESC, id DESC LIMIT 1`
  );

  // Fetch the canonical reference entries for all starred names in one query
  // (the table's PK is COLLATE NOCASE, so IN matches case-insensitively),
  // rather than a per-star lookup.
  const cbRows = db
    .prepare(
      `SELECT * FROM canonical_biomarkers
       WHERE name IN (${stars.map(() => "?").join(",")})`
    )
    .all(...stars) as CanonicalBiomarker[];
  const cbByName = new Map(cbRows.map((c) => [c.name.toLowerCase(), c]));

  return stars.map((name) => {
    const latest = latestStmt.get(profileId, name) as MedicalRecord | undefined;
    const cb = cbByName.get(name.toLowerCase()) ?? null;
    return {
      canonical_name: name,
      latest_value: latest?.value ?? null,
      latest_value_num: latest?.value_num ?? null,
      latest_unit: latest?.unit ?? null,
      latest_flag: latest?.flag ?? null,
      latest_date: latest?.date ?? null,
      canonical: cb,
    };
  });
}

// ---- Immunizations ----

// All recorded vaccine doses for a profile, newest first. `vaccine` is a
// catalog/combo code (or slug); the immunizations page resolves display names
// and schedule status via lib/immunization-catalog + lib/immunization-status.
// De-duplicated across sources: the same dose imported from two documents (a
// comprehensive CCD after a per-visit one) appears ONCE. Content-identity is
// (profile_id, vaccine, date, dose_label) — the natural key of a physical dose;
// two docs contributing the same dose share all four. Representative prefers a
// MANUAL dose (source not a 'document:%' import) over an imported twin, then the
// most recent id. Delete semantics are untouched: every physical row still lives
// under its own document source and is cleared with it (clearImportedDocumentRows),
// so deleting one of two documents leaves the other's dose to represent the group.
// The deduped CTE binds profile_id first, then the main WHERE binds it again.
export function getImmunizations(profileId: number): Immunization[] {
  return db
    .prepare(
      `WITH imm_deduped AS (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY profile_id, vaccine, date, COALESCE(dose_label, '')
             ORDER BY (source IS NULL OR source NOT LIKE 'document:%') DESC, id DESC
           ) AS rn
           FROM immunizations WHERE profile_id = ?
         ) WHERE rn = 1
       )
       SELECT id, date, vaccine, dose_label, notes, source, external_id, created_at,
              provider_id,
              (SELECT p.name FROM providers p WHERE p.id = immunizations.provider_id)
                AS provider_name
       FROM immunizations
       WHERE profile_id = ? AND id IN (SELECT id FROM imm_deduped)
       ORDER BY date DESC, id DESC`
    )
    .all(profileId, profileId) as Immunization[];
}

export interface ImmunizationOverrideRow {
  vaccine: string; // catalog code the override applies to
  kind: OverrideKind;
  reason: string | null;
  note: string | null;
  created_at: string;
}

// All manual per-vaccine status overrides for a profile. Feeds the
// pure `applyOverride` resolver in the schedule assessment and the detail view's
// override controls.
export function getImmunizationOverrides(
  profileId: number
): ImmunizationOverrideRow[] {
  return db
    .prepare(
      `SELECT vaccine, kind, reason, note, created_at
       FROM immunization_overrides WHERE profile_id = ?`
    )
    .all(profileId) as ImmunizationOverrideRow[];
}

// The single override in effect for one vaccine code, or null. Used by the
// per-vaccine detail view to render its current override state.
export function getImmunizationOverride(
  profileId: number,
  vaccine: string
): ImmunizationOverrideRow | null {
  return (db
    .prepare(
      `SELECT vaccine, kind, reason, note, created_at
       FROM immunization_overrides WHERE profile_id = ? AND vaccine = ?`
    )
    .get(profileId, vaccine) ?? null) as ImmunizationOverrideRow | null;
}

export interface ImmunityTiter {
  marker: string; // biomarker name as stored (canonical or raw)
  value: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
  status: TiterStatus; // interpreted immune / non-immune / indeterminate
}

// Aggregate the profile's immunity/antibody titers: the latest reading per
// biomarker whose canonical/raw name matches one of the catalog's antibody
// markers (anti-HBs, MMR/VZV IgG, …), interpreted into an immune/non-immune
// status. Feeds both the "Immunity titers" section and series-completeness in
// the schedule assessment.
export function getImmunityTiters(profileId: number): ImmunityTiter[] {
  if (TITER_DISTINCTIVE_TOKENS.length === 0) return [];
  // SQL prefilter on a distinctive disease token to avoid scanning every record;
  // a true subset match always contains at least one distinctive token, so this
  // never drops a real titer. Final precision is the JS subset match below.
  const likeClauses = TITER_DISTINCTIVE_TOKENS.map(
    () => `${BIOMARKER_NAME_KEY} LIKE ? ESCAPE '\\'`
  ).join(" OR ");
  const rows = db
    .prepare(
      `SELECT * FROM medical_records
       WHERE profile_id = ?
         AND (${likeClauses})
       ORDER BY date DESC, id DESC`
    )
    .all(
      profileId,
      ...TITER_DISTINCTIVE_TOKENS.map((t) => likeContains(t))
    ) as MedicalRecord[];

  // Keep the latest reading per marker (rows already ordered newest-first).
  const seen = new Set<string>();
  const out: ImmunityTiter[] = [];
  for (const r of rows) {
    const marker = (r.canonical_name?.trim() || r.name).trim();
    const recordTokens = markerNameTokens(marker);
    if (!matchesImmunityMarker(recordTokens)) continue;
    const key = marker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Interpret from the string value, falling back to the numeric value when a
    // titer was stored numerically (value NULL, value_num set) so a numeric
    // anti-HBs like 45 still reads "immune" against its threshold.
    const forStatus =
      r.value ?? (r.value_num != null ? String(r.value_num) : null);
    out.push({
      marker,
      value: r.value,
      value_num: r.value_num,
      unit: r.unit,
      date: r.date,
      status: titerImmuneStatus(forStatus, {
        immuneAtLeast: immuneThresholdFor(marker),
      }),
    });
  }
  return out;
}

// Reconcile each record's flag against our canonical ranges: clinical high/low
// from the reference range (overriding an over-strict or missing lab flag),
// non-optimal from the optimal band, cleared when optimal — so the stored flag
// never contradicts the live-computed status. Never touches 'abnormal'
// (qualitative). Pass `ids` to limit the scan to specific rows (e.g. a
// just-imported batch); omit to evaluate all eligible rows. Returns the number
// of rows whose flag changed.
export function reconcileFlags(profileId: number, ids?: number[]): number {
  // profile_id scopes every row, so an id from another profile in `ids` simply
  // can't match — the caller's list is never trusted on its own.
  let sql = `SELECT id, value_num, unit, canonical_name, flag, date FROM medical_records
     WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
       AND (flag IS NULL OR flag IN ('normal','non-optimal','non-optimal-high','non-optimal-low','high','low'))`;
  const args: number[] = [profileId];
  if (ids) {
    if (ids.length === 0) return 0;
    sql += ` AND id IN (${ids.map(() => "?").join(",")})`;
    args.push(...ids);
  }
  const rows = db.prepare(sql).all(...args) as {
    id: number;
    value_num: number;
    unit: string | null;
    canonical_name: string;
    flag: string | null;
    date: string;
  }[];

  // Sex + age context: age-banded ranges are judged against the subject's age on
  // each record's own collection date (from the birthdate), so read the profile's
  // birthdate/stored-age once and let computeFlagReconciliation derive per-row age.
  const sex = getUserSex(profileId);
  const birthdate = getUserBirthdate(profileId);
  const storedAge = getStoredAge(profileId);
  // Reproductive status (female physiology only) overrides the age proxy for the
  // reproductive hormones — a profile-level attribute applied to all its records.
  const reproductiveStatus = getUserReproductiveStatus(profileId);
  // Preload the whole canonical table into a case-insensitive map so the loop is a
  // hash lookup, not a per-record `SELECT ... COLLATE NOCASE` (N+1). Mirrors the
  // boot-time reconcileNonOptimalFlags in lib/db.ts. The canonical PK is NOCASE and
  // biomarker names are ASCII, so lowercasing keys matches SQLite's NOCASE compare.
  const cbByName = new Map(
    (
      db
        .prepare("SELECT * FROM canonical_biomarkers")
        .all() as CanonicalBiomarker[]
    ).map((c) => [c.name.toLowerCase(), c])
  );

  // The per-row flag-derivation is the pure shared decision (lib/flag-reconcile),
  // so this and the boot-time reconcile in lib/db.ts stay in lock-step.
  const changes = computeFlagReconciliation(rows, cbByName, {
    sex,
    birthdate,
    age: storedAge,
    reproductiveStatus,
  });
  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  const run = db.transaction(() => {
    for (const c of changes) {
      if (c.flag === null) clear.run(c.id);
      else setFlag.run(c.flag, c.id);
    }
  });
  run();
  return changes.length;
}

// ---- Encounters / visits ----

// The id of the representative encounter for each distinct visit, collapsing the
// per-document duplicates two overlapping CCDs produce (each portal export carries
// the full history, so the same visit is stored once PER uploaded document — see
// import-persist's source-scoped external_id, which keeps a per-document delete from
// orphaning another document's copy). This is the SINGLE source of truth for that
// collapse, shared by the Visits list, the Timeline, and Search so every read
// surface hides the duplicates identically (the timeline/search once did NOT — the
// user-visible "duplicate visits" bug).
//
// Identity prefers the CCD's own encounter id: the stored external_id is
// source-scoped as "<document:N>|<ccda:encounter:...>", so stripping the "<source>|"
// prefix recovers the doc-independent key and the same visit from two uploads
// collapses even when one copy is thinner (reason/diagnoses filled in only one). A
// row with no external_id (a manual entry) falls back to a conservative content key
// (date/end_date/type/class_code/reason), so two genuinely distinct visits on one
// day stay visible while identical re-imports collapse. Representative prefers a
// MANUAL row (document_id IS NULL), then the most recent id. Takes one profile_id
// bind param; storage / per-document delete are untouched.
export const ENCOUNTER_REPRESENTATIVE_IDS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY profile_id, COALESCE(
        CASE WHEN external_id IS NOT NULL
             THEN substr(external_id, instr(external_id, '|') + 1) END,
        date || '|' || COALESCE(end_date, '') || '|' || COALESCE(type, '')
             || '|' || COALESCE(class_code, '') || '|' || COALESCE(reason, '')
      )
      ORDER BY (document_id IS NULL) DESC, id DESC
    ) AS rn
    FROM encounters WHERE profile_id = ?
  ) WHERE rn = 1`;

// The profile's visit history, newest first. Joins the shared providers registry
// for the attending clinician + facility display names (LEFT JOINs so an
// unlinked/absent provider just shows blank). Profile-scoped on the encounters row,
// de-duplicated across documents via ENCOUNTER_REPRESENTATIVE_IDS. The deduped
// subquery binds profile_id first, then the main WHERE binds it again.
// cache(): the dashboard's upcoming/preventive fan-out reads the visit history
// several times per render (window passes over the same deduped set), each a
// window-partition scan of the encounters table (#386). Single primitive arg, so
// cache() collapses those to one scan per profile per request.
export const getEncounters = cache(function getEncounters(
  profileId: number
): Encounter[] {
  return db
    .prepare(
      `SELECT e.id, e.date, e.end_date, e.type, e.class_code, e.reason,
              e.diagnoses, e.provider_id, p.name AS provider_name,
              e.location_provider_id, l.name AS location_name,
              e.notes, e.source, e.document_id, e.external_id, e.created_at
         FROM encounters e
         LEFT JOIN providers p ON p.id = e.provider_id
         LEFT JOIN providers l ON l.id = e.location_provider_id
        WHERE e.profile_id = ? AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
        ORDER BY e.date DESC, e.id DESC`
    )
    .all(profileId, profileId) as Encounter[];
});

// A single visit for the detail page (/encounters/[id]). Profile-scoped on BOTH id
// AND profile_id, so a member can never open another profile's visit by guessing an
// id. Not deduped — a detail page shows exactly the requested row. Returns null when
// the id doesn't belong to the profile.
export function getEncounter(profileId: number, id: number): Encounter | null {
  return (
    (db
      .prepare(
        `SELECT e.id, e.date, e.end_date, e.type, e.class_code, e.reason,
                e.diagnoses, e.provider_id, p.name AS provider_name,
                e.location_provider_id, l.name AS location_name,
                e.notes, e.source, e.document_id, e.external_id, e.created_at
           FROM encounters e
           LEFT JOIN providers p ON p.id = e.provider_id
           LEFT JOIN providers l ON l.id = e.location_provider_id
          WHERE e.id = ? AND e.profile_id = ?`
      )
      .get(id, profileId) as Encounter | undefined) ?? null
  );
}
