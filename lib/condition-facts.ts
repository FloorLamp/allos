// The summary row of the condition form (#5302, over #3218's primitive and #5300's
// grammar) — the FIRST of the thirteen clinical record forms to adopt it.
//
// A CONDITION IS A CODED PICK AND A STATUS. The form asked ten labelled questions —
// name, code, code system, status, onset, side, severity, stage, resolved date, notes
// — for a record whose ICD-10-CM pick already answers the first three. So the name
// stays above the chips as rule 1's one identifying field, the code and the status are
// the two facts the row STATES, and the other six fall behind the one trailing
// affordance until someone wants them.
//
// WHY `code` IS AN ESSENTIAL AND NOT AN OPTIONAL, which is the only classification
// here worth arguing. A condition with no code is not merely a thinner record: the
// coded safety screens run code-first with a name-substring fallback and the
// risk-factor derivations key on ICD (#5287's `condition-code` gap, 170 of 178 rows on
// the last prod snapshot). The dashed prompt IS that gap's sentence, said at the moment
// the person could answer it, which is why #5302 puts the code chip's prompt behaviour
// on this form rather than inventing it later.
//
// AND WHY `status` IS ALWAYS STATED. The select is born "active" and the action writes
// whatever it holds, so the status is never absent — a default the form WILL write is
// exactly the kind of fact the row exists to show before it is written (the injury
// form's reading of the same case, lib/injury-facts.ts).
//
// The chip shape, the more-line's label and the state-or-defer loop are the family's,
// not this form's: see lib/record-facts.ts, which also carries the argument for why
// each record form has a module of its own at all.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states — which facts the row
// states, which it prompts for, which fall behind the trailing affordance — never this
// file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `conditionFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import type {
  ConditionLaterality,
  ConditionSeverity,
  ConditionStatus,
} from "./types";

// The facts, in the order the row draws them. `code` leads because it is what the
// seeding pick answers (#3218's contract: the chips follow the pick), and `resolved`
// sits beside the status it belongs to.
export type ConditionFactKey =
  | "code"
  | "status"
  | "onset"
  | "laterality"
  | "severity"
  | "stage"
  | "resolved"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const CONDITION_FACT_NOUNS: Record<ConditionFactKey, string> = {
  code: "code",
  status: "status",
  onset: "onset",
  laterality: "side",
  severity: "severity",
  stage: "stage",
  resolved: "resolved date",
  notes: "notes",
};


const STATUS_LABELS: Record<ConditionStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  resolved: "Resolved",
};

export interface ConditionFactInput {
  /** The code field's value, already trimmed or not — blank means no code. */
  code: string;
  /** The code system's value. Qualifies the code chip; never a chip of its own. */
  codeSystem: string;
  /**
   * True while the code on screen came from the catalog pick or the accepted
   * suggestion and the person has not typed over it (#846).
   */
  codeSuggested: boolean;
  status: ConditionStatus;
  onsetDate: string;
  laterality: ConditionLaterality | "";
  severity: ConditionSeverity | "";
  stage: string;
  resolvedDate: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

const cased = (v: string): string => v[0].toUpperCase() + v.slice(1);

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 *
 * THE RESOLVED DATE EXISTS ONLY WHILE THE STATUS IS RESOLVED, and it is left out of
 * BOTH lists otherwise rather than tucked into the more-line. The form has always
 * mounted that field conditionally, and naming a resolved date behind "more" on an
 * active condition would offer a fact the record cannot hold — the protocol form's
 * reading of the same case ("a cadence of nothing is not a fact", lib/protocol-facts).
 */
export function conditionFactSummary(
  f: ConditionFactInput
): RecordFactSummary<ConditionFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<ConditionFactKey>();
  const day = (iso: string) => formatMonthDay(iso, prefs);

  const code = f.code.trim();
  const system = f.codeSystem.trim();
  if (code) {
    // The system qualifies the code rather than standing as its own chip: a bare
    // "250.00" is a different concept in ICD-9 and ICD-10, so the two read together or
    // the chip states less than it appears to.
    row.stated("code", system ? `${code} · ${system}` : code, f.codeSuggested);
  } else {
    // #5287's `condition-code` gap, as the dashed prompt. On the row rather than behind
    // "more", because a code-less condition is the row the coded screens cannot read.
    row.missing("code", "Add a code");
  }

  row.stated("status", STATUS_LABELS[f.status]);
  row.state(
    "onset",
    f.onsetDate,
    f.onsetDate.trim() ? `Onset ${day(f.onsetDate)}` : ""
  );
  row.state("laterality", f.laterality, f.laterality ? cased(f.laterality) : "");
  row.state("severity", f.severity, f.severity ? cased(f.severity) : "");
  // The stage reads as recorded — staging vocabularies are open-ended, so the chip
  // states the person's own token rather than a word bolted onto it.
  row.state("stage", f.stage, f.stage.trim());
  if (f.status === "resolved")
    row.state(
      "resolved",
      f.resolvedDate,
      f.resolvedDate.trim() ? `Resolved ${day(f.resolvedDate)}` : ""
    );
  // The notes MARKER, not the notes: a chip states a fact, and a pasted paragraph would
  // state it at the row's expense (the visit row's reading of the same field).
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
