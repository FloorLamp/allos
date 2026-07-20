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

import { cleanMedicationName, strengthFromName } from "./prescription-parse";
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
// its cached RxNorm codes (product rxcui + ingredient CUIs). `doseAmounts` (#1027)
// carries the med's per-dose amount strings ("200 mg") so the bridge can compare a
// record's strength against what's actually tracked — the common OTC shape keeps the
// strength in the dose row, not the name.
export interface TrackedMedLike {
  name: string;
  brand?: string | null;
  rxcui?: string | null;
  rxcuiIngredients?: string[] | null;
  doseAmounts?: string[] | null;
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
// Exported for the #1027 ingredient-family derivation (lib/medication-family.ts) so
// the bridge and the family key can never disagree on how a med name collapses.
export function medNameKey(name: string): string {
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

// Normalize a strength token for comparison: lowercased, whitespace removed
// ("800 mg" ≡ "800mg" ≡ "800 MG"). Null in ⇒ null out.
function normStrength(s: string | null): string | null {
  const n = (s ?? "").toLowerCase().replace(/\s+/g, "");
  return n || null;
}

// Every normalized strength a tracked med is known at: parsed off its NAME
// ("Ibuprofen 800 mg" → "800mg") plus each dose amount ("200 mg" → "200mg"; a
// non-strength amount like "1 tab" parses to nothing and is skipped).
function trackedStrengths(med: TrackedMedLike): Set<string> {
  const out = new Set<string>();
  for (const raw of [med.name, ...(med.doseAmounts ?? [])]) {
    const s = normStrength(raw ? strengthFromName(raw) : null);
    if (s) out.add(s);
  }
  return out;
}

// The record's parsed strength (display form, e.g. "800 mg") from its RAW name —
// the canonical alias is cleaned (strength stripped), so the raw label is the
// strength carrier. Null when the name carries none (#1026's parenthesized-strength
// cleaning will widen what parses here).
export function recordStrength(record: PrescriptionRecordLike): string | null {
  return strengthFromName(record.name);
}

// One bridge candidate: an imported prescription record that is either genuinely
// UNTRACKED (`strengthOffer` null — today's suggestion) or tracked-by-family at a
// provably DIFFERENT strength (`strengthOffer` = the record's strength, e.g.
// "800 mg" — the #1027 ask-4 offer, labeled by the attribute that differs, #531).
export interface BridgeCandidate<T extends PrescriptionRecordLike> {
  record: T;
  strengthOffer: string | null;
}

// The bridge's suggestion set (#560/#817 + #1027 ask 4). A record whose med is
// already tracked (under any med's name or brand, active OR paused) is FOLDED —
// UNLESS it carries a parsed strength and every matching tracked med is known at
// OTHER strengths only, in which case it surfaces as a different-strength OFFER
// ("Track as separate 800 mg item") instead of being silently absorbed.
// Conservative by design: no strength on the record, or no known strength on a
// matched med, keeps today's fold (never guess). Duplicate records for the same
// drug collapse to the FIRST (most recent, since the caller passes them date-desc).
export function bridgeCandidates<T extends PrescriptionRecordLike>(
  records: T[],
  meds: TrackedMedLike[]
): BridgeCandidate<T>[] {
  const out: BridgeCandidate<T>[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    const matched = meds.filter((m) => recordMatchesMed(rec, m));
    let strengthOffer: string | null = null;
    if (matched.length > 0) {
      const recStr = normStrength(recordStrength(rec));
      if (!recStr) continue; // no strength on the record → fold
      const strengthSets = matched.map(trackedStrengths);
      // Fold when any matched med has no known strength (can't prove a difference)
      // or already carries this strength.
      if (strengthSets.some((s) => s.size === 0 || s.has(recStr))) continue;
      strengthOffer = recordStrength(rec);
    }
    const key = recordMedKey(rec);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({ record: rec, strengthOffer });
  }
  return out;
}

// The subset of imported prescription records with NO matching tracked med — the
// pre-#1027 suggestion set, preserved for callers that only want the untracked rows.
export function unmatchedPrescriptionRecords<T extends PrescriptionRecordLike>(
  records: T[],
  meds: TrackedMedLike[]
): T[] {
  return bridgeCandidates(records, meds)
    .filter((c) => c.strengthOffer == null)
    .map((c) => c.record);
}

// The bridge dismissal key for a record (issue #203 name-keyed): `med-bridge:<name key>`.
// A different-strength OFFER keys with its strength appended
// (`med-bridge:ibuprofen:800mg`) so waving off the 800 mg offer never suppresses a
// future plain-ibuprofen suggestion (or a different strength's offer).
export function medBridgeDismissalKey(
  record: PrescriptionRecordLike,
  strengthOffer?: string | null
): string {
  const base = MED_BRIDGE_PREFIX + recordMedKey(record);
  const s = normStrength(strengthOffer ?? null);
  return s ? `${base}:${s}` : base;
}
