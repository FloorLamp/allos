// The FLAGGED-LABS domain adapter for the finding → follow-up → resolution chain
// (issue #700) — the SECOND adapter, decided as next because it needs NO new record
// type (biomarkers + flags + care_plan_items already exist) so it ships the
// "recheck A1c in 3 months" loop immediately. PURE — it operates on lab-reading
// shapes, no DB/network. It plugs into the domain-agnostic core (lib/followup.ts) by
// answering the same three domain questions the imaging adapter does: what a flagged
// source result reads as, what its follow-up is called, and which LATER reading
// resolves it — WITHOUT touching the core.
//
// #482 identity discipline: the source finding and its resolving record are matched
// by biomarker FAMILY, never the raw name — so an A1c follow-up is resolved by an eAG
// recheck (same measurement, two names) and a total-vitamin-D follow-up is NOT
// resurrected by a D2 fraction (distinct assays stay apart). This reuses the ONE
// grouping every biomarker surface keys on, biomarkerFamily().

import { biomarkerFamily } from "./canonical-name";
import type { FollowUpAdapter, FollowUpItemLike } from "./followup";

// The labs source kind stored in care_plan_items.source_kind.
export const LABS_FOLLOWUP_KIND = "labs";

// The narrow lab-reading shape the adapter reasons over — a Pick of MedicalRecord's
// identity/value columns, so both the source finding and the resolving candidates are
// the same shape (a later reading of the same family). date is always present
// (medical_records.date is NOT NULL), which is what lets candidates order.
export interface LabFollowUpRecord {
  id: number;
  date: string;
  canonical_name: string | null;
  name: string;
  value: string | null;
  unit: string | null;
  value_num: number | null;
  flag: string | null;
}

// The display/grouping name of a reading: its canonical name when present, else the
// raw name — the same identity biomarkerNameKey() uses on the SQL side.
export function labBiomarkerName(record: LabFollowUpRecord): string {
  const canonical = record.canonical_name?.trim();
  return canonical && canonical.length > 0 ? canonical : record.name;
}

// The #482 family identity of a reading (its `family:<key>` when it belongs to a
// registered family, else its own trimmed name). Lower-cased at the comparison
// boundary — biomarkerFamily folds case for family members but returns a non-family
// name unchanged, so two spellings of the same singleton analyte still compare equal.
function familyOf(record: LabFollowUpRecord): string {
  return biomarkerFamily(labBiomarkerName(record)).toLowerCase();
}

// YYYY-MM of a reading date (for the compact "(2026-05)" reason tail).
function readingMonth(record: LabFollowUpRecord): string {
  return record.date ? record.date.slice(0, 7) : "";
}

// A compact value label ("8.2%", "142 mg/dL", "Positive"). Prefers the reading's
// value string; falls back to its numeric value. A "%"-suffixed unit attaches with no
// space (matching how labs print), every other unit with a space.
export function labValueLabel(record: LabFollowUpRecord): string {
  const raw = record.value?.trim();
  const v =
    raw && raw.length > 0
      ? raw
      : record.value_num != null
        ? String(record.value_num)
        : "";
  const u = record.unit?.trim();
  if (!v) return u ?? "";
  if (!u) return v;
  return u === "%" ? `${v}${u}` : `${v} ${u}`;
}

// A short human label for the source flagged finding, for the "for the …" reason line
// ("flagged 8.2% (2026-05)"). Names the FLAGGED value + the reading month, so a serial
// view reads unambiguously and the follow-up says WHY it exists.
export function labsSourceLabel(record: LabFollowUpRecord): string {
  const value = labValueLabel(record) || labBiomarkerName(record);
  const month = readingMonth(record);
  return month ? `flagged ${value} (${month})` : `flagged ${value}`;
}

// The default follow-up title for a flagged lab source ("Recheck Hemoglobin A1c",
// "Recheck LDL Cholesterol"). The biomarker name is the noun; "Recheck" is the verb.
export function labsFollowUpTitle(record: LabFollowUpRecord): string {
  return `Recheck ${labBiomarkerName(record)}`;
}

// Whether two lab readings are the SAME measurement for resolution matching: same
// #482 biomarker family. This is the labs adapter's answer to "which later reading
// resolves this follow-up" — family-anchored (A1c ↔ eAG), never a different analyte,
// and never over-collapsing distinct assays/fractions (biomarkerFamily's exclusion
// discipline).
export function sameBiomarkerFamily(
  a: LabFollowUpRecord,
  b: LabFollowUpRecord
): boolean {
  return familyOf(a) === familyOf(b);
}

// The later lab reading that resolves a follow-up for `source`, or null when none has
// landed. A candidate qualifies when it is a DIFFERENT reading of the same biomarker
// family whose date is STRICTLY AFTER the source reading's date. The MOST RECENT
// qualifying reading wins (the actual repeat-draw result). Confirm-first: returning a
// candidate only OFFERS the resolution; the user records resolved/stable/changed.
export function findResolvingLabResult(
  source: LabFollowUpRecord,
  _followUp: FollowUpItemLike,
  candidates: readonly LabFollowUpRecord[]
): LabFollowUpRecord | null {
  if (!source.date) return null; // an undated source can't order candidates
  let best: LabFollowUpRecord | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (!c.date || c.date <= source.date) continue;
    if (!sameBiomarkerFamily(source, c)) continue;
    if (!best || c.date > best.date || (c.date === best.date && c.id > best.id))
      best = c;
  }
  return best;
}

// A compact label for a resolving candidate, for the offer copy ("5.4% · 2026-08").
export function labsResolvingLabel(record: LabFollowUpRecord): string {
  const value = labValueLabel(record) || labBiomarkerName(record);
  const month = readingMonth(record);
  return month ? `${value} · ${month}` : value;
}

// The labs adapter instance the builder consumes. One object satisfying the generic
// FollowUpAdapter<Source, Candidate> contract — the same seam the imaging adapter fills.
export const labsFollowUpAdapter: FollowUpAdapter<
  LabFollowUpRecord,
  LabFollowUpRecord
> = {
  kind: LABS_FOLLOWUP_KIND,
  describeSource: labsSourceLabel,
  followUpTitle: labsFollowUpTitle,
  findResolvingRecord: findResolvingLabResult,
  describeResolvingRecord: labsResolvingLabel,
};
