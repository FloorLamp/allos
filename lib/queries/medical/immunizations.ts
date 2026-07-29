import { db } from "../../db";
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
  MedicalRecord,
} from "../../types";

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
       SELECT id, date, vaccine, dose_label, notes,
              lot_number, route, site, reaction,
              source, external_id, created_at,
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

export function getImmunizationOverrides(
  profileId: number
): ImmunizationOverrideRow[] {
  return db
    .prepare(
      `SELECT vaccine, kind, reason, exemption_type, note, created_at
         FROM immunization_overrides WHERE profile_id = ?`
    )
    .all(profileId) as ImmunizationOverrideRow[];
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
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export function getImmunityTiters(profileId: number): ImmunityTiter[] {
  if (TITER_DISTINCTIVE_TOKENS.length === 0) return [];
  const nameKey = "COALESCE(NULLIF(TRIM(canonical_name), ''), name)";
  const likeClauses = TITER_DISTINCTIVE_TOKENS.map(
    () => `${nameKey} LIKE ? ESCAPE '\\'`
  ).join(" OR ");
  const rows = db
    .prepare(
      `SELECT * FROM medical_records
        WHERE profile_id = ? AND (${likeClauses})
        ORDER BY date DESC, id DESC`
    )
    .all(
      profileId,
      ...TITER_DISTINCTIVE_TOKENS.map((token) => likeContains(token))
    ) as MedicalRecord[];

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
    });
  }
  return titers;
}
