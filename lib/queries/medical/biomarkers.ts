// BIOMARKERS — one of the three submodules behind lib/queries/medical.ts (issue
// #5171). The canonical vocabulary reads, the family-collapsed series (single, batch,
// trend tail and all-analyte), and the saved clinical-result store with its
// de-orphan sweep. Every profile-owned read and write is profile-scoped; the
// vocabulary table is global.

import { db, writeTx } from "../../db";
import { cache } from "../../request-cache";
import { biomarkerFamily } from "../../canonical-name";
import { NON_IDENTITY_CATEGORIES } from "../../medical-categories";
import type {
  CanonicalResultDefinition,
  MedicalFlag,
  ClinicalObservation,
} from "../../types";
import {
  BIOMARKER_FAMILY_KEY,
  DEDUP_IDS_CTE,
  familyKeyOfExpr,
  IN_DEDUPED,
} from "./common";

// ---- Biomarkers (canonical names, ranges, series, stars) ----

// The same family identity computed over the SAVE store's key column (saved_items.key
// where kind='clinical-result' — the canonical result name, #1456), so a save keys on the
// identical family identity the readings do.
const SAVED_FAMILY_KEY = familyKeyOfExpr("key");
// "this row carries a biomarker identity" as SQL — the statement
// carriesResultIdentity makes in TypeScript (#2318). Every read that decides
// whether a NAME is an analyte binds NON_IDENTITY_CATEGORIES through this, so a
// category added to that list reaches all of them at once.
const IDENTITY_CATEGORY_SQL = `category NOT IN (${NON_IDENTITY_CATEGORIES.map(
  () => "?"
).join(",")})`;

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
        "SELECT name FROM canonical_result_definitions ORDER BY (source = 'ai'), name COLLATE NOCASE"
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
    "INSERT OR IGNORE INTO canonical_result_definitions (name, source) VALUES (?, 'ai')"
  );
  writeTx(() => {
    for (const n of distinct) insert.run(n);
  });
}

// Distinct canonical names actually used by records — including user-typed ones
// not in the vocabulary, so prior manual names still autocomplete.
//
// EXCLUDES the categories that carry no biomarker identity (#2318). This one read is
// what makes a stored name an ANALYTE: it feeds Coverage candidacy (Data → Coverage
// → Uncatalogued items), the trajectory/trends series enumerations, the logical
// outcome catalog and the canonical-name autocomplete. A functional-status finding,
// a questionnaire ITEM's free-text answer or a temperature's body site is a stored
// observation, not a quantity anyone can chart or ask us to catalogue — and letting
// it through here is exactly how it became a permanent "uncatalogued item".
export function getUsedCanonicalNames(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT canonical_name FROM medical_records
         WHERE profile_id = ? AND canonical_name IS NOT NULL AND TRIM(canonical_name) != ''
           AND ${IDENTITY_CATEGORY_SQL}
         ORDER BY canonical_name COLLATE NOCASE`
      )
      .all(profileId, ...NON_IDENTITY_CATEGORIES) as {
      canonical_name: string;
    }[]
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
export function getLatestClinicalObservationByCanonical(
  profileId: number,
  canonical: string
): ClinicalObservation | undefined {
  return db
    .prepare(
      `SELECT * FROM medical_records
       WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE
       ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(profileId, canonical) as ClinicalObservation | undefined;
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
): ClinicalObservation[] {
  // Match by the #482 FAMILY identity, not the exact canonical name: a request for
  // any family member (e.g. the total-25-OH spellings, or A1c ↔ eAG) returns the
  // WHOLE family's readings, so the chart/detail page and the starred tile show one
  // series instead of several — the same collapse the dedup/latest partitions apply.
  // A non-family analyte's family key is just its own name, so its series is
  // unchanged. NOTE (#1193): the vitamin-D D2/D3 FRACTIONS are NOT in this family
  // anymore — each is its own trendable series (biomarkerFamily gives it its own
  // identity), so a request for "Vitamin D3, 25-Hydroxy" returns only the D3
  // readings, apart from the total; they share only the retest clock.
  // A NON_IDENTITY row is excluded (#2318): the series IS the biomarker identity, so
  // a category that carries none contributes no point to one. Without this the
  // enumerations would agree the name is not an analyte while a direct by-name read
  // still drew it a bandless chart.
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE AND ${IN_DEDUPED}
         AND ${IDENTITY_CATEGORY_SQL}
       ORDER BY date ASC, id ASC`
    )
    .all(
      profileId,
      profileId,
      biomarkerFamily(canonical),
      ...NON_IDENTITY_CATEGORIES
    ) as ClinicalObservation[];
});

// getBiomarkerSeries for SEVERAL analytes in ONE pass (#1961), keyed by the exact
// requested name. Same predicate, same de-dup CTE, same order — the single-analyte
// `= ?` widened to `IN (…)` over the requested families, so a caller with K analytes
// issues one query instead of K.
//
// It is NOT getAllBiomarkerSeries + group: that read is narrower (it drops rows with
// no canonical_name, which the family key still resolves through `name`), so grouping
// it would silently lose a freeform-named reading this returns.
//
// Grouping uses the family key SQL itself computed (selected as an extra column and
// stripped), not a JS re-derivation of the COALESCE/TRIM name key — the row lands in
// the bucket the WHERE matched it into, by construction. Two requested names in one
// family share one array, exactly as two separate getBiomarkerSeries calls would
// return equal series.
//
// One family short-circuits to the cache()d single read: it is the same one query,
// and going through the cache keeps it shared with every OTHER caller in the request.
export function getBiomarkerSeriesFor(
  profileId: number,
  canonicals: readonly string[]
): Map<string, ClinicalObservation[]> {
  const out = new Map<string, ClinicalObservation[]>();
  const names = [...new Set(canonicals)];
  if (names.length === 0) return out;

  const familyOf = new Map(names.map((n) => [n, biomarkerFamily(n)]));
  const families = [...new Set(familyOf.values())];
  if (families.length === 1) {
    const rows = getBiomarkerSeries(profileId, names[0]);
    for (const n of names) out.set(n, rows);
    return out;
  }

  const rows = db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT *, ${BIOMARKER_FAMILY_KEY} AS series_family FROM medical_records
       WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} COLLATE NOCASE IN (${families
         .map(() => "?")
         .join(",")}) AND ${IN_DEDUPED}
         AND ${IDENTITY_CATEGORY_SQL}
       ORDER BY date ASC, id ASC`
    )
    .all(
      profileId,
      profileId,
      ...families,
      ...NON_IDENTITY_CATEGORIES
    ) as (ClinicalObservation & {
    series_family: string | null;
  })[];

  const byFamily = new Map<string, ClinicalObservation[]>();
  for (const f of families) byFamily.set(f.toLowerCase(), []);
  for (const row of rows) {
    const { series_family, ...record } = row;
    // NOCASE matched it to a requested family, so the two differ at most in ASCII
    // letter case and lowercasing both lands them on the same key.
    byFamily.get((series_family ?? "").toLowerCase())?.push(record);
  }
  for (const n of names) {
    out.set(n, byFamily.get(familyOf.get(n)!.toLowerCase()) ?? []);
  }
  return out;
}

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
): ClinicalObservation[] {
  const rows = db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND ${BIOMARKER_FAMILY_KEY} = ? COLLATE NOCASE
         AND ${IN_DEDUPED} AND value_num IS NOT NULL
       ORDER BY date DESC, id DESC LIMIT 2`
    )
    .all(
      profileId,
      profileId,
      biomarkerFamily(canonical)
    ) as ClinicalObservation[];
  return rows.reverse();
}

// Every canonically-named reading for a profile in ONE deduped pass, ordered so
// each analyte's rows are contiguous and oldest-first — the bulk companion to
// getBiomarkerSeries for callers that need EVERY analyte's series (the trajectory
// rules). Per-analyte getBiomarkerSeries calls re-run the dedup window over the
// whole table each time, which is O(analytes × records) per request (#105);
// grouping this one result by canonical name (lib/biomarker-group) yields the
// same per-analyte series as N individual calls.
export function getAllBiomarkerSeries(
  profileId: number
): ClinicalObservation[] {
  return db
    .prepare(
      `WITH ${DEDUP_IDS_CTE}
       SELECT * FROM medical_records
       WHERE profile_id = ? AND canonical_name IS NOT NULL
         AND TRIM(canonical_name) != '' AND ${IN_DEDUPED}
       ORDER BY canonical_name COLLATE NOCASE, date ASC, id ASC`
    )
    .all(profileId, profileId) as ClinicalObservation[];
}

// Drop any saved clinical result whose FAMILY no longer has a backing record (its last
// reading was deleted or its canonical name changed), so the status card can't
// point at nothing. Family-keyed (#482): a save on "Vitamin D, 25-Hydroxy"
// survives as long as ANY family member (a D2/D3 breakdown) still has a reading,
// matching the family-collapsed tile. Shared by every path that deletes records.
// Scoped to kind='clinical-result' — a `trend-metric` save keys on a metric id, not a
// clinical-result name, and must never be swept by a records-driven de-orphan (#1456).
// A row in a NON_IDENTITY category does not count as a backing record (#2318): an
// `assessment` never charts, so a star backed only by one points at nothing just as
// surely as a star with no rows at all.
export function cleanupOrphanSavedClinicalResults(profileId: number): void {
  writeTx(() => {
    // PROMOTE first: a watch-star that has since gained a reading is no longer a
    // watch, so from here on its absence would be real orphanhood. Doing this
    // before the delete is what lets a star cross from watch to backed without
    // any write path having to notice the reading arrive.
    db.prepare(
      `UPDATE saved_items
          SET backed = 1
        WHERE profile_id = ?
          AND kind = 'clinical-result'
          AND backed = 0
          AND ${SAVED_FAMILY_KEY} IN (
            SELECT ${BIOMARKER_FAMILY_KEY} FROM medical_records
            WHERE profile_id = ? AND canonical_name IS NOT NULL
              AND ${IDENTITY_CATEGORY_SQL}
          )`
    ).run(profileId, profileId, ...NON_IDENTITY_CATEGORIES);
    // Then de-orphan ONLY what a reading once stood behind. `backed = 0` is a
    // star waiting for its first reading — deleting that is not de-orphaning, it
    // is discarding a tap.
    db.prepare(
      `DELETE FROM saved_items
       WHERE profile_id = ?
         AND kind = 'clinical-result'
         AND backed = 1
         AND ${SAVED_FAMILY_KEY} NOT IN (
           SELECT ${BIOMARKER_FAMILY_KEY} FROM medical_records
           WHERE profile_id = ? AND canonical_name IS NOT NULL
             AND ${IDENTITY_CATEGORY_SQL}
         )`
    ).run(profileId, profileId, ...NON_IDENTITY_CATEGORIES);
  });
}

// True when THIS clinical result — or any sibling in its #482 family — is saved, so
// the star toggle reflects the family-collapsed tile (starring "Vitamin D, Total"
// lights the star on the "Vitamin D3" detail page too). Saves are few, so the
// family compare is done in JS over the profile's saved clinical-result list.
export function isClinicalResultSaved(
  profileId: number,
  canonical: string
): boolean {
  const fam = biomarkerFamily(canonical);
  const saved = db
    .prepare(
      "SELECT key FROM saved_items WHERE profile_id = ? AND kind = 'clinical-result'"
    )
    .all(profileId) as { key: string }[];
  return saved.some((s) => biomarkerFamily(s.key) === fam);
}

// Save a clinical result for a profile (the star half of the toggle). Idempotent — the
// store's NOCASE UNIQUE makes a re-save a no-op — and deliberately keyed on the NAME
// the user starred, not its family key: the family is resolved on READ
// (isClinicalResultSaved / getSavedClinicalResults), so the stored row stays a real analyte
// name that a rename can re-key (#203) and a human can read in an export.
export function saveClinicalResult(profileId: number, canonical: string): void {
  // `backed` records whether a reading has EVER stood behind this star, which is
  // what lets the de-orphan sweep tell "its readings were deleted" from "nobody
  // has measured it yet". Stamped at save time from what is true now; the sweep
  // promotes 0 -> 1 later if a reading arrives (see cleanupOrphanSavedClinicalResults).
  // It never returns to 0 — the question is about the past, and the past does not
  // un-happen.
  db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key, backed)
     VALUES (?, 'clinical-result', ?, (
       SELECT EXISTS (
         SELECT 1 FROM medical_records
          WHERE profile_id = ? AND canonical_name IS NOT NULL
            AND ${IDENTITY_CATEGORY_SQL}
            AND ${BIOMARKER_FAMILY_KEY} = ${familyKeyOfExpr("?")} COLLATE NOCASE
       )
     ))`
  ).run(profileId, canonical, profileId, ...NON_IDENTITY_CATEGORIES, canonical);
}

// Remove every saved clinical result in a #482 family (the unsave half of the toggle):
// because a save on any member lights the whole family, un-saving must clear all
// of them, not just the exact name — else isClinicalResultSaved would still report the
// family saved and the toggle would appear stuck. Returns rows deleted.
export function unsaveClinicalResultFamily(
  profileId: number,
  canonical: string
): number {
  const fam = biomarkerFamily(canonical);
  const info = db
    .prepare(
      `DELETE FROM saved_items
        WHERE profile_id = ? AND kind = 'clinical-result'
          AND ${SAVED_FAMILY_KEY} = ? COLLATE NOCASE`
    )
    .run(profileId, fam);
  return info.changes;
}

// Toggle a clinical result's save, returning the resulting state — the write core behind
// the ★ gesture (auth-blind, profileId-first; the Server Action in
// app/(app)/saved-actions.ts is the auth boundary). Check-then-act as ONE atomic
// transaction so two concurrent toggles can't both read the same state and race (two
// inserts, or an insert lost to a delete). Unsave clears the whole #482 family.
export function toggleClinicalResultSaved(
  profileId: number,
  canonical: string
): boolean {
  return writeTx(() => {
    if (isClinicalResultSaved(profileId, canonical)) {
      unsaveClinicalResultFamily(profileId, canonical);
      return false;
    }
    saveClinicalResult(profileId, canonical);
    return true;
  });
}

export interface SavedClinicalResult {
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
  // detail page and table (which read the full ClinicalObservation).
  latest_notes: string | null;
  latest_reference_range: string | null;
  // Reference entry (ranges/direction) joined in so the chip needs no extra query.
  canonical: CanonicalResultDefinition | null;
}

// Saved clinical results with their latest reading and the canonical reference entry
// (ranges/direction). The one read behind every result-save surface: the Results →
// Readings status card, the Trends Overview chart tiles, and the profile passport
// summary (#1456 — save membership IS summary inclusion; see lib/profile-summary-load).
//
// Ordered by the canonical saved order — positioned rows first, then unpositioned ones
// newest-first — the SQL twin of orderSavedRefs() in lib/saved-items.ts (position is
// set only by the Trends reorder affordance; a plain star leaves it NULL).
export function getSavedClinicalResults(
  profileId: number
): SavedClinicalResult[] {
  const stars = (
    db
      .prepare(
        `SELECT key FROM saved_items
          WHERE profile_id = ? AND kind = 'clinical-result'
          ORDER BY (position IS NULL), position, created_at DESC, id DESC`
      )
      .all(profileId) as { key: string }[]
  ).map((r) => r.key);
  if (stars.length === 0) return [];

  // The latest reading, chosen over the DE-DUPED id set so it agrees with the
  // detail page / table (which read via getBiomarkerSeries / getClinicalObservations):
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
      `SELECT * FROM canonical_result_definitions
       WHERE name IN (${stars.map(() => "?").join(",")})`
    )
    .all(...stars) as CanonicalResultDefinition[];
  const cbByName = new Map(cbRows.map((c) => [c.name.toLowerCase(), c]));

  return stars.map((name) => {
    const latest = latestStmt.get(
      profileId,
      profileId,
      biomarkerFamily(name)
    ) as ClinicalObservation | undefined;
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
