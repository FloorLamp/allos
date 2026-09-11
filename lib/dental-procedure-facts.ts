// The summary row of the dental-procedure form (#5302, over #3218's primitive and
// #5300's grammar) — the second of slice 3's specialty forms.
//
// A DENTAL RECORD IS A PROCEDURE OR A FINDING, ON A DAY, IN A STATE. The form asked
// eleven labelled questions — name, status, date, tooth, numbering system, surface, CDT
// code, recheck interval, finding, provider, notes — for a record two separate engines
// read: the #704 pre-procedure safety cross-check and the #82 preventive clock. The
// NAME stays above the chips as rule 1's one identifying field (it is also the form's
// required value); the row states the three facts those engines read; the rest fall
// behind the one trailing affordance.
//
// WHY `cdt` IS ESSENTIAL — the condition form's `code` argument at this address, and
// the reason it is worth making again is that the consumer is a SAFETY screen.
// `isInvasiveDentalProcedure(name, cdt_code)` is the ONE gate `getDentalSafetyWarnings`
// fires on, and the MRONJ / antibiotic-prophylaxis / anticoagulant-bleeding notes exist
// only behind it. It reads the CDT code FIRST (D7xxx, D6010–D6199, D4210–D4286,
// D3410–D3473) and falls back to fourteen whole-word NAME patterns that are
// "deliberately conservative on the NON-invasive side" so "an unrecognized procedure
// returns false". A planned surgical extraction typed as "#17 exo" or "alveolar ridge
// reduction" therefore matches nothing and carries no note at all, while its D7xxx code
// would have caught it. The same column is also the preventive clock's code-first
// signal (`getInferredPreventiveSatisfactions` passes `code: d.cdt_code`). The dashed
// prompt is that gap's sentence, said where it can be answered.
//
// AND WHY `date` IS ESSENTIAL. An undated record is dropped by BOTH readers. The
// follow-up chain's `findResolvingDentalRecord` returns null on its first line when the
// source has no `procedure_date` ("undated source can't order candidates"), so a "watch
// #14" finding with no date can never be closed by the re-exam that closes it; and
// `inferPreventiveSatisfactions` skips any record whose date is not a real ISO day, so
// a logged cleaning with no date never satisfies `dental_cleaning` and the person keeps
// being told the visit is overdue.
//
// AND WHY `status` IS ALWAYS STATED. The select is born "completed" and
// `normalizeDentalStatus` degrades anything else onto the enum, so the fact can never
// be absent and the more-line can never hold it (the allergy and injury forms' reading
// of the same case). It also happens to be the discriminator both engines gate on —
// 'planned' is the safety check's trigger and 'completed' is the preventive clock's
// evidence — so the row showing it before the save is the row showing which of the two
// this record is about to become.
//
// WHY `tooth` IS OPTIONAL, WHICH IS THE ASYMMETRY WITH THE SKIN FORM BESIDE IT. Both
// forms carry a "where on the body" fact and the resolution matchers read them in
// OPPOSITE directions. Skin's `sameLesion` is STRICT, so an omitted region splits one
// mole's track and its recheck never resolves — hence essential there. Dental's
// `sameTooth` is deliberately LOOSE in exactly the absent case: `if (!ta || !tb) return
// true`, "one side unspecified → recency match suffices", because "a general re-exam
// can resolve a general finding". An absent tooth is therefore DEFINED rather than
// missing, and most of what this form records — a prophylaxis, an exam, a full-mouth
// series — genuinely has no tooth to name. The tooth, its numbering system and the
// surface are ONE chip over ONE editor, read back through `toothLabel` ("#14 MOD") —
// the same labeller `dentalDisplayLabel` builds the list row from, so the chip cannot
// state a tooth differently from the row it will become. The NUMBERING SYSTEM is in
// that editor too but reaches neither a chip of its own nor the tooth chip's wording:
// no display surface reads `tooth_system`, so putting it on the chip would make the
// chip state something the list row it becomes never shows.
//
// AND WHY `recheck` IS OPTIONAL despite naming a follow-up: nothing reads the stored
// `follow_up_interval_days` to schedule anything. `trackDentalFollowUp` takes its
// interval from the list's own scheduler and refuses a missing one there; the column is
// what the exam note SAID ("recheck in 6 months"), so its absence is absence.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `dentalFactSummary`.

import { dentalStatusLabel, normalizeDentalStatus, toothLabel } from "./dental";
import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";

// The facts, in the order the row draws them. The three essentials lead.
export type DentalProcedureFactKey =
  | "date"
  | "status"
  | "cdt"
  | "tooth"
  | "recheck"
  | "finding"
  | "provider"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const DENTAL_PROCEDURE_FACT_NOUNS: Record<
  DentalProcedureFactKey,
  string
> = {
  date: "date",
  status: "status",
  cdt: "CDT code",
  tooth: "tooth",
  recheck: "recheck interval",
  finding: "finding",
  provider: "provider",
  notes: "notes",
};

export interface DentalProcedureFactInput {
  procedureDate: string;
  /** Born "completed" and normalized on the server, so never blank. */
  status: string;
  cdtCode: string;
  /** The tooth designation as typed — "14", "#14", "UL6", "A". */
  tooth: string;
  /** Qualifies the tooth chip; never a chip of its own ("#14 MOD"). */
  surface: string;
  recheckDays: string;
  finding: string;
  provider: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function dentalFactSummary(
  f: DentalProcedureFactInput
): RecordFactSummary<DentalProcedureFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<DentalProcedureFactKey>();

  const date = f.procedureDate.trim();
  if (date) row.stated("date", formatMonthDay(date, prefs));
  else row.missing("date", "Add the date");

  // Through the ONE labeller the list badge already uses, so the chip and the badge
  // cannot read differently. The normalizer is the server's own coercion, so the chip
  // states what the action WILL store rather than what the select happens to hold.
  row.stated("status", dentalStatusLabel(normalizeDentalStatus(f.status)));

  const cdt = f.cdtCode.trim();
  if (cdt) row.stated("cdt", cdt);
  // On the row rather than behind "more", because an uncoded record is the row the
  // #704 invasiveness gate can only guess at from its name.
  else row.missing("cdt", "Add a CDT code");

  // The tooth, its system and its surface as the ONE line `dentalDisplayLabel` builds
  // the list row from. "" when no tooth is named — a surface with no tooth is not a
  // location, which is `toothLabel`'s own rule and not one re-decided here.
  const tooth = toothLabel({
    tooth: f.tooth || null,
    surface: f.surface || null,
  });
  row.state("tooth", tooth, tooth);
  const recheck = f.recheckDays.trim();
  row.state("recheck", recheck, recheck ? `Recheck in ${recheck} days` : "");
  // The finding MARKER, not the finding: the clinical impression is a paragraph, and a
  // chip states a fact (the visit row's reading of the same shape).
  row.state("finding", f.finding, "Finding noted");
  row.state("provider", f.provider, f.provider.trim());
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
