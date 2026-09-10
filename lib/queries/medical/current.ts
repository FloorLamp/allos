// CURRENT readings — one of the three submodules behind lib/queries/medical.ts
// (issue #5171). The hoisted DEDUP+LATEST statements behind the care-tier flagged
// labs, the recent-changes flagged vitals and the current qualitative results, plus
// the row-level counterpart of the de-dup grouping key. Every read is profile-scoped.

import { db, hoistedStatement } from "../../db";
import { biomarkerFamily } from "../../canonical-name";
import { flagInSql, NOTABLE_FLAGS } from "../../reference-range";
import type { ClinicalObservation } from "../../types";
import {
  BIOMARKER_FAMILY_KEY,
  DEDUP_IDS_CTE,
  LATEST_IDS_CTE,
  LATEST_IN_GROUP,
} from "./common";

// A currently-flagged biomarker reading — a biomarker family whose CURRENT
// (latest-per-family) reading is out-of-range/non-optimal. The minimal shape the
// digest/dashboard flagged surface consumes (canonical-preferred display name so links
// key on the same identity the biomarker view resolves).
export interface CurrentFlaggedReading {
  name: string;
  canonicalName: string | null;
  value: string | null;
  flag: string;
  date: string;
}

// ---- Hoisted current-reading statements (#2110) -----------------------------
//
// The DEDUP+LATEST pass over medical_records is the most expensive text this module
// compiles, and the Household page asks for it once PER MEMBER: the
// flagged-labs read is the attention model's own (through the digest's
// getNewlyFlaggedBiomarkers), the qualitative read is the condition-suggestion
// builder's. Hoisting compiles each once per connection instead of once per member
// per render — the value is never cached, so the rollup's integer is untouched.
//
// getClinicalObservations' row/count reads are deliberately NOT here: their WHERE
// clause is assembled from the caller's filters (an exclude list contributes one
// placeholder per category), so their text space is unbounded and a per-text
// statement cache over it would leak. They keep the request-scoped cache() that
// already collapses their repeats.
// Each hoisted text is spelled out at its own `hoistedStatement` call rather than
// returned by a builder: the profile-scoping scan reads this file as TEXT and can
// only verify a statement whose `profile_id = ?` it can SEE, so a builder call would
// be an unverifiable non-literal. The parts that are genuinely shared between the
// four flagged variants are interpolated fragments, which the scan does follow.
const FLAGGED_CURRENT_COLUMNS = `COALESCE(NULLIF(TRIM(canonical_name), ''), name) AS name,
          NULLIF(TRIM(canonical_name), '') AS canonicalName,
          value, flag, date`;
// The shared "this reading is flagged" predicate for the care-tier reads below.
//
// It used to be a DENYLIST — `flag NOT IN ('normal','immune')` — which asks "is this
// token one of the two neutral words?" rather than "is this token one we mark?". The
// two questions differ on exactly one input: a token this build does not recognise
// (#2937). A rolled-back build reads such a value as "Normal" everywhere (flagLabel's
// fallback, isNormalFlag, and neither range filter) while the denylist counted it as
// flagged, so the row raised a permanent review item reading "Flagged normal — 44":
// normal and flagged at once, filterable by neither state. Spelling it as the SAME
// NOTABLE_FLAGS list the predicates read makes display and query agree by
// construction, and is identical for every token this build does know.
const FLAGGED_NOTABLE = `AND ${flagInSql(NOTABLE_FLAGS)}`;
const FLAGGED_WINDOW = `AND created_at > ? AND date >= date(?)`;

const FLAGGED_LABS_STMT = {
  unwindowed: hoistedStatement(
    `WITH ${DEDUP_IDS_CTE},
          ${LATEST_IDS_CTE}
     SELECT ${FLAGGED_CURRENT_COLUMNS}
       FROM medical_records
      WHERE profile_id = ? AND ${LATEST_IN_GROUP}
        AND category = 'lab'
        ${FLAGGED_NOTABLE}
      ORDER BY date DESC, id ASC`
  ),
  windowed: hoistedStatement(
    `WITH ${DEDUP_IDS_CTE},
          ${LATEST_IDS_CTE}
     SELECT ${FLAGGED_CURRENT_COLUMNS}
       FROM medical_records
      WHERE profile_id = ? AND ${LATEST_IN_GROUP}
        AND category = 'lab'
        ${FLAGGED_NOTABLE}
        ${FLAGGED_WINDOW}
      ORDER BY date DESC, id ASC`
  ),
};

const FLAGGED_VITALS_STMT = {
  unwindowed: hoistedStatement(
    `WITH ${DEDUP_IDS_CTE},
          ${LATEST_IDS_CTE}
     SELECT ${FLAGGED_CURRENT_COLUMNS}
       FROM medical_records
      WHERE profile_id = ? AND ${LATEST_IN_GROUP}
        AND category = 'vitals'
        ${FLAGGED_NOTABLE}
      ORDER BY date DESC, id ASC`
  ),
  windowed: hoistedStatement(
    `WITH ${DEDUP_IDS_CTE},
          ${LATEST_IDS_CTE}
     SELECT ${FLAGGED_CURRENT_COLUMNS}
       FROM medical_records
      WHERE profile_id = ? AND ${LATEST_IN_GROUP}
        AND category = 'vitals'
        ${FLAGGED_NOTABLE}
        ${FLAGGED_WINDOW}
      ORDER BY date DESC, id ASC`
  ),
};

const CURRENT_QUALITATIVE_STMT = hoistedStatement(
  `WITH ${DEDUP_IDS_CTE},
        ${LATEST_IDS_CTE}
   SELECT id,
          COALESCE(NULLIF(TRIM(canonical_name), ''), name) AS name,
          value, notes, reference_range AS reference, loinc, date
     FROM medical_records
    WHERE profile_id = ? AND ${LATEST_IN_GROUP}
      AND category = 'lab'
      AND value_num IS NULL
    ORDER BY date DESC, id ASC`
);

// THE shared "which biomarkers are currently flagged" computation (issue #557).
// Returns one row per biomarker family whose CURRENT reading is flagged, reusing
// the SAME DEDUP+LATEST CTE machinery (LATEST_IDS_CTE / the #482/#394 family
// identity layer) that getClinicalObservations(current:true) drives for the household
// (range:"oor") and passport (range:"nonoptimal") surfaces. So the three surfaces
// can never disagree, and a SUPERSEDED historical out-of-range reading — a
// 5-year-old low that a later normal reading has since replaced — can NEVER
// surface: only an analyte whose LATEST reading is flagged does. Before #557 the
// digest/dashboard read raw SQL (`created_at > since AND flag NOT IN ...`) with no
// current-reading filter, so any historical flagged row leaked through.
//
// Category scope (#1076): `category = 'lab'` ONLY. This is the care-tier dashboard +
// digest source, so a non-lab flagged reading — a fever ('vitals'), a high BP
// ('vitals'), a severe PHQ-9 ('instrument') — must NEVER surface here; each is
// owned by its domain engine (temp-red-flag #859, BP percentiles #150, instrument
// severity bands #716/#998). The mental-health/substance sensitivity is load-
// bearing: a depression/alcohol score can never leak into the general health hero.
//
// Flag set: the NOTABLE_FLAGS list (FLAGGED_NOTABLE) — the same membership
// range:"nonoptimal" spells, so the two surfaces agree by construction rather than by
// two lists happening to match, and #544's "immune" (a good durable-immunity status)
// stays off the care-tier surface. It was a denylist until #2937; see FLAGGED_NOTABLE.
//
// Recency (#557 fix 2): when `since` is given the read is windowed by BOTH the
// import cursor (`created_at > since` — the digest send-cursor / dashboard stable
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
  if (since != null) args.push(since, since);
  // Both CTEs bind profile_id (deduped first, then latest — in WITH order), then
  // the main query's profile_id, then the optional window's two `since` binds.
  // ORDER BY date DESC (newest collection first) with an id ASC tiebreak keeps the
  // slice the caller applies deterministic.
  const stmt =
    since != null ? FLAGGED_LABS_STMT.windowed : FLAGGED_LABS_STMT.unwindowed;
  return stmt.all(...args) as CurrentFlaggedReading[];
}

// The VITALS twin of getCurrentFlaggedBiomarkers (#1713). Same DEDUP+LATEST machinery,
// same flag denylist, same dual (import cursor + collection date) window — the ONE
// difference is `category = 'vitals'` instead of `'lab'`.
//
// WHY A SEPARATE FUNCTION rather than a category parameter. #1076 scoped the flagged
// LAB read to `category = 'lab'` on purpose: it is the care-tier dashboard + digest source,
// and a fever or a high BP belongs to its own domain engine, not to the general
// "flagged results" list. That decision stands. This read exists for the RECENT-CHANGES
// collector only, which reports what changed rather than raising a care finding, and it
// is what makes #1713's central observation fixable: "a blood-pressure spike, low SpO₂
// logged yesterday is invisible" precisely because the digest's only flagged source is
// lab-scoped.
//
// The sensitivity boundary is preserved by the category, not by a keyword list:
// `'instrument'` (PHQ-9, AUDIT-C — #716/#998) is NOT read here, so a depression or
// alcohol score can never leak into a recent-changes line.
export function getCurrentFlaggedVitals(
  profileId: number,
  since?: string
): CurrentFlaggedReading[] {
  const args: (string | number)[] = [profileId, profileId, profileId];
  if (since != null) args.push(since, since);
  const stmt =
    since != null
      ? FLAGGED_VITALS_STMT.windowed
      : FLAGGED_VITALS_STMT.unwindowed;
  return stmt.all(...args) as CurrentFlaggedReading[];
}

// The CURRENT qualitative (value_num IS NULL) lab readings — one per
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
  return CURRENT_QUALITATIVE_STMT.all(
    profileId,
    profileId,
    profileId
  ) as CurrentQualitativeReading[];
}

// The content-identity of a reading — the tuple the read-layer de-dup groups on.
// `nameKey` is the display/grouping name (canonical when present, else the raw
// name), matching biomarkerNameKey().
export interface ObservationContentIdentity {
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
export function findObservationsByContentIdentity(
  profileId: number,
  identity: ObservationContentIdentity
): ClinicalObservation[] {
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
    ) as ClinicalObservation[];
}
