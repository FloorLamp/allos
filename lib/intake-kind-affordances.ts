// Which affordances a derived kind gets, in the ONE intake form (#3216).
//
// WHAT THIS INHERITS. #846 split one shared form in two because the shared body
// taught the user wrong: a medication was offered SUPPLEMENT_BRANDS ("e.g. Thorne"),
// a Stack field, workout-relative scheduling and dose suggestions from the supplement
// catalog. The split made that structurally impossible by making the two forms
// different FILES, and a text-scanning test guarded the seam.
//
// The merge puts one form back — so the guarantee has to survive somewhere else, and
// this is where. The rule is no longer "these two files may not mention each other's
// tokens"; it is "for the kind this form has DERIVED, the affordances offered are that
// kind's own". That is the property the split was actually protecting, and unlike the
// text scan it is a behaviour: it fails when the form shows a med the supplement brand
// list, not when a comment mentions the word.
//
// Pure over the derived kind. The form reads it; the test asserts it per kind.

import type {
  IntakeCondition,
  IntakeItemKind,
  IntakeObligation,
} from "./types";
import { availableIntakeConditions } from "./intake-schedule";

export type IntakeBrandSource = "medication" | "supplement";

export interface IntakeKindAffordances {
  kind: IntakeItemKind;
  // The one name field's placeholder — the thing that taught wrong before #846.
  namePlaceholder: string;
  brandPlaceholder: string;
  brandSource: IntakeBrandSource;
  // Which `condition` values this kind may schedule by. Workout/rest days are a
  // supplement concept; a medication is daily or situational.
  conditions: IntakeCondition[];
  // Medication-only surfaces.
  prescription: boolean;
  redose: boolean;
  pediatric: boolean;
  indication: boolean;
  // Supplement-only surfaces.
  stack: boolean;
  composition: boolean;
  // Where the dose-amount suggestions come from: OTC label figures vs the catalog.
  dosageSource: IntakeBrandSource;
  // The kind's default obligation — a medication is `must` because that is the
  // posture a prescription is prescribed under (#1505).
  defaultObligation: IntakeObligation;
}

const MEDICATION_CONDITIONS: IntakeCondition[] = ["daily", "situational"];

export function intakeKindAffordances(
  kind: IntakeItemKind,
  options: {
    // Under early childhood the workout logger stands down, so new workout-relative
    // schedules do too; a stored value stays selectable while editing.
    activityScheduleAvailable?: boolean;
    storedCondition?: IntakeCondition | null;
  } = {}
): IntakeKindAffordances {
  if (kind === "medication") {
    return {
      kind,
      namePlaceholder: "e.g. Ibuprofen",
      brandPlaceholder: "e.g. Advil",
      brandSource: "medication",
      conditions: MEDICATION_CONDITIONS,
      prescription: true,
      redose: true,
      pediatric: true,
      indication: true,
      stack: false,
      composition: false,
      dosageSource: "medication",
      defaultObligation: "must",
    };
  }
  const { activityScheduleAvailable = true, storedCondition = null } = options;
  return {
    kind,
    namePlaceholder: "e.g. Vitamin D3",
    brandPlaceholder: "e.g. Thorne",
    brandSource: "supplement",
    conditions: availableIntakeConditions(
      activityScheduleAvailable,
      storedCondition
    ),
    prescription: false,
    redose: false,
    pediatric: false,
    indication: false,
    stack: true,
    composition: true,
    dosageSource: "supplement",
    defaultObligation: "should",
  };
}
