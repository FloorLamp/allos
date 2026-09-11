// The summary row of the care-plan form (#5302, over #3218's primitive and #5300's
// grammar) — the first of the three care-overview forms, and an adopter of the shape
// lib/condition-facts.ts set rather than a re-derivation of it.
//
// A CARE-PLAN ITEM IS A PLANNED THING AND A DATE. The form asked seven labelled
// questions — planned item, category, status, code, code system, planned date,
// provider, notes — with a standing paragraph about unrecognized statuses underneath.
// The DESCRIPTION stays above the chips as rule 1's one identifying field, the row
// states the planned date, and the rest fall behind the one trailing affordance.
//
// WHY `planned` IS THE ESSENTIAL, and the only one. An UNDATED care-plan item never
// reaches Upcoming at all: `carePlanUpcomingItems` keeps `planned_date != null &&
// isCarePlanItemOpen(status)` and drops everything else, so a plan with no date is
// recorded and then silently never mentioned again. The dashed prompt IS that
// omission's sentence, said at the moment the person could answer it — the same
// reading the condition form gives #5287's code gap.
//
// AND WHY `status` IS OPTIONAL HERE while the care-goal form beside it calls the same
// field essential. The two are not the same question. A care-plan item's absent status
// is READ — `isCarePlanItemOpen(null)` is `true`, the safe direction — and the app
// ITSELF writes the close: `markCarePlanItemDone` sets `status = 'completed'` from the
// Upcoming chip and the completed-appointment offer. So the person never has to state
// one for the machinery to work, and a dashed prompt on every new plan would ask for a
// value whose absence already means the right thing. Nothing writes a care GOAL's
// status but the person (lib/care-goal-facts), which is why that form prompts.
//
// The chip shape, the more-line's label and the state-or-defer loop are the family's:
// see lib/record-facts.ts.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `carePlanFactSummary`.

import { carePlanCategoryLabel } from "./care-plan-upcoming";
import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import { titleCase } from "./record-format";

// The facts, in the order the row draws them. `planned` leads because it is the one
// the row prompts for, and `code` sits beside the category it qualifies.
export type CarePlanFactKey =
  "planned" | "category" | "status" | "code" | "provider" | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const CARE_PLAN_FACT_NOUNS: Record<CarePlanFactKey, string> = {
  planned: "planned date",
  category: "category",
  status: "status",
  code: "code",
  provider: "provider",
  notes: "notes",
};

export interface CarePlanFactInput {
  /**
   * The values the form WILL POST, not the picker's own state. Both pickers carry a
   * free-text escape whose sentinel is never stored, so the chip has to read what the
   * hidden/paired input holds or it would state `__other` at the person.
   */
  category: string;
  status: string;
  code: string;
  /** Qualifies the code chip; never a chip of its own. */
  codeSystem: string;
  plannedDate: string;
  provider: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function carePlanFactSummary(
  f: CarePlanFactInput
): RecordFactSummary<CarePlanFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<CarePlanFactKey>();

  const planned = f.plannedDate.trim();
  if (planned)
    row.stated("planned", `Planned ${formatMonthDay(planned, prefs)}`);
  // On the row rather than behind "more": an undated plan is the one Upcoming cannot
  // read, so this is the prompt that keeps a plan from going quiet.
  else row.missing("planned", "Add a planned date");

  // Through the SAME labeller the Upcoming subtitle uses, so a chip never names a
  // bucket differently from the feed — and an unrecognized imported value is
  // capitalized and shown rather than dropped.
  row.state("category", f.category, carePlanCategoryLabel(f.category) ?? "");
  // `titleCase` is the casing the shared StatusBadge gives this same column on the
  // list (#643), so the chip and the badge cannot read differently.
  row.state(
    "status",
    f.status,
    f.status.trim() ? titleCase(f.status.trim()) : ""
  );

  const code = f.code.trim();
  const system = f.codeSystem.trim();
  // The system qualifies the code rather than standing as its own chip: a bare "45378"
  // is a different concept in CPT and SNOMED (the condition row's reading).
  row.state("code", code, system ? `${code} · ${system}` : code);
  row.state("provider", f.provider, f.provider.trim());
  // The notes MARKER, not the notes: a chip states a fact, and a pasted paragraph would
  // state it at the row's expense (the visit row's reading of the same field).
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
