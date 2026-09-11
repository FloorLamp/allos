// The summary row of the imaging-study form (#5302, over #3218's primitive and #5300's
// grammar) — slice 4's second form.
//
// AN IMAGING STUDY IS A MODALITY AIMED AT A PLACE ON A DAY. The form asked twelve
// labelled questions — modality, body region, laterality, study date, contrast and its
// agent, effective dose, indication, impression, status, two providers and notes — for
// a record with two downstream consumers: the CUMULATIVE RADIATION-DOSE card (#703 /
// #2970) and the imaging half of the finding → follow-up → resolution chain (#700). The
// MODALITY stays above the chips as rule 1's one identifying field: it is the coded
// pick over `IMAGING_MODALITIES`, the first thing `studyDisplayLabel` prints, and the
// key `resolveDoseEntry` and `sameImagingKind` both read first.
//
// WHY `study_date` IS ESSENTIAL, and it is the only one. BOTH consumers drop an undated
// study, each with its own line:
//
//   • `cumulativeDose` skips it before classifying anything (`if (!s.study_date)
//     continue`, lib/radiation-dose.ts:253) and `doseContributions` reports it under the
//     named exclusion `no-date` — "no study date, so it can't be placed on the timeline.
//     User-fixable" (lines 166-167). The module names the reason precisely because it
//     wants the person to fix it; the dashed chip is where that ask belongs.
//   • `findResolvingImagingStudy` returns null on its first line for an undated source
//     ("an undated source can't order candidates", lib/followup-imaging.ts:77) and skips
//     every undated candidate on the next, so a nodule follow-up hung off an undated CT
//     can never be closed by the scan that closes it.
//
// ── WHY `region` IS **OPTIONAL** HERE, WHERE THE SKIN FORM'S LOCATION IS ESSENTIAL ──
//
// This is the slice's asymmetry, and it is argued at THIS end rather than inherited
// from slice 3's. The two forms look like the same question — where on the body — and
// their resolution matchers are the same shape. They differ in what the matcher does
// with a blank:
//
//   • `sameLesion` (#482) compares a STRICT `region|side|label` identity key, so a
//     recheck recorded without the region never resolves the watch record that has one
//     and one mole's serial track silently splits in two. Hence `skin-lesion.location`
//     is essential.
//   • `sameImagingKind` is MODALITY-anchored and deliberately loose about the region:
//     `if (!ra || !rb) return true; // one side unspecified → modality match suffices`
//     (lib/followup-imaging.ts:63). A later CT resolves a CT follow-up whether or not
//     either study named a region. The comment above the function says the looseness is
//     on purpose, and bounds it — "never cross-modality — an ultrasound never resolves a
//     CT follow-up" — so the specificity that matters is carried by the field that IS
//     above the chips.
//
// The dose card reads the same way. `resolveDoseEntry` prefers a region-specific entry
// and falls back to `generic`, the modality's empty-regions entry (lib/radiation-dose.ts:118),
// which every modality in the dataset except the unclassifiable `other` has — so a
// region-less CT still contributes its typical estimate and is never reported as
// `no-entry`. An absent region costs specificity; it never costs the record.
//
// AND `laterality` IS ITS OWN CHIP, not folded into the region the way the skin form
// folds its side. The skin form fuses the two because `bodyMapLabel` is the ONE function
// every skin surface reads those two columns back through, so two chips would state one
// place twice. Imaging has no such function: `studyDisplayLabel` joins the side and the
// region but leads with the MODALITY, which is the heading here, and `sameImagingKind`
// reads the region ALONE while nothing but display reads the laterality. Two columns,
// two readers, two chips — and no new labeller invented to make the row look tidier.
//
// AND `dose` IS OPTIONAL although this is the dose card's own record, because the card
// is BUILT for its absence: `estimateStudyDose` falls through to the curated typical
// estimate (lines 135-144), and the field's own helper text already promises it
// ("Leave blank to use a typical estimate for the modality"). A recorded dose is a fact
// the report printed, and most reports do not print one.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `imagingStudyFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { lateralityLabel } from "./imaging-study";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import type { ImagingLaterality } from "./types/medical";

// The facts, in the order the row draws them. The one essential leads, then what
// narrows the study, then how it was read.
export type ImagingStudyFactKey =
  | "study_date"
  | "region"
  | "laterality"
  | "contrast"
  | "dose"
  | "indication"
  | "impression"
  | "status"
  | "ordering"
  | "radiologist"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const IMAGING_STUDY_FACT_NOUNS: Record<ImagingStudyFactKey, string> = {
  study_date: "study date",
  region: "body region",
  laterality: "laterality",
  contrast: "contrast",
  dose: "effective dose",
  indication: "indication",
  impression: "impression",
  status: "status",
  ordering: "ordering provider",
  radiologist: "reading radiologist",
  notes: "notes",
};

export interface ImagingStudyFactInput {
  studyDate: string;
  bodyRegion: string;
  /** The laterality select's value — "" is unstated, which is a real answer. */
  laterality: string;
  /** The checkbox. Unchecked is the presumption, not an omission (`normalizeContrast`). */
  contrast: boolean;
  /** Qualifies the contrast chip; never a chip of its own. */
  contrastAgent: string;
  /** The mSv field as the number input holds it. */
  doseMsv: string;
  indication: string;
  impression: string;
  status: string;
  orderingProvider: string;
  readingProvider: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

function isLaterality(v: string): v is ImagingLaterality {
  return v === "left" || v === "right" || v === "bilateral" || v === "na";
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function imagingStudyFactSummary(
  f: ImagingStudyFactInput
): RecordFactSummary<ImagingStudyFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<ImagingStudyFactKey>();

  const date = f.studyDate.trim();
  if (date) row.stated("study_date", formatMonthDay(date, prefs));
  else row.missing("study_date", "Add the study date");

  row.state("region", f.bodyRegion, f.bodyRegion.trim());
  // Through the one labeller the list and the passport read the column with.
  const side = isLaterality(f.laterality.trim())
    ? lateralityLabel(f.laterality.trim() as ImagingLaterality)
    : "";
  row.state("laterality", side, side);

  // The agent qualifies the fact rather than standing as its own chip: "with contrast"
  // is the claim, and the agent names which. An unchecked box is the presumption
  // `normalizeContrast` documents, so it states nothing.
  const agent = f.contrastAgent.trim();
  const contrast = f.contrast
    ? agent
      ? `With contrast (${agent})`
      : "With contrast"
    : "";
  row.state("contrast", contrast, contrast);

  const dose = f.doseMsv.trim();
  row.state("dose", dose, dose ? `${dose} mSv` : "");
  row.state("indication", f.indication, f.indication.trim());
  // The impression MARKER, not the impression: a radiologist's impression is a
  // paragraph, and a chip states a fact (the skin row's reading of its finding field).
  row.state("impression", f.impression, "Impression noted");
  row.state("status", f.status, f.status.trim());
  row.state("ordering", f.orderingProvider, f.orderingProvider.trim());
  row.state("radiologist", f.readingProvider, f.readingProvider.trim());
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
