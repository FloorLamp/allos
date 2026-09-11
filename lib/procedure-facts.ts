// The summary row of the procedure / surgical-history form (#5302, over #3218's
// primitive and #5300's grammar) — the third of slice 3's forms, and the smallest of
// the twelve after the care goal.
//
// A PROCEDURE IS A CODED ACT ON A DAY. The form asked six labelled questions — name,
// code, code system, date, provider, notes — for a record whose entire downstream job
// is to quiet a preventive-screening clock. The NAME stays above the chips as rule 1's
// one identifying field (it is also the form's required value, and the field #1083's
// deep link seeds); the row states the code and the date; the provider and the notes
// fall behind the one trailing affordance.
//
// WHY `code` IS ESSENTIAL — the condition form's argument at the address where the
// consumer is the preventive clock rather than a safety screen. Every procedure is fed
// to `getInferredPreventiveSatisfactions` as `{ code, name, date, allow: ["screening"] }`
// and matched by `matchRuleKeys`, which reads the CODE against the concept map's exact
// table FIRST and falls back to whole-word NAME synonyms. A coded CPT 45378 satisfies
// colorectal screening outright; a free-typed "lower endoscopy" or "colo" reaches the
// rule only if its spelling happens to contain a curated needle, and otherwise the
// person is told they are overdue for the screening they just had. #1083's flow makes
// that the likely case rather than the rare one: the nudge deep-links here with
// `?new=1&name=<procedure>`, so the NAME arrives prefilled and the code is precisely
// the fact the person came to add. The dashed prompt is that gap's sentence.
//
// AND WHY `date` IS ESSENTIAL. `inferPreventiveSatisfactions` drops any record whose
// date is not a real ISO day before it ever reaches the matcher, so an undated
// colonoscopy satisfies NOTHING however well it is coded — it cannot be placed on the
// timeline the interval is measured along. An undated procedure is a row that exists
// and counts for nothing.
//
// THERE IS NO STATUS FACT HERE, and the asymmetry with both specialty forms in this
// slice is deliberate rather than an omission: `procedures` has no status column, the
// form renders no such control and the action parses none. A status chip would make
// the form post a field it has never posted, which #5302 rules out — the allergy form's
// `substance_code` refusal at this address.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `procedureFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";

// The facts, in the order the row draws them. The two essentials lead.
export type ProcedureFactKey = "code" | "date" | "provider" | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const PROCEDURE_FACT_NOUNS: Record<ProcedureFactKey, string> = {
  code: "code",
  date: "date",
  provider: "provider",
  notes: "notes",
};

export interface ProcedureFactInput {
  code: string;
  /** Qualifies the code chip; never a chip of its own. */
  codeSystem: string;
  date: string;
  provider: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function procedureFactSummary(
  f: ProcedureFactInput
): RecordFactSummary<ProcedureFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<ProcedureFactKey>();

  const code = f.code.trim();
  const system = f.codeSystem.trim();
  // The system qualifies the code rather than standing as its own chip: a bare "45378"
  // is a different concept in CPT and SNOMED CT, so the two read together or the chip
  // states less than it appears to (the condition row's rule at this address).
  if (code) row.stated("code", system ? `${code} · ${system}` : code);
  else row.missing("code", "Add a code");

  const date = f.date.trim();
  if (date) row.stated("date", formatMonthDay(date, prefs));
  else row.missing("date", "Add the date");

  row.state("provider", f.provider, f.provider.trim());
  // The notes MARKER, not the notes (the visit row's reading of the same field).
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
