// The IMAGING domain adapter for the finding → follow-up → resolution chain (issue
// #700) — the FIRST and driving adapter (highest harm, richest findings). PURE — it
// operates on ImagingStudy shapes, no DB/network. It plugs into the domain-agnostic
// core (lib/followup.ts) by answering three domain questions: what a source imaging
// finding reads as, what its follow-up is called, and which LATER study resolves it.
// #698 (IOP), #705 (dental), #715 (skin) each ship a sibling adapter of this shape.

import type { ImagingStudy } from "./types";
import { modalityLabel, studyDisplayLabel } from "./imaging-study";
import type { FollowUpAdapter, FollowUpItemLike } from "./followup";

// The imaging source kind stored in care_plan_items.source_kind.
export const IMAGING_FOLLOWUP_KIND = "imaging";

// YYYY-MM of a study date (for the compact "(2026-03)" reason tail). Empty when the
// study is undated.
function studyMonth(study: Pick<ImagingStudy, "study_date">): string {
  return study.study_date ? study.study_date.slice(0, 7) : "";
}

// A short human label for the source imaging finding. Prefers the radiologist's
// impression (that IS the finding — "6 mm RLL nodule"), collapsed to one line and
// capped so a paragraph-length impression stays a legible reason; falls back to the
// study display label ("MRI Left Knee") when there's no impression. A YYYY-MM tail
// pins WHICH study, so a serial view reads unambiguously across time.
export function imagingSourceLabel(study: ImagingStudy): string {
  const impression = study.impression?.replace(/\s+/g, " ").trim();
  const core =
    impression && impression.length > 0
      ? impression.length > 80
        ? `${impression.slice(0, 77)}…`
        : impression
      : studyDisplayLabel(study);
  const month = studyMonth(study);
  return month ? `${core} (${month})` : core;
}

// The default follow-up title for an imaging source ("Follow-up CT", "Follow-up MRI
// knee"). The modality is the verb; the region (when known) narrows it.
export function imagingFollowUpTitle(study: ImagingStudy): string {
  const region = study.body_region?.trim();
  return region
    ? `Follow-up ${modalityLabel(study.modality)} ${region.toLowerCase()}`
    : `Follow-up ${modalityLabel(study.modality)}`;
}

// Whether two imaging studies describe the SAME anatomy for resolution matching:
// same modality, and — when both name a body region — an overlapping region
// (case-insensitive substring either way, so "chest" resolves "CT chest w/o
// contrast"'s region). A study with no region is matched on modality alone. This is
// the imaging adapter's answer to "which later study resolves this follow-up"; it is
// deliberately loose (modality-anchored) but never cross-modality — an ultrasound
// never resolves a CT follow-up.
function sameImagingKind(a: ImagingStudy, b: ImagingStudy): boolean {
  if (a.modality !== b.modality) return false;
  const ra = a.body_region?.trim().toLowerCase();
  const rb = b.body_region?.trim().toLowerCase();
  if (!ra || !rb) return true; // one side unspecified → modality match suffices
  return ra.includes(rb) || rb.includes(ra);
}

// The later imaging study that resolves a follow-up for `source`, or null when none
// has landed. A candidate qualifies when it is a DIFFERENT study of the same imaging
// kind (sameImagingKind) whose study_date is STRICTLY AFTER the source study's date.
// The MOST RECENT qualifying study wins (the actual follow-up result). Confirm-first:
// returning a candidate only OFFERS the resolution; the user records the outcome.
export function findResolvingImagingStudy(
  source: ImagingStudy,
  _followUp: FollowUpItemLike,
  candidates: readonly ImagingStudy[]
): ImagingStudy | null {
  if (!source.study_date) return null; // an undated source can't order candidates
  let best: ImagingStudy | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (!c.study_date || c.study_date <= source.study_date) continue;
    if (!sameImagingKind(source, c)) continue;
    if (!best || c.study_date > best.study_date! || (c.study_date === best.study_date! && c.id > best.id))
      best = c;
  }
  return best;
}

// A compact label for a resolving candidate, for the offer copy ("CT chest · 2026-03").
export function imagingResolvingLabel(study: ImagingStudy): string {
  const label = studyDisplayLabel(study);
  const month = studyMonth(study);
  return month ? `${label} · ${month}` : label;
}

// The imaging adapter instance the builder consumes. One object satisfying the
// generic FollowUpAdapter<Source, Candidate> contract — the seam a new domain copies.
export const imagingFollowUpAdapter: FollowUpAdapter<ImagingStudy, ImagingStudy> = {
  kind: IMAGING_FOLLOWUP_KIND,
  describeSource: imagingSourceLabel,
  followUpTitle: imagingFollowUpTitle,
  findResolvingRecord: findResolvingImagingStudy,
  describeResolvingRecord: imagingResolvingLabel,
};
