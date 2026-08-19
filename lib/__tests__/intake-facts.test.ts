import { describe, expect, it } from "vitest";
import {
  intakeFactSummary,
  moreFactsLabel,
  type IntakeFactInput,
  type IntakeFactKey,
} from "@/lib/intake-facts";
import { nextRuleId } from "@/lib/intake-rules";

// The summary row (#3216 decision 5). These assertions name WHICH FACTS THE ROW
// STATES and which it leaves to the trailing affordance — never the chips' copy. A
// chip's wording is a rendering; "an as-needed item does not also state 'as needed' as
// its timing" is the property.

function base(over: Partial<IntakeFactInput> = {}): IntakeFactInput {
  return {
    kind: "medication",
    amount: "",
    formulationLabel: "",
    extraDoses: [],
    firstDoseTimeOfDay: "",
    obligation: "must",
    critical: false,
    minIntervalHours: "",
    maxDailyCount: "",
    maxDailyAmountMg: "",
    cadenceSentence: null,
    rx: false,
    prescriber: "",
    indication: "",
    brand: "",
    product: "",
    stack: "",
    supplyLabel: null,
    quantityOnHand: "",
    stopDate: "",
    ingredientCount: 0,
    notes: "",
    rules: [],
    itemNames: new Map(),
    ...over,
  };
}

function keys(input: IntakeFactInput): IntakeFactKey[] {
  return intakeFactSummary(input).chips.map((c) => c.key);
}

function stateOf(
  input: IntakeFactInput,
  key: IntakeFactKey
): "stated" | "missing" | "absent" {
  return (
    intakeFactSummary(input).chips.find((c) => c.key === key)?.state ?? "absent"
  );
}

describe("intake fact summary (#3216)", () => {
  it("a missing essential is stated as missing, not omitted", () => {
    // The person has to be able to see what the form still needs. An absent dose that
    // rendered nothing would make Add look complete.
    expect(stateOf(base(), "dose")).toBe("missing");
    expect(stateOf(base({ amount: "200 mg" }), "dose")).toBe("stated");
  });

  it("an absent OPTIONAL renders nothing and moves to the trailing affordance", () => {
    const empty = base();
    expect(keys(empty)).not.toContain("notes");
    expect(intakeFactSummary(empty).more).toContain("notes");
    // …and stops being "more" the moment it has something to say.
    const withNotes = base({ notes: "half a tablet on bad days" });
    expect(keys(withNotes)).toContain("notes");
    expect(intakeFactSummary(withNotes).more).not.toContain("notes");
  });

  it("the trailing affordance NAMES the facts it holds", () => {
    // "more" that does not say what is inside it is a place things get lost.
    const label = moreFactsLabel(["supply", "notes"]);
    expect(label).toContain("supply");
    expect(label).toContain("notes");
    expect(moreFactsLabel([])).toBe("");
  });

  it("timing states WHEN and importance states how much it matters — never both", () => {
    const prn = base({
      obligation: "may",
      minIntervalHours: "6",
      maxDailyCount: "4",
      amount: "200 mg",
    });
    const summary = intakeFactSummary(prn);
    const timing = summary.chips.find((c) => c.key === "timing");
    const importance = summary.chips.find((c) => c.key === "importance");
    // The as-neededness is the OBLIGATION. Stating it in the timing chip too is the
    // duplication the prototyping caught; the timing chip carries the ceiling only.
    expect(timing?.label).toContain("6");
    expect(timing?.label).toContain("4");
    expect(timing?.label).not.toContain("as needed");
    expect(importance?.label).toContain("as needed");
  });

  it("an as-needed item with no confirmed ceiling states no timing at all", () => {
    const summary = intakeFactSummary(base({ obligation: "may" }));
    expect(summary.chips.map((c) => c.key)).not.toContain("timing");
    expect(summary.more).toContain("timing");
  });

  it("a scheduled item always states its schedule", () => {
    expect(stateOf(base({ obligation: "must" }), "timing")).toBe("stated");
  });

  it("a medication always states OTC or prescription; a supplement never does", () => {
    // "OTC" is a FACT, not an absence: it is the difference between a drug nobody
    // prescribed and one nobody recorded.
    expect(keys(base({ kind: "medication" }))).toContain("prescription");
    expect(keys(base({ kind: "supplement" }))).not.toContain("prescription");
    expect(intakeFactSummary(base({ kind: "supplement" })).more).not.toContain(
      "prescription"
    );
  });

  it("kind decides which optional facts even exist", () => {
    const supp = intakeFactSummary(base({ kind: "supplement" }));
    const med = intakeFactSummary(base({ kind: "medication" }));
    expect(supp.more).toContain("composition");
    expect(med.more).not.toContain("composition");
    expect(med.more).toContain("indication");
    expect(supp.more).not.toContain("indication");
  });

  it("further dose rows read back as 'also [amount] at [slot]'", () => {
    const summary = intakeFactSummary(
      base({
        amount: "200 mg",
        extraDoses: [{ amount: "400 mg", timeOfDay: "Evening" }],
      })
    );
    const dose = summary.chips.find((c) => c.key === "dose");
    expect(dose?.label).toContain("200 mg");
    expect(dose?.label).toContain("400 mg");
    expect(dose?.label).toContain("Evening");
  });

  it("a rule becomes its own chip, and a suggested one says so", () => {
    const summary = intakeFactSummary(
      base({
        rules: [
          {
            id: nextRuleId(),
            type: "food",
            timing: "with_food",
            suggested: true,
          },
          { id: nextRuleId(), type: "pause-while", situation: "Pre-surgery" },
        ],
      })
    );
    expect(summary.rules).toHaveLength(2);
    expect(summary.rules[0].suggested).toBe(true);
    expect(summary.rules[1].suggested).toBe(false);
    expect(summary.rules[1].label).toContain("Pre-surgery");
  });

  it("a keep-apart rule names the other item, not its id", () => {
    const summary = intakeFactSummary(
      base({
        rules: [
          {
            id: nextRuleId(),
            type: "keep-apart",
            otherId: 7,
            hours: 2,
            note: "",
          },
        ],
      })
    );
    expect(summary.rules[0].label).toContain("2");
    // With no name to resolve, it must still read as a sentence rather than "item 7".
    expect(summary.rules[0].label).not.toContain("7");

    const named = intakeFactSummary(
      base({
        itemNames: new Map([[7, "Iron"]]),
        rules: [
          {
            id: nextRuleId(),
            type: "keep-apart",
            otherId: 7,
            hours: 2,
            note: "",
          },
        ],
      })
    );
    expect(named.rules[0].label).toContain("Iron");
  });
});
