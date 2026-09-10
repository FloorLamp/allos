// Clinical RECORDS and observations — one of the three submodules behind
// lib/queries/medical.ts (issue #5171). The filtered, de-duplicated observation
// read and its count, the dashboard's current-plus-previous projection, the
// narrative report rows, the document reads and the per-document results table,
// and the legacy rows still awaiting a category. Every read is profile-scoped.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { snapshotCached } from "../../read-snapshot";
import { biomarkerFamily } from "../../canonical-name";
import { panelOrderOfPanelExpr, type PanelId } from "../../biomarker-panels";
import {
  flagInSql,
  NOTABLE_FLAGS,
  OUT_OF_RANGE_FLAGS,
} from "../../reference-range";
import type {
  MedicalDocument,
  MedicalFlag,
  ClinicalObservation,
} from "../../types";
import {
  biomarkerNameKey,
  biomarkerPanelKey,
  DEDUP_IDS_CTE,
  IN_DEDUPED,
  LATEST_IDS_CTE,
  LATEST_IN_GROUP,
} from "./common";

// ---- Medical ----
export type ClinicalObservationSortColumn = "name" | "panel" | "date";
export type SortDirection = "asc" | "desc";

// Flag-based row filter: "oor" = out of the lab reference range (high/low/
// abnormal); "nonoptimal" = every flag carrying a concern marker (a superset).
export type RangeFilter = "oor" | "nonoptimal";

// #2799's `reported-*` join the BROAD tier, never the "out of range" one: the whole
// point is that the lab's printed range is not our range, so "Out of range only" must
// keep meaning our own clinical verdict. But a user filtering the readings table down to
// what needs a look — the same read the passport's flagged-vitals list uses — must see
// the microalbumin the app has just started marking, or the filter would hide exactly
// the reading the issue is about.
//
// The two lists and their SQL spelling come from lib/reference-range/flags, which is
// where every predicate reads them from too, so this filter and `isOutOfRange` /
// `isNotableFlag` cannot disagree about a tier's membership.

export function rangeFilterClause(range?: RangeFilter): string | null {
  if (range === "oor") return flagInSql(OUT_OF_RANGE_FLAGS);
  if (range === "nonoptimal") return flagInSql(NOTABLE_FLAGS);
  return null;
}

export interface ClinicalObservationFilters {
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
  sort?: ClinicalObservationSortColumn;
  dir?: SortDirection;
  // When set, keep only the most recent reading per biomarker (its current
  // value), grouped by the canonical name shown in the table.
  current?: boolean;
}

export interface UnclassifiedClinicalObservation {
  id: number;
  profile_id: number;
  date: string;
  name: string;
  canonical_name: string | null;
  value: string | null;
  unit: string | null;
  source: string | null;
  document_id: number | null;
  encounter_id: number | null;
  provider_name: string | null;
}

// Legacy catch-all rows that still need an explicit category decision (#2877).
// NULL is never a writer output; it is the migration-created review state. Keep this
// read separate from the ordinary result catalog so an unresolved row cannot acquire
// lab/vitals behavior before a person classifies it.
export function getUnclassifiedClinicalObservations(
  profileId: number
): UnclassifiedClinicalObservation[] {
  return db
    .prepare(
      `SELECT mr.id, mr.profile_id, mr.date, mr.name, mr.canonical_name,
              mr.value, mr.unit, mr.source, mr.document_id, mr.encounter_id,
              p.name AS provider_name
         FROM medical_records mr
         LEFT JOIN providers p ON p.id = mr.provider_id
        WHERE mr.profile_id = ? AND mr.category IS NULL
        ORDER BY mr.date DESC, mr.id DESC`
    )
    .all(profileId) as UnclassifiedClinicalObservation[];
}

const BIOMARKER_NAME_KEY = biomarkerNameKey();
const BIOMARKER_PANEL_KEY = biomarkerPanelKey();
// The panel's curated sort order, over the slug the expression above resolves.
const BIOMARKER_PANEL_ORDER = panelOrderOfPanelExpr(BIOMARKER_PANEL_KEY);

// Build a "contains" LIKE pattern for free-text search, escaping the SQL wildcards
// (%, _) and the escape char (\) so a user typing e.g. "50%" or "a_b" matches
// literally. Pair with `LIKE ? ESCAPE '\'`.
function likeContains(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

// Build an ORDER BY clause for the given sort column, or `fallback` when none
// is set. Columns and direction are whitelisted, so this is safe to inline.
function observationOrderBy(
  fallback: string,
  sort?: ClinicalObservationSortColumn,
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
function observationFiltersKey(filters: ClinicalObservationFilters): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    )
  );
}

// The WHERE clause + bound args a filter set resolves to, over the DEDUP+LATEST CTEs.
// ONE composition, so the row read and the COUNT read below can never select different
// sets (#2116): a badge that disagrees with the list it links to is worse than a slow
// badge. `profile_id = ?` leads it, so every statement built from it is profile-scoped.
function observationSelection(filters: ClinicalObservationFilters): {
  clause: string;
  args: (string | number)[];
} {
  // Cross-source de-dup: the list always shows ONE representative per
  // content-identity (see DEDUP_IDS_CTE), so a reading uploaded in two documents —
  // or a manual reading plus its imported twin — is never double-counted.
  const where: string[] = ["profile_id = ?", IN_DEDUPED];
  const args: (string | number)[] = [];
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
  return { clause: `WHERE ${where.join(" AND ")}`, args };
}

// cache(): one dashboard render fans the same profile's medical_records dedup
// window out ~4× (upcoming biomarker items + preventive inference + the recent-
// labs widget + healthspan pillars), each a full-table scan + sort partitioned by
// a non-indexable name expression (#386). Keyed on (profileId, serialized
// filters) so equivalent calls collapse to a single scan per request.
const getObservationsCached = cache(function getObservationsCached(
  profileId: number,
  filtersKey: string
): ClinicalObservation[] {
  const filters = JSON.parse(filtersKey) as ClinicalObservationFilters;
  const { clause, args } = observationSelection(filters);
  const orderBy = observationOrderBy(
    "date DESC, id DESC",
    filters.sort,
    filters.dir
  );
  // is_latest (1/0) marks the current reading per biomarker group so the table
  // can flag it. Computed over the DE-DUPED readings (via the CTEs), so it holds
  // even when older rows are filtered out of the result set and never marks a
  // collapsed duplicate. Both CTEs bind profile_id (deduped first, then latest —
  // in WITH order), then the main query's own `profile_id = ?`, then `args`.
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
    .all(profileId, profileId, profileId, ...args) as ClinicalObservation[];
});
const getObservationsSnapshot = snapshotCached(
  "medical.observations",
  (profileId: number, filtersKey: string) => `${profileId}:${filtersKey}`,
  getObservationsCached
);

export function getClinicalObservations(
  profileId: number,
  filters: ClinicalObservationFilters = {}
): ClinicalObservation[] {
  return getObservationsSnapshot(profileId, observationFiltersKey(filters));
}

export type DashboardClinicalObservation = ClinicalObservation & {
  previous_id: number | null;
  previous_flag: MedicalFlag | null;
};

// The current lab reading and its immediately-prior comparable family reading,
// in one row per family. The dashboard already pays for the canonical, de-duplicated
// all-history observation snapshot through its preventive evidence. Projecting that
// same date-desc/id-desc list keeps the #482 family identity and avoids a parallel
// medical_records scan solely for transition detection.
export function getDashboardClinicalObservations(
  profileId: number
): DashboardClinicalObservation[] {
  const currentByFamily = new Map<string, DashboardClinicalObservation>();
  for (const observation of getClinicalObservations(profileId)) {
    if (observation.category !== "lab") continue;
    const name = observation.canonical_name?.trim() || observation.name;
    const family = biomarkerFamily(name).toLowerCase();
    const current = currentByFamily.get(family);
    if (!current) {
      currentByFamily.set(family, {
        ...observation,
        previous_id: null,
        previous_flag: null,
      });
    } else if (current.previous_id == null) {
      current.previous_id = observation.id;
      current.previous_flag = observation.flag;
    }
  }
  return [...currentByFamily.values()];
}

// HOW MANY observations a filter set selects, without hydrating one (#2116). The
// /household out-of-range badge renders a number per accessible profile and used to
// take `.length` of the full read: the same DEDUP+LATEST pass, but every matching row
// materialized with every column and both provider sub-selects, once per member.
//
// Same `observationSelection` as the row read above and the same CTEs, so the number
// is exactly the length of the list it stands for. Ordering is irrelevant to a count,
// so no ORDER BY. Not cache()d: a count and a row list are different result shapes,
// and the surfaces that want the rows already share the read above.
export function countClinicalObservations(
  profileId: number,
  filters: ClinicalObservationFilters = {}
): number {
  const { clause, args } = observationSelection(filters);
  const row = db
    .prepare(
      `WITH ${DEDUP_IDS_CTE},
            ${LATEST_IDS_CTE}
       SELECT COUNT(*) AS n FROM medical_records ${clause}`
    )
    .get(profileId, profileId, profileId, ...args) as { n: number };
  return row.n;
}

// A narrative diagnostic report row (#708): the free-text body of a microbiology
// culture / gram stain / cytopathology report, imported from a CCD/XDM Results-section
// ED-valued observation. It carries its text in `notes` with no value/flag, so it never
// trends — it's a dated document. Feeds Results → Reports only.
export interface ClinicalReport {
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
export function getClinicalReports(profileId: number): ClinicalReport[] {
  return db
    .prepare(
      `SELECT id, date, name, notes, loinc, document_id, source,
              (SELECT p.name FROM providers p WHERE p.id = medical_records.provider_id)
                AS provider_name
       FROM medical_records
       WHERE profile_id = ? AND category = 'report'
       ORDER BY date DESC, id DESC`
    )
    .all(profileId) as ClinicalReport[];
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

// Filters for the per-document results table. Mirrors the clinical results table's
// affordances (category filter, flag-range filter, free-text search, and a
// sortable name/panel/date column set), so the shared UI controls thread the
// same params through to this query.
export interface DocumentObservationFilters {
  // undefined = every category; null = only rows awaiting category review.
  category?: string | null;
  // Flag-based filter: out-of-range only, or all non-optimal rows.
  range?: RangeFilter;
  // Free-text search matched against name and panel.
  q?: string;
  sort?: ClinicalObservationSortColumn;
  dir?: SortDirection;
}

// Records imported from one document, grouped sensibly for review (by panel,
// then name) unless an explicit sort is chosen. Optionally narrowed by category,
// flag range, and free-text search — matching the clinical results table's filters.
export function getObservationsForDocument(
  profileId: number,
  documentId: number,
  filters: DocumentObservationFilters = {}
): ClinicalObservation[] {
  const where = ["profile_id = ?", "document_id = ?"];
  const args: (string | number)[] = [profileId, documentId];
  if (filters.category !== undefined) {
    if (filters.category === null) {
      where.push("category IS NULL");
    } else {
      where.push("category = ?");
      args.push(filters.category);
    }
  }
  const rangeClause = rangeFilterClause(filters.range);
  if (rangeClause) where.push(rangeClause);
  if (filters.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR panel LIKE ? ESCAPE '\\')");
    const like = likeContains(filters.q);
    args.push(like, like);
  }
  const orderBy = observationOrderBy(
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
    .all(...args) as ClinicalObservation[];
}
