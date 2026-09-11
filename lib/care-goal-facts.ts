// The summary row of the care-goal form (#5302, over #3218's primitive and #5300's
// grammar) — the second of the three care-overview forms.
//
// A CARE GOAL IS A TARGET AND A DATE TO AIM IT AT. The form asked five labelled
// questions — goal, target date, status, code, code system, notes — for the smallest
// of the thirteen. The DESCRIPTION ("A1c below 7.0%") stays above the chips as rule
// 1's one identifying field; the row states the target date and the status, which are
// exactly the two columns the goal list gives their own space to beside the goal
// itself (CareGoalList's `buildColumns`); the code and the notes fall behind the one
// trailing affordance.
//
// WHY `status` IS ESSENTIAL HERE while the care-plan form beside it calls the same
// field optional. NOTHING IN THE APP EVER WRITES A CARE GOAL'S STATUS. A care-plan
// item is closed for you — `markCarePlanItemDone` writes `status = 'completed'` from
// the Upcoming chip and the completed-appointment offer — but the only writer of
// `care_goals.status` is this form's own action. `isCareGoalOpen` gives "achieved" a
// terminal meaning the broader CarePlan vocabulary lacks, and an unstated status reads
// as open, so a goal nobody ever states one for keeps presenting as live and keeps
// drawing the scheduled-appointment reflection (#1355). The prompt is where that is
// cheapest to answer.
//
// AND WHY `target` IS ESSENTIAL. The goal's target date is the DATE WINDOW the same
// reflection matches within: HealthGoalsSection hands each goal to
// `scheduledAppointmentsForCareItems` as `planned_date: goal.target_date`, and
// `itemMatches` skips the window check entirely when that is null. So an undated goal
// matches a scheduled appointment on words alone, at any distance in time. The date is
// what keeps the match honest, which is why the row asks for it rather than letting it
// go quiet behind the more-line.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `careGoalFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import { titleCase } from "./record-format";

// The facts, in the order the row draws them. The two essentials lead.
export type CareGoalFactKey = "target" | "status" | "code" | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const CARE_GOAL_FACT_NOUNS: Record<CareGoalFactKey, string> = {
  target: "target date",
  status: "status",
  code: "code",
  notes: "notes",
};

export interface CareGoalFactInput {
  targetDate: string;
  /**
   * FREE-FORM BY DESIGN (#328): the importers pass FHIR lifecycle codes through
   * verbatim and the form takes a clinical status as typed, so the chip states the
   * person's own word rather than one bolted onto it.
   */
  status: string;
  code: string;
  /** Qualifies the code chip; never a chip of its own. */
  codeSystem: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function careGoalFactSummary(
  f: CareGoalFactInput
): RecordFactSummary<CareGoalFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<CareGoalFactKey>();

  const target = f.targetDate.trim();
  if (target) row.stated("target", `Target ${formatMonthDay(target, prefs)}`);
  else row.missing("target", "Add a target date");

  const status = f.status.trim();
  // `titleCase` is the casing the shared StatusBadge gives this same column on the
  // list (#643), so the chip and the badge cannot read differently.
  if (status) row.stated("status", titleCase(status));
  else row.missing("status", "Add a status");

  const code = f.code.trim();
  const system = f.codeSystem.trim();
  row.state("code", code, system ? `${code} · ${system}` : code);
  // The notes MARKER, not the notes (the visit row's reading of the same field).
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
