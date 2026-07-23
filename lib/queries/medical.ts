import { db, writeTx } from "../db";
import { cache } from "../request-cache";
import { biomarkerFamily, BIOMARKER_FAMILIES } from "../canonical-name";
import {
  getStoredAge,
  getUserBirthdate,
  getUserReproductiveStatus,
  getUserSex,
} from "../settings";
import {
  ageForRecord,
  computeFlagReconciliation,
  computeQualitativeFlagChanges,
} from "../flag-reconcile";
import { listCyclePeriods } from "../cycle-store";
import { detectUnitMislabel } from "../reference-range";
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
import type { PersistInput } from "../import-shape";

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

// The biomarker FAMILY identity as a SQL expression (#482) — the ONE grouping key
// every biomarker surface partitions/matches on so none of them can disagree about
// what "Vitamin D" is: the dedup partition, the is_latest/current marker, the
// chart/detail series, and the starred tile all key on THIS instead of the bare
// per-name key. It is the finite-preimage (#394) realization of the pure
// biomarkerFamily(): SQL can't call the JS matcher, so each family's member
// spellings are inlined as an `IN (...)` preimage (from the shared BIOMARKER_FAMILIES
// data — one source of truth with the JS side) and every other name falls through to
// the plain display-name key, byte-for-byte the pre-#482 grouping for non-family
// analytes. Family keys and member strings are hardcoded constants (single-quote
// escaped), so this is injection-safe. Pass a table alias for a self-join.
function sqlStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
// The family CASE over an arbitrary name expression — reused both for the records
// grouping key (over the canonical-or-raw display name) and the star store (over
// its bare canonical_name column), so both key on the identical family identity.
function familyKeyOfExpr(nameExpr: string): string {
  const whens = BIOMARKER_FAMILIES.map((fam) => {
    const inList = fam.members.map(sqlStringLiteral).join(", ");
    return `WHEN lower(${nameExpr}) IN (${inList}) THEN ${sqlStringLiteral(
      `family:${fam.key}`
    )}`;
  }).join(" ");
  return `CASE ${whens} ELSE ${nameExpr} END`;
}
export function biomarkerFamilyKey(alias = ""): string {
  return familyKeyOfExpr(biomarkerNameKey(alias));
}
const BIOMARKER_FAMILY_KEY = biomarkerFamilyKey();
// The same family identity computed over the star store's canonical_name column.
const STAR_FAMILY_KEY = familyKeyOfExpr("canonical_name");

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
                AS provider_name
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

// Drop any star whose biomarker FAMILY no longer has a backing record (its last
// reading was deleted or its canonical name changed), so the pinned card can't
// point at nothing. Family-keyed (#482): a star on "Vitamin D, 25-Hydroxy"
// survives as long as ANY family member (a D2/D3 breakdown) still has a reading,
// matching the family-collapsed tile. Shared by every path that deletes records.
export function cleanupOrphanStars(profileId: number): void {
  db.prepare(
    `DELETE FROM starred_biomarkers
     WHERE profile_id = ?
       AND ${STAR_FAMILY_KEY} NOT IN (
         SELECT ${BIOMARKER_FAMILY_KEY} FROM medical_records
         WHERE profile_id = ? AND canonical_name IS NOT NULL
       )`
  ).run(profileId, profileId);
}

// True when THIS biomarker — or any sibling in its #482 family — is starred, so
// the star toggle reflects the family-collapsed tile (starring "Vitamin D, Total"
// lights the star on the "Vitamin D3" detail page too). Stars are few, so the
// family compare is done in JS over the profile's star list.
export function isBiomarkerStarred(
  profileId: number,
  canonical: string
): boolean {
  const fam = biomarkerFamily(canonical);
  const stars = db
    .prepare(
      "SELECT canonical_name FROM starred_biomarkers WHERE profile_id = ?"
    )
    .all(profileId) as { canonical_name: string }[];
  return stars.some((s) => biomarkerFamily(s.canonical_name) === fam);
}

// Remove every star in a biomarker's #482 family (the unstar half of the toggle):
// because a star on any member lights the whole family, un-starring must clear all
// of them, not just the exact name — else isBiomarkerStarred would still report the
// family starred and the toggle would appear stuck. Returns rows deleted.
export function unstarBiomarkerFamily(
  profileId: number,
  canonical: string
): number {
  const fam = biomarkerFamily(canonical);
  const info = db
    .prepare(
      `DELETE FROM starred_biomarkers
        WHERE profile_id = ? AND ${STAR_FAMILY_KEY} = ? COLLATE NOCASE`
    )
    .run(profileId, fam);
  return info.changes;
}

export interface StarredBiomarker {
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

  // The latest reading, chosen over the DE-DUPED id set so it agrees with the
  // detail page / table (which read via getBiomarkerSeries / getMedicalRecords):
  // when a manual reading and its imported twin share content-identity, dedup's
  // representative rule (prefer the manual, unflagged row) wins here too, so the
  // tile's flag chip matches the representative the other surfaces show (#381).
  // Matched by the #482 FAMILY identity, so a star on "Vitamin D, 25-Hydroxy"
  // surfaces the newest reading of ANY family member (a fresh D3 breakdown), the
  // same series the chart shows. Binds profile_id (for DEDUP_IDS_CTE), then
  // profile_id + the star's family key.
  const latestStmt = db.prepare(
    `WITH ${DEDUP_IDS_CTE}
     SELECT * FROM medical_records
     WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE AND ${IN_DEDUPED}
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
// The profile-level context both flag passes judge against: sex + birthdate /
// stored age (age-banded ranges), reproductive status and the cycle log (#718),
// and the canonical table preloaded as a NOCASE map. Shared by reconcileFlags and
// its preview twin below so the two can never read different context.
function flagReconcileProfileContext(profileId: number) {
  const cbByName = new Map(
    (
      db
        .prepare("SELECT * FROM canonical_biomarkers")
        .all() as CanonicalBiomarker[]
    ).map((c) => [c.name.toLowerCase(), c])
  );
  return {
    cbByName,
    ctx: {
      sex: getUserSex(profileId),
      birthdate: getUserBirthdate(profileId),
      age: getStoredAge(profileId),
      reproductiveStatus: getUserReproductiveStatus(profileId),
      periods: listCyclePeriods(profileId),
    },
  };
}

// The flag values reconcileFlags is allowed to revisit — a derived/range flag. A
// qualitative 'abnormal'/'immune' etc. from the numeric pass's view is left alone.
const RECONCILABLE_FLAGS = new Set([
  "normal",
  "non-optimal",
  "non-optimal-high",
  "non-optimal-low",
  "high",
  "low",
]);

// Preview twin of reconcileFlags: derive the flags the post-commit reconcile WILL
// write for a NOT-yet-persisted batch of records (the reprocess preview's fresh
// extraction), mutating each record's `flag` in place. Without this, the preview
// diff compares post-follow-up persisted rows against pre-follow-up extraction, so
// every app-derived flag (age-banded vitals, optimal bands, titer "immune") reads
// as a phantom "flag → none" change on a byte-identical reprocess. Same
// eligibility gates and the same pure cores (computeFlagReconciliation /
// computeQualitativeFlagChanges) as reconcileFlags, so preview and commit can't
// drift.
export function previewReconcileFlags(
  profileId: number,
  records: PersistInput["records"]
): void {
  if (records.length === 0) return;
  const { cbByName, ctx } = flagReconcileProfileContext(profileId);
  const numericRows = records.flatMap((r, i) =>
    r.canonical?.trim() &&
    r.value_num != null &&
    (r.flag == null || RECONCILABLE_FLAGS.has(r.flag))
      ? [
          {
            id: i,
            value_num: r.value_num,
            unit: r.unit,
            canonical_name: r.canonical,
            flag: r.flag,
            date: r.date,
            reference: r.reference_range,
          },
        ]
      : []
  );
  const qualRows = records.flatMap((r, i) =>
    r.value_num == null && (r.category === "lab" || r.category === "biomarker")
      ? [
          {
            id: i,
            name: r.canonical?.trim() || r.name,
            value: r.value,
            notes: r.notes,
            reference: r.reference_range,
            flag: r.flag,
            loinc: r.loinc,
          },
        ]
      : []
  );
  for (const c of [
    ...computeFlagReconciliation(numericRows, cbByName, ctx),
    ...computeQualitativeFlagChanges(qualRows),
  ]) {
    records[c.id].flag = c.flag as PersistInput["records"][number]["flag"];
  }
}

export function reconcileFlags(profileId: number, ids?: number[]): number {
  // profile_id scopes every row, so an id from another profile in `ids` simply
  // can't match — the caller's list is never trusted on its own.
  let sql = `SELECT id, value_num, unit, canonical_name, flag, date, reference_range FROM medical_records
     WHERE profile_id = ? AND canonical_name IS NOT NULL AND value_num IS NOT NULL
       AND (flag IS NULL OR flag IN ('normal','non-optimal','non-optimal-high','non-optimal-low','high','low'))`;
  const args: number[] = [profileId];
  if (ids) {
    if (ids.length === 0) return 0;
    sql += ` AND id IN (${ids.map(() => "?").join(",")})`;
    args.push(...ids);
  }
  const rows = (
    db.prepare(sql).all(...args) as {
      id: number;
      value_num: number;
      unit: string | null;
      canonical_name: string;
      flag: string | null;
      date: string;
      reference_range: string | null;
    }[]
  ).map((r) => ({ ...r, reference: r.reference_range }));

  // Sex/age/cycle context + the preloaded canonical map — shared with the preview
  // twin (flagReconcileProfileContext) so both judge against identical context.
  const { cbByName, ctx } = flagReconcileProfileContext(profileId);

  // The per-row flag-derivation is the pure shared decision (lib/flag-reconcile),
  // so this and the boot-time reconcile in lib/db.ts stay in lock-step.
  const changes = computeFlagReconciliation(rows, cbByName, ctx);
  // Qualitative pass (#549): the numeric reconcile above bails on value_num IS NULL,
  // so a qualitative value's extractor-guessed flag is never revisited. Route those
  // rows through the shared classifier — promote a durable-immunity titer to "immune"
  // (#544), clear a blunt "abnormal" on a context-neutral attribute like a blood type
  // (#548 §1) — leaving infection markers + unrecognized values alone. Same profile
  // scoping and optional id filter as the numeric pass.
  let qsql = `SELECT id, canonical_name, name, value, notes, reference_range, flag, loinc
     FROM medical_records
     WHERE profile_id = ? AND value_num IS NULL AND category IN ('lab','biomarker')`;
  const qargs: number[] = [profileId];
  if (ids) {
    qsql += ` AND id IN (${ids.map(() => "?").join(",")})`;
    qargs.push(...ids);
  }
  const qrows = (
    db.prepare(qsql).all(...qargs) as {
      id: number;
      canonical_name: string | null;
      name: string;
      value: string | null;
      notes: string | null;
      reference_range: string | null;
      flag: string | null;
      loinc: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    name: r.canonical_name?.trim() || r.name,
    value: r.value,
    notes: r.notes,
    reference: r.reference_range,
    flag: r.flag,
    loinc: r.loinc,
  }));
  const qChanges = computeQualitativeFlagChanges(qrows);

  const setFlag = db.prepare(
    "UPDATE medical_records SET flag = ? WHERE id = ?"
  );
  const clear = db.prepare(
    "UPDATE medical_records SET flag = NULL WHERE id = ?"
  );
  writeTx(() => {
    for (const c of [...changes, ...qChanges]) {
      if (c.flag === null) clear.run(c.id);
      else setFlag.run(c.flag, c.id);
    }
  });
  return changes.length + qChanges.length;
}

// ---- Unit-mislabel cross-check (issue #761) ----

// The stable suppression key for a dismissed unit-mislabel detection. Id-keyed
// (record ids never recycle — AUTOINCREMENT), stored in the shared findings-
// suppression bus (upcoming_dismissals), so a Dismiss survives re-render and the
// next reconcile without re-surfacing.
export function unitMislabelSignalKey(recordId: number): string {
  return `unit-mislabel:${recordId}`;
}

// One Data → Review card: a numeric lab reading whose stored unit is a probable
// power-of-ten mislabel of the canonical unit, per detectUnitMislabel. Carries the
// before/after the card renders and the Apply/Dismiss forms post.
export interface UnitMislabelReview {
  id: number;
  name: string; // display name (canonical when known, else the raw name)
  value: number;
  statedUnit: string;
  correctedUnit: string;
  statedRange: string;
  factor: number;
}

// Detect a probable unit mislabel for ONE stored record (shared by the Review
// gather below and the Apply write core, so the card, the flag suppression, and
// the correction all read the SAME detection — "one question, one computation").
// Loads the record + its canonical entry + the profile's sex/age/status context;
// returns null when the row isn't a numeric lab with both a stated and canonical
// range, or the cross-check doesn't fire. Profile-scoped.
export function detectRecordUnitMislabel(
  profileId: number,
  recordId: number
): (UnitMislabelReview & { canonicalName: string }) | null {
  const row = db
    .prepare(
      `SELECT id, name, canonical_name, value_num, unit, reference_range, date
         FROM medical_records
        WHERE id = ? AND profile_id = ?`
    )
    .get(recordId, profileId) as
    | {
        id: number;
        name: string;
        canonical_name: string | null;
        value_num: number | null;
        unit: string | null;
        reference_range: string | null;
        date: string | null;
      }
    | undefined;
  if (!row || !row.canonical_name || row.value_num == null) return null;

  const cb = getCanonicalBiomarker(row.canonical_name);
  if (!cb) return null;

  const sex = getUserSex(profileId);
  const birthdate = getUserBirthdate(profileId);
  const storedAge = getStoredAge(profileId);
  const reproductiveStatus = getUserReproductiveStatus(profileId);
  const age = ageForRecord({ sex, birthdate, age: storedAge }, row.date);

  const hit = detectUnitMislabel(
    row.reference_range,
    row.unit,
    row.value_num,
    cb,
    sex,
    age,
    reproductiveStatus
  );
  if (!hit) return null;

  return {
    id: row.id,
    name: row.canonical_name.trim() || row.name,
    canonicalName: row.canonical_name,
    value: row.value_num,
    statedUnit: row.unit as string,
    correctedUnit: hit.corrected.unit,
    statedRange: (row.reference_range as string).trim(),
    factor: hit.factor,
  };
}

// The unit-mislabel review cards for a profile (issue #761): every numeric lab
// reading whose stored unit is a probable power-of-ten mislabel and hasn't been
// dismissed. One canonical-map + context load, then the shared pure detector per
// row. Profile-scoped; dismissed detections (upcoming_dismissals) are excluded.
export function getUnitMislabelReviews(
  profileId: number
): UnitMislabelReview[] {
  const rows = db
    .prepare(
      `SELECT id, name, canonical_name, value_num, unit, reference_range, date
         FROM medical_records
        WHERE profile_id = ?
          AND canonical_name IS NOT NULL
          AND value_num IS NOT NULL
          AND unit IS NOT NULL
          AND reference_range IS NOT NULL
        ORDER BY date DESC, id DESC`
    )
    .all(profileId) as {
    id: number;
    name: string;
    canonical_name: string;
    value_num: number;
    unit: string;
    reference_range: string;
    date: string | null;
  }[];
  if (rows.length === 0) return [];

  const dismissed = new Set(
    (
      db
        .prepare(
          `SELECT signal_key FROM upcoming_dismissals
            WHERE profile_id = ? AND dismissed_at IS NOT NULL
              AND signal_key LIKE 'unit-mislabel:%'`
        )
        .all(profileId) as { signal_key: string }[]
    ).map((r) => r.signal_key)
  );

  const cbByName = new Map(
    (
      db
        .prepare("SELECT * FROM canonical_biomarkers")
        .all() as CanonicalBiomarker[]
    ).map((c) => [c.name.toLowerCase(), c])
  );
  const sex = getUserSex(profileId);
  const birthdate = getUserBirthdate(profileId);
  const storedAge = getStoredAge(profileId);
  const reproductiveStatus = getUserReproductiveStatus(profileId);

  const out: UnitMislabelReview[] = [];
  for (const r of rows) {
    if (dismissed.has(unitMislabelSignalKey(r.id))) continue;
    const cb = cbByName.get(r.canonical_name.toLowerCase());
    if (!cb) continue;
    const age = ageForRecord({ sex, birthdate, age: storedAge }, r.date);
    const hit = detectUnitMislabel(
      r.reference_range,
      r.unit,
      r.value_num,
      cb,
      sex,
      age,
      reproductiveStatus
    );
    if (!hit) continue;
    out.push({
      id: r.id,
      name: r.canonical_name.trim() || r.name,
      value: r.value_num,
      statedUnit: r.unit,
      correctedUnit: hit.corrected.unit,
      statedRange: r.reference_range.trim(),
      factor: hit.factor,
    });
  }
  return out;
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
      `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
              e.class_code, e.reason,
              e.diagnoses, e.provider_id, p.name AS provider_name,
              e.location_provider_id, l.name AS location_name,
              l.address AS location_address,
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
        `SELECT e.id, e.date, e.end_date, e.type, e.code, e.code_system,
                e.class_code, e.reason,
                e.diagnoses, e.provider_id, p.name AS provider_name,
                e.location_provider_id, l.name AS location_name,
                l.address AS location_address,
                e.notes, e.source, e.document_id, e.external_id, e.created_at
           FROM encounters e
           LEFT JOIN providers p ON p.id = e.provider_id
           LEFT JOIN providers l ON l.id = e.location_provider_id
          WHERE e.id = ? AND e.profile_id = ?`
      )
      .get(id, profileId) as Encounter | undefined) ?? null
  );
}
