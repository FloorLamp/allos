// Pure record↔medication matcher for the "From your records" bridge (issue #817).
// No DB or network — everything here is a pure function of its inputs, unit-tested
// in lib/__tests__/medication-record-match.test.ts.
//
// The bridge surfaces IMPORTED prescription records (medical_records
// category='prescription') that have NO matched TRACKED medication (intake_items
// kind='medication') and offers a one-tap "Track this" (suggest-only, #560). This
// module decides "does this imported prescription already correspond to a tracked
// med?" so the bridge only shows the genuinely-untracked ones.
//
// Matching follows the #279 style: RxNorm CUI is authoritative when both sides carry
// one, with a normalized cleaned-name fallback. In practice a `medical_records`
// prescription row carries NO rxcui (the column doesn't exist there), so the name
// path is the working signal — but the CUI-first shape keeps the door open for a
// future import that captures a code, and mirrors how the passport's `extractedMeds`
// read-time fallback (lib/profile-summary-load.ts) already de-dups by cleaned name.

import { cleanMedicationName } from "./prescription-parse";
import { itemRxcuis } from "./drug-interactions";
import { splitMedicationName } from "./medication-info";

// The dismissal-key prefix for a bridge "not now" (issue #203 name-keyed hygiene).
// The suggestion is keyed by the record's cleaned MED NAME, not its row id: a record
// deleted-and-reimported (reprocess mints a new id) must not resurface a suggestion
// the user already waved off, and two prescription rows for the same drug share one
// dismissal. Guarded on its own namespace by the dismiss action.
export const MED_BRIDGE_PREFIX = "med-bridge:";

// The minimal record shape the matcher needs. `canonical_name` is the cleaned alias
// the extractor set (preferred when present); `name` is the raw label text. `rxcui`
// is accepted for the #279 CUI-first path but is null for today's prescription rows.
export interface PrescriptionRecordLike {
  name: string;
  canonical_name?: string | null;
  rxcui?: string | null;
}

// The minimal tracked-med shape: its name + brand (both matched by cleaned name) and
// its cached RxNorm codes (product rxcui + ingredient CUIs).
export interface TrackedMedLike {
  name: string;
  brand?: string | null;
  rxcui?: string | null;
  rxcuiIngredients?: string[] | null;
}

// The record's display name: the canonical (cleaned) alias when the extractor set
// one, else the raw label name — the same `recordName` rule the passport uses.
export function recordDisplayName(record: PrescriptionRecordLike): string {
  return record.canonical_name?.trim() || record.name;
}

// The stable NAME KEY a record de-dups / dismisses on: its display name stripped of a
// trailing strength/form and lowercased (the cleanMedicationName grouping key used
// across the import projection). A brand label ("Tylenol 500 mg") collapses to its
// generic ("acetaminophen") so a tracked generic med matches a branded record.
export function recordMedKey(record: PrescriptionRecordLike): string {
  return medNameKey(recordDisplayName(record));
}

// The NAME KEY for any medication name (record or tracked med). cleanMedicationName
// strips a trailing strength/form; splitMedicationName then collapses a brand to its
// generic so both sides land on the same token ("Advil" and "Ibuprofen" → "ibuprofen").
function medNameKey(name: string): string {
  const cleaned = cleanMedicationName(name);
  const generic = splitMedicationName(cleaned).name || cleaned;
  return generic.toLowerCase().trim();
}

// Every NAME KEY a tracked med answers to: its own name and its brand (each collapsed
// to a generic key), so a record naming either matches.
function trackedMedKeys(med: TrackedMedLike): Set<string> {
  const keys = new Set<string>();
  if (med.name) keys.add(medNameKey(med.name));
  if (med.brand) keys.add(medNameKey(med.brand));
  return keys;
}

// Whether an imported prescription record already corresponds to a tracked med.
// RxCUI first (any shared code between the record and the med's product+ingredient
// CUIs), then the cleaned/generic name. Records carry no rxcui today, so the name
// path is what fires.
export function recordMatchesMed(
  record: PrescriptionRecordLike,
  med: TrackedMedLike
): boolean {
  // #279 CUI-first: only when BOTH sides carry a code.
  const recordCui = record.rxcui?.trim();
  if (recordCui) {
    const medCuis = itemRxcuis({
      rxcui: med.rxcui ?? null,
      rxcuiIngredients: med.rxcuiIngredients ?? null,
    });
    if (medCuis.has(recordCui)) return true;
  }
  // Name fallback.
  const key = recordMedKey(record);
  return !!key && trackedMedKeys(med).has(key);
}

// The subset of imported prescription records with NO matching tracked med — the
// bridge's suggestion set. A record whose med is already tracked (under any med's
// name or brand, active OR paused — a paused med is still "tracked") is dropped, and
// duplicate records for the same drug collapse to the FIRST (most recent, since the
// caller passes them date-desc) so the bridge lists one row per untracked drug.
export function unmatchedPrescriptionRecords<T extends PrescriptionRecordLike>(
  records: T[],
  meds: TrackedMedLike[]
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (meds.some((m) => recordMatchesMed(rec, m))) continue;
    const key = recordMedKey(rec);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(rec);
  }
  return out;
}

// The bridge dismissal key for a record (issue #203 name-keyed): `med-bridge:<name key>`.
export function medBridgeDismissalKey(record: PrescriptionRecordLike): string {
  return MED_BRIDGE_PREFIX + recordMedKey(record);
}
