import { describe, expect, it } from "vitest";
import {
  anxietyScaleRelevant,
  conditionMatchesAnxiety,
  medMatchesAnxiety,
  type AnxietyGateSignals,
} from "@/lib/mood-anxiety-gate";
import {
  anxietyDisplaySlot,
  anxietyStoredValue,
  ANXIETY_CALM_LOW_LABEL,
  ANXIETY_CALM_HIGH_LABEL,
} from "@/lib/mood";

// Pure coverage for the check-in Calm-scale relevance gate (issue #1313): the OR
// matrix (each input alone flips it; none → hidden; opt-in reveals), the curated
// keyword/CUI matchers over synthetic fixtures (phi-scan-clean), and the axis relabel.

// A baseline where every signal is OFF — the gate is hidden here.
const NONE: AnxietyGateSignals = {
  priorUse: false,
  instrumentOnRecord: false,
  activeConditionNames: [],
  activeMeds: [],
  anxietyProtocolOutcome: false,
  optIn: false,
};

describe("conditionMatchesAnxiety (signal 3)", () => {
  it("matches curated anxiety/mood keywords (case-folded substring)", () => {
    expect(conditionMatchesAnxiety(["Generalized Anxiety Disorder"])).toBe(
      true
    );
    expect(conditionMatchesAnxiety(["Panic disorder"])).toBe(true);
    expect(conditionMatchesAnxiety(["Major depressive disorder"])).toBe(true);
    expect(conditionMatchesAnxiety(["PTSD"])).toBe(true);
    expect(conditionMatchesAnxiety(["Bipolar II"])).toBe(true);
  });

  it("does not match an unrelated condition", () => {
    expect(conditionMatchesAnxiety(["Type 2 diabetes", "Hypertension"])).toBe(
      false
    );
    expect(conditionMatchesAnxiety([])).toBe(false);
  });
});

describe("medMatchesAnxiety (signal 4 — CUI only, never name)", () => {
  it("matches a curated anxiolytic/antidepressant ingredient RxCUI", () => {
    // sertraline ingredient RxCUI.
    expect(medMatchesAnxiety([{ rxcui: "36437" }])).toBe(true);
    // A combination product whose product rxcui isn't curated but an ingredient CUI is.
    expect(
      medMatchesAnxiety([{ rxcui: "999999", rxcuiIngredients: ["321988"] }])
    ).toBe(true);
  });

  it("ignores the name entirely (RxCUI-authoritative) and an unmatched med", () => {
    // A med literally named to look like an anxiolytic but with a non-curated CUI does
    // NOT match — the gate never name-string matches (per the issue).
    expect(medMatchesAnxiety([{ rxcui: "12345" }])).toBe(false);
    expect(medMatchesAnxiety([{ rxcui: null }])).toBe(false);
    expect(medMatchesAnxiety([])).toBe(false);
  });
});

describe("anxietyScaleRelevant OR matrix", () => {
  it("hides when no signal holds", () => {
    expect(anxietyScaleRelevant(NONE)).toBe(false);
  });

  it("prior use alone reveals it (continuity trumps inference)", () => {
    expect(anxietyScaleRelevant({ ...NONE, priorUse: true })).toBe(true);
  });

  it("an instrument on record alone reveals it", () => {
    expect(anxietyScaleRelevant({ ...NONE, instrumentOnRecord: true })).toBe(
      true
    );
  });

  it("a matching active condition alone reveals it", () => {
    expect(
      anxietyScaleRelevant({ ...NONE, activeConditionNames: ["Anxiety"] })
    ).toBe(true);
  });

  it("a matching active medication alone reveals it", () => {
    expect(
      anxietyScaleRelevant({ ...NONE, activeMeds: [{ rxcui: "36437" }] })
    ).toBe(true);
  });

  it("a protocol outcome alone reveals it", () => {
    expect(
      anxietyScaleRelevant({ ...NONE, anxietyProtocolOutcome: true })
    ).toBe(true);
  });

  it("the explicit opt-in alone reveals it", () => {
    expect(anxietyScaleRelevant({ ...NONE, optIn: true })).toBe(true);
  });
});

describe("axis relabel (#1313 fold-in)", () => {
  it("maps stored ↔ display as a 6 − x involution", () => {
    for (let stored = 1; stored <= 5; stored++) {
      const slot = anxietyDisplaySlot(stored);
      expect(anxietyStoredValue(slot)).toBe(stored);
    }
    // Stored 1 = calm sits at the HIGH display slot (5); stored 5 = anxious at slot 1.
    expect(anxietyDisplaySlot(1)).toBe(5);
    expect(anxietyDisplaySlot(5)).toBe(1);
  });

  it("labels the good (calm) end high, matching Energy's direction", () => {
    expect(ANXIETY_CALM_LOW_LABEL).toBe("anxious");
    expect(ANXIETY_CALM_HIGH_LABEL).toBe("calm");
  });
});
