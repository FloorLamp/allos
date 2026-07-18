// The IOP (intraocular-pressure) domain adapter for the finding → follow-up →
// resolution chain (issue #698 §6 / Part of #700) — the eye-care sibling of the
// imaging (lib/followup-imaging) and flagged-labs (lib/followup-labs) adapters. PURE:
// it operates on medical_records reading shapes, no DB/network. It plugs into the
// domain-agnostic core (lib/followup.ts) by answering the same three domain questions
// — what a flagged IOP reading reads as, what its follow-up is called, and which LATER
// reading resolves it — WITHOUT touching the core.
//
// Why a distinct adapter (not just the generic labs "Recheck …")? An elevated IOP is
// the eye-care instance of the safety loop: it is not a lipid to re-draw, it is a
// pressure awaiting a GLAUCOMA WORKUP (#698 §6). So the follow-up is titled and
// described for that, and it is ONE bilateral question — a single glaucoma evaluation
// covers both eyes.
//
// #698 §3 / #482 identity — the LATERALITY decision (documented deliberately): IOP is
// per-eye (OD/OS) and the two eyes are stored as SEPARATE canonical analytes
// ("Intraocular Pressure, Right Eye" / "…, Left Eye" / a generic "Intraocular
// Pressure") so their CHART SERIES stay separate and the cross-source dedup never
// merges two equal same-day pressures — they are the same assay but DIFFERENT
// subjects. The data model carries no structured OD/OS column; laterality lives in the
// canonical name. So the "one question" collapse is scoped HERE, in the adapter, not in
// the global biomarkerFamily(): this adapter treats ANY IOP reading (either eye,
// generic) as the same follow-up subject, so a flagged pressure in either eye seeds the
// single glaucoma-workup follow-up and a repeat pressure in either eye resolves it —
// clinically correct (a workup is not per-eye) — while the per-eye trends stay intact.

import type { FollowUpAdapter, FollowUpItemLike } from "./followup";
import type { LabFollowUpRecord } from "./followup-labs";

// The IOP source kind stored in care_plan_items.source_kind.
export const IOP_FOLLOWUP_KIND = "iop";

// The follow-up title for a flagged IOP source. Fixed (one bilateral question): it is
// a glaucoma workup / repeat pressure, not a per-eye "Recheck …" (#698 §6).
export const IOP_FOLLOWUP_TITLE = "Recheck IOP / glaucoma workup";

// An IOP reading IS a medical_records reading (same projection the labs adapter uses),
// so the adapter reuses that shape for both the source finding and the candidates.
export type IopFollowUpRecord = LabFollowUpRecord;

// The canonical IOP entries (lib/curated-biomarkers). The finite SQL preimage the
// query layer needs (#394 — SQL can't call the JS matcher), and the anchor for the JS
// matcher below.
export const IOP_CANONICAL_NAMES = [
  "Intraocular Pressure",
  "Intraocular Pressure, Right Eye",
  "Intraocular Pressure, Left Eye",
] as const;

// Whether a reading name is an intraocular-pressure reading (any eye / generic). Keys
// on "intraocular pressure" (all three canonical spellings contain it) plus the bare
// "IOP" abbreviation as a whole word — NOT a loose "iop" substring, which would also
// match "biopsy". This is the adapter's own identity, deliberately independent of the
// global biomarkerFamily() (see the header — collapsing eyes there would merge charts).
export function isIopBiomarker(name: string | null | undefined): boolean {
  const s = (name ?? "").trim().toLowerCase();
  if (!s) return false;
  return /intraocular pressure/.test(s) || /\biop\b/.test(s);
}

// The display name of a reading: its canonical name when present, else the raw name.
export function iopReadingName(record: IopFollowUpRecord): string {
  const canonical = record.canonical_name?.trim();
  return canonical && canonical.length > 0 ? canonical : record.name;
}

// The eye a reading names ("right eye" / "left eye"), or "" when unspecified/generic —
// recovered from the canonical/raw name (the only place laterality is encoded).
export function iopLateralityLabel(record: IopFollowUpRecord): string {
  const s = iopReadingName(record).toLowerCase();
  if (/\bright\b|\bod\b/.test(s)) return "right eye";
  if (/\bleft\b|\bos\b/.test(s)) return "left eye";
  return "";
}

// YYYY-MM of a reading date (for the compact "(2026-05)" reason tail).
function readingMonth(record: IopFollowUpRecord): string {
  return record.date ? record.date.slice(0, 7) : "";
}

// A compact value label ("28 mmHg"). Prefers the value string; falls back to value_num.
// The mmHg unit attaches with a space (IOP prints spaced, unlike a "%").
export function iopValueLabel(record: IopFollowUpRecord): string {
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
  return `${v} ${u}`;
}

// A short human label for the source flagged finding, for the "for the …" reason line
// ("flagged 28 mmHg, right eye (2026-05)"). Names the flagged pressure, which eye, and
// the reading month, so a serial view reads unambiguously and the follow-up says WHY.
export function iopSourceLabel(record: IopFollowUpRecord): string {
  const value = iopValueLabel(record) || iopReadingName(record);
  const eye = iopLateralityLabel(record);
  const month = readingMonth(record);
  const head = eye ? `flagged ${value}, ${eye}` : `flagged ${value}`;
  return month ? `${head} (${month})` : head;
}

// The follow-up title — fixed (the glaucoma-workup question is bilateral).
export function iopFollowUpTitle(_record: IopFollowUpRecord): string {
  return IOP_FOLLOWUP_TITLE;
}

// The later IOP reading that resolves a follow-up for `source`, or null when none has
// landed. A candidate qualifies when it is a DIFFERENT IOP reading (any eye) whose date
// is STRICTLY AFTER the source reading's date. The MOST RECENT qualifying reading wins
// (the actual repeat pressure). Confirm-first: returning a candidate only OFFERS the
// resolution; the user records resolved/stable/changed. (The candidate pool the builder
// passes is already IOP-only, so any later reading is a valid repeat pressure — the
// isIopBiomarker guard is defensive.)
export function findResolvingIopReading(
  source: IopFollowUpRecord,
  _followUp: FollowUpItemLike,
  candidates: readonly IopFollowUpRecord[]
): IopFollowUpRecord | null {
  if (!source.date) return null; // an undated source can't order candidates
  let best: IopFollowUpRecord | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (!c.date || c.date <= source.date) continue;
    if (!isIopBiomarker(iopReadingName(c))) continue;
    if (!best || c.date > best.date || (c.date === best.date && c.id > best.id))
      best = c;
  }
  return best;
}

// A compact label for a resolving candidate, for the offer copy ("16 mmHg, left eye · 2026-08").
export function iopResolvingLabel(record: IopFollowUpRecord): string {
  const value = iopValueLabel(record) || iopReadingName(record);
  const eye = iopLateralityLabel(record);
  const head = eye ? `${value}, ${eye}` : value;
  const month = readingMonth(record);
  return month ? `${head} · ${month}` : head;
}

// The IOP adapter instance the builder consumes — one object satisfying the generic
// FollowUpAdapter<Source, Candidate> contract, the same seam imaging and labs fill.
export const iopFollowUpAdapter: FollowUpAdapter<
  IopFollowUpRecord,
  IopFollowUpRecord
> = {
  kind: IOP_FOLLOWUP_KIND,
  describeSource: iopSourceLabel,
  followUpTitle: iopFollowUpTitle,
  findResolvingRecord: findResolvingIopReading,
  describeResolvingRecord: iopResolvingLabel,
};
