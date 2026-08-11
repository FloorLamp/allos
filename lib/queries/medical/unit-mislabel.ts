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

  const sex = getProfileSex(profileId);
  const birthdate = getProfileBirthdate(profileId);
  const storedAge = getStoredAge(profileId);
  const reproductiveStatus = getProfileReproductiveStatus(profileId);
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
  // Alias-aware, like the flag path: a stored row under a legacy/abbreviation name
  // ("MCHC" pre-migration-103) must still resolve to its canonical entry, else the
  // scan skips it and its mislabel card never surfaces.
  const resolve = canonicalResolver();
  const sex = getProfileSex(profileId);
  const birthdate = getProfileBirthdate(profileId);
  const storedAge = getStoredAge(profileId);
  const reproductiveStatus = getProfileReproductiveStatus(profileId);

  const out: UnitMislabelReview[] = [];
  for (const r of rows) {
    if (dismissed.has(unitMislabelSignalKey(r.id))) continue;
    const cb = cbByName.get(resolve(r.canonical_name).toLowerCase());
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
import { canonicalResolver } from "../../canonical-resolve";
import { db } from "../../db";
import { ageForRecord } from "../../flag-reconcile";
import { detectUnitMislabel } from "../../reference-range";
import {
  getStoredAge,
  getProfileBirthdate,
  getProfileReproductiveStatus,
  getProfileSex,
} from "../../settings";
import type { CanonicalBiomarker } from "../../types";
import { getCanonicalBiomarker } from "./canonical";
