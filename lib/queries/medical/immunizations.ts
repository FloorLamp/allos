import { db, hoistedStatement } from "../../db";
import {
  REPRESENTATIVE_SPECS,
  representativeCte,
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

// Hoisted (#2110): the immunization schedule generator asks for all three of these
// per member, and the dashboard's household strip runs that generator once per
// member. Statement cached per connection, value never — the answer is identical.
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
