import { db, hoistedStatement } from "../../db";
import {
  REPRESENTATIVE_SPECS,
  representativeCte,
  representativeIds,
  representativeOrderBy,
} from "../../representative-ids";
import {
  immuneThresholdFor,
  titerImmuneStatus,
  type OverrideKind,
  type TiterStatus,
} from "../../immunization-status";
import {
  matchesImmunityMarker,
  markerNameTokens,
  TITER_DISTINCTIVE_TOKENS,
} from "../../titer-match";
import type {
  Immunization,
  ImmunizationExemptionType,
  ClinicalObservation,
} from "../../types";

// One row per (vaccine, date, dose label) across overlapping documents. The window is
// emitted by the shared builder (lib/representative-ids.ts, #2035) from the
// `immunizations` registry row, which declares the `source` preference axis — the
// manual-beats-imported rule keyed on the `source` string BECAUSE this table has no
// document_id column. That divergence used to be an un-named re-spelling of the rule
// its six siblings wrote as `(document_id IS NULL) DESC`, which is exactly how one
// provenance rule becomes two (#2005). Binds profile_id twice (CTE, then the read).
const IMMUNIZATION_DEDUPED = representativeCte(
  "imm_deduped",
  REPRESENTATIVE_SPECS.immunizations
);

// The same collapse as a bare subquery, for the readers that bound the rows
// themselves and so cannot go through getImmunizations: the Timeline's own
// date-bounded, limited SELECT (#4366). Takes ONE profile_id bind, like its
// ENCOUNTER_REPRESENTATIVE_IDS sibling.
export const IMMUNIZATION_REPRESENTATIVE_IDS = representativeIds(
  REPRESENTATIVE_SPECS.immunizations
);

// Separator between two contributing rows' notes on one representative. The tree's
// existing "two facts on one line" separator (lib/activity-import-details.ts and the
// medication subtitles), not a new one.
const NOTE_SEPARATOR = " · ";

// THE CONTRIBUTED NOTES OF A COLLAPSE GROUP, merged onto its representative (#4731).
//
// The election ranks on (vaccine, date, dose label) and breaks ties on provenance
// then `id DESC`. Notes are not in it, so when two overlapping portal documents
// produce one administration and only the LOWER-id row carries the note, the
// note-less row wins and the text is unreachable from every surface a person reads.
// Measured on the issue's probe before this existed: `getImmunizations` returned the
// note-less row, the Timeline event's detail was null, and Search for the lot number
// returned nothing while the text sat in the table.
//
// WHY NOT THE SMALLER FIX — a `precede` clause electing a note-carrying row. Two
// measurements ruled it out, not a preference:
//   • It does not meet the issue's own standard. When BOTH rows carry notes and the
//     notes DIFFER, the precedence term ties and `id DESC` decides, so one note is
//     still lost — a different one. The both-rows case is in the db tier
//     (lib/__db_tests__/immunization-notes-collapse.test.ts) precisely because that
//     is the case a note-preference cannot answer.
//   • `precede` outranks the preference AXIS by construction (see
//     representativeOrderBy), so a note-carrying IMPORTED row would beat a note-less
//     MANUAL one. That silently inverts the manual-beats-imported rule the registry
//     exists to state once, for every immunization pair in the tree — a much larger
//     change than the one the issue asks for.
//
// So the ELECTION IS UNTOUCHED — this file changes no spec and no builder, and no
// site re-elects anything — and the notes are gathered instead. `imm_notes` maps each
// representative id to the DISTINCT notes of every row sharing its collapse identity,
// oldest contributing row first. Identity and ranking are the registry's own
// expressions, reused verbatim, so this can never drift from the election it follows.
//
// WHAT "DISTINCT" MEANS HERE: exact text after TRIM. Two near-duplicate spellings of
// one fact ("Lot 9" and "Lot 9." from two portals) BOTH survive and read twice. That
// is the deliberate direction to err: text shown twice is something a reader can
// resolve, text dropped is not.
//
// Binds ONE profile_id, before whatever the reading statement binds.
const immunizationSpec = REPRESENTATIVE_SPECS.immunizations;
export const IMMUNIZATION_CONTRIBUTED_NOTES_CTE = `imm_notes AS (
    SELECT rep_id AS id,
           group_concat(note, '${NOTE_SEPARATOR}' ORDER BY first_id) AS notes
      FROM (
        SELECT rep_id, TRIM(notes) AS note, MIN(id) AS first_id
          FROM (
            SELECT id, notes,
                   FIRST_VALUE(id) OVER (
                     PARTITION BY profile_id,
                       ${immunizationSpec.partition.join(",\n                       ")}
                     ORDER BY ${representativeOrderBy(immunizationSpec)}
                   ) AS rep_id
              FROM immunizations WHERE profile_id = ?
          )
         WHERE TRIM(COALESCE(notes, '')) <> ''
         GROUP BY rep_id, TRIM(notes)
      )
     GROUP BY rep_id
  )`;

// The notes column the two DISPLAY-ONLY readers select in place of `immunizations.
// notes`: this representative's own note plus every contributor's, or NULL when the
// group holds none. Reads the CTE above, so a statement using it must carry that CTE,
// and names the outer table explicitly — both readers select `FROM immunizations`
// unaliased.
//
// WHAT THIS DOES NOT REACH, deliberately: `getImmunizations` below is UNCHANGED, so
// the immunizations record page, its print/share view, and `assessSchedule`'s input
// still see only the representative's OWN note. Those rows are not display-only —
// they populate ImmunizationForm's notes field, and updateImmunization writes that
// field straight back, so a merged string would be STORED on the survivor the next
// time anyone edited the dose, turning a display merge into a data merge. The note
// is therefore reachable — the Timeline and Search both show it — but it is not
// reachable from every surface; the record page still shows one of the two.
export const IMMUNIZATION_CONTRIBUTED_NOTES = `(SELECT notes FROM imm_notes
             WHERE imm_notes.id = immunizations.id)`;

// Hoisted (#2110): the immunization schedule generator asks for all three of these
// per member, and the Household page runs that generator once per member. Statement
// cached per connection, value never — the answer is identical.
const IMMUNIZATIONS_STMT = hoistedStatement(
  `WITH ${IMMUNIZATION_DEDUPED}
   SELECT id, date, vaccine, dose_label, notes,
          lot_number, route, site, reaction,
          source, external_id, created_at,
          provider_id,
          (SELECT p.name FROM providers p WHERE p.id = immunizations.provider_id)
            AS provider_name
   FROM immunizations
   WHERE profile_id = ? AND id IN (SELECT id FROM imm_deduped)
   ORDER BY date DESC, id DESC`
);

export function getImmunizations(profileId: number): Immunization[] {
  return IMMUNIZATIONS_STMT.all(profileId, profileId) as Immunization[];
}

export interface ImmunizationOverrideRow {
  vaccine: string;
  kind: OverrideKind;
  reason: string | null;
  // Structured declination category (#1406), alongside the free-text `reason` —
  // 'medical' / 'religious' / 'philosophical', or NULL when unstated (always NULL
  // for kind 'immune', where the concept does not apply).
  exemption_type: ImmunizationExemptionType | null;
  note: string | null;
  created_at: string;
}

const IMMUNIZATION_OVERRIDES_STMT = hoistedStatement(
  `SELECT vaccine, kind, reason, exemption_type, note, created_at
     FROM immunization_overrides WHERE profile_id = ?`
);

export function getImmunizationOverrides(
  profileId: number
): ImmunizationOverrideRow[] {
  return IMMUNIZATION_OVERRIDES_STMT.all(
    profileId
  ) as ImmunizationOverrideRow[];
}

export function getImmunizationOverride(
  profileId: number,
  vaccine: string
): ImmunizationOverrideRow | null {
  return (db
    .prepare(
      `SELECT vaccine, kind, reason, exemption_type, note, created_at
         FROM immunization_overrides WHERE profile_id = ? AND vaccine = ?`
    )
    .get(profileId, vaccine) ?? null) as ImmunizationOverrideRow | null;
}

export interface ImmunityTiter {
  marker: string;
  value: string | null;
  value_num: number | null;
  unit: string | null;
  date: string | null;
  status: TiterStatus;
  document_id: number | null;
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

// One LIKE per distinctive titer token. The token list is a module constant, so the
// text is fixed at import — hoisting it (#2110) is safe, and hoistedStatement only
// stores the text (it compiles on first USE), so the empty-token guard below still
// short-circuits before any invalid SQL could reach SQLite.
const TITER_ROWS_STMT = hoistedStatement(
  `SELECT * FROM medical_records
    WHERE profile_id = ? AND (${TITER_DISTINCTIVE_TOKENS.map(
      () =>
        `COALESCE(NULLIF(TRIM(canonical_name), ''), name) LIKE ? ESCAPE '\\'`
    ).join(" OR ")})
    ORDER BY date DESC, id DESC`
);

export function getImmunityTiters(profileId: number): ImmunityTiter[] {
  if (TITER_DISTINCTIVE_TOKENS.length === 0) return [];
  const rows = TITER_ROWS_STMT.all(
    profileId,
    ...TITER_DISTINCTIVE_TOKENS.map((token) => likeContains(token))
  ) as ClinicalObservation[];

  const seen = new Set<string>();
  const titers: ImmunityTiter[] = [];
  for (const row of rows) {
    const marker = (row.canonical_name?.trim() || row.name).trim();
    if (!matchesImmunityMarker(markerNameTokens(marker))) continue;
    const key = marker.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const value =
      row.value ?? (row.value_num != null ? String(row.value_num) : null);
    titers.push({
      marker,
      value: row.value,
      value_num: row.value_num,
      unit: row.unit,
      date: row.date,
      status: titerImmuneStatus(value, {
        immuneAtLeast: immuneThresholdFor(marker),
      }),
      document_id: row.document_id,
    });
  }
  return titers;
}
