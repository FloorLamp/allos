import { describe, it, expect } from "vitest";
import {
  conditionFactSummary,
  CONDITION_FACT_NOUNS,
  type ConditionFactInput,
  type ConditionFactKey,
} from "@/lib/condition-facts";
import {
  allergyFactSummary,
  ALLERGY_FACT_NOUNS,
  type AllergyFactInput,
  type AllergyFactKey,
} from "@/lib/allergy-facts";
import {
  carePlanFactSummary,
  CARE_PLAN_FACT_NOUNS,
  type CarePlanFactInput,
  type CarePlanFactKey,
} from "@/lib/care-plan-facts";
import {
  careGoalFactSummary,
  CARE_GOAL_FACT_NOUNS,
  type CareGoalFactInput,
  type CareGoalFactKey,
} from "@/lib/care-goal-facts";
import {
  familyFactSummary,
  FAMILY_HISTORY_FACT_NOUNS,
  type FamilyHistoryFactInput,
  type FamilyHistoryFactKey,
} from "@/lib/family-history-facts";
import { moreRecordFactsLabel } from "@/lib/record-facts";

// The clinical record family's fact summaries (#5302), in ONE file for the family
// rather than one per form. The question every one of the thirteen asks is the same —
// which facts does the row state, which does it prompt for, which fall behind the
// trailing affordance — so a slice adopting a form adds a `describe` here instead of a
// test file, and the family's answers stay readable side by side.
//
// WHAT THESE ASSERT is the chip KEYS and their STATES, never the wording: copy changes,
// and "a condition with no code PROMPTS rather than going quiet" does not.

/** A condition whose every optional fact is stated, so a case can empty one at a time. */
const FULL_CONDITION: ConditionFactInput = {
  code: "J45.909",
  codeSystem: "ICD-10-CM",
  codeSuggested: false,
  status: "active",
  onsetDate: "2026-03-04",
  laterality: "left",
  severity: "moderate",
  stage: "Grade II",
  resolvedDate: "",
  notes: "seasonal",
};

const keysOf = (chips: { key: string }[]) => chips.map((c) => c.key);
const stateOf = (chips: { key: string; state: string }[], key: string) =>
  chips.find((c) => c.key === key)?.state;

describe("the condition row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = conditionFactSummary(FULL_CONDITION);
    expect(keysOf(chips)).toEqual([
      "code",
      "status",
      "onset",
      "laterality",
      "severity",
      "stage",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("prompts for a missing code rather than going quiet about it", () => {
    // The essential/optional split is the whole point: an absent OPTIONAL renders
    // nothing and is reached through the trailing affordance, but an absent ESSENTIAL
    // is dashed and on the row. #5287's `condition-code` gap is that prompt.
    const { chips, more } = conditionFactSummary({
      ...FULL_CONDITION,
      code: "",
      codeSystem: "",
    });
    expect(stateOf(chips, "code")).toBe("missing");
    expect(more).not.toContain("code");
  });

  it("marks a code the app supplied as a suggestion, and a typed one as stated", () => {
    // #846: a value supplied FOR the person is an editable suggestion, not something
    // they said. The chip carries the marking; the primitive renders it.
    expect(
      conditionFactSummary({ ...FULL_CONDITION, codeSuggested: true }).chips[0]
    ).toMatchObject({ key: "code", state: "stated", suggested: true });
    expect(conditionFactSummary(FULL_CONDITION).chips[0]).toMatchObject({
      key: "code",
      suggested: false,
    });
  });

  it("states the status even when nobody chose it", () => {
    // A new condition is born active and the action writes that, so the status is a
    // default the form WILL write — exactly what the row exists to show beforehand.
    expect(stateOf(conditionFactSummary(FULL_CONDITION).chips, "status")).toBe(
      "stated"
    );
  });

  it("offers the resolved date only while the condition is resolved", () => {
    const active = conditionFactSummary({
      ...FULL_CONDITION,
      resolvedDate: "",
    });
    expect(keysOf(active.chips)).not.toContain("resolved");
    expect(active.more).not.toContain("resolved");

    const resolved = conditionFactSummary({
      ...FULL_CONDITION,
      status: "resolved",
      resolvedDate: "",
    });
    // Optional, so an empty one goes behind the trailing affordance rather than
    // accusing a just-resolved condition of missing something.
    expect(resolved.more).toContain("resolved");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = conditionFactSummary({
      ...FULL_CONDITION,
      laterality: "",
      stage: "",
      notes: "",
    });
    const expected: ConditionFactKey[] = ["laterality", "stage", "notes"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, CONDITION_FACT_NOUNS)).toBe(
      "side, stage, notes…"
    );
  });
});

const FULL_ALLERGY: AllergyFactInput = {
  reactions: [
    { manifestation: "Hives", severity: "moderate" },
    { manifestation: "Wheeze", severity: "severe" },
  ],
  criticality: "high",
  verification: "confirmed",
  status: "active",
  onsetDate: "2026-01-09",
  provider: "Dr. Okafor",
  encounter: "Mar 3 · Allergy clinic",
  linkableVisits: true,
  notes: "carries an auto-injector",
};

describe("the allergy row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = allergyFactSummary(FULL_ALLERGY);
    expect(keysOf(chips)).toEqual([
      "reaction",
      "severity",
      "criticality",
      "verification",
      "status",
      "onset",
      "provider",
      "encounter",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("prompts for both essentials when the reaction list is blank", () => {
    // The form always mounts one empty pair so there is something to type into, so a
    // blank row must not be read as a stated reaction.
    const { chips } = allergyFactSummary({
      ...FULL_ALLERGY,
      reactions: [{ manifestation: "", severity: "" }],
    });
    expect(stateOf(chips, "reaction")).toBe("missing");
    expect(stateOf(chips, "severity")).toBe("missing");
  });

  it("prompts for the grade alone when the reaction is stated and ungraded", () => {
    // Two facts, two chips, two independent prompts: "Hives" and "Hives, severe" are
    // different clinical claims and the second is what the emergency card reads.
    const { chips } = allergyFactSummary({
      ...FULL_ALLERGY,
      reactions: [{ manifestation: "Hives", severity: "" }],
    });
    expect(stateOf(chips, "reaction")).toBe("stated");
    expect(stateOf(chips, "severity")).toBe("missing");
  });

  it("leaves the visit link out entirely when there is no visit to link to", () => {
    const { chips, more } = allergyFactSummary({
      ...FULL_ALLERGY,
      encounter: "",
      linkableVisits: false,
    });
    expect(keysOf(chips)).not.toContain("encounter");
    expect(more).not.toContain("encounter");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = allergyFactSummary({
      ...FULL_ALLERGY,
      criticality: "",
      provider: "",
      encounter: "",
    });
    const expected: AllergyFactKey[] = ["criticality", "provider", "encounter"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, ALLERGY_FACT_NOUNS)).toBe(
      "criticality, who documented it, visit…"
    );
  });
});

const FULL_CARE_PLAN: CarePlanFactInput = {
  category: "procedure",
  status: "planned",
  code: "45378",
  codeSystem: "CPT",
  plannedDate: "2026-11-02",
  provider: "Dr. Smith",
  notes: "bowel prep posted",
};

describe("the care-plan row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = carePlanFactSummary(FULL_CARE_PLAN);
    expect(keysOf(chips)).toEqual([
      "planned",
      "category",
      "status",
      "code",
      "provider",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("prompts for a missing planned date rather than going quiet about it", () => {
    // The sharpest of the family's essentials: carePlanUpcomingItems keeps only
    // `planned_date != null` rows, so an undated plan is recorded and then never
    // mentioned again. The prompt is on the ROW, not behind the trailing affordance.
    const { chips, more } = carePlanFactSummary({
      ...FULL_CARE_PLAN,
      plannedDate: "",
    });
    expect(stateOf(chips, "planned")).toBe("missing");
    expect(more).not.toContain("planned");
  });

  it("lets an unstated status go quiet, because the app closes the item itself", () => {
    // The asymmetry with the care goal below, asserted rather than only argued: an
    // absent care-plan status reads as OPEN and markCarePlanItemDone writes the close,
    // so it reaches the more-line instead of prompting.
    const { chips, more } = carePlanFactSummary({
      ...FULL_CARE_PLAN,
      status: "",
    });
    expect(keysOf(chips)).not.toContain("status");
    expect(more).toContain("status");
  });

  it("states what the form will post, not the picker's own sentinel", () => {
    // Both pickers hand the free-text escape's value to the summary, so a typed
    // category reads as itself and never as the never-stored "__other".
    const { chips } = carePlanFactSummary({
      ...FULL_CARE_PLAN,
      category: "awaiting authorization",
    });
    expect(chips.find((c) => c.key === "category")?.label).toBe(
      "Awaiting authorization"
    );
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = carePlanFactSummary({
      ...FULL_CARE_PLAN,
      category: "",
      provider: "",
      notes: "",
    });
    const expected: CarePlanFactKey[] = ["category", "provider", "notes"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, CARE_PLAN_FACT_NOUNS)).toBe(
      "category, provider, notes…"
    );
  });
});

const FULL_CARE_GOAL: CareGoalFactInput = {
  targetDate: "2026-12-01",
  status: "active",
  code: "4548-4",
  codeSystem: "LOINC",
  notes: "reviewed at last visit",
};

describe("the care-goal row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = careGoalFactSummary(FULL_CARE_GOAL);
    expect(keysOf(chips)).toEqual(["target", "status", "code", "notes"]);
    expect(more).toEqual([]);
  });

  it("prompts for both essentials when neither is stated", () => {
    // The mirror of the care-plan case above: NOTHING in the app writes a care goal's
    // status, so an unstated one stays unstated and the row says so rather than
    // folding it behind the trailing affordance.
    const { chips, more } = careGoalFactSummary({
      ...FULL_CARE_GOAL,
      targetDate: "",
      status: "",
    });
    expect(stateOf(chips, "target")).toBe("missing");
    expect(stateOf(chips, "status")).toBe("missing");
    expect(more).not.toContain("status");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = careGoalFactSummary({
      ...FULL_CARE_GOAL,
      code: "",
      codeSystem: "",
      notes: "",
    });
    const expected: CareGoalFactKey[] = ["code", "notes"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, CARE_GOAL_FACT_NOUNS)).toBe(
      "code, notes…"
    );
  });
});

const FULL_FAMILY: FamilyHistoryFactInput = {
  relation: "Father",
  code: "I25.10",
  codeSystem: "ICD-10-CM",
  codeSuggested: false,
  relationship: "genetic",
  lineage: "paternal",
  onsetAge: "48",
  deceased: true,
  ageAtDeath: "52",
  causeOfDeath: "Myocardial infarction",
  notes: "two stents",
};

describe("the family-history row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = familyFactSummary(FULL_FAMILY);
    expect(keysOf(chips)).toEqual([
      "relation",
      "code",
      "relationship",
      "lineage",
      "onsetAge",
      "death",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("prompts for both essentials when the relative and the code are blank", () => {
    const { chips } = familyFactSummary({
      ...FULL_FAMILY,
      relation: "",
      code: "",
      codeSystem: "",
    });
    expect(stateOf(chips, "relation")).toBe("missing");
    expect(stateOf(chips, "code")).toBe("missing");
  });

  it("marks a code the pick supplied as a suggestion, and a typed one as stated", () => {
    // #846, the condition row's rule at this address: the picker applies the curated
    // code FOR the person, so the chip says it is an editable suggestion.
    expect(
      familyFactSummary({ ...FULL_FAMILY, codeSuggested: true }).chips[1]
    ).toMatchObject({ key: "code", state: "stated", suggested: true });
    expect(familyFactSummary(FULL_FAMILY).chips[1]).toMatchObject({
      key: "code",
      suggested: false,
    });
  });

  it("states the three death columns as ONE fact, read back as one line", () => {
    // They describe one event, so the row states it once — and an age or a cause on
    // its own implies the death it describes, which is familyDeathLabel's own rule
    // rather than anything this module re-decides.
    const { chips } = familyFactSummary({
      ...FULL_FAMILY,
      deceased: false,
      ageAtDeath: "52",
      causeOfDeath: "Myocardial infarction",
    });
    expect(chips.find((c) => c.key === "death")?.label).toBe(
      "Died at 52 — Myocardial infarction"
    );
  });

  it("holds the death behind the trailing affordance when the row asserts none", () => {
    const { chips, more } = familyFactSummary({
      ...FULL_FAMILY,
      deceased: false,
      ageAtDeath: "",
      causeOfDeath: "",
    });
    expect(keysOf(chips)).not.toContain("death");
    expect(more).toContain("death");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = familyFactSummary({
      ...FULL_FAMILY,
      relationship: "",
      onsetAge: "",
      notes: "",
    });
    const expected: FamilyHistoryFactKey[] = [
      "relationship",
      "onsetAge",
      "notes",
    ];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, FAMILY_HISTORY_FACT_NOUNS)).toBe(
      "relationship, age at onset, notes…"
    );
  });
});
