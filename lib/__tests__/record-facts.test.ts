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
import {
  skinLesionFactSummary,
  SKIN_LESION_FACT_NOUNS,
  type SkinLesionFactInput,
  type SkinLesionFactKey,
} from "@/lib/skin-lesion-facts";
import {
  dentalFactSummary,
  DENTAL_PROCEDURE_FACT_NOUNS,
  type DentalProcedureFactInput,
  type DentalProcedureFactKey,
} from "@/lib/dental-procedure-facts";
import {
  procedureFactSummary,
  PROCEDURE_FACT_NOUNS,
  type ProcedureFactInput,
  type ProcedureFactKey,
} from "@/lib/procedure-facts";
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

const FULL_SKIN_LESION: SkinLesionFactInput = {
  bodyRegion: "forearm",
  bodySide: "left",
  observedDate: "2026-03-04",
  status: "watch",
  sizeMm: "5",
  abcde: {
    asymmetry: true,
    border: true,
    color: false,
    diameter: false,
    evolving: true,
  },
  recheckDays: "90",
  finding: "slightly raised",
  provider: "Dr. Okafor",
  visit: "Dermatology · Mar 4",
  linkableVisits: true,
  notes: "photographed",
};

describe("the skin-lesion row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = skinLesionFactSummary(FULL_SKIN_LESION);
    expect(keysOf(chips)).toEqual([
      "location",
      "observed",
      "status",
      "size",
      "abcde",
      "recheck",
      "finding",
      "provider",
      "visit",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("states the region and the side as ONE fact, through the shared body-map label", () => {
    // They are two of the three components of the #482 identity and the list, the
    // follow-up reason and the search projection all read them back as one line, so
    // the row states the place once rather than twice.
    const { chips } = skinLesionFactSummary(FULL_SKIN_LESION);
    expect(chips.find((c) => c.key === "location")?.label).toBe("Left forearm");
    expect(keysOf(chips)).not.toContain("side");
  });

  it("prompts for the location when no region is chosen, even with a side", () => {
    // A side with no region is not a location — `bodyMapLabel`'s own rule — so the
    // half-answer is still the dashed prompt and never a chip stating "Left".
    const { chips, more } = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      bodyRegion: "",
    });
    expect(stateOf(chips, "location")).toBe("missing");
    expect(more).not.toContain("location");
  });

  it("prompts for the observation date rather than going quiet about it", () => {
    // An undated lesion is the one `findResolvingSkinRecord` refuses to order
    // candidates against, so its recheck can never be resolved.
    const { chips, more } = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      observedDate: "",
    });
    expect(stateOf(chips, "observed")).toBe("missing");
    expect(more).not.toContain("observed");
  });

  it("states the status even when nobody chose it", () => {
    // The select is born "active" and the action normalizes whatever it holds onto the
    // CHECK set, so the fact can never be absent — the allergy row's reading.
    expect(
      stateOf(
        skinLesionFactSummary({ ...FULL_SKIN_LESION, status: "" }).chips,
        "status"
      )
    ).toBe("stated");
  });

  it("states the five ABCDE observations as ONE neutral letter list", () => {
    // Never a count, never a threshold, never a verdict (#715's scope law) — the same
    // string `abcdeLetters` prints on every other surface.
    expect(
      skinLesionFactSummary(FULL_SKIN_LESION).chips.find(
        (c) => c.key === "abcde"
      )?.label
    ).toBe("ABCDE A·B·E");
  });

  it("lets an empty ABCDE set go quiet instead of prompting", () => {
    // "Nothing noticed" is a complete answer, so it reaches the trailing affordance
    // rather than a dashed chip pressing for observations the app never grades.
    const { chips, more } = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      abcde: {
        asymmetry: false,
        border: false,
        color: false,
        diameter: false,
        evolving: false,
      },
    });
    expect(keysOf(chips)).not.toContain("abcde");
    expect(more).toContain("abcde");
  });

  it("offers the visit fact only when the profile has a visit to link", () => {
    // The picker renders nothing without options, so the row must not name a fact the
    // editor behind it cannot show (the allergy row's rule).
    const none = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      visit: "",
      linkableVisits: false,
    });
    expect(keysOf(none.chips)).not.toContain("visit");
    expect(none.more).not.toContain("visit");

    const some = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      visit: "",
      linkableVisits: true,
    });
    expect(some.more).toContain("visit");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = skinLesionFactSummary({
      ...FULL_SKIN_LESION,
      sizeMm: "",
      recheckDays: "",
      notes: "",
    });
    const expected: SkinLesionFactKey[] = ["size", "recheck", "notes"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, SKIN_LESION_FACT_NOUNS)).toBe(
      "size, recheck interval, notes…"
    );
  });
});

const FULL_DENTAL: DentalProcedureFactInput = {
  procedureDate: "2026-03-04",
  status: "watch",
  cdtCode: "D2392",
  tooth: "14",
  surface: "MOD",
  recheckDays: "180",
  finding: "watch mesial for recurrent decay",
  provider: "Dr. Rivera",
  notes: "patient reports sensitivity",
};

describe("the dental-procedure row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = dentalFactSummary(FULL_DENTAL);
    expect(keysOf(chips)).toEqual([
      "date",
      "status",
      "cdt",
      "tooth",
      "recheck",
      "finding",
      "provider",
      "notes",
    ]);
    expect(more).toEqual([]);
  });

  it("prompts for a missing CDT code rather than going quiet about it", () => {
    // The #704 invasiveness gate reads the code first; without it the MRONJ /
    // prophylaxis / anticoagulant notes depend on the name hitting one of fourteen
    // conservative patterns.
    const { chips, more } = dentalFactSummary({ ...FULL_DENTAL, cdtCode: "" });
    expect(stateOf(chips, "cdt")).toBe("missing");
    expect(more).not.toContain("cdt");
  });

  it("prompts for a missing date, which both readers drop the record for", () => {
    const { chips, more } = dentalFactSummary({
      ...FULL_DENTAL,
      procedureDate: "",
    });
    expect(stateOf(chips, "date")).toBe("missing");
    expect(more).not.toContain("date");
  });

  it("states the status the server will store, not the one the select holds", () => {
    // `normalizeDentalStatus` degrades anything off-vocabulary to 'completed', so a
    // tampered or imported value reads on the chip as what the action will write.
    expect(
      dentalFactSummary({ ...FULL_DENTAL, status: "" }).chips.find(
        (c) => c.key === "status"
      )?.label
    ).toBe("Completed");
  });

  it("states the tooth and its surface as ONE fact, through the shared label", () => {
    expect(
      dentalFactSummary(FULL_DENTAL).chips.find((c) => c.key === "tooth")?.label
    ).toBe("#14 MOD");
  });

  it("lets an untoothed record go quiet instead of prompting", () => {
    // The asymmetry with the skin row's `location`, asserted rather than only argued:
    // `sameTooth` matches on recency whenever either side is unspecified, so an absent
    // tooth is defined rather than missing — and a prophylaxis has none to name.
    const { chips, more } = dentalFactSummary({
      ...FULL_DENTAL,
      tooth: "",
      surface: "",
    });
    expect(keysOf(chips)).not.toContain("tooth");
    expect(more).toContain("tooth");
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = dentalFactSummary({
      ...FULL_DENTAL,
      tooth: "",
      surface: "",
      recheckDays: "",
      provider: "",
      notes: "",
    });
    const expected: DentalProcedureFactKey[] = [
      "tooth",
      "recheck",
      "provider",
      "notes",
    ];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, DENTAL_PROCEDURE_FACT_NOUNS)).toBe(
      "tooth, recheck interval, provider, notes…"
    );
  });
});

const FULL_PROCEDURE: ProcedureFactInput = {
  code: "45378",
  codeSystem: "CPT",
  date: "2026-03-04",
  provider: "Dr. Smith",
  notes: "no polyps",
};

describe("the procedure row (#5302)", () => {
  it("states every fact it has, and holds nothing behind the more-line", () => {
    const { chips, more } = procedureFactSummary(FULL_PROCEDURE);
    expect(keysOf(chips)).toEqual(["code", "date", "provider", "notes"]);
    expect(more).toEqual([]);
  });

  it("reads the code system with the code rather than as its own chip", () => {
    // A bare "45378" is a different concept in CPT and SNOMED CT, so the two read
    // together or the chip states less than it appears to.
    expect(
      procedureFactSummary(FULL_PROCEDURE).chips.find((c) => c.key === "code")
        ?.label
    ).toBe("45378 · CPT");
  });

  it("prompts for both essentials when neither is stated", () => {
    // The preventive clock reads a procedure code-first and drops any record whose
    // date is not a real ISO day, so an uncoded undated row satisfies nothing.
    const { chips, more } = procedureFactSummary({
      ...FULL_PROCEDURE,
      code: "",
      codeSystem: "",
      date: "",
    });
    expect(stateOf(chips, "code")).toBe("missing");
    expect(stateOf(chips, "date")).toBe("missing");
    expect(more).toEqual([]);
  });

  it("names the facts the trailing affordance holds", () => {
    const { more } = procedureFactSummary({
      ...FULL_PROCEDURE,
      provider: "",
      notes: "",
    });
    const expected: ProcedureFactKey[] = ["provider", "notes"];
    expect(more).toEqual(expected);
    expect(moreRecordFactsLabel(more, PROCEDURE_FACT_NOUNS)).toBe(
      "provider, notes…"
    );
  });
});
